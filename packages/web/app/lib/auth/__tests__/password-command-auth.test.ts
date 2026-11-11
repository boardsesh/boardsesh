// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import CredentialsProvider from 'next-auth/providers/credentials';
import type { NextAuthOptions } from 'next-auth';
import type { PasswordReply } from '@boardsesh/auth-protocol';
vi.mock('server-only', () => ({}));
import {
  createPasswordCommandAuthRequest,
  limitPasswordLoginPerClient,
  unavailablePasswordAuthResponse,
} from '../password-command-auth.server';

const reply: Extract<PasswordReply, { outcome: 'authenticated' }> = {
  protocolVersion: 2,
  operation: 'password',
  requestId: 'e363934b-b7ba-41ba-a279-52185daa100e',
  outcome: 'authenticated',
  user: { id: 'selected', email: 'duplicate@example.com', name: null, image: null },
  verification: { userId: 'selected', required: true, verified: false },
};
function base() {
  return {
    providers: [
      CredentialsProvider({ id: 'native-oauth', credentials: {}, authorize: async () => ({ id: 'native' }) }),
      CredentialsProvider({ credentials: {}, authorize: async () => ({ id: 'local-fallback' }) }),
    ],
    callbacks: { signIn: vi.fn(async () => true) },
  } satisfies NextAuthOptions;
}
function provider(options: NextAuthOptions) {
  const configured = options.providers.find((entry) => (entry.options?.id ?? entry.id) === 'credentials');
  if (!configured || configured.type !== 'credentials') throw new Error('Missing credentials provider');
  return { ...configured, ...configured.options };
}
function parameters(userId: string) {
  return {
    user: { id: userId },
    account: { provider: 'credentials', type: 'credentials' as const, providerAccountId: userId },
    credentials: {},
  };
}
afterEach(() => vi.unstubAllEnvs());

describe('request-local backend password verdict', () => {
  it('preserves the original options and needs no transport configuration when disabled', () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
    const original = base();
    const factory = vi.fn();
    expect(createPasswordCommandAuthRequest(original, factory).options).toBe(original);
    expect(factory).not.toHaveBeenCalled();
  });
  it('preserves the actual custom native provider and replaces exactly one effective credentials ID', () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    const original = base();
    const scoped = createPasswordCommandAuthRequest(original);
    expect(scoped.options.providers[0]).toBe(original.providers[0]);
    expect(scoped.options.providers[1]).not.toBe(original.providers[1]);
    expect(scoped.options.providers.filter((entry) => (entry.options?.id ?? entry.id) === 'credentials')).toHaveLength(
      1,
    );
  });
  it('uses selected UID verification and never calls the legacy signIn lookup', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    const original = base();
    const scoped = createPasswordCommandAuthRequest(original, () => ({
      password: async () => reply,
      register: vi.fn(),
    }));
    await expect(
      provider(scoped.options).authorize({ email: 'duplicate@example.com', password: 'x' }, { headers: {} }),
    ).resolves.toEqual(reply.user);
    await expect(scoped.options.callbacks?.signIn?.(parameters('selected'))).resolves.toBe(
      '/auth/verify-request?error=EmailNotVerified',
    );
    expect(original.callbacks.signIn).not.toHaveBeenCalled();
  });
  it('does not leak a successful verdict into an independent request for the same email', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    const first = createPasswordCommandAuthRequest(base(), () => ({
      password: async () => ({ ...reply, verification: { ...reply.verification, verified: true } }),
      register: vi.fn(),
    }));
    const second = createPasswordCommandAuthRequest(base(), () => ({ password: async () => reply, register: vi.fn() }));
    await provider(first.options).authorize({ email: reply.user.email, password: 'x' }, { headers: {} });
    await provider(second.options).authorize({ email: reply.user.email, password: 'x' }, { headers: {} });
    await expect(first.options.callbacks?.signIn?.(parameters('selected'))).resolves.toBe(true);
    await expect(second.options.callbacks?.signIn?.(parameters('selected'))).resolves.toBe(
      '/auth/verify-request?error=EmailNotVerified',
    );
  });
  it('rejects a signIn callback for another UID without a legacy fallback', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    const scoped = createPasswordCommandAuthRequest(base(), () => ({ password: async () => reply, register: vi.fn() }));
    await provider(scoped.options).authorize({ email: reply.user.email, password: 'x' }, { headers: {} });
    await expect(scoped.options.callbacks?.signIn?.(parameters('another'))).rejects.toThrow('AuthBackendUnavailable');
    expect(scoped.unavailable()).toBe(true);
  });
  it('only maps the explicit invalid_credentials verdict to authorize null', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    const denied = createPasswordCommandAuthRequest(base(), () => ({
      password: async () => ({
        protocolVersion: 2,
        operation: 'password',
        requestId: reply.requestId,
        outcome: 'invalid_credentials',
      }),
      register: vi.fn(),
    }));
    await expect(
      provider(denied.options).authorize({ email: 'x', password: 'y' }, { headers: {} }),
    ).resolves.toBeNull();
    expect(denied.unavailable()).toBe(false);
    const unavailable = createPasswordCommandAuthRequest(base(), () => ({
      password: async () => ({
        protocolVersion: 2,
        operation: 'password',
        requestId: reply.requestId,
        outcome: 'error',
        code: 'replayed',
      }),
      register: vi.fn(),
    }));
    await expect(
      provider(unavailable.options).authorize({ email: 'x', password: 'y' }, { headers: {} }),
    ).rejects.toThrow('AuthBackendUnavailable');
    expect(unavailable.unavailable()).toBe(true);
  });
});

describe('on the standalone server, whose request URL is its bind address', () => {
  const bindAddress = 'https://0.0.0.0:3000/api/auth/callback/credentials';
  const www = 'https://www.boardsesh.com/auth/error?error=AuthBackendUnavailable';

  it('points the unavailable result at the configured site', async () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://www.boardsesh.com');
    expect(await unavailablePasswordAuthResponse(bindAddress).json()).toEqual({ url: www });
  });

  it('points a client over its login limit at the configured site', async () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://www.boardsesh.com');
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    const attempt = () =>
      limitPasswordLoginPerClient(
        new Request(bindAddress, { method: 'POST', headers: { 'X-Forwarded-For': '203.0.113.201' } }),
      );
    for (let count = 0; count < 10; count += 1) expect(attempt()).toBeNull();
    const limited = attempt();
    expect(limited?.status).toBe(429);
    expect(await limited?.json()).toEqual({ url: www });
  });
});
