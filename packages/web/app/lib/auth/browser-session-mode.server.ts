import 'server-only';
import { createHash } from 'node:crypto';
import { WEB_SESSION_COMMAND_PATHS, webCredentialProofMode } from '@boardsesh/auth-protocol';
import {
  BROWSER_SESSION_COOKIE_MIN_SECRET_BYTES,
  browserSessionCookieClears,
  readBrowserSessionCookies,
} from '@boardsesh/auth-protocol/browser-session-cookie';
import { BROWSER_SESSION_MODE_ENV, parseBrowserSessionMode } from '@boardsesh/auth-protocol/browser-session-mode';
import { webLogger } from '@/app/lib/observability/logger';
import { createAuthCommandTransport } from './auth-command-transport.server';
import { webPasswordMode } from './password-command-client.server';
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
  /** An unknown mode value, or `better-auth` without its preconditions: the auth routes answer 503. */
  | { kind: 'unavailable' };

/** One code per missing precondition, logged once per configuration so a failed turn-on names what is missing. */
export const BROWSER_SESSION_WEB_PRECONDITION_ERRORS = Object.freeze({
  modeInvalid: 'AUTH_BROWSER_SESSION_MODE_INVALID',
  backendChannel: 'AUTH_BROWSER_SESSION_WEB_BACKEND_CHANNEL_INVALID',
  webAuthMode: 'AUTH_BROWSER_SESSION_WEB_AUTH_MODE_REQUIRED',
  credentialProof: 'AUTH_BROWSER_SESSION_WEB_CREDENTIAL_PROOF_REQUIRED',
  nextAuthSecret: 'AUTH_BROWSER_SESSION_WEB_NEXTAUTH_SECRET_INVALID',
  cookieSecret: 'AUTH_BROWSER_SESSION_WEB_COOKIE_SECRET_INVALID',
  secretReused: 'AUTH_BROWSER_SESSION_WEB_SECRET_REUSED',
  insecure: 'AUTH_BROWSER_SESSION_WEB_INSECURE_IN_PRODUCTION',
  cookieDomain: 'AUTH_BROWSER_SESSION_WEB_COOKIE_DOMAIN_INVALID',
});

type PreconditionCode =
  (typeof BROWSER_SESSION_WEB_PRECONDITION_ERRORS)[keyof typeof BROWSER_SESSION_WEB_PRECONDITION_ERRORS];

/** Every variable the checks read, so a changed value is checked again and an unchanged one never is. */
const CHECKED_VARIABLES = [
  'AUTH_BROWSER_SESSION_COOKIE_SECRET',
  'CURRENT_STORE_AUTH_BACKEND_ORIGIN',
  'CURRENT_STORE_AUTH_RPC_SECRET',
  'CURRENT_STORE_WEB_AUTH_MODE',
  'CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE',
  'NEXTAUTH_SECRET',
  'CRON_SECRET',
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
    createAuthCommandTransport({ environment, paths: Object.values(WEB_SESSION_COMMAND_PATHS) });
  } catch {
    return { failed: errors.backendChannel };
  }
  try {
    if (webPasswordMode(environment) !== 'backend-staging') return { failed: errors.webAuthMode };
  } catch {
    return { failed: errors.webAuthMode };
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

function digest(text: string | undefined): string {
  return createHash('sha256')
    .update(text ?? '')
    .digest('base64url');
}

let checked: { key: string; mode: BrowserSessionRouteMode } | undefined;

/**
 * `AUTH_BROWSER_SESSION_MODE`, read on the server for each auth request (never
 * a `NEXT_PUBLIC_*` value, so a rollback needs no rebuild). Unset, empty or
 * `legacy` is `legacy` and touches nothing else: no codec, no secret, no check.
 * `better-auth` checks www's own preconditions once per configuration; with
 * any missing, the auth routes answer 503. Any other value is 503 too.
 */
export function browserSessionRouteMode(): BrowserSessionRouteMode {
  const environment = process.env;
  let mode: ReturnType<typeof parseBrowserSessionMode>;
  try {
    mode = parseBrowserSessionMode(environment[BROWSER_SESSION_MODE_ENV]);
  } catch {
    logUnavailable(BROWSER_SESSION_WEB_PRECONDITION_ERRORS.modeInvalid, digest(environment[BROWSER_SESSION_MODE_ENV]));
    return { kind: 'unavailable' };
  }
  if (mode === 'legacy') return { kind: 'legacy' };
  // A digest, so no secret is kept beside the result.
  const key = digest(JSON.stringify(CHECKED_VARIABLES.map((name) => environment[name] ?? null)));
  if (checked?.key === key) return checked.mode;
  const result = betterAuthPreconditions(environment);
  const resolved: BrowserSessionRouteMode =
    'cookies' in result ? { kind: 'better-auth', cookies: result.cookies } : { kind: 'unavailable' };
  if ('failed' in result) logUnavailable(result.failed, key);
  checked = { key, mode: resolved };
  return resolved;
}

let lastLogged: string | undefined;
function logUnavailable(code: PreconditionCode, configurationKey: string): void {
  const marker = `${code}:${configurationKey}`;
  if (lastLogged === marker) return;
  lastLogged = marker;
  // The code only; never a value.
  webLogger.error('browser session mode unavailable', { code });
}
