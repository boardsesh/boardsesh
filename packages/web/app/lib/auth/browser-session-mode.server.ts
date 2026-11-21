// Server code (node:crypto), but without `import 'server-only'`: `instrumentation.ts`
// runs this check at boot, outside the React server layer that package needs.
// Nothing here imports a module that does.
import { createHash } from 'node:crypto';
import {
  AUTH_COMMAND_ENV,
  WEB_SESSION_COMMAND_PATHS,
  parseWebAuthMode,
  webCredentialProofMode,
} from '@boardsesh/auth-protocol';
import { createPrivateAuthCommandTransport } from '@boardsesh/auth-protocol/transport';
import {
  BROWSER_SESSION_COOKIE_MIN_SECRET_BYTES,
  browserSessionCookieClears,
  readBrowserSessionCookies,
} from '@boardsesh/auth-protocol/browser-session-cookie';
import { BROWSER_SESSION_MODE_ENV, parseBrowserSessionMode } from '@boardsesh/auth-protocol/browser-session-mode';
import { webLogger } from '@/app/lib/observability/logger';
import { isSecureCookieContext, sessionCookieDomain } from './secure-cookies';

/** www's own secret for the signed session cookie. Used for nothing else. */
export const BROWSER_SESSION_COOKIE_SECRET_ENV = 'AUTH_BROWSER_SESSION_COOKIE_SECRET';

/** How www writes and reads the session cookie under `better-auth`. */
export type BrowserSessionCookieConfiguration = Readonly<{
  secret: string;
  /** Secure context: `__Secure-` names and the `Secure` attribute. Never false in production. */
  secure: boolean;
  /** `.boardsesh.com` on production www; undefined (host-only) on previews and local. */
  domain: string | undefined;
}>;

export type BrowserSessionRouteMode =
  | { kind: 'legacy' }
  | { kind: 'better-auth'; cookies: BrowserSessionCookieConfiguration }
  /**
   * An unknown mode value, or `better-auth` without its preconditions or with
   * www cutover work still listed: the auth routes answer 503 and a boot fails.
   */
  | { kind: 'unavailable'; code: PreconditionCode };

/** One code per missing precondition, logged once per configuration so a failed turn-on names what is missing. */
export const BROWSER_SESSION_WEB_PRECONDITION_ERRORS = Object.freeze({
  modeInvalid: 'AUTH_BROWSER_SESSION_MODE_INVALID',
  backendChannel: 'AUTH_BROWSER_SESSION_WEB_BACKEND_CHANNEL_INVALID',
  webAuthMode: 'AUTH_BROWSER_SESSION_WEB_AUTH_MODE_REQUIRED',
  webOAuthMode: 'AUTH_BROWSER_SESSION_WEB_OAUTH_MODE_REQUIRED',
  credentialProof: 'AUTH_BROWSER_SESSION_WEB_CREDENTIAL_PROOF_REQUIRED',
  nextAuthSecret: 'AUTH_BROWSER_SESSION_WEB_NEXTAUTH_SECRET_INVALID',
  cookieSecret: 'AUTH_BROWSER_SESSION_WEB_COOKIE_SECRET_INVALID',
  secretReused: 'AUTH_BROWSER_SESSION_WEB_SECRET_REUSED',
  insecure: 'AUTH_BROWSER_SESSION_WEB_INSECURE_IN_PRODUCTION',
  cookieDomain: 'AUTH_BROWSER_SESSION_WEB_COOKIE_DOMAIN_INVALID',
  cutoverIncomplete: 'AUTH_BROWSER_SESSION_WEB_CUTOVER_INCOMPLETE',
  e2eCutoverOutsideTest: 'AUTH_BROWSER_SESSION_WEB_E2E_CUTOVER_OUTSIDE_TEST',
});

/**
 * www work (#7596 Phase B) that must land before a browser can be served the
 * first-party session end to end. While any entry remains, `better-auth`
 * resolves to `unavailable` even with every precondition met, as the backend's
 * `BROWSER_SESSION_CUTOVER_BLOCKERS` refuses to start. Each www PR deleted
 * its own entry; #7880 emptied the list (docs/auth/better-auth-browser-session.md,
 * "Status"). No environment variable or flag removes one; only
 * tests build a resolver with another list (`browserSessionRouteModeResolver`).
 */
export const BROWSER_SESSION_WEB_CUTOVER_BLOCKERS: readonly string[] = Object.freeze([]);

type PreconditionCode =
  (typeof BROWSER_SESSION_WEB_PRECONDITION_ERRORS)[keyof typeof BROWSER_SESSION_WEB_PRECONDITION_ERRORS];

/** Every variable the checks read, so a changed value is checked again and an unchanged one never is. */
const CHECKED_VARIABLES = [
  'AUTH_BROWSER_SESSION_COOKIE_SECRET',
  'CURRENT_STORE_AUTH_BACKEND_ORIGIN',
  'CURRENT_STORE_AUTH_RPC_SECRET',
  'CURRENT_STORE_WEB_AUTH_MODE',
  'CURRENT_STORE_WEB_OAUTH_MODE',
  'CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE',
  'NEXTAUTH_SECRET',
  'CRON_SECRET',
  'AUTH_DEVICE_TOKEN_SECRET',
  'NEXTAUTH_URL',
  'VERCEL_ENV',
  'VERCEL_URL',
  'AUTH_COOKIE_DOMAIN',
  'NODE_ENV',
] as const;

function isStrongSecret(candidate: string | undefined): candidate is string {
  return (
    typeof candidate === 'string' &&
    candidate === candidate.trim() &&
    Buffer.byteLength(candidate, 'utf8') >= BROWSER_SESSION_COOKIE_MIN_SECRET_BYTES
  );
}

function betterAuthPreconditions(
  environment: NodeJS.ProcessEnv,
): { cookies: BrowserSessionCookieConfiguration } | { failed: PreconditionCode } {
  const errors = BROWSER_SESSION_WEB_PRECONDITION_ERRORS;
  try {
    // The same channel rules as `createAuthCommandTransport`, checked without sending anything.
    createPrivateAuthCommandTransport({
      environment,
      fetch,
      paths: Object.values(WEB_SESSION_COMMAND_PATHS),
      originKey: AUTH_COMMAND_ENV.origin,
      secretKey: AUTH_COMMAND_ENV.secret,
      disallowedSecretKeys: ['NEXTAUTH_SECRET', 'CRON_SECRET'],
    });
  } catch {
    return { failed: errors.backendChannel };
  }
  try {
    if (parseWebAuthMode(environment[AUTH_COMMAND_ENV.mode]) !== 'backend-staging')
      return { failed: errors.webAuthMode };
  } catch {
    return { failed: errors.webAuthMode };
  }
  // Google and Apple issue a first-party session only through the backend's web OAuth commands (B5b).
  try {
    if (parseWebAuthMode(environment.CURRENT_STORE_WEB_OAUTH_MODE) !== 'backend-staging')
      return { failed: errors.webOAuthMode };
  } catch {
    return { failed: errors.webOAuthMode };
  }
  try {
    if (webCredentialProofMode(environment) !== 'required') return { failed: errors.credentialProof };
  } catch {
    return { failed: errors.credentialProof };
  }
  if (!isStrongSecret(environment.NEXTAUTH_SECRET)) return { failed: errors.nextAuthSecret };
  const secret = environment[BROWSER_SESSION_COOKIE_SECRET_ENV];
  if (!isStrongSecret(secret)) return { failed: errors.cookieSecret };
  const otherSecrets = [
    environment.NEXTAUTH_SECRET,
    environment.CURRENT_STORE_AUTH_RPC_SECRET,
    environment.CRON_SECRET,
    environment.AUTH_DEVICE_TOKEN_SECRET,
  ];
  if (otherSecrets.includes(secret)) return { failed: errors.secretReused };
  const secure = isSecureCookieContext();
  // A plain cookie name can be set from http or document.cookie on any subdomain.
  if (environment.NODE_ENV === 'production' && !secure) return { failed: errors.insecure };
  const domain = sessionCookieDomain();
  try {
    // The codec's own checks, once: the secret floor, and a Domain only with Secure.
    readBrowserSessionCookies(null, secret, secure);
    browserSessionCookieClears({ domain, secure, requestCookieNames: [] });
  } catch {
    return { failed: errors.cookieDomain };
  }
  return { cookies: Object.freeze({ secret, secure, domain }) };
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
export const HOSTED_DEPLOYMENT_VARIABLES = [
  'RAILWAY_PROJECT_ID',
  'RAILWAY_ENVIRONMENT_ID',
  'RAILWAY_ENVIRONMENT_NAME',
  'RAILWAY_ENVIRONMENT',
  'RAILWAY_SERVICE_ID',
  'RAILWAY_DEPLOYMENT_ID',
  'VERCEL',
] as const;

/**
 * The www cutover list this process enforces, or undefined when the e2e
 * switch is set where it must never be. The browser acceptance run (B7) has to
 * serve `better-auth` before its own entry can leave the list, so with
 * `BOARDSESH_E2E_BROWSER_SESSION_CUTOVER=allow` the list counts as empty, and
 * only when `NEXTAUTH_URL` is an https host under `boardsesh.test` and the
 * session cookie domain is under it too. `.test` is reserved (RFC 2606), so no
 * production host can be one. Set to anything on any other origin, every mode
 * answers unavailable and the boot fails; so it does on a host Railway or
 * Vercel runs (`HOSTED_DEPLOYMENT_VARIABLES`), whatever origin is
 * configured. Another value on a `.test` origin changes nothing.
 */
function cutoverBlockersInEffect(blockers: readonly string[], environment: NodeJS.ProcessEnv) {
  const requested = environment[E2E_BROWSER_SESSION_CUTOVER_ENV];
  if (requested === undefined || requested === '') return blockers;
  if (HOSTED_DEPLOYMENT_VARIABLES.some((name) => (environment[name] ?? '') !== '')) return undefined;
  let origin: URL | undefined;
  try {
    origin = new URL(environment.NEXTAUTH_URL ?? '');
  } catch {
    origin = undefined;
  }
  const cookieDomain = sessionCookieDomain()?.toLowerCase();
  const onReservedTestDomain =
    origin?.protocol === 'https:' &&
    origin.hostname.toLowerCase().endsWith('.boardsesh.test') &&
    cookieDomain !== undefined &&
    (cookieDomain === '.boardsesh.test' || cookieDomain.endsWith('.boardsesh.test'));
  if (!onReservedTestDomain) return undefined;
  return requested === 'allow' ? [] : blockers;
}

function digest(text: string | undefined): string {
  return createHash('sha256')
    .update(text ?? '')
    .digest('base64url');
}

/**
 * A resolver for `AUTH_BROWSER_SESSION_MODE` that holds `cutoverBlockers`.
 * Production code uses `browserSessionRouteMode`, built with
 * `BROWSER_SESSION_WEB_CUTOVER_BLOCKERS`; a boundary test keeps every other
 * list in tests and proofs.
 */
export function browserSessionRouteModeResolver(cutoverBlockers: readonly string[]): () => BrowserSessionRouteMode {
  const listed = Object.freeze([...cutoverBlockers]);
  let checked: { key: string; mode: BrowserSessionRouteMode } | undefined;
  return () => {
    const environment = process.env;
    const blockers = cutoverBlockersInEffect(listed, environment);
    if (blockers === undefined) {
      const code = BROWSER_SESSION_WEB_PRECONDITION_ERRORS.e2eCutoverOutsideTest;
      logUnavailable(code, digest(environment.NEXTAUTH_URL));
      return { kind: 'unavailable', code };
    }
    let mode: ReturnType<typeof parseBrowserSessionMode>;
    try {
      mode = parseBrowserSessionMode(environment[BROWSER_SESSION_MODE_ENV]);
    } catch {
      const code = BROWSER_SESSION_WEB_PRECONDITION_ERRORS.modeInvalid;
      logUnavailable(code, digest(environment[BROWSER_SESSION_MODE_ENV]));
      return { kind: 'unavailable', code };
    }
    if (mode === 'legacy') return { kind: 'legacy' };
    // The cache key is a digest of the checked values; the cached result does
    // hold the cookie secret itself, in memory, as the environment does.
    // The list in effect is part of the key: the e2e seam can change it with no checked variable changing.
    const key = digest(JSON.stringify([...CHECKED_VARIABLES.map((name) => environment[name] ?? null), blockers]));
    if (checked?.key === key) return checked.mode;
    const result = betterAuthPreconditions(environment);
    let resolved: BrowserSessionRouteMode;
    if ('failed' in result) resolved = { kind: 'unavailable', code: result.failed };
    else if (blockers.length > 0)
      resolved = { kind: 'unavailable', code: BROWSER_SESSION_WEB_PRECONDITION_ERRORS.cutoverIncomplete };
    else resolved = { kind: 'better-auth', cookies: result.cookies };
    if (resolved.kind === 'unavailable') logUnavailable(resolved.code, key, blockers);
    checked = { key, mode: resolved };
    return resolved;
  };
}

/**
 * `AUTH_BROWSER_SESSION_MODE`, read on the server for each auth request (never
 * a `NEXT_PUBLIC_*` value, so a rollback needs no rebuild). Unset, empty or
 * `legacy` is `legacy` and touches nothing else: no codec, no secret, no check.
 * `better-auth` checks www's own preconditions once per configuration and then
 * the www cutover list; with a precondition missing or work still listed, the
 * auth routes answer 503. Any other value is 503 too.
 */
export const browserSessionRouteMode = browserSessionRouteModeResolver(BROWSER_SESSION_WEB_CUTOVER_BLOCKERS);

/**
 * For `instrumentation.ts`: the error that must stop this process from serving,
 * or undefined. `legacy` (unset, empty) boots as before. A mode that resolves
 * to `unavailable` fails the boot, so a typo or a missing precondition keeps
 * the previous deployment serving instead of a healthy-looking one answering
 * 503 on every auth route.
 */
export function browserSessionBootRefusal(
  resolve: () => BrowserSessionRouteMode = browserSessionRouteMode,
): Error | undefined {
  const mode = resolve();
  return mode.kind === 'unavailable' ? new Error(mode.code) : undefined;
}

let lastLogged: string | undefined;
function logUnavailable(code: PreconditionCode, configurationKey: string, blockers: readonly string[] = []): void {
  const marker = `${code}:${configurationKey}`;
  if (lastLogged === marker) return;
  lastLogged = marker;
  // The code (and, for an incomplete cutover, the listed work); never a value.
  webLogger.error(
    'browser session mode unavailable',
    code === BROWSER_SESSION_WEB_PRECONDITION_ERRORS.cutoverIncomplete
      ? { code, blockers: blockers.join(', ') }
      : { code },
  );
}
