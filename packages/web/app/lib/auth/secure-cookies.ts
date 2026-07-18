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
