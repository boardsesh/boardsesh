// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { webLogger } from '@/app/lib/observability/logger';
import {
  BROWSER_SESSION_WEB_CUTOVER_BLOCKERS,
  BROWSER_SESSION_WEB_PRECONDITION_ERRORS,
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

function stub(overrides: Partial<Record<keyof typeof READY, string>> = {}) {
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
    expect(BROWSER_SESSION_WEB_CUTOVER_BLOCKERS.length).toBeGreaterThan(0);
    expect(Object.isFrozen(BROWSER_SESSION_WEB_CUTOVER_BLOCKERS)).toBe(true);
    const code = BROWSER_SESSION_WEB_PRECONDITION_ERRORS.cutoverIncomplete;
    expect(browserSessionRouteMode()).toEqual({ kind: 'unavailable', code });
    expect(logged).toHaveBeenCalledWith('browser session mode unavailable', {
      code,
      blockers: BROWSER_SESSION_WEB_CUTOVER_BLOCKERS.join(', '),
    });
  });

  it('refuses a boot exactly when the mode is unavailable', () => {
    stub();
    expect(browserSessionBootRefusal()).toEqual(new Error(BROWSER_SESSION_WEB_PRECONDITION_ERRORS.cutoverIncomplete));
    expect(browserSessionBootRefusal(resolveWithoutBlockers)).toBeUndefined();
    vi.stubEnv('AUTH_BROWSER_SESSION_MODE', 'legacy');
    expect(browserSessionBootRefusal()).toBeUndefined();
  });
});
