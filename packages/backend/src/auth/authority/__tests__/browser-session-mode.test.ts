import { AUTHORITY_ACTIVATION_BLOCKERS } from '../activation-gates';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  assertBrowserSessionModeConfiguration,
  BROWSER_SESSION_CUTOVER_BLOCKERS,
  BROWSER_SESSION_STARTUP_ERRORS,
  BrowserSessionStartupError,
  browserSessionModeChecker,
  bridgeTokenKeyFromEnvironment,
  cutoverBlockersInEffect,
  E2E_BROWSER_SESSION_CUTOVER_ENV,
  browserAccessTokenKeyFromEnvironment,
  readBrowserSessionMode,
  type BrowserSessionStartupErrorCode,
} from '../browser-session-mode';
import { bridgedSessionToken, bridgeTokenKey } from '../session-token';

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
  AUTH_BRIDGE_TOKEN_SECRET: secret('bridge-token'),
  CRON_SECRET: secret('cron'),
  // Cutover plus 30 days, as the runbook sets it.
  AUTH_LEGACY_BRIDGE_UNTIL: new Date(Date.now() + 30 * 86_400_000).toISOString(),
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
    'the device and bridge keys match',
    { AUTH_DEVICE_TOKEN_SECRET: READY.AUTH_BRIDGE_TOKEN_SECRET },
  ],
  [
    errors.secretReused,
    'the guess and access keys match',
    { AUTH_ACCOUNT_GUESS_LIMIT_EMAIL_KEY: READY.AUTH_BROWSER_ACCESS_TOKEN_SECRET },
  ],
  [errors.bridgeTokenSecret, 'the bridge token secret is unset', { AUTH_BRIDGE_TOKEN_SECRET: undefined }],
  [errors.legacyBridgeUntil, 'the bridge end date is unset', { AUTH_LEGACY_BRIDGE_UNTIL: undefined }],
  [errors.legacyBridgeUntil, 'the bridge end date is not a time', { AUTH_LEGACY_BRIDGE_UNTIL: 'next month' }],
  [
    errors.legacyBridgeUntil,
    'the bridge end date is 30 February',
    { AUTH_LEGACY_BRIDGE_UNTIL: '2026-02-30T00:00:00Z' },
  ],
  [errors.legacyBridgeUntil, 'the bridge end date is T24:00', { AUTH_LEGACY_BRIDGE_UNTIL: '2026-12-01T24:00:00Z' }],
  [
    errors.legacyBridgeUntil,
    'the bridge end date has no offset',
    { AUTH_LEGACY_BRIDGE_UNTIL: new Date(Date.now() + 86_400_000).toISOString().replace('Z', '') },
  ],
  [
    errors.legacyBridgeUntil,
    'the bridge end date is more than 45 days away',
    { AUTH_LEGACY_BRIDGE_UNTIL: new Date(Date.now() + 46 * 86_400_000).toISOString() },
  ],
  [
    errors.secretReused,
    'the bridge token secret is the access-token secret',
    { AUTH_BRIDGE_TOKEN_SECRET: READY.AUTH_BROWSER_ACCESS_TOKEN_SECRET },
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

  it('never wait on the authority activation gates, so a test-built checker boots with them open', () => {
    expect(AUTHORITY_ACTIVATION_BLOCKERS).toContain('HISTORICAL_WEB_ISSUER_RETIREMENT');
    expect(refusal(() => preconditions(READY))).toBeUndefined();
  });

  it('pass with a bridge end date already behind them: bridging is over, the rest of the session runs', () => {
    const ended = { ...READY, AUTH_LEGACY_BRIDGE_UNTIL: new Date(Date.now() - 86_400_000).toISOString() };
    expect(refusal(() => preconditions(ended))).toBeUndefined();
  });

  it.each(cases)('refuse with %s when %s', (code, _label, change) => {
    expect(refusal(() => preconditions({ ...READY, ...change }))).toBe(code);
  });

  it('have a case for every code but the cutover and provider-security ones', () => {
    const tested = new Set<string>(cases.map(([code]) => code));
    const ownDescribe = new Set<string>([
      errors.cutoverIncomplete,
      errors.e2eCutoverOutsideTest,
      errors.providerSecurityNeedsBrowserSession,
      errors.firstPasswordNeedsBrowserSession,
    ]);
    expect(Object.values(errors).filter((code) => !ownDescribe.has(code) && !tested.has(code))).toEqual([]);
  });

  it('do not need the legacy bridge or the web sign-out writer', () => {
    const without: Change = { AUTH_LEGACY_BRIDGE_MODE: undefined, CURRENT_STORE_WEB_SIGNOUT_MODE: undefined };
    expect(refusal(() => preconditions({ ...READY, ...without }))).toBeUndefined();
  });
});

describe('the bridge key', () => {
  it('is derived from AUTH_BRIDGE_TOKEN_SECRET alone, whatever the browser session mode', () => {
    const fromEnvironment = bridgeTokenKeyFromEnvironment({ ...READY, AUTH_BROWSER_SESSION_MODE: undefined });
    const expected = bridgeTokenKey(READY.AUTH_BRIDGE_TOKEN_SECRET);
    expect(bridgedSessionToken(fromEnvironment, 's').token).toBe(bridgedSessionToken(expected, 's').token);
  });

  it.each([
    ['unset', undefined],
    ['short', short],
    ['padded', ` ${secret('bridge')}`],
    ['NEXTAUTH_SECRET', READY.NEXTAUTH_SECRET],
    ['the cookie secret', READY.AUTH_BROWSER_SESSION_COOKIE_SECRET],
    ['the RPC secret', READY.CURRENT_STORE_AUTH_RPC_SECRET],
  ])('refuses a secret that is %s, without its value in the message', (_label, value) => {
    expect(() => bridgeTokenKeyFromEnvironment({ ...READY, AUTH_BRIDGE_TOKEN_SECRET: value })).toThrow(
      'Invalid AUTH_BRIDGE_TOKEN_SECRET',
    );
  });
});

describe('the browser access token key', () => {
  it.each([
    ['unset', undefined],
    ['short', short],
    ['the bridge secret', READY.AUTH_BRIDGE_TOKEN_SECRET],
    ['NEXTAUTH_SECRET', READY.NEXTAUTH_SECRET],
  ])('refuses a secret that is %s, without its value in the message', (_label, value) => {
    expect(() => browserAccessTokenKeyFromEnvironment({ ...READY, AUTH_BROWSER_ACCESS_TOKEN_SECRET: value })).toThrow(
      'Invalid AUTH_BROWSER_ACCESS_TOKEN_SECRET',
    );
  });

  it('reads a valid one whatever the browser session mode', () => {
    expect(browserAccessTokenKeyFromEnvironment({ ...READY, AUTH_BROWSER_SESSION_MODE: undefined }).kind).toBe(
      'browser-access-token-key',
    );
  });
});

// #7596 B5c2: first password acts only for a canonical web session too.
describe('first password needs better-auth first', () => {
  it.each([{}, { AUTH_BROWSER_SESSION_MODE: 'legacy' }])(
    'refuses first password backend-staging with %j',
    (environment) => {
      expect(
        refusal(() =>
          assertBrowserSessionModeConfiguration({
            ...environment,
            CURRENT_STORE_FIRST_PASSWORD_MODE: 'backend-staging',
          }),
        ),
      ).toBe(errors.firstPasswordNeedsBrowserSession);
    },
  );

  it('passes first password backend-staging under better-auth, which then meets its own checks', () => {
    expect(
      refusal(() => preconditions({ ...READY, CURRENT_STORE_FIRST_PASSWORD_MODE: 'backend-staging' })),
    ).toBeUndefined();
  });

  it.each([undefined, '', 'legacy'])('leaves first password %j alone on a legacy start', (mode) => {
    expect(() => assertBrowserSessionModeConfiguration({ CURRENT_STORE_FIRST_PASSWORD_MODE: mode })).not.toThrow();
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
  /** The startup check as it ran while Phase B work was listed. */
  const listing = browserSessionModeChecker(['B9_EXAMPLE_WORK']);

  it('refuses better-auth with every precondition met while work is listed, naming it', () => {
    expect(refusal(() => listing(READY))).toBe(errors.cutoverIncomplete);
    expect(() => listing(READY)).toThrow('B9_EXAMPLE_WORK');
  });

  it('lists nothing since #7880: better-auth starts once every precondition is met (#7596 Phase B)', () => {
    // B7 left with #7810 (five green acceptance runs in a row on one head). With #7880:
    // - B3_BROWSER_ACCESS_TOKEN: browser-access-token-burst.test.ts (a burst shares a few coalesced reads,
    //   B3a review H1), ws-auth-access-token.integration.proof.ts and use-ws-auth-token.test.ts (www),
    //   auth-browser-access-token.web.test.ts (Expo web), acceptance-2-account-switch.spec.ts;
    // - B5_PROVIDER_SIGN_IN: web-oauth-session.test.ts, web-provider-session.integration.proof.ts (Google),
    //   web-apple-sign-in.integration.proof.ts (Apple), provider-sign-in.spec.ts (both engines);
    // - B6_PARTNER_CONSENT: www runs the shared precedence function and its vectors
    //   (legacy-login-precedence.server.test.ts), as this backend's consent reader does;
    // - B7C_COOKIE_ORDER_FIXTURE: cookie-order.spec.ts in Chromium and WebKit on every pull request run.
    expect(BROWSER_SESSION_CUTOVER_BLOCKERS).toEqual([]);
    expect(Object.isFrozen(BROWSER_SESSION_CUTOVER_BLOCKERS)).toBe(true);
    expect(refusal(() => assertBrowserSessionModeConfiguration(READY))).toBeUndefined();
  });

  it('cannot be turned off from the environment while work is listed', () => {
    for (const name of ['BROWSER_SESSION_CUTOVER_BLOCKERS', 'AUTH_BROWSER_SESSION_CUTOVER', 'NODE_ENV'])
      for (const content of ['', 'off', 'test', '[]'])
        expect(refusal(() => listing({ ...READY, [name]: content }))).toBe(errors.cutoverIncomplete);
  });
});

// #7596 B7b: the browser acceptance run boots `better-auth` on `.test` hosts only.
describe('the e2e cutover seam', () => {
  const E2E = 'BOARDSESH_E2E_BROWSER_SESSION_CUTOVER';
  const TEST_ORIGINS = { BACKEND_PUBLIC_URL: 'https://ws.boardsesh.test', BOARDSESH_URL: 'https://www.boardsesh.test' };

  it('empties the list for allow when both origins are https hosts under boardsesh.test', () => {
    expect(E2E_BROWSER_SESSION_CUTOVER_ENV).toBe(E2E);
    expect(cutoverBlockersInEffect(['B7'], { ...TEST_ORIGINS, [E2E]: 'allow' })).toEqual([]);
    expect(refusal(() => assertBrowserSessionModeConfiguration({ ...READY, ...TEST_ORIGINS, [E2E]: 'allow' }))).toBe(
      undefined,
    );
  });

  it('still checks every precondition under allow', () => {
    const missing = { ...READY, ...TEST_ORIGINS, [E2E]: 'allow', CURRENT_STORE_WEB_SESSION_MODE: undefined };
    expect(refusal(() => assertBrowserSessionModeConfiguration(missing))).toBe(errors.webSessionMode);
  });

  it.each([undefined, ''])('leaves startup as it was when the variable is %j', (requested) => {
    const environment = { ...READY, BACKEND_PUBLIC_URL: 'https://ws.boardsesh.com', [E2E]: requested };
    expect(refusal(() => browserSessionModeChecker(['B7'])(environment))).toBe(errors.cutoverIncomplete);
    expect(() => assertBrowserSessionModeConfiguration({ [E2E]: requested })).not.toThrow();
  });

  it.each(['yes', 'ALLOW', 'allow '])('keeps the list for %j on a .test origin', (requested) => {
    expect(cutoverBlockersInEffect(['B7'], { ...TEST_ORIGINS, [E2E]: requested })).toEqual(['B7']);
    expect(refusal(() => browserSessionModeChecker(['B7'])({ ...READY, ...TEST_ORIGINS, [E2E]: requested }))).toBe(
      errors.cutoverIncomplete,
    );
  });

  it.each([
    ['production', { BACKEND_PUBLIC_URL: 'https://ws.boardsesh.com', BOARDSESH_URL: 'https://www.boardsesh.com' }],
    ['the backend default origin', { BOARDSESH_URL: 'https://www.boardsesh.test' }],
    ['a production backend', { ...TEST_ORIGINS, BACKEND_PUBLIC_URL: 'https://ws.boardsesh.com' }],
    ['a production www', { ...TEST_ORIGINS, BOARDSESH_URL: 'https://boardsesh.com' }],
    ['plain http', { ...TEST_ORIGINS, BACKEND_PUBLIC_URL: 'http://ws.boardsesh.test' }],
    ['a look-alike host', { ...TEST_ORIGINS, BOARDSESH_URL: 'https://www.boardsesh.test.example.com' }],
    ['the bare parent', { ...TEST_ORIGINS, BOARDSESH_URL: 'https://boardsesh.test' }],
    [
      'userinfo hiding a production host',
      { ...TEST_ORIGINS, BOARDSESH_URL: 'https://www.boardsesh.test@boardsesh.com' },
    ],
    ['a trailing dot', { ...TEST_ORIGINS, BACKEND_PUBLIC_URL: 'https://ws.boardsesh.test.' }],
    ['a suffix without the dot', { ...TEST_ORIGINS, BOARDSESH_URL: 'https://evilboardsesh.test' }],
    ['a backslash path', { ...TEST_ORIGINS, BACKEND_PUBLIC_URL: 'https://ws.boardsesh.com\\.boardsesh.test' }],
    ['a wss origin', { ...TEST_ORIGINS, BACKEND_PUBLIC_URL: 'wss://ws.boardsesh.test' }],
    ['a .test origin on Railway', { ...TEST_ORIGINS, RAILWAY_ENVIRONMENT_NAME: 'production' }],
    ['a .test origin on Vercel', { ...TEST_ORIGINS, VERCEL: '1' }],
    [
      'a preview',
      { BACKEND_PUBLIC_URL: 'https://12.ws.preview.boardsesh.com', BOARDSESH_URL: 'https://12.preview.boardsesh.com' },
    ],
  ])('refuses to start in every mode when set on %s', (_label, origins) => {
    for (const mode of [undefined, 'legacy', 'better-auth'])
      for (const requested of ['allow', 'off'])
        expect(
          refusal(() =>
            assertBrowserSessionModeConfiguration({
              ...READY,
              ...origins,
              AUTH_BROWSER_SESSION_MODE: mode,
              [E2E]: requested,
            }),
          ),
        ).toBe(errors.e2eCutoverOutsideTest);
  });

  it('never repeats the value in its error', () => {
    const environment = { ...READY, [E2E]: 'allow-secret-looking-value' };
    expect(() => assertBrowserSessionModeConfiguration(environment)).toThrow(
      new BrowserSessionStartupError(errors.e2eCutoverOutsideTest),
    );
  });
});

describe('backend startup', () => {
  it.each([
    ['an unknown value', { AUTH_BROWSER_SESSION_MODE: 'better_auth' }, 'AUTH_BROWSER_SESSION_MODE_INVALID'],
    ['better-auth missing a precondition', { ...READY, CURRENT_STORE_WEB_SESSION_MODE: '' }, errors.webSessionMode],
    [
      'provider security staged without better-auth',
      { CURRENT_STORE_PROVIDER_SECURITY_MODE: 'backend-staging' },
      errors.providerSecurityNeedsBrowserSession,
    ],
    [
      'first password staged without better-auth',
      { CURRENT_STORE_FIRST_PASSWORD_MODE: 'backend-staging' },
      errors.firstPasswordNeedsBrowserSession,
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
