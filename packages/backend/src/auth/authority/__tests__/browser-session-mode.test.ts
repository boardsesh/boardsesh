import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  assertBrowserSessionModeConfiguration,
  BROWSER_SESSION_CUTOVER_BLOCKERS,
  BROWSER_SESSION_STARTUP_ERRORS,
  BrowserSessionStartupError,
  browserSessionModeChecker,
  readBrowserSessionMode,
  type BrowserSessionStartupErrorCode,
} from '../browser-session-mode';

// #7596 B1b: `better-auth` needs real preconditions, each refused with its own
// code, and still refuses while later Phase B work is outstanding.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const secret = (label: string) => `${label}-synthetic-browser-session-secret-0123456789`;

/** Every precondition met. */
const READY: Readonly<Record<string, string>> = Object.freeze({
  AUTH_BROWSER_SESSION_MODE: 'better-auth',
  AUTH_CUTOFF_ENFORCEMENT: 'enforce',
  DEBUG_SQL: 'false',
  CURRENT_STORE_WEB_SESSION_MODE: 'backend-staging',
  CURRENT_STORE_WEB_AUTH_MODE: 'backend-staging',
  CURRENT_STORE_WEB_OAUTH_MODE: 'backend-staging',
  CURRENT_STORE_SET_PASSWORD_MODE: 'backend-staging',
  CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE: 'required',
  CURRENT_STORE_AUTH_RPC_SECRET: secret('rpc'),
  CURRENT_STORE_AUTH_PROJECTION_ID: 'browser-session-projection',
  CURRENT_STORE_AUTH_WRITER_EPOCH: '3',
  CURRENT_STORE_DELETED_EMAIL_KEY: secret('deleted-email'),
  NEXTAUTH_SECRET: secret('nextauth'),
  AUTH_BROWSER_SESSION_COOKIE_SECRET: secret('cookie'),
  AUTH_BROWSER_ACCESS_TOKEN_SECRET: secret('access-token'),
  CRON_SECRET: secret('cron'),
});

/** The preconditions alone: the cutover refusal left out, as only a test can build it. */
const preconditions = browserSessionModeChecker([]);

function refusal(check: () => void): BrowserSessionStartupErrorCode | undefined {
  try {
    check();
    return undefined;
  } catch (error) {
    if (error instanceof BrowserSessionStartupError) return error.code;
    throw error;
  }
}

const errors = BROWSER_SESSION_STARTUP_ERRORS;
const short = 'short-secret';
type Change = Record<string, string | undefined>;
const cases: ReadonlyArray<readonly [BrowserSessionStartupErrorCode, string, Change]> = [
  [errors.cutoffNotEnforced, 'enforcement is observe', { AUTH_CUTOFF_ENFORCEMENT: 'observe' }],
  [errors.sqlLogging, 'DEBUG_SQL is true', { DEBUG_SQL: 'true' }],
  [errors.webSessionMode, 'the web session mode is unset', { CURRENT_STORE_WEB_SESSION_MODE: undefined }],
  [errors.webAuthMode, 'the web auth mode is legacy', { CURRENT_STORE_WEB_AUTH_MODE: 'legacy' }],
  [errors.webOAuthMode, 'the web OAuth mode is unset', { CURRENT_STORE_WEB_OAUTH_MODE: undefined }],
  [errors.setPasswordMode, 'the set-password mode is legacy', { CURRENT_STORE_SET_PASSWORD_MODE: 'legacy' }],
  [errors.credentialProofRequired, 'proofs are compatible', { CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE: 'compatible' }],
  [errors.rpcSecret, 'the RPC secret is short', { CURRENT_STORE_AUTH_RPC_SECRET: short }],
  [errors.projectionId, 'the projection id is unset', { CURRENT_STORE_AUTH_PROJECTION_ID: undefined }],
  [errors.writerEpoch, 'the writer epoch is zero', { CURRENT_STORE_AUTH_WRITER_EPOCH: '0' }],
  [errors.deletedEmailKey, 'the deleted-email key is unset', { CURRENT_STORE_DELETED_EMAIL_KEY: undefined }],
  [errors.nextAuthSecret, 'NEXTAUTH_SECRET is short', { NEXTAUTH_SECRET: short }],
  [errors.cookieSecret, 'the cookie secret is unset', { AUTH_BROWSER_SESSION_COOKIE_SECRET: undefined }],
  [
    errors.accessTokenSecret,
    'the access-token secret is padded',
    { AUTH_BROWSER_ACCESS_TOKEN_SECRET: ` ${secret('a')}` },
  ],
  [
    errors.secretReused,
    'the cookie secret is NEXTAUTH_SECRET',
    { AUTH_BROWSER_SESSION_COOKIE_SECRET: READY.NEXTAUTH_SECRET },
  ],
  [
    errors.secretReused,
    'the access-token secret is CRON_SECRET',
    { AUTH_BROWSER_ACCESS_TOKEN_SECRET: READY.CRON_SECRET },
  ],
];

describe('readBrowserSessionMode', () => {
  it('reads AUTH_BROWSER_SESSION_MODE from the process environment by default', () => {
    vi.stubEnv('AUTH_BROWSER_SESSION_MODE', 'better-auth');
    expect(readBrowserSessionMode()).toBe('better-auth');
  });

  it.each([undefined, '', 'legacy'])('reads %j as legacy', (rawMode) => {
    expect(readBrowserSessionMode(rawMode)).toBe('legacy');
  });
});

describe('the better-auth startup preconditions', () => {
  it.each([{}, { AUTH_BROWSER_SESSION_MODE: '' }, { AUTH_BROWSER_SESSION_MODE: 'legacy' }])(
    'leave a legacy start with %j unchecked',
    (environment) => {
      expect(() => assertBrowserSessionModeConfiguration(environment)).not.toThrow();
      // Nothing else is read on legacy, even an environment that fails every check.
      expect(() =>
        assertBrowserSessionModeConfiguration({
          ...environment,
          AUTH_CUTOFF_ENFORCEMENT: 'observe',
          DEBUG_SQL: 'true',
        }),
      ).not.toThrow();
    },
  );

  it.each(['Legacy', 'better_auth', 'on', ' legacy'])('refuse the unknown value %j', (rawMode) => {
    expect(() => assertBrowserSessionModeConfiguration({ AUTH_BROWSER_SESSION_MODE: rawMode })).toThrow(
      'AUTH_BROWSER_SESSION_MODE_INVALID',
    );
  });

  it('pass with every precondition met', () => {
    expect(refusal(() => preconditions(READY))).toBeUndefined();
  });

  it.each(cases)('refuse with %s when %s', (code, _label, change) => {
    expect(refusal(() => preconditions({ ...READY, ...change }))).toBe(code);
  });

  it('have a case for every code but the cutover and provider-security ones', () => {
    const tested = new Set<string>(cases.map(([code]) => code));
    const ownDescribe = new Set<string>([errors.cutoverIncomplete, errors.providerSecurityNeedsBrowserSession]);
    expect(Object.values(errors).filter((code) => !ownDescribe.has(code) && !tested.has(code))).toEqual([]);
  });

  it('do not need the legacy bridge or the web sign-out writer', () => {
    const without: Change = { AUTH_LEGACY_BRIDGE_MODE: undefined, CURRENT_STORE_WEB_SIGNOUT_MODE: undefined };
    expect(refusal(() => preconditions({ ...READY, ...without }))).toBeUndefined();
  });
});

// #7596 B5c1: provider link and unlink act only for a canonical web session.
describe('provider security needs better-auth first', () => {
  it.each([{}, { AUTH_BROWSER_SESSION_MODE: 'legacy' }, { AUTH_BROWSER_SESSION_MODE: '' }])(
    'refuses provider security backend-staging with %j',
    (environment) => {
      expect(
        refusal(() =>
          assertBrowserSessionModeConfiguration({
            ...environment,
            CURRENT_STORE_PROVIDER_SECURITY_MODE: 'backend-staging',
          }),
        ),
      ).toBe(errors.providerSecurityNeedsBrowserSession);
    },
  );

  it('passes provider security backend-staging under better-auth, which then meets its own checks', () => {
    expect(
      refusal(() => preconditions({ ...READY, CURRENT_STORE_PROVIDER_SECURITY_MODE: 'backend-staging' })),
    ).toBeUndefined();
  });

  it.each([undefined, '', 'legacy'])('leaves provider security %j alone on a legacy start', (mode) => {
    expect(() => assertBrowserSessionModeConfiguration({ CURRENT_STORE_PROVIDER_SECURITY_MODE: mode })).not.toThrow();
  });
});

describe('the cutover refusal', () => {
  it('still refuses better-auth with every precondition met, naming what has not landed', () => {
    expect(BROWSER_SESSION_CUTOVER_BLOCKERS.length).toBeGreaterThan(0);
    expect(Object.isFrozen(BROWSER_SESSION_CUTOVER_BLOCKERS)).toBe(true);
    expect(refusal(() => assertBrowserSessionModeConfiguration(READY))).toBe(errors.cutoverIncomplete);
    expect(() => assertBrowserSessionModeConfiguration(READY)).toThrow(BROWSER_SESSION_CUTOVER_BLOCKERS[0]);
  });

  it('cannot be turned off from the environment', () => {
    for (const name of ['BROWSER_SESSION_CUTOVER_BLOCKERS', 'AUTH_BROWSER_SESSION_CUTOVER', 'NODE_ENV'])
      for (const content of ['', 'off', 'test', '[]'])
        expect(refusal(() => assertBrowserSessionModeConfiguration({ ...READY, [name]: content }))).toBe(
          errors.cutoverIncomplete,
        );
  });
});

describe('backend startup', () => {
  it.each([
    ['an unknown value', { AUTH_BROWSER_SESSION_MODE: 'better_auth' }, 'AUTH_BROWSER_SESSION_MODE_INVALID'],
    ['better-auth missing a precondition', { ...READY, CURRENT_STORE_WEB_SESSION_MODE: '' }, errors.webSessionMode],
    ['better-auth with every precondition met', READY, errors.cutoverIncomplete],
    [
      'provider security staged without better-auth',
      { CURRENT_STORE_PROVIDER_SECURITY_MODE: 'backend-staging' },
      errors.providerSecurityNeedsBrowserSession,
    ],
  ])('refuses %s before any external initialization', async (_label, environment, refusalCode) => {
    for (const [name, content] of Object.entries(environment)) vi.stubEnv(name, content);
    // The database client is built on import but never connects here.
    vi.stubEnv('DATABASE_URL', 'postgresql://unused:unused@127.0.0.1:1/unused');
    const { pubsub } = await import('../../../pubsub/index');
    const initialize = vi.spyOn(pubsub, 'initialize').mockRejectedValue(new Error('UNEXPECTED_STARTUP_IO'));
    const { startServer } = await import('../../../server');
    await expect(startServer()).rejects.toThrow(refusalCode);
    expect(initialize).not.toHaveBeenCalled();
  });
});
