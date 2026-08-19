// next-auth derives `secureCookie` from `NEXTAUTH_URL?.startsWith('https://')
// ?? !!process.env.VERCEL`. The `??` only kicks in when NEXTAUTH_URL is unset
// — if it's set to an `http://` value, secureCookie silently becomes false and
// next-auth reads/writes `next-auth.session-token` instead of
// `__Secure-next-auth.session-token`. A misconfigured NEXTAUTH_URL in Vercel
// took ws-auth (and all logbook fetches) down once already; this helper is the
// floor so it can't happen again.
export function isSecureCookieContext(): boolean {
  return (
    process.env.VERCEL_ENV === 'production' ||
    process.env.NEXTAUTH_URL?.startsWith('https://') === true ||
    !!process.env.VERCEL_URL
  );
}

export function sessionCookieName(): string {
  return isSecureCookieContext() ? '__Secure-next-auth.session-token' : 'next-auth.session-token';
}

// Domain attribute for the session cookie (and the OAuth-flow cookies), shared
// with app.boardsesh.com. `.boardsesh.com` may ONLY be emitted when this
// deployment actually serves the production www/apex host — keyed on the
// serving host, NOT on the secure-context flag:
//   - `isSecureCookieContext()` is true on every Vercel preview (`VERCEL_URL`
//     is set), but a `Set-Cookie` with `Domain=.boardsesh.com` from a
//     `*.vercel.app` response fails the browser's domain-match check and is
//     rejected — login would silently break on previews.
//   - Homelab previews ({N}.preview.boardsesh.com) DO domain-match, which is
//     worse: a preview login/sign-out would write/delete the domain-wide
//     production cookie identity. Preview hosts stay host-only.
// AUTH_COOKIE_DOMAIN overrides everything for non-standard deployments.
export function sessionCookieDomain(): string | undefined {
  const explicitDomain = process.env.AUTH_COOKIE_DOMAIN?.trim();
  if (explicitDomain) return explicitDomain;

  const nextAuthUrl = process.env.NEXTAUTH_URL;
  if (nextAuthUrl) {
    let servingHostname: string;
    try {
      servingHostname = new URL(nextAuthUrl).hostname.toLowerCase();
    } catch {
      return undefined;
    }
    return servingHostname === 'boardsesh.com' || servingHostname === 'www.boardsesh.com'
      ? '.boardsesh.com'
      : undefined;
  }

  // NEXTAUTH_URL can be omitted on Vercel (auto-detected from VERCEL_URL).
  // Only the production deployment serves www.boardsesh.com; previews serve
  // *.vercel.app hosts where the parent-domain cookie would be rejected.
  return process.env.VERCEL_ENV === 'production' ? '.boardsesh.com' : undefined;
}

// Before app.boardsesh.com shared the login, the session cookie was host-only
// (no Domain, scoped to the exact www host). Adding `Domain=.boardsesh.com`
// mints a browser-distinct second cookie of the same name, so a pre-migration
// host-only cookie keeps riding every www request and, because sign-out only
// clears the Domain-scoped cookie, would survive logout with a still-valid JWT
// (a logout bypass). Whenever NextAuth writes a fresh session cookie (login) or
// clears it (sign-out), we ALSO emit this host-only deletion — a Set-Cookie with
// NO Domain attribute, which targets the legacy host-only entry and cannot touch
// the new Domain-scoped cookie. `__Secure-` permits a Domain-less cookie (unlike
// `__Host-`), so the deletion is valid for the secure-context name.
export function appendLegacyHostOnlySessionCookieClear(response: Response): void {
  // The host-only deletion is only a DIFFERENT cookie identity when the live
  // session cookie is Domain-scoped. Where no cookie domain is in play (local
  // dev, previews), the fresh cookie NextAuth just wrote is itself host-only
  // with the same name + path — appending this clear would delete the login
  // that was just written. There is no legacy Domain-cookie migration to do in
  // those environments, so skipping is strictly correct.
  if (sessionCookieDomain() === undefined) return;
  appendHostOnlyCookieClear(response, sessionCookieName());
}

// Single source of truth for every cookie name `auth-options.ts` gives a
// `Domain`. auth-options builds its `cookies` block from this and the legacy
// clears below read the same values, so a rename cannot leave the sweep
// pointing at a name nothing writes. The dependency runs one way only —
// auth-options imports secure-cookies, never the reverse — so no import cycle.
//
// Names are NextAuth's own (next-auth/core/lib/cookie.js): `pkceCodeVerifier`
// is stored as `next-auth.pkce.code_verifier`, not `next-auth.pkceCodeVerifier`.
// `csrfToken` is deliberately absent — it uses the `__Host-` prefix, which
// forbids a Domain attribute, so it has no second cookie identity.
export function domainScopedCookieNames(): {
  sessionToken: string;
  callbackUrl: string;
  state: string;
  nonce: string;
  pkceCodeVerifier: string;
} {
  const cookiePrefix = isSecureCookieContext() ? '__Secure-' : '';
  return {
    sessionToken: sessionCookieName(),
    callbackUrl: `${cookiePrefix}next-auth.callback-url`,
    state: `${cookiePrefix}next-auth.state`,
    nonce: `${cookiePrefix}next-auth.nonce`,
    pkceCodeVerifier: `${cookiePrefix}next-auth.pkce.code_verifier`,
  };
}

// The flow-cookie subset of the above — the names the legacy host-only sweep
// targets. `next-auth.nonce` is here because auth-options declares it with a
// Domain, not because this deployment writes it: `checks.nonce.create`
// early-returns unless the provider's `checks` include `'nonce'`
// (next-auth/core/lib/oauth/checks.js), and both configured OIDC providers are
// `['pkce', 'state']` — Google's built-in default, Apple's explicit override in
// auth-options. Its clear is inert today; mirroring the declaration rather than
// the current provider config means enabling the nonce check later cannot
// silently leave a gap.
export function oauthFlowCookieNames(): string[] {
  const { callbackUrl, state, nonce, pkceCodeVerifier } = domainScopedCookieNames();
  return [callbackUrl, state, nonce, pkceCodeVerifier];
}

// Cookie-jar hygiene, NOT a sign-in fix — read this before extending it.
//
// The flow cookies were host-only before app.boardsesh.com shared the login, so
// a browser that signed in before #3775 (2026-07-20) can still carry a host-only
// copy of each alongside the Domain-scoped one NextAuth writes now: `(name,
// domain, path)` is the storage key, so both entries coexist and both ride every
// www request.
//
// A duplicate does NOT shadow the fresh cookie on the read path. Next's
// `parseCookie` (next/dist/compiled/@edge-runtime/cookies) does `map.set(key,
// value)` per pair, so the LAST occurrence in the Cookie header wins, and RFC
// 6265 §5.4 orders equal-path cookies by ascending creation time — the older
// host-only copy is sent first, the Domain-scoped one last. The fresh cookie
// wins deterministically, and so does the one `getToken({ req })` reads.
//
// What is left is leftovers, not breakage. `state` and `pkceCodeVerifier` are
// bounded to 15 minutes — though NOT by the `maxAge: 60 * 15` in NextAuth's
// `defaultCookies()`, which this app never sees: next-auth merges the `cookies`
// map one level deep (`{...defaultCookies(), ...authOptions.cookies}`,
// core/init.js), so auth-options' entries replace the defaults' `options`
// wholesale and drop the maxAge. The real ceiling is `signCookie`
// (core/lib/oauth/checks.js), which takes `cookies[type].options.maxAge ??
// STATE_MAX_AGE | PKCE_MAX_AGE` (both `60 * 15`) and stamps `expires` on the
// Set-Cookie. That applied identically before #3775 — the cookies block already
// overrode those entries — so every pre-#3775 host-only copy expired 15 minutes
// after its owner's last sign-in. `nonce` was never written at all (see the name
// list above). Only `callback-url` gets neither maxAge nor expires, so a legacy
// copy can sit in the jar for the life of a browser session — losing every read,
// and neutered anyway by the `callbacks.redirect` allow-list in auth-options.
// Deleting the host-only entries keeps the jar honest; no user-visible failure
// depends on it.
//
// Unlike the session clear above, which IS load-bearing: after sign-out only the
// Domain-scoped session cookie is deleted, so a surviving host-only copy would
// be the only one left and would win by default — a logout bypass.
export function appendLegacyHostOnlyOAuthFlowCookieClears(response: Response): void {
  // Identical load-bearing guard to the session clear: with no cookie domain in
  // play (local dev, previews) the cookies NextAuth writes are THEMSELVES
  // host-only, so this "legacy" deletion would target the live flow cookies and
  // break the sign-in it is meant to protect.
  if (sessionCookieDomain() === undefined) return;
  for (const cookieName of oauthFlowCookieNames()) {
    appendHostOnlyCookieClear(response, cookieName);
  }
}

// A `Set-Cookie` with NO Domain attribute: that is what targets the legacy
// host-only entry, and it cannot touch the Domain-scoped cookie of the same
// name. `__Secure-` permits a Domain-less cookie (unlike `__Host-`), so the
// deletion is valid for the secure-context names too. Cookie removal matches on
// name + domain + path only, so SameSite here is inert.
function appendHostOnlyCookieClear(response: Response, cookieName: string): void {
  const secure = isSecureCookieContext();
  response.headers.append(
    'Set-Cookie',
    `${cookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
  );
}

// True when the response installs a fresh (non-empty) value for the session
// cookie — i.e. a login or a rolling-session refresh, as opposed to a plain
// session read (no Set-Cookie) or the sign-out deletion (empty value). We only
// clear the legacy host-only cookie when a fresh Domain-scoped cookie is being
// written, so we never delete a pre-migration user's ONLY cookie on a bare read.
export function responseSetsSessionCookie(response: Response): boolean {
  const name = sessionCookieName();
  const setCookies =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : response.headers.get('set-cookie')
        ? [response.headers.get('set-cookie') as string]
        : [];
  return setCookies.some((setCookie) => {
    const nameValuePair = setCookie.split(';', 1)[0] ?? '';
    const separatorIndex = nameValuePair.indexOf('=');
    if (separatorIndex === -1) return false;
    const cookieName = nameValuePair.slice(0, separatorIndex).trim();
    const cookieValue = nameValuePair.slice(separatorIndex + 1).trim();
    return cookieName === name && cookieValue.length > 0;
  });
}
