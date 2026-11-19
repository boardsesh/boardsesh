import 'server-only';
import { createHash } from 'node:crypto';
import type { NextAuthOptions, Profile } from 'next-auth';
import type { AuthorizationEndpointHandler, OAuthConfig } from 'next-auth/providers/oauth';
import { decode } from 'next-auth/jwt';
import type { NextRequest } from 'next/server';
import {
  WEB_OAUTH_GOOGLE_NONCE_DOMAIN,
  type IssuedWebSessionReply,
  type PresentedWebSession,
  type WebOAuthProvider,
} from '@boardsesh/auth-protocol';
import type { BrowserSessionCookieConfiguration } from './browser-session-mode.server';
import { loginSessionCookies, presentedForLogin, readRequestBrowserSession } from './browser-session.server';
import { appendLegacyHostOnlySessionCookieClear, appendStaleLegacySessionCookieClears } from './secure-cookies';

/**
 * Google and Apple web sign-in under `AUTH_BROWSER_SESSION_MODE=better-auth`
 * (#7596 B5b): the backend's `resolve` issues a first-party web session, and
 * the one callback response publishes it beside the legacy twin.
 *
 * Google freshness (#7655, #7590). A sign-in counts as fresh only when the
 * backend verifies Google's own signed `auth_time` under five minutes old.
 * Every session sign-in therefore asks Google for an ID token that carries
 * `auth_time` (`max_age`) and binds a nonce of its own: NextAuth's `nonce`
 * check makes one (32 random bytes), sends it to Google, seals it in a
 * host-only HttpOnly cookie for this flow, and checks the ID token against it.
 * The intent's `flow` is the SHA-256 of the nonce (single use with the
 * intent), and `resolve` forwards the raw ID token and the nonce.
 *
 * The plain login button does not force a fresh Google login: `max_age` is a
 * year, so a climber already signed in to Google is not asked again, and the
 * session is `carried` unless Google's `auth_time` is itself under five
 * minutes old. That silent sign-in can never pass a five-minute check, which
 * is what #7655 asks. The forced re-sign-in page (`/auth/reauthenticate`,
 * B5e1) sends `max_age=0` and `prompt=select_account consent` as the start's
 * query (`GOOGLE_FORCED_REAUTHENTICATION`), which NextAuth puts over these.
 */

/** Long enough that a climber signed in to Google is not asked to sign in again; any value makes Google send `auth_time`. */
export const GOOGLE_SIGN_IN_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** The authorization parameters a session sign-in adds for Google. */
export function googleSessionAuthorizationParams() {
  return { max_age: GOOGLE_SIGN_IN_MAX_AGE_SECONDS };
}

/** The intent `flow` of a Google session sign-in: the SHA-256 hex of the domain-tagged nonce. */
export function googleSessionFlow(nonce: string): string {
  return createHash('sha256')
    .update(JSON.stringify([WEB_OAUTH_GOOGLE_NONCE_DOMAIN, nonce]))
    .digest('hex');
}

/** At least 128 random bits, as NextAuth's generator (base64url) makes them; nothing else is accepted as a nonce. */
function isStrongNonce(nonce: string): boolean {
  return /^[A-Za-z0-9_-]{22,1024}$/.test(nonce);
}

type CookieOption = NonNullable<NonNullable<NextAuthOptions['cookies']>['nonce']>;

/**
 * The Google nonce cookie of a session sign-in: host-only, and in a secure
 * context under the `__Host-` prefix, which a browser accepts only without a
 * Domain and with Secure and `Path=/`, so a sibling subdomain cannot plant a
 * copy. On local http the plain name stays (no prefix is possible there).
 */
export function hostOnlyNonceCookie(cookie: CookieOption): CookieOption {
  const name = cookie.name.startsWith('__Secure-') ? `__Host-${cookie.name.slice('__Secure-'.length)}` : cookie.name;
  return { ...cookie, name, options: { ...cookie.options, domain: undefined, path: '/' } };
}

/**
 * Request-local options for a session sign-in: for Google, NextAuth's nonce
 * check on, the nonce cookie host-only, and `max_age` so the ID token carries
 * `auth_time`. Apple is unchanged (its sign-ins are always `carried`).
 */
export function sessionSignInOptions(options: NextAuthOptions, provider: WebOAuthProvider): NextAuthOptions {
  if (provider !== 'google') return options;
  const authorizationParams = googleSessionAuthorizationParams();
  const nonceCookie = options.cookies?.nonce;
  return {
    ...options,
    cookies: {
      ...options.cookies,
      ...(nonceCookie ? { nonce: hostOnlyNonceCookie(nonceCookie) } : {}),
    },
    providers: options.providers.map((configured) => {
      if (configured.type !== 'oauth' || (configured.options?.id ?? configured.id) !== 'google') return configured;
      const authorization: AuthorizationEndpointHandler =
        typeof configured.authorization === 'object' && configured.authorization !== null
          ? configured.authorization
          : {};
      const sessionAuthorization: AuthorizationEndpointHandler = {
        ...authorization,
        params: { ...authorization.params, ...authorizationParams },
      };
      const checks: Extract<OAuthConfig<Profile>['checks'], unknown[]> = ['pkce', 'state', 'nonce'];
      const google: OAuthConfig<Profile> = {
        ...configured,
        checks,
        authorization: sessionAuthorization,
        ...(configured.options
          ? { options: { ...configured.options, checks, authorization: sessionAuthorization } }
          : {}),
      };
      return google;
    }),
  };
}

/** The nonce NextAuth put in the Google authorization URL it answered with, or undefined. */
export function nonceOfAuthorizationUrl(destination: string): string | undefined {
  const nonces = new URL(destination).searchParams.getAll('nonce');
  return nonces.length === 1 && isStrongNonce(nonces[0]) ? nonces[0] : undefined;
}

/**
 * The nonce this Google flow sent, from its sealed host-only cookie (scoped to
 * the flow), decoded as NextAuth's own nonce check decodes it. Undefined when
 * the cookie is missing or does not open.
 */
export async function readGoogleSignInNonce(
  request: NextRequest,
  options: NextAuthOptions,
): Promise<string | undefined> {
  const name = options.cookies?.nonce?.name;
  const secret = options.secret ?? process.env.NEXTAUTH_SECRET;
  if (!name || !secret) return undefined;
  // The raw header, so two copies of the name (which a parsed cookie store would merge) refuse.
  const sealed = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair.slice(0, pair.indexOf('=')) === name)
    .map((pair) => pair.slice(pair.indexOf('=') + 1));
  if (sealed.length !== 1 || !sealed[0]) return undefined;
  try {
    const claims = await (options.jwt?.decode ?? decode)({ token: sealed[0], secret, salt: name });
    const value = claims?.value;
    return claims?.provider === 'google' && typeof value === 'string' && isStrongNonce(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The session this callback arrived with, as a login presents it: the
 * verified first-party cookie first, else the legacy cookie (never both); a
 * legacy cookie no command accepts is dropped. Throws when the legacy cookie
 * cannot be reassembled, which the caller answers as unavailable.
 */
export async function presentedForProviderSignIn(
  request: NextRequest,
  cookies: BrowserSessionCookieConfiguration,
): Promise<PresentedWebSession | undefined> {
  return presentedForLogin(await readRequestBrowserSession(request, cookies));
}

/**
 * Publishes a provider sign-in's session on the callback response NextAuth
 * already wrote the legacy twin on (same session id, from the proof): the
 * host-only legacy clear, clears of the bridged name in both scopes and of the
 * host-only login copy, then the login cookie last. The same headers a
 * password login appends, so no legacy cookie with another id stays beside it.
 */
export function publishProviderSignIn(
  response: Response,
  request: NextRequest,
  cookies: BrowserSessionCookieConfiguration,
  issued: IssuedWebSessionReply,
): Response {
  appendLegacyHostOnlySessionCookieClear(response);
  const carried = request.cookies.getAll().map((requestCookie) => requestCookie.name);
  appendStaleLegacySessionCookieClears(response, carried);
  for (const setCookie of loginSessionCookies(cookies, issued.token, issued.sessionId, carried))
    response.headers.append('Set-Cookie', setCookie);
  return response;
}
