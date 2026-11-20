// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { webLogger } from '@/app/lib/observability/logger';
import {
  BROWSER_SESSION_WEB_CUTOVER_BLOCKERS,
  BROWSER_SESSION_WEB_PRECONDITION_ERRORS,
  E2E_BROWSER_SESSION_CUTOVER_ENV,
  browserSessionBootRefusal,
  browserSessionRouteMode,
  browserSessionRouteModeResolver,
} from '../browser-session-mode.server';

/** The preconditions alone, as the later PRs will see them once the www list is empty. */
let resolveWithoutBlockers: ReturnType<typeof browserSessionRouteModeResolver>;

const READY = {
  AUTH_BROWSER_SESSION_MODE: 'better-auth',
  AUTH_BROWSER_SESSION_COOKIE_SECRET: 'browser-session-cookie-secret-for-mode-tests-0001',
  CURRENT_STORE_AUTH_BACKEND_ORIGIN: 'https://backend.boardsesh.test',
  CURRENT_STORE_AUTH_RPC_SECRET: 'browser-session-rpc-secret-for-mode-tests-00000001',
  CURRENT_STORE_WEB_AUTH_MODE: 'backend-staging',
  CURRENT_STORE_WEB_OAUTH_MODE: 'backend-staging',
  CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE: 'required',
  NEXTAUTH_SECRET: 'browser-session-nextauth-secret-for-mode-tests-0001',
  NEXTAUTH_URL: 'https://www.boardsesh.com',
  CRON_SECRET: '',
  VERCEL_ENV: '',
  VERCEL_URL: '',
  AUTH_COOKIE_DOMAIN: '',
  NODE_ENV: 'production',
} as const;

let logged: ReturnType<typeof vi.spyOn>;

function stub(overrides: Partial<Record<string, string>> = {}) {
  for (const [name, value] of Object.entries({ ...READY, ...overrides })) vi.stubEnv(name, value);
}

beforeEach(() => {
  logged = vi.spyOn(webLogger, 'error').mockImplementation(() => {});
  resolveWithoutBlockers = browserSessionRouteModeResolver([]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('browserSessionRouteMode', () => {
  it.each([undefined, '', 'legacy'])('reads %j as legacy and checks nothing else', (mode) => {
    // Every precondition broken: legacy must not look at any of them.
    stub({ AUTH_BROWSER_SESSION_COOKIE_SECRET: 'short', CURRENT_STORE_AUTH_BACKEND_ORIGIN: '', NEXTAUTH_SECRET: '' });
    if (mode === undefined) delete process.env.AUTH_BROWSER_SESSION_MODE;
    else vi.stubEnv('AUTH_BROWSER_SESSION_MODE', mode);
    expect(browserSessionRouteMode()).toEqual({ kind: 'legacy' });
    expect(logged).not.toHaveBeenCalled();
  });

  it.each(['Better-Auth', ' better-auth', 'on', 'true'])('answers an unknown value %j as unavailable', (mode) => {
    stub({ AUTH_BROWSER_SESSION_MODE: mode });
    expect(resolveWithoutBlockers()).toEqual({
      kind: 'unavailable',
      code: BROWSER_SESSION_WEB_PRECONDITION_ERRORS.modeInvalid,
    });
    expect(logged).toHaveBeenCalledWith('browser session mode unavailable', {
      code: BROWSER_SESSION_WEB_PRECONDITION_ERRORS.modeInvalid,
    });
  });

  it('turns on with every precondition met: secure names and the shared domain on production www', () => {
    stub();
    expect(resolveWithoutBlockers()).toEqual({
      kind: 'better-auth',
      cookies: { secret: READY.AUTH_BROWSER_SESSION_COOKIE_SECRET, secure: true, domain: '.boardsesh.com' },
    });
  });

  it('is host-only on a preview host', () => {
    stub({ NEXTAUTH_URL: 'https://12.preview.boardsesh.com' });
    expect(resolveWithoutBlockers()).toMatchObject({ kind: 'better-auth', cookies: { domain: undefined } });
  });

  const errors = BROWSER_SESSION_WEB_PRECONDITION_ERRORS;
  it.each([
    ['no backend origin', { CURRENT_STORE_AUTH_BACKEND_ORIGIN: '' }, errors.backendChannel],
    ['a short RPC secret', { CURRENT_STORE_AUTH_RPC_SECRET: 'short' }, errors.backendChannel],
    ['the legacy web auth mode', { CURRENT_STORE_WEB_AUTH_MODE: 'legacy' }, errors.webAuthMode],
    ['the legacy web OAuth mode', { CURRENT_STORE_WEB_OAUTH_MODE: 'legacy' }, errors.webOAuthMode],
    ['no web OAuth mode', { CURRENT_STORE_WEB_OAUTH_MODE: undefined }, errors.webOAuthMode],
    ['proof mode off', { CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE: 'off' }, errors.credentialProof],
    ['a short NEXTAUTH_SECRET', { NEXTAUTH_SECRET: 'short-nextauth-secret' }, errors.nextAuthSecret],
    ['no cookie secret', { AUTH_BROWSER_SESSION_COOKIE_SECRET: '' }, errors.cookieSecret],
    ['a 31-byte cookie secret', { AUTH_BROWSER_SESSION_COOKIE_SECRET: 'x'.repeat(31) }, errors.cookieSecret],
    [
      'a cookie secret padded with spaces',
      { AUTH_BROWSER_SESSION_COOKIE_SECRET: ` ${READY.AUTH_BROWSER_SESSION_COOKIE_SECRET}` },
      errors.cookieSecret,
    ],
    [
      'the cookie secret reused as NEXTAUTH_SECRET',
      { NEXTAUTH_SECRET: READY.AUTH_BROWSER_SESSION_COOKIE_SECRET },
      errors.secretReused,
    ],
    [
      'the cookie secret reused as the RPC secret',
      { CURRENT_STORE_AUTH_RPC_SECRET: READY.AUTH_BROWSER_SESSION_COOKIE_SECRET },
      errors.secretReused,
    ],
    [
      'the device and cookie keys match',
      { AUTH_DEVICE_TOKEN_SECRET: READY.AUTH_BROWSER_SESSION_COOKIE_SECRET },
      errors.secretReused,
    ],
    ['an insecure context in production', { NEXTAUTH_URL: 'http://www.boardsesh.com' }, errors.insecure],
    ['a cookie domain the codec refuses', { AUTH_COOKIE_DOMAIN: 'boardsesh.com; Path=/x' }, errors.cookieDomain],
  ])('answers unavailable with %s, logging only the code', (_case, overrides, code) => {
    stub(overrides);
    expect(resolveWithoutBlockers()).toEqual({ kind: 'unavailable', code });
    expect(logged).toHaveBeenCalledWith('browser session mode unavailable', { code });
    expect(JSON.stringify(logged.mock.calls)).not.toContain('secret-for-mode-tests');
  });

  it('allows plain names on local http outside production', () => {
    stub({
      NODE_ENV: 'development',
      NEXTAUTH_URL: 'http://localhost:3000',
      CURRENT_STORE_AUTH_BACKEND_ORIGIN: 'http://localhost:8080',
    });
    expect(resolveWithoutBlockers()).toMatchObject({
      kind: 'better-auth',
      cookies: { secure: false, domain: undefined },
    });
  });

  it('checks a configuration once and logs a refusal once', () => {
    stub({ AUTH_BROWSER_SESSION_COOKIE_SECRET: 'short' });
    resolveWithoutBlockers();
    resolveWithoutBlockers();
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it('keeps better-auth unavailable while www cutover work is listed, even with every precondition met', () => {
    stub();
    const listing = browserSessionRouteModeResolver(['B9_EXAMPLE_WORK']);
    const code = BROWSER_SESSION_WEB_PRECONDITION_ERRORS.cutoverIncomplete;
    expect(listing()).toEqual({ kind: 'unavailable', code });
    expect(logged).toHaveBeenCalledWith('browser session mode unavailable', { code, blockers: 'B9_EXAMPLE_WORK' });
    expect(browserSessionBootRefusal(listing)).toEqual(new Error(code));
  });

  it('lists nothing since #7880: better-auth serves once every precondition is met (#7596 Phase B)', () => {
    // B7 left with #7810 (five green acceptance runs in a row on one head). With #7880:
    // - B5B_WWW_PROVIDER_SIGN_IN: web-provider-session.integration.proof.ts (Google),
    //   web-apple-sign-in.integration.proof.ts (Apple: the cross-site form_post held with no session cookie,
    //   resumed on the same-site GET that presents and ends the old session, a carried login with its twin and
    //   marker, the Expo web return), provider-sign-in.spec.ts (both, Chromium and WebKit);
    // - B5E1_APPLE_LINK_PROOF: provider-security-apple-link.integration.proof.ts;
    // - B6_PARTNER_CONSENT: legacy-login-precedence.server.test.ts runs the shared vectors through
    //   legacyClaimsWin, and the partner pages hide an account the consent endpoint would not pick;
    // - B7C_COOKIE_ORDER_FIXTURE: cookie-order.spec.ts in Chromium and WebKit on every pull request run.
    stub();
    expect(BROWSER_SESSION_WEB_CUTOVER_BLOCKERS).toEqual([]);
    expect(Object.isFrozen(BROWSER_SESSION_WEB_CUTOVER_BLOCKERS)).toBe(true);
    expect(browserSessionRouteMode()).toMatchObject({ kind: 'better-auth' });
  });

  it('refuses a boot exactly when the mode is unavailable', () => {
    stub({ AUTH_BROWSER_SESSION_COOKIE_SECRET: 'short' });
    expect(browserSessionBootRefusal()).toEqual(new Error(BROWSER_SESSION_WEB_PRECONDITION_ERRORS.cookieSecret));
    stub();
    expect(browserSessionBootRefusal(resolveWithoutBlockers)).toBeUndefined();
    vi.stubEnv('AUTH_BROWSER_SESSION_MODE', 'legacy');
    expect(browserSessionBootRefusal()).toBeUndefined();
  });
});

// #7596 B7b: the browser acceptance run serves `better-auth` on `.test` hosts only.
describe('the e2e cutover seam', () => {
  const E2E = 'BOARDSESH_E2E_BROWSER_SESSION_CUTOVER';
  const TEST_HOST = { NEXTAUTH_URL: 'https://www.boardsesh.test', AUTH_COOKIE_DOMAIN: '.boardsesh.test' };
  const outside = { kind: 'unavailable', code: BROWSER_SESSION_WEB_PRECONDITION_ERRORS.e2eCutoverOutsideTest };

  // A fresh resolver per case: the production one caches its last configuration.
  const production = () => browserSessionRouteModeResolver(BROWSER_SESSION_WEB_CUTOVER_BLOCKERS)();
  // The seam's own rule, with work listed as it was before #7880 emptied the list.
  const listing = () => browserSessionRouteModeResolver(['B9_EXAMPLE_WORK'])();

  it('empties the www list for allow on a .test origin with a .test cookie domain', () => {
    expect(E2E_BROWSER_SESSION_CUTOVER_ENV).toBe(E2E);
    stub(TEST_HOST);
    vi.stubEnv(E2E, 'allow');
    expect(production()).toEqual({
      kind: 'better-auth',
      cookies: { secret: READY.AUTH_BROWSER_SESSION_COOKIE_SECRET, secure: true, domain: '.boardsesh.test' },
    });
    expect(browserSessionBootRefusal(production)).toBeUndefined();
  });

  it('empties it too with the VERCEL_ENV=development of the committed .env.local, which is no deployment', () => {
    stub({ ...TEST_HOST, VERCEL_ENV: 'development' });
    vi.stubEnv(E2E, 'allow');
    expect(production()).toMatchObject({ kind: 'better-auth' });
  });

  it('still checks every precondition under allow', () => {
    stub({ ...TEST_HOST, CURRENT_STORE_WEB_OAUTH_MODE: 'legacy' });
    vi.stubEnv(E2E, 'allow');
    expect(production()).toEqual({ kind: 'unavailable', code: BROWSER_SESSION_WEB_PRECONDITION_ERRORS.webOAuthMode });
  });

  it.each(['', 'yes', 'ALLOW'])('keeps the www list for %j on a .test origin', (requested) => {
    stub(TEST_HOST);
    vi.stubEnv(E2E, requested);
    expect(listing()).toEqual({
      kind: 'unavailable',
      code: BROWSER_SESSION_WEB_PRECONDITION_ERRORS.cutoverIncomplete,
    });
  });

  it('leaves a resolver with listed work as it was with the variable unset', () => {
    stub();
    expect(listing()).toEqual({
      kind: 'unavailable',
      code: BROWSER_SESSION_WEB_PRECONDITION_ERRORS.cutoverIncomplete,
    });
  });

  it.each([
    ['production www', { NEXTAUTH_URL: 'https://www.boardsesh.com' }],
    ['a .test origin with the production cookie domain', { ...TEST_HOST, AUTH_COOKIE_DOMAIN: '.boardsesh.com' }],
    ['a .test origin with a host-only cookie', { ...TEST_HOST, AUTH_COOKIE_DOMAIN: '' }],
    ['plain http on .test', { ...TEST_HOST, NEXTAUTH_URL: 'http://www.boardsesh.test' }],
    ['a look-alike host', { ...TEST_HOST, NEXTAUTH_URL: 'https://www.boardsesh.test.example.com' }],
    ['userinfo hiding a production host', { ...TEST_HOST, NEXTAUTH_URL: 'https://www.boardsesh.test@boardsesh.com' }],
    ['a trailing dot', { ...TEST_HOST, NEXTAUTH_URL: 'https://www.boardsesh.test.' }],
    ['a suffix without the dot', { ...TEST_HOST, NEXTAUTH_URL: 'https://evilboardsesh.test' }],
    ['a backslash path', { ...TEST_HOST, NEXTAUTH_URL: 'https://www.boardsesh.com\\.boardsesh.test' }],
    ['a look-alike cookie domain', { ...TEST_HOST, AUTH_COOKIE_DOMAIN: '.evilboardsesh.test' }],
    ['a .test origin on Railway', { ...TEST_HOST, RAILWAY_ENVIRONMENT_NAME: 'production' }],
    ['a .test origin on Vercel', { ...TEST_HOST, VERCEL: '1' }],
    ['a preview', { NEXTAUTH_URL: 'https://12.preview.boardsesh.com' }],
    ['no origin at all', { NEXTAUTH_URL: '' }],
  ])('fails the boot in every mode when set on %s', (_label, overrides) => {
    for (const mode of ['', 'legacy', 'better-auth']) {
      stub({ ...overrides, AUTH_BROWSER_SESSION_MODE: mode });
      vi.stubEnv(E2E, 'allow');
      expect(production()).toEqual(outside);
      expect(browserSessionBootRefusal(production)).toEqual(new Error(outside.code));
    }
    expect(JSON.stringify(logged.mock.calls)).not.toContain('allow');
  });
});
