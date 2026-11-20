// @vitest-environment node
import { afterEach, expect, it, vi } from 'vite-plus/test';
import type { createPasswordCommandAuthRequest } from '../password-command-auth.server';
type WebAuthOptions = Parameters<typeof createPasswordCommandAuthRequest>[0];
import { verifyDeviceToken } from '@boardsesh/auth-protocol/device-token';
vi.mock('server-only', () => ({}));
import { sessionCookieName } from '../secure-cookies';
import { createDeviceTokenAuthRequest } from '../device-token-request.server';
const secret = 'device-request-secret-distinct-32bytes';
const base: WebAuthOptions = { providers: [], callbacks: { jwt: async ({ token }) => token } };
type JwtParameters = Parameters<NonNullable<NonNullable<WebAuthOptions['callbacks']>['jwt']>>[0];
function parameters(userId?: string): JwtParameters {
  return {
    token: {},
    ...(userId
      ? {
          user: { id: userId },
          account: { provider: 'credentials', type: 'credentials' as const, providerAccountId: userId },
          trigger: 'signIn' as const,
        }
      : {}),
  } as unknown as JwtParameters;
}
function login(chunked = false) {
  return new Response(null, {
    headers: { 'set-cookie': `${sessionCookieName()}${chunked ? '.0' : ''}=admitted; Path=/; HttpOnly` },
  });
}
afterEach(() => vi.unstubAllEnvs());

it('returns exactly the original options and response when tokens are off', () => {
  vi.stubEnv('AUTH_DEVICE_TOKEN_SECRET', '');
  const scoped = createDeviceTokenAuthRequest(base);
  expect(scoped.options).toBe(base);
  const response = login();
  expect(scoped.decorate(response)).toBe(response);
  expect(response.headers.getSetCookie()).toHaveLength(1);
});

it.each([false, true])('seeds a host-only HttpOnly token after an admitted login (chunked=%s)', async (chunked) => {
  vi.stubEnv('AUTH_DEVICE_TOKEN_SECRET', secret);
  vi.stubEnv('NEXTAUTH_URL', 'https://www.boardsesh.test');
  const scoped = createDeviceTokenAuthRequest(base);
  const token = await scoped.options.callbacks?.jwt?.(parameters('owner'));
  expect(token).toEqual({});
  const response = scoped.decorate(login(chunked));
  const cookie = response.headers.getSetCookie().find((entry) => entry.startsWith('__Host-boardsesh.device='));
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('Secure');
  expect(cookie).not.toContain('Domain=');
  const signedToken = cookie?.split(';')[0].split('=')[1];
  expect(await verifyDeviceToken(signedToken, { userId: 'owner', secret })).not.toBeNull();
  expect(await verifyDeviceToken(signedToken, { userId: 'another', secret })).toBeNull();
});

it('does not mint on session reads or publish a token after admission refused the login', async () => {
  vi.stubEnv('AUTH_DEVICE_TOKEN_SECRET', secret);
  const read = createDeviceTokenAuthRequest(base);
  await read.options.callbacks?.jwt?.(parameters());
  expect(read.decorate(login()).headers.getSetCookie()).toHaveLength(1);
  const refused = createDeviceTokenAuthRequest(base);
  await refused.options.callbacks?.jwt?.(parameters('owner'));
  expect(refused.decorate(new Response(null, { status: 503 })).headers.getSetCookie()).toEqual([]);
});

it('keeps concurrent requests and failed JWT callbacks isolated', async () => {
  vi.stubEnv('AUTH_DEVICE_TOKEN_SECRET', secret);
  const first = createDeviceTokenAuthRequest(base);
  const second = createDeviceTokenAuthRequest(base);
  await first.options.callbacks?.jwt?.(parameters('owner'));
  expect(second.decorate(login()).headers.getSetCookie()).toHaveLength(1);
  const failing = createDeviceTokenAuthRequest({
    providers: [],
    callbacks: {
      jwt: async () => {
        throw new Error('refused');
      },
    },
  });
  await expect(failing.options.callbacks?.jwt?.(parameters('owner'))).rejects.toThrow('refused');
  expect(failing.decorate(login()).headers.getSetCookie()).toHaveLength(1);
});
