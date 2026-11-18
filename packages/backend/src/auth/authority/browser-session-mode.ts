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
const PROVIDER_SECURITY_MODE_ENV = 'CURRENT_STORE_PROVIDER_SECURITY_MODE';
const FIRST_PASSWORD_MODE_ENV = 'CURRENT_STORE_FIRST_PASSWORD_MODE';

/**
 * Phase B work (#7596) that must land before a browser can be served a
 * backend session end to end. While any entry remains, `better-auth` refuses
 * to start even with every precondition met. Each later PR deletes its own
 * entry; the last one empties the list. Like `AUTHORITY_ACTIVATION_BLOCKERS`,
 * no environment variable or flag removes an entry.
 */
export const BROWSER_SESSION_CUTOVER_BLOCKERS: readonly string[] = Object.freeze([
  'B1C_WWW_COOKIE_WRITERS',
  'B2_LEGACY_COOKIE_BRIDGE',
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
  secretReused: 'AUTH_BROWSER_SESSION_SECRET_REUSED',
  cutoverIncomplete: 'AUTH_BROWSER_SESSION_CUTOVER_INCOMPLETE',
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
] as const;

/** The other auth secrets none of those three may equal. */
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
 * precondition above, each refused with its own code, and then still refuses
 * with `AUTH_BROWSER_SESSION_CUTOVER_INCOMPLETE` until the later Phase B PRs
 * empty `BROWSER_SESSION_CUTOVER_BLOCKERS`.
 */
export const assertBrowserSessionModeConfiguration = browserSessionModeChecker(BROWSER_SESSION_CUTOVER_BLOCKERS);
