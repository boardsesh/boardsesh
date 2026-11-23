// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const sentry = vi.hoisted(() => ({
  captureException: vi.fn(),
  flush: vi.fn(async () => true),
  captureRequestError: vi.fn(),
}));
vi.mock('@sentry/nextjs', () => sentry);
vi.mock('@boardsesh/db/client/config', () => ({ markWebDatabaseUrlProcess: () => {} }));
vi.mock('../sentry.server.config', () => ({}));
vi.mock('../sentry.edge.config', () => ({}));
const errorResponseCdnCache = vi.hoisted(() => ({ installErrorResponseCdnCacheGuard: vi.fn(() => true) }));
vi.mock('../app/lib/error-response-cdn-cache.server', () => errorResponseCdnCache);
vi.mock('../app/lib/auth/canonical-auth-url', () => ({
  applyCanonicalAuthUrl: () => {},
  diagnoseCanonicalOrigin: () => ({ level: 'ok', message: '' }),
}));

import { register } from '../instrumentation';

const READY = {
  AUTH_BROWSER_SESSION_COOKIE_SECRET: 'instrumentation-test-browser-cookie-secret-0001',
  CURRENT_STORE_AUTH_BACKEND_ORIGIN: 'https://backend.boardsesh.test',
  CURRENT_STORE_AUTH_RPC_SECRET: 'instrumentation-test-private-rpc-secret-00000001',
  CURRENT_STORE_WEB_AUTH_MODE: 'backend-staging',
  CURRENT_STORE_WEB_OAUTH_MODE: 'backend-staging',
  CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE: 'required',
  NEXTAUTH_SECRET: 'instrumentation-test-nextauth-secret-00000000001',
  NEXTAUTH_URL: 'https://www.boardsesh.com',
};

let exit: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  sentry.captureException.mockClear();
});

describe('register: error responses and the CDN cache', () => {
  it('guards error responses against a shared-cache TTL before serving', async () => {
    errorResponseCdnCache.installErrorResponseCdnCacheGuard.mockClear();
    await register();
    expect(errorResponseCdnCache.installErrorResponseCdnCacheGuard).toHaveBeenCalledTimes(1);
  });

  it('leaves the edge runtime alone', async () => {
    errorResponseCdnCache.installErrorResponseCdnCacheGuard.mockClear();
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    await register();
    expect(errorResponseCdnCache.installErrorResponseCdnCacheGuard).not.toHaveBeenCalled();
  });
});

describe('register: AUTH_BROWSER_SESSION_MODE at boot', () => {
  it.each([undefined, '', 'legacy'])('boots as before with %j', async (mode) => {
    if (mode === undefined) delete process.env.AUTH_BROWSER_SESSION_MODE;
    else vi.stubEnv('AUTH_BROWSER_SESSION_MODE', mode);
    await register();
    expect(exit).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown value', { AUTH_BROWSER_SESSION_MODE: 'Better-Auth' }, 'AUTH_BROWSER_SESSION_MODE_INVALID'],
    [
      'better-auth without its preconditions',
      { AUTH_BROWSER_SESSION_MODE: 'better-auth' },
      'AUTH_BROWSER_SESSION_WEB_BACKEND_CHANNEL_INVALID',
    ],
  ])('fails the boot on %s', async (_case, environment, code) => {
    for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
    await register();
    expect(exit).toHaveBeenCalledWith(1);
    expect(sentry.captureException).toHaveBeenCalledWith(new Error(code));
  });
});

describe('register: better-auth with every precondition met', () => {
  it('boots: the www cutover list is empty since #7880', async () => {
    for (const [name, value] of Object.entries({ ...READY, AUTH_BROWSER_SESSION_MODE: 'better-auth' }))
      vi.stubEnv(name, value);
    await register();
    expect(exit).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});

describe('register: the browser-session e2e provider stand-ins at boot', () => {
  const STAND_IN = 'http://127.0.0.1:41234/.well-known/openid-configuration';

  it('fails the boot when a stand-in is set on a production origin', async () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://www.boardsesh.com');
    vi.stubEnv('BOARDSESH_E2E_APPLE_OIDC_WELL_KNOWN', STAND_IN);
    await register();
    expect(exit).toHaveBeenCalledWith(1);
    expect(sentry.captureException).toHaveBeenCalledWith(new Error('AUTH_OIDC_STAND_IN_OUTSIDE_TEST'));
  });

  it('boots with a loopback stand-in on a .boardsesh.test origin', async () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://www.boardsesh.test');
    vi.stubEnv('BOARDSESH_E2E_GOOGLE_OIDC_WELL_KNOWN', STAND_IN);
    await register();
    expect(sentry.captureException).not.toHaveBeenCalledWith(new Error('AUTH_OIDC_STAND_IN_OUTSIDE_TEST'));
  });
});
