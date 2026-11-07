// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';

const controls = vi.hoisted(() => ({
  cookies: [] as { name: string; value: string }[],
  session: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => controls.cookies }) }));
vi.mock('next-auth/next', () => ({ getServerSession: (...arguments_: unknown[]) => controls.session(...arguments_) }));
vi.mock('../auth-options', () => ({
  authOptions: {
    cookies: { sessionToken: { name: 'next-auth.session-token', options: { httpOnly: true, sameSite: 'lax' } } },
  },
}));
vi.mock('../../backend-url', () => ({ getGraphQLHttpUrl: () => 'http://authority.invalid/graphql' }));

import {
  capturePresentedWebCredential,
  getAdmittedRawServerToken,
  getAdmittedServerSession,
} from '../admitted-session.server';
import { CredentialAuthorityUnavailable } from '../credential-admission.server';

const fixtureSecret = 'local-admitted-session-fixture-secret';
const fetchMock = vi.fn<typeof fetch>();
let credential: string;

beforeEach(async () => {
  vi.stubEnv('NEXTAUTH_SECRET', fixtureSecret);
  vi.stubEnv('NEXTAUTH_URL', 'https://www.boardsesh.com');
  vi.stubEnv('VERCEL_ENV', '');
  vi.stubEnv('VERCEL_URL', '');
  vi.stubGlobal('fetch', fetchMock);
  controls.cookies = [];
  controls.session.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => Response.json({ data: { authenticatedUserId: 'fixture-owner' } }));
  credential = await encode({ secret: fixtureSecret, token: { sub: 'fixture-owner' }, maxAge: 60 });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function requestWithCookies(cookieHeader: string, authorization?: string) {
  return new NextRequest('https://www.boardsesh.com/profile', {
    headers: { cookie: cookieHeader, ...(authorization ? { authorization } : {}) },
  });
}

function useChunkedFallback() {
  const split = Math.floor(credential.length / 2);
  controls.cookies = [
    { name: 'next-auth.session-token.1', value: credential.slice(split) },
    { name: 'next-auth.session-token.0', value: credential.slice(0, split) },
  ];
}

describe('public session cookie admission', () => {
  it('reconstructs out-of-order fallback chunks through the public cookie codec', async () => {
    useChunkedFallback();
    const header = controls.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    const result = await capturePresentedWebCredential(requestWithCookies(header));
    expect(result).toEqual({ cookieName: 'next-auth.session-token', credential });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('prefers the configured name and never substitutes an Authorization token', async () => {
    const result = await capturePresentedWebCredential(
      requestWithCookies(
        `__Secure-next-auth.session-token=${credential}; next-auth.session-token=other`,
        'Bearer other',
      ),
    );
    expect(result?.credential === credential).toBe(true);
    expect(result?.cookieName).toBe('__Secure-next-auth.session-token');
    await expect(capturePresentedWebCredential(requestWithCookies('', `Bearer ${credential}`))).resolves.toBeNull();
  });

  it('returns anonymously without loading core session handling or calling authority', async () => {
    await expect(getAdmittedServerSession()).resolves.toBeNull();
    await expect(getAdmittedRawServerToken()).resolves.toBeUndefined();
    expect(controls.session).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('admits chunked raw server forwarding without truncating to the base cookie', async () => {
    useChunkedFallback();
    const result = await getAdmittedRawServerToken();
    expect(result === credential).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(controls.session).not.toHaveBeenCalled();
  });

  it('lets the session core consume the same admitted fallback name with local options', async () => {
    useChunkedFallback();
    const session = { user: { id: 'fixture-owner' }, expires: '2099-01-01T00:00:00.000Z' };
    controls.session.mockResolvedValue(session);
    await expect(getAdmittedServerSession()).resolves.toEqual(session);
    expect(controls.session).toHaveBeenCalledWith(
      expect.objectContaining({
        cookies: { sessionToken: { name: 'next-auth.session-token', options: { httpOnly: true, sameSite: 'lax' } } },
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const { authOptions } = await import('../auth-options');
    expect(authOptions.cookies?.sessionToken?.name).toBe('next-auth.session-token');
  });

  it('denies before core handling once a captured subject is deleted', async () => {
    useChunkedFallback();
    fetchMock.mockResolvedValue(Response.json({ data: null, errors: [{ extensions: { code: 'UNAUTHENTICATED' } }] }));
    await expect(getAdmittedServerSession()).resolves.toBeNull();
    expect(controls.session).not.toHaveBeenCalled();
  });

  it('rechecks deletion after the local session callback finishes', async () => {
    useChunkedFallback();
    controls.session.mockResolvedValue({ user: { id: 'fixture-owner' }, expires: '2099-01-01T00:00:00.000Z' });
    fetchMock.mockResolvedValueOnce(Response.json({ data: { authenticatedUserId: 'fixture-owner' } }));
    fetchMock.mockResolvedValueOnce(
      Response.json({ data: null, errors: [{ extensions: { code: 'UNAUTHENTICATED' } }] }),
    );
    await expect(getAdmittedServerSession()).resolves.toBeNull();
    expect(controls.session).toHaveBeenCalledOnce();
  });

  it('does not expose a different identity from the local session callback', async () => {
    useChunkedFallback();
    controls.session.mockResolvedValue({ user: { id: 'different-owner' }, expires: '2099-01-01T00:00:00.000Z' });
    await expect(getAdmittedServerSession()).rejects.toBeInstanceOf(CredentialAuthorityUnavailable);
  });

  it('preserves uncertainty before and after core session processing', async () => {
    useChunkedFallback();
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(getAdmittedServerSession()).rejects.toBeInstanceOf(CredentialAuthorityUnavailable);
    expect(controls.session).not.toHaveBeenCalled();
    controls.session.mockResolvedValue({ user: { id: 'fixture-owner' }, expires: '2099-01-01T00:00:00.000Z' });
    fetchMock.mockResolvedValueOnce(Response.json({ data: { authenticatedUserId: 'fixture-owner' } }));
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(getAdmittedServerSession()).rejects.toBeInstanceOf(CredentialAuthorityUnavailable);
  });
});
