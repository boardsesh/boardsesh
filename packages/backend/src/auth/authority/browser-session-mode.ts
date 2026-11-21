import {
  BROWSER_SESSION_MODE_ENV,
  parseBrowserSessionMode,
  type BrowserSessionMode,
} from '@boardsesh/auth-protocol/browser-session-mode';
import {
  AUTH_COMMAND_ENV,
  BATCH_SYSTEM_USER_COMMAND_ENV,
  LOCATION_SYNC_COMMAND_ENV,
  SET_PASSWORD_MODE_ENV,
  WEB_CREDENTIAL_PROOF_ENV,
  WEB_SESSION_MODE_ENV,
} from '@boardsesh/auth-protocol';
import { AUTH_CUTOFF_ENFORCEMENT_ENV, parseCutoffEnforcement } from '../credential-cutoffs';
import {
  currentStoreDeletedEmailKey,
  currentStoreRpcSecret,
  DELETED_EMAIL_KEY_ENV,
  isValidAuthorityProjectionId,
  isValidAuthorityWriterEpoch,
} from '../current-store/authority-configuration';
import { bridgeTokenKey, type BridgeTokenKey } from './session-token';
import { browserAccessTokenKey, type BrowserAccessTokenKey } from './browser-access-token';

export { BROWSER_SESSION_MODES, type BrowserSessionMode } from '@boardsesh/auth-protocol/browser-session-mode';

type Environment = Readonly<Record<string, string | undefined>>;

/** Unset or empty is `legacy`. Any other unknown value throws. */
export function readBrowserSessionMode(
  rawMode: string | undefined = process.env[BROWSER_SESSION_MODE_ENV],
): BrowserSessionMode {
  return parseBrowserSessionMode(rawMode);
}

export const BROWSER_SESSION_COOKIE_SECRET_ENV = 'AUTH_BROWSER_SESSION_COOKIE_SECRET';
export const BROWSER_ACCESS_TOKEN_SECRET_ENV = 'AUTH_BROWSER_ACCESS_TOKEN_SECRET';
/**
 * Backend only. The bridge key (`bridgeTokenKey`) is derived from it, and the
 * key with a session id mints that bridged session's token, so neither www nor
 * the database may hold it. Its own secret, not a derivation of another one:
 * `NEXTAUTH_SECRET` and the cookie secret are on www too, and the access-token
 * secret verifies short tokens and should stay free to rotate.
 */
export const BRIDGE_TOKEN_SECRET_ENV = 'AUTH_BRIDGE_TOKEN_SECRET';
const PROVIDER_SECURITY_MODE_ENV = 'CURRENT_STORE_PROVIDER_SECURITY_MODE';
const FIRST_PASSWORD_MODE_ENV = 'CURRENT_STORE_FIRST_PASSWORD_MODE';

/**
 * The end of the web bridge (#7596 B2c): an exact ISO 8601 time with `Z` or an
 * explicit offset. From that instant `/web-session/v1/bridge` answers `denied`
 * and writes nothing, so www treats a browser holding only a legacy cookie as
 * signed out. Unset or invalid, `/bridge` answers 503 in every mode, so no
 * combination of switches runs an open-ended bridge; under `better-auth` the
 * backend also refuses to start unless it is set at most 45 days ahead. The
 * owner sets it to cutover plus 30 days and may move it once, after a rollback.
 */
export const LEGACY_BRIDGE_UNTIL_ENV = 'AUTH_LEGACY_BRIDGE_UNTIL';
export const LEGACY_BRIDGE_UNTIL_MAX_DAYS = 45;
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * The instant, or undefined for a value that is not an exact time: every field
 * in range, the day real for its month (no `2027-02-30`), no `T24:00`, and an
 * offset or `Z`. A lenient parser would roll those over silently.
 */
function exactInstant(raw: string): Date | undefined {
  const match = ISO_INSTANT.exec(raw);
  if (!match) return undefined;
  const [, , , , , , , sign, offsetHoursText, offsetMinutesText] = match;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map((field) => Number(field ?? '0'));
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return undefined;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return undefined;
  if (sign && (Number(offsetHoursText) > 23 || Number(offsetMinutesText) > 59)) return undefined;
  const instant = new Date(raw);
  return Number.isNaN(instant.getTime()) ? undefined : instant;
}

/** The configured end of the bridge, undefined when unset. Throws on a value that is not an exact instant. */
export function legacyBridgeUntil(environment: Environment = process.env): Date | undefined {
  const raw = environment[LEGACY_BRIDGE_UNTIL_ENV];
  if (raw === undefined || raw === '') return undefined;
  const until = exactInstant(raw);
  if (!until) throw new Error(`Invalid ${LEGACY_BRIDGE_UNTIL_ENV}`);
  return until;
}

/**
 * Phase B work (#7596) that must land before a browser can be served a
 * backend session end to end. While any entry remains, `better-auth` refuses
 * to start even with every precondition met. Each Phase B PR deleted its own
 * entry; #7880 emptied the list (the evidence per entry is in
 * docs/auth/better-auth-browser-session.md, "Status"). Like
 * `AUTHORITY_ACTIVATION_BLOCKERS`, no environment variable or flag changes it.
 */
export const BROWSER_SESSION_CUTOVER_BLOCKERS: readonly string[] = Object.freeze([]);

/** One stable code per refusal, so a failed deploy names exactly what is missing. */
export const BROWSER_SESSION_STARTUP_ERRORS = Object.freeze({
  cutoffNotEnforced: 'AUTH_BROWSER_SESSION_CUTOFF_NOT_ENFORCED',
  sqlLogging: 'AUTH_BROWSER_SESSION_SQL_LOGGING',
  webSessionMode: 'AUTH_BROWSER_SESSION_WEB_SESSION_MODE_REQUIRED',
  webAuthMode: 'AUTH_BROWSER_SESSION_WEB_AUTH_MODE_REQUIRED',
  webOAuthMode: 'AUTH_BROWSER_SESSION_WEB_OAUTH_MODE_REQUIRED',
  setPasswordMode: 'AUTH_BROWSER_SESSION_SET_PASSWORD_MODE_REQUIRED',
  credentialProofRequired: 'AUTH_BROWSER_SESSION_CREDENTIAL_PROOF_REQUIRED',
  rpcSecret: 'AUTH_BROWSER_SESSION_RPC_SECRET_INVALID',
  projectionId: 'AUTH_BROWSER_SESSION_PROJECTION_ID_INVALID',
  writerEpoch: 'AUTH_BROWSER_SESSION_WRITER_EPOCH_INVALID',
  deletedEmailKey: 'AUTH_BROWSER_SESSION_DELETED_EMAIL_KEY_INVALID',
  nextAuthSecret: 'AUTH_BROWSER_SESSION_NEXTAUTH_SECRET_INVALID',
  cookieSecret: 'AUTH_BROWSER_SESSION_COOKIE_SECRET_INVALID',
  accessTokenSecret: 'AUTH_BROWSER_SESSION_ACCESS_TOKEN_SECRET_INVALID',
  bridgeTokenSecret: 'AUTH_BROWSER_SESSION_BRIDGE_TOKEN_SECRET_INVALID',
  legacyBridgeUntil: 'AUTH_BROWSER_SESSION_LEGACY_BRIDGE_UNTIL_INVALID',
  secretReused: 'AUTH_BROWSER_SESSION_SECRET_REUSED',
  cutoverIncomplete: 'AUTH_BROWSER_SESSION_CUTOVER_INCOMPLETE',
  e2eCutoverOutsideTest: 'AUTH_BROWSER_SESSION_E2E_CUTOVER_OUTSIDE_TEST',
  providerSecurityNeedsBrowserSession: 'AUTH_PROVIDER_SECURITY_BROWSER_SESSION_REQUIRED',
  firstPasswordNeedsBrowserSession: 'AUTH_FIRST_PASSWORD_BROWSER_SESSION_REQUIRED',
} as const);

export type BrowserSessionStartupErrorCode =
  (typeof BROWSER_SESSION_STARTUP_ERRORS)[keyof typeof BROWSER_SESSION_STARTUP_ERRORS];

/** The message starts with the code. It never holds a secret's value. */
export class BrowserSessionStartupError extends Error {
  readonly code: BrowserSessionStartupErrorCode;

  constructor(code: BrowserSessionStartupErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'BrowserSessionStartupError';
    this.code = code;
  }
}

/** The secrets the browser session adds or depends on, each with its own refusal. */
const BROWSER_SESSION_SECRETS = [
  ['NEXTAUTH_SECRET', BROWSER_SESSION_STARTUP_ERRORS.nextAuthSecret],
  [BROWSER_SESSION_COOKIE_SECRET_ENV, BROWSER_SESSION_STARTUP_ERRORS.cookieSecret],
  [BROWSER_ACCESS_TOKEN_SECRET_ENV, BROWSER_SESSION_STARTUP_ERRORS.accessTokenSecret],
  [BRIDGE_TOKEN_SECRET_ENV, BROWSER_SESSION_STARTUP_ERRORS.bridgeTokenSecret],
] as const;

/** The other auth secrets none of those four may equal. */
const OTHER_AUTH_SECRET_ENV = [
  AUTH_COMMAND_ENV.secret,
  DELETED_EMAIL_KEY_ENV,
  'CRON_SECRET',
  BATCH_SYSTEM_USER_COMMAND_ENV.secret,
  LOCATION_SYNC_COMMAND_ENV.secret,
  'AUTH_ACCOUNT_GUESS_LIMIT_EMAIL_KEY',
  'AUTH_DEVICE_TOKEN_SECRET',
] as const;

function refuseUnless(condition: boolean, code: BrowserSessionStartupErrorCode): void {
  if (!condition) throw new BrowserSessionStartupError(code);
}

/** Runs a configuration reader that throws on a bad value, and names the refusal instead. */
function refuseIfThrows(read: () => unknown, code: BrowserSessionStartupErrorCode): void {
  try {
    read();
  } catch {
    throw new BrowserSessionStartupError(code);
  }
}

/** At least 32 bytes, no surrounding spaces. */
function isStrongSecret(secret: string | undefined): boolean {
  return secret !== undefined && secret === secret.trim() && Buffer.byteLength(secret, 'utf8') >= 32;
}

function cutoffEnforced(environment: Environment): boolean {
  try {
    return parseCutoffEnforcement(environment[AUTH_CUTOFF_ENFORCEMENT_ENV]) === 'enforce';
  } catch {
    return false;
  }
}

function assertBetterAuthPreconditions(environment: Environment): void {
  const errors = BROWSER_SESSION_STARTUP_ERRORS;
  refuseUnless(cutoffEnforced(environment), errors.cutoffNotEnforced);
  refuseUnless(environment.DEBUG_SQL !== 'true', errors.sqlLogging);
  // Each is required by its own value; `better-auth` implies none of them.
  refuseUnless(environment[WEB_SESSION_MODE_ENV] === 'backend-staging', errors.webSessionMode);
  refuseUnless(environment[AUTH_COMMAND_ENV.mode] === 'backend-staging', errors.webAuthMode);
  refuseUnless(environment.CURRENT_STORE_WEB_OAUTH_MODE === 'backend-staging', errors.webOAuthMode);
  refuseUnless(environment[SET_PASSWORD_MODE_ENV] === 'backend-staging', errors.setPasswordMode);
  refuseUnless(environment[WEB_CREDENTIAL_PROOF_ENV] === 'required', errors.credentialProofRequired);
  refuseIfThrows(() => currentStoreRpcSecret(environment), errors.rpcSecret);
  refuseUnless(isValidAuthorityProjectionId(environment.CURRENT_STORE_AUTH_PROJECTION_ID), errors.projectionId);
  refuseUnless(isValidAuthorityWriterEpoch(environment.CURRENT_STORE_AUTH_WRITER_EPOCH), errors.writerEpoch);
  refuseIfThrows(() => currentStoreDeletedEmailKey(environment), errors.deletedEmailKey);
  for (const [name, code] of BROWSER_SESSION_SECRETS) refuseUnless(isStrongSecret(environment[name]), code);
  const browserSecrets = BROWSER_SESSION_SECRETS.map(([name]) => environment[name]);
  const otherSecrets = OTHER_AUTH_SECRET_ENV.map((name) => environment[name]).filter(Boolean);
  refuseUnless(
    new Set(browserSecrets).size === browserSecrets.length &&
      !browserSecrets.some((secret) => otherSecrets.includes(secret)),
    errors.secretReused,
  );
  // Set, and at most 45 days ahead: production never runs an open-ended bridge.
  let until: Date | undefined;
  try {
    until = legacyBridgeUntil(environment);
  } catch {
    until = undefined;
  }
  refuseUnless(
    until !== undefined && until.getTime() - Date.now() <= LEGACY_BRIDGE_UNTIL_MAX_DAYS * 86_400_000,
    errors.legacyBridgeUntil,
  );
}

/**
 * The bridge key for the web bridge command, read per request like the other
 * command configuration. Throws (the command answers 503) unless
 * `AUTH_BRIDGE_TOKEN_SECRET` is at least 32 bytes with no surrounding spaces
 * and equals none of the other auth secrets, so a deployment with only
 * `CURRENT_STORE_WEB_SESSION_MODE` on cannot bridge under a reused secret
 * either. The error never carries the value.
 */
export function bridgeTokenKeyFromEnvironment(environment: Environment = process.env): BridgeTokenKey {
  return bridgeTokenKey(distinctSecret(environment, BRIDGE_TOKEN_SECRET_ENV));
}

/**
 * The browser access token key, read per request like the bridge key. Throws
 * (the caller answers unavailable) unless `AUTH_BROWSER_ACCESS_TOKEN_SECRET`
 * is strong and equals none of the other auth secrets.
 */
export function browserAccessTokenKeyFromEnvironment(environment: Environment = process.env): BrowserAccessTokenKey {
  const secret = distinctSecret(environment, BROWSER_ACCESS_TOKEN_SECRET_ENV);
  // Every browser request needs the key; derive it once per secret value.
  if (derivedAccessTokenKey?.secret !== secret) derivedAccessTokenKey = { secret, key: browserAccessTokenKey(secret) };
  return derivedAccessTokenKey.key;
}

let derivedAccessTokenKey: { readonly secret: string; readonly key: BrowserAccessTokenKey } | undefined;

/**
 * The secret that signs the first-party session cookies, for a backend reader
 * of them (partner consent, B6). Throws unless strong and different from every
 * other auth secret; the message names the variable only.
 */
export function browserSessionCookieSecretFromEnvironment(environment: Environment = process.env): string {
  return distinctSecret(environment, BROWSER_SESSION_COOKIE_SECRET_ENV);
}

/** The named secret, refused unless strong and different from every other auth secret. Never in the message. */
function distinctSecret(environment: Environment, name: string): string {
  const secret = environment[name];
  const others = [...BROWSER_SESSION_SECRETS.map(([secretName]) => secretName), ...OTHER_AUTH_SECRET_ENV]
    .filter((secretName) => secretName !== name)
    .map((secretName) => environment[secretName]);
  if (!isStrongSecret(secret) || secret === undefined || others.includes(secret)) throw new Error(`Invalid ${name}`);
  return secret;
}

/**
 * The browser acceptance run's one switch (#7596 B7b). Read only by
 * `cutoverBlockersInEffect`; never set it outside that run.
 */
export const E2E_BROWSER_SESSION_CUTOVER_ENV = 'BOARDSESH_E2E_BROWSER_SESSION_CUTOVER';

/**
 * Variables Railway and Vercel set in every deployment they run. A prefix
 * would be too wide: the Railway CLI sets `RAILWAY_HOME` on a laptop, and
 * `VERCEL_ENV=development` is in www's committed `.env.local`. Vercel sets
 * `VERCEL=1` on every build and function.
 */
const HOSTED_DEPLOYMENT_VARIABLES = [
  'RAILWAY_PROJECT_ID',
  'RAILWAY_ENVIRONMENT_ID',
  'RAILWAY_ENVIRONMENT_NAME',
  'RAILWAY_ENVIRONMENT',
  'RAILWAY_SERVICE_ID',
  'RAILWAY_DEPLOYMENT_ID',
  'VERCEL',
] as const;

/** True on a host Railway or Vercel runs. The acceptance run never runs there, whatever origin is configured. */
function hostedDeployment(environment: Environment): boolean {
  return HOSTED_DEPLOYMENT_VARIABLES.some((name) => (environment[name] ?? '') !== '');
}

/**
 * The cutover list this process enforces. The browser acceptance run (B7) has
 * to boot `better-auth` before its own entry can leave the list, so with
 * `BOARDSESH_E2E_BROWSER_SESSION_CUTOVER=allow` the list counts as empty, and
 * only when this backend's public origin (`BACKEND_PUBLIC_URL`) and the www
 * origin it serves (`BOARDSESH_URL`) are both https hosts under
 * `boardsesh.test`. `.test` is reserved (RFC 2606), so no production host can
 * be one. Set to anything on any other origin, or on a host that Railway or
 * Vercel runs (`hostedDeployment`), it refuses to start in every mode; another
 * value on a `.test` origin changes nothing.
 */
export function cutoverBlockersInEffect(blockers: readonly string[], environment: Environment): readonly string[] {
  const requested = environment[E2E_BROWSER_SESSION_CUTOVER_ENV];
  if (requested === undefined || requested === '') return blockers;
  if (hostedDeployment(environment))
    throw new BrowserSessionStartupError(BROWSER_SESSION_STARTUP_ERRORS.e2eCutoverOutsideTest);
  const onReservedTestDomain = (origin: string | undefined) => {
    try {
      const url = new URL(origin ?? '');
      return url.protocol === 'https:' && url.hostname.toLowerCase().endsWith('.boardsesh.test');
    } catch {
      return false;
    }
  };
  if (![environment.BACKEND_PUBLIC_URL, environment.BOARDSESH_URL].every(onReservedTestDomain))
    throw new BrowserSessionStartupError(BROWSER_SESSION_STARTUP_ERRORS.e2eCutoverOutsideTest);
  return requested === 'allow' ? [] : blockers;
}

/**
 * Builds the startup check. The backend uses `assertBrowserSessionModeConfiguration`,
 * built with `BROWSER_SESSION_CUTOVER_BLOCKERS`; tests build one with an empty
 * list to reach the preconditions alone. Nothing reads the list from the
 * environment; `cutoverBlockersInEffect` empties it only on a `.test` origin.
 */
export function browserSessionModeChecker(cutoverBlockers: readonly string[]) {
  const listed = Object.freeze([...cutoverBlockers]);
  return (environment: Environment = process.env): void => {
    const blockers = cutoverBlockersInEffect(listed, environment);
    const browserSessionMode = readBrowserSessionMode(environment[BROWSER_SESSION_MODE_ENV]);
    // Provider link and unlink act for a canonical web session and refuse a
    // legacy cookie (#7596 B5c1), so without `better-auth` nobody could link.
    // `better-auth` is required first, not implied.
    refuseUnless(
      environment[PROVIDER_SECURITY_MODE_ENV] !== 'backend-staging' || browserSessionMode === 'better-auth',
      BROWSER_SESSION_STARTUP_ERRORS.providerSecurityNeedsBrowserSession,
    );
    // First password does the same since B5c2.
    refuseUnless(
      environment[FIRST_PASSWORD_MODE_ENV] !== 'backend-staging' || browserSessionMode === 'better-auth',
      BROWSER_SESSION_STARTUP_ERRORS.firstPasswordNeedsBrowserSession,
    );
    if (browserSessionMode === 'legacy') return;
    assertBetterAuthPreconditions(environment);
    if (blockers.length > 0)
      throw new BrowserSessionStartupError(BROWSER_SESSION_STARTUP_ERRORS.cutoverIncomplete, blockers.join(', '));
  };
}

/**
 * Checked once at startup, before anything listens. An unknown value refuses
 * to start, so a typo fails the deploy visibly. `better-auth` needs every
 * precondition above, each refused with its own code, and refuses with
 * `AUTH_BROWSER_SESSION_CUTOVER_INCOMPLETE` while
 * `BROWSER_SESSION_CUTOVER_BLOCKERS` lists work (empty since #7880).
 */
export const assertBrowserSessionModeConfiguration = browserSessionModeChecker(BROWSER_SESSION_CUTOVER_BLOCKERS);
