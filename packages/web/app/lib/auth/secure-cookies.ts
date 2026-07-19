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
  const secure = isSecureCookieContext();
  const clearedCookie = `${sessionCookieName()}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  response.headers.append('Set-Cookie', clearedCookie);
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
