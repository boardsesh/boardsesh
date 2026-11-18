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
 * to start even with every precondition met. Each later PR deletes its own
 * entry; the last one empties the list. Like `AUTHORITY_ACTIVATION_BLOCKERS`,
 * no environment variable or flag removes an entry.
 */
export const BROWSER_SESSION_CUTOVER_BLOCKERS: readonly string[] = Object.freeze([
  'B3_BROWSER_ACCESS_TOKEN',
  'B4_SERVER_RENDERS_ON_CANONICAL_SESSION',
  'B5_PROVIDER_SIGN_IN',
  'B6_PARTNER_CONSENT',
  'B7_BROWSER_ACCEPTANCE',
]);

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
  const secret = environment[BRIDGE_TOKEN_SECRET_ENV];
  const others = [...BROWSER_SESSION_SECRETS.map(([name]) => name), ...OTHER_AUTH_SECRET_ENV]
    .filter((name) => name !== BRIDGE_TOKEN_SECRET_ENV)
    .map((name) => environment[name]);
  if (!isStrongSecret(secret) || secret === undefined || others.includes(secret))
    throw new Error(`Invalid ${BRIDGE_TOKEN_SECRET_ENV}`);
  return bridgeTokenKey(secret);
}

/**
 * Builds the startup check. The backend uses `assertBrowserSessionModeConfiguration`,
 * built with `BROWSER_SESSION_CUTOVER_BLOCKERS`; tests build one with an empty
 * list to reach the preconditions alone. Nothing reads the list from the
 * environment.
 */
export function browserSessionModeChecker(cutoverBlockers: readonly string[]) {
  const blockers = Object.freeze([...cutoverBlockers]);
  return (environment: Environment = process.env): void => {
    if (readBrowserSessionMode(environment[BROWSER_SESSION_MODE_ENV]) === 'legacy') return;
    assertBetterAuthPreconditions(environment);
    if (blockers.length > 0)
      throw new BrowserSessionStartupError(BROWSER_SESSION_STARTUP_ERRORS.cutoverIncomplete, blockers.join(', '));
  };
}

/**
 * Checked once at startup, before anything listens. An unknown value refuses
 * to start, so a typo fails the deploy visibly. `better-auth` needs every
 * precondition above, each refused with its own code, and then still refuses
 * with `AUTH_BROWSER_SESSION_CUTOVER_INCOMPLETE` until the later Phase B PRs
 * empty `BROWSER_SESSION_CUTOVER_BLOCKERS`.
 */
export const assertBrowserSessionModeConfiguration = browserSessionModeChecker(BROWSER_SESSION_CUTOVER_BLOCKERS);
