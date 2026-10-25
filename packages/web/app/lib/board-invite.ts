/**
 * A home board's share link: `/b/{slug}?invite={token}`.
 *
 * The owner hands it out from the app's Share sheet for a Followers or
 * Invite-only board. Confirming Join while signed in makes the climber an
 * approved member (`redeemBoardShareLink`); signed out, the page names the board and
 * asks for a sign-in that comes back to the same URL.
 *
 * The token is a capability, so it is kept out of everything that outlives
 * the request:
 * - shared caches: middleware, the TTL helpers and the Cloudflare rule all bypass it;
 * - analytics: `getPosthog` stays off on such a URL, and every event is scrubbed too;
 * - error reports.
 * The scrubbing for analytics and error reports lives in `share-capability.ts`,
 * which also covers a wall's `?wall=`.
 *
 * This module is pure and dependency-free, so the middleware, the client
 * analytics and the server page all read the token the same way.
 */

export const BOARD_INVITE_PARAM = 'invite';

/** 128 random bits in base64url without padding: always 22 characters. */
const INVITE_TOKEN_SHAPE = /^[A-Za-z0-9_-]{22}$/;

/**
 * The token a request presents, or `undefined`. Only one well-formed value
 * counts: a repeated param is not a capability, and a malformed one is never
 * sent to the backend.
 */
export function readBoardInviteToken(value: string | string[] | undefined | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  return INVITE_TOKEN_SHAPE.test(value) ? value : undefined;
}

/**
 * True for a `/b/...` request carrying a share link's token. Takes the
 * LOCALE-STRIPPED pathname, like the TTL helpers. Any value counts here, well
 * formed or not: the point is that no shared cache keys on it.
 */
export function isBoardInviteRequest(pathname: string, searchParams: URLSearchParams): boolean {
  return (pathname === '/b' || pathname.startsWith('/b/')) && searchParams.has(BOARD_INVITE_PARAM);
}

/**
 * An `invite=` pair, raw or percent-encoded in nested return URLs (a sign-in page's
 * `callbackUrl`). The value runs to the next separator, so inside an encoded
 * return URL the rest of that URL goes too; over-redacting is the safe side.
 */
const INVITE_PAIR = /(invite(?:=|%(?:25)*3D))[^&#\s"']*/gi;

/**
 * Whether a query string carries a share link's token, either as its own param
 * or inside an encoded return URL such as `/auth/login?callbackUrl=...`.
 */
export function searchCarriesBoardInvite(search: string): boolean {
  INVITE_PAIR.lastIndex = 0;
  return INVITE_PAIR.test(search);
}
