// Turns a shared Boardsesh link into the in-app path it names, for the links
// that point at a board or a climb: `/{board}/{layout}/{size}/{sets}/{angle}/…`
// and `/b/{slug}/…`.
//
// The deep-link provider uses it to keep a destination through sign-in (#6027).
// A signed-out climber who taps a shared climb is sent to the login screen by
// the auth gate, and until now the climb was gone by the time they got in:
// only `/join` and the retired `/preview` links were held on to. That is the
// path a new climber takes, tap a link, install, sign up, tap it again, so the
// one link that brought them in was the one the app forgot.
//
// What comes out of here is stored on the phone and later handed to the router,
// so it is rebuilt from validated pieces, never passed through:
// - only our own hosts and the app's scheme are read at all;
// - the first segment must be `b` or one of the nine board names;
// - the rest must be one of the shapes the app has a route for (list, view,
//   play), by the same matcher the browser app's auth gate uses;
// - of the query, only `wall` (as a uuid), `invite` (as a share-link token)
//   and the printed-code pair `src` + `medium` survive. A home board's share
//   link has to survive sign-in: it is how a new climber is meant to join a
//   friend's board, so dropping the token would land them on a board they
//   cannot open. The QR pair survives so the scan that brought a new installer
//   into the app is still counted once they sign in (#4415), and only as a pair
//   the strict `parseBoardQrLanding` accepts, rewritten to its canonical spelling.
// Pure and React-free so every rule is a unit test.

import {
  GYM_QR_MEDIUM_PARAM,
  GYM_QR_SRC_PARAM,
  GYM_QR_SRC_VALUE,
  parseBoardQrLanding,
  type GymQrSearchParams,
} from '@boardsesh/analytics';
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { parseDeepLinkQueryEntries } from '../deep-link-query';
import { isReadOnlyAnonymousPath, isSafeReturnPath } from './read-only-routes';
import { stripLocalePrefix } from './strip-locale-prefix';
import { BOARD_INVITE_PARAM, isBoardInviteToken } from '../board-share/board-share-link';

/** `https://www.boardsesh.com`, the apex, or the app's own scheme, up to where the path starts. */
const BOARDSESH_LINK_PREFIX = /^(?:https:\/\/(?:www\.)?boardsesh\.com(?=[/?#]|$)|com\.boardsesh\.app:\/\/)/i;

/** An unlisted spray wall's share link names the wall as `?wall={uuid}` (spray-share.ts). */
const WALL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const boardNames: ReadonlySet<string> = new Set<string>(SUPPORTED_BOARDS);

/**
 * `src` and `medium` as `parseBoardQrLanding` expects them, from the query's
 * decoded pairs. A name that appears twice becomes an array, which the parser
 * refuses: a duplicated param is a hand-edited URL, not a scan.
 */
function qrLandingParams(entries: ReadonlyArray<readonly [string, string]>): GymQrSearchParams {
  const params: GymQrSearchParams = {};
  for (const [name, value] of entries) {
    if (name !== GYM_QR_SRC_PARAM && name !== GYM_QR_MEDIUM_PARAM) continue;
    const earlier = params[name];
    params[name] = earlier === undefined ? value : [...(Array.isArray(earlier) ? earlier : [earlier]), value];
  }
  return params;
}

/**
 * The in-app path a board or climb link points at, or null when `url` is not
 * one: another host, a join link, a profile, a malformed path. A locale prefix
 * (`/es/kilter/…`) is dropped, because the app's route tree has none.
 */
export function parseBoardLinkPath(url: string | null | undefined): string | null {
  if (!url) return null;
  const prefix = BOARDSESH_LINK_PREFIX.exec(url);
  if (!prefix) return null;

  const afterHost = url.slice(prefix[0].length).split('#', 1)[0] ?? '';
  const queryIndex = afterHost.indexOf('?');
  const rawPath = queryIndex === -1 ? afterHost : afterHost.slice(0, queryIndex);
  // The custom scheme has no host, so its path starts without a slash
  // (`com.boardsesh.app://kilter/…`); a trailing slash names the same route.
  const slashedPath = `/${rawPath.replace(/^\/+/, '').replace(/\/+$/, '')}`;
  const path = stripLocalePrefix(slashedPath) ?? slashedPath;

  const firstSegment = path.split('/')[1];
  if (firstSegment === undefined || (firstSegment !== 'b' && !boardNames.has(firstSegment))) return null;
  if (!isReadOnlyAnonymousPath(path)) return null;

  // One decode of the query for every param read below. A repeated `wall` or
  // `invite` keeps its last copy; a repeated QR param is refused.
  const entries = queryIndex === -1 ? [] : parseDeepLinkQueryEntries(afterHost);
  const query = new Map(entries);
  const wallUuid = query.get('wall');
  const inviteToken = query.get(BOARD_INVITE_PARAM);
  const qrLanding = parseBoardQrLanding(qrLandingParams(entries));
  const kept = [
    wallUuid !== undefined && WALL_UUID.test(wallUuid) ? `wall=${wallUuid}` : null,
    isBoardInviteToken(inviteToken) ? `${BOARD_INVITE_PARAM}=${inviteToken}` : null,
    qrLanding ? `${GYM_QR_SRC_PARAM}=${GYM_QR_SRC_VALUE}&${GYM_QR_MEDIUM_PARAM}=${qrLanding.medium}` : null,
  ].filter((part): part is string => part !== null);
  const href = kept.length > 0 ? `${path}?${kept.join('&')}` : path;
  return isSafeReturnPath(href) ? href : null;
}

/**
 * Is `href` a path this module could have produced? The check a stored value
 * gets before it is handed to the router: what is on disk was written by an
 * older build, or by nothing we know of.
 */
export function isBoardLinkPath(href: string | null | undefined): href is string {
  if (!href || !href.startsWith('/')) return false;
  return parseBoardLinkPath(`https://www.boardsesh.com${href}`) === href;
}
