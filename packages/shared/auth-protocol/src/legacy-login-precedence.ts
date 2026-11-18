/**
 * Which login a browser is in when it holds a first-party session cookie and a
 * legacy NextAuth cookie (#7596). The first-party cookie wins, except when the
 * legacy cookie is a NEWER login: a login made while the browser mode was
 * `legacy` (a rollback) wrote only the legacy cookie and left the older
 * first-party cookie in place.
 *
 * - Beside a LOGIN cookie: the legacy cookie names another session id (or
 *   none), and its sign-in time (`auth_time`, else the cookie's issue time
 *   `iat`, both in seconds) is later than the session's `authenticatedAt`.
 *   An unknown `authenticatedAt` keeps the login cookie.
 * - Beside a BRIDGED cookie: the legacy cookie has a string `authSessionId`
 *   that differs from the bridged session's. No time test: a bridged row's
 *   time is often unknown, and its id is the claim of the cookie it was
 *   bridged from. A cookie without the claim never wins.
 *
 * The kind comes from the cookie's NAME, never from the session's `source`
 * (a carried login reads as `bridge`). Only the legacy cookie name the
 * deployment writes may be considered; the caller filters that.
 *
 * One rule for www (the session read, B2b) and the backend (partner consent,
 * B6); `LEGACY_LOGIN_PRECEDENCE_VECTORS` pins both.
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

/** Which first-party cookie the session came from, by its name. */
export type FirstPartyCookieKind = 'login' | 'bridged';

export function isNewerLegacyLogin(
  legacy: LegacyLoginClaims,
  active: FirstPartyLogin,
  cookieKind: FirstPartyCookieKind,
): boolean {
  if (cookieKind === 'login' && active.authenticatedAt === null) return false;
  const legacySessionId = typeof legacy.authSessionId === 'string' ? legacy.authSessionId : undefined;
  if (legacySessionId === active.authSessionId) return false;
  if (cookieKind === 'bridged') return legacySessionId !== undefined;
  const signedInAt = typeof legacy.authTime === 'number' ? legacy.authTime : legacy.issuedAt;
  if (typeof signedInAt !== 'number' || !Number.isFinite(signedInAt) || active.authenticatedAt === null) return false;
  const activeSignedInAt =
    active.authenticatedAt instanceof Date ? active.authenticatedAt.getTime() : Date.parse(active.authenticatedAt);
  if (!Number.isFinite(activeSignedInAt)) return false;
  return signedInAt * 1000 > activeSignedInAt;
}
