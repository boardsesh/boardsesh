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

export const SECURE_SESSION_COOKIE_NAME = '__Secure-next-auth.session-token';
export const PLAIN_SESSION_COOKIE_NAME = 'next-auth.session-token';

export function sessionCookieName(): string {
  return isSecureCookieContext() ? SECURE_SESSION_COOKIE_NAME : PLAIN_SESSION_COOKIE_NAME;
}

// Both session cookie names, the one this context would WRITE first. Read paths
// try them in order so that resolving an existing session never depends on
// isSecureCookieContext() being right: the failure this whole module guards
// against is a host change flipping the predicate and making every live cookie
// unreadable, and a reader that accepts either name simply cannot have it.
//
// `server-auth.ts` has read both names in production since it was written; this
// is the same posture, expressed once. The write path stays single-named —
// next-auth writes one cookie, and `__Secure-` may only be set over https
// (RFC 6265bis §4.1.3.1), so there is no dual write to be had.
//
// The cost is that a plain-named cookie minted during a misconfiguration window
// is honoured again. www is HSTS'd and the value is still a JWE validated
// against NEXTAUTH_SECRET, so the exposure is small — but it is why sign-out
// clears BOTH names (appendSignOutSessionCookieClears below). Revisit with the
// rest of the Vercel teardown, #4656.
export function sessionCookieNameCandidates(): readonly [string, string] {
  return isSecureCookieContext()
    ? [SECURE_SESSION_COOKIE_NAME, PLAIN_SESSION_COOKIE_NAME]
    : [PLAIN_SESSION_COOKIE_NAME, SECURE_SESSION_COOKIE_NAME];
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
  const secure = isSecureCookieContext();
  const clearedCookie = `${sessionCookieName()}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  response.headers.append('Set-Cookie', clearedCookie);
}

function sessionCookieClear(name: string, domain: string | undefined): string {
  // A `__Secure-` cookie is only accepted with the Secure attribute, whatever
  // isSecureCookieContext() says, so its deletion always carries one. Over http
  // the browser drops that Set-Cookie — correctly: no `__Secure-` cookie can
  // exist there to delete. The plain name follows the context instead, because
  // a Secure deletion sent over http would be dropped and dev sign-out would
  // stop clearing anything.
  const secure = name.startsWith('__Secure-') || isSecureCookieContext();
  return `${name}=; Path=/${domain ? `; Domain=${domain}` : ''}; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/**
 * Sign-out only. Deletes BOTH session cookie names, in every scope this
 * deployment could have written them in (Domain-scoped where a cookie domain
 * applies, plus host-only).
 *
 * Why both names: the read paths accept either (sessionCookieNameCandidates),
 * so clearing only the name the predicate currently picks would leave a cookie
 * behind that still authenticates — a logout bypass, and a worse one than the
 * legacy host-only cookie `appendLegacyHostOnlySessionCookieClear` was written
 * to close, because it survives indefinitely.
 *
 * Why this does NOT reuse that function: it returns early when
 * `sessionCookieDomain()` is undefined. That early return is correct there —
 * on a LOGIN response with no cookie domain in play, the "legacy" clear would
 * target the very cookie NextAuth just wrote. A sign-out writes no fresh
 * cookie, so there is nothing to protect, and inheriting the guard would emit
 * nothing at all on exactly the host-only deployments (local, previews, a
 * mis-enved container) where the other name is most likely to be the live one.
 */
export function appendSignOutSessionCookieClears(response: Response, requestCookieNames: readonly string[] = []): void {
  const domain = sessionCookieDomain();
  const namesToClear = new Set([SECURE_SESSION_COOKIE_NAME, PLAIN_SESSION_COOKIE_NAME]);
  // next-auth splits an oversized session cookie into `<name>.0`, `<name>.1`, …
  // and its SessionStore reassembles anything whose name startsWith the base
  // (next-auth/core/lib/cookie.js). Clearing only the base names would leave a
  // chunked session intact — and the fallback read would go on honouring it.
  // Pass the names the request actually carried so the chunk count never has to
  // be guessed.
  for (const cookieName of requestCookieNames) {
    for (const baseName of [SECURE_SESSION_COOKIE_NAME, PLAIN_SESSION_COOKIE_NAME]) {
      if (cookieName.startsWith(`${baseName}.`)) namesToClear.add(cookieName);
    }
  }
  for (const name of namesToClear) {
    response.headers.append('Set-Cookie', sessionCookieClear(name, undefined));
    if (domain) response.headers.append('Set-Cookie', sessionCookieClear(name, domain));
  }
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
