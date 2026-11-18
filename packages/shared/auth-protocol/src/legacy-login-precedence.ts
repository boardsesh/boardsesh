/**
 * Which login a browser is in when it holds both a first-party session cookie
 * and a legacy NextAuth cookie (#7596). The first-party cookie wins, except
 * when the legacy cookie is a NEWER login: a login made while the browser mode
 * was `legacy` (a rollback) leaves the older first-party cookie in place.
 *
 * Newer means: the session's sign-in time is known, the legacy cookie names
 * another session id (or none), and its sign-in time (`auth_time`, else the
 * cookie's issue time `iat`, both in seconds) is later than the session's.
 * Anything unknown or malformed keeps the first-party cookie.
 *
 * One rule for www (the session read, B2b) and the backend (partner consent,
 * B6), so both pick the same login for the same browser.
 */
export interface LegacyLoginClaims {
  /** The cookie's `authSessionId` claim, as decoded. */
  readonly authSessionId: unknown;
  /** The cookie's `auth_time` claim, in seconds, as decoded. */
  readonly authTime: unknown;
  /** The cookie's `iat` claim, in seconds, as decoded. */
  readonly issuedAt: unknown;
}

export interface FirstPartyLogin {
  readonly authSessionId: string;
  /** The session's sign-in time: an ISO string, a Date, or null when unknown. */
  readonly authenticatedAt: string | Date | null;
}

export function isNewerLegacyLogin(legacy: LegacyLoginClaims, active: FirstPartyLogin): boolean {
  if (active.authenticatedAt === null) return false;
  const activeSignedInAt =
    active.authenticatedAt instanceof Date ? active.authenticatedAt.getTime() : Date.parse(active.authenticatedAt);
  if (!Number.isFinite(activeSignedInAt)) return false;
  if (typeof legacy.authSessionId === 'string' && legacy.authSessionId === active.authSessionId) return false;
  const signedInAt = typeof legacy.authTime === 'number' ? legacy.authTime : legacy.issuedAt;
  if (typeof signedInAt !== 'number' || !Number.isFinite(signedInAt)) return false;
  return signedInAt * 1000 > activeSignedInAt;
}
