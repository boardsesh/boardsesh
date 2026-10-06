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
// - of the query, only `wall` survives, and only as a uuid.
// Pure and React-free so every rule is a unit test.

import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { parseDeepLinkQueryParams } from '../deep-link-query';
import { isReadOnlyAnonymousPath, isSafeReturnPath } from './read-only-routes';
import { stripLocalePrefix } from './strip-locale-prefix';

/** `https://www.boardsesh.com`, the apex, or the app's own scheme, up to where the path starts. */
const BOARDSESH_LINK_PREFIX = /^(?:https:\/\/(?:www\.)?boardsesh\.com(?=[/?#]|$)|com\.boardsesh\.app:\/\/)/i;

/** An unlisted spray wall's share link names the wall as `?wall={uuid}` (spray-share.ts). */
const WALL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const boardNames: ReadonlySet<string> = new Set<string>(SUPPORTED_BOARDS);

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

  const wallUuid = queryIndex === -1 ? undefined : parseDeepLinkQueryParams(afterHost).get('wall');
  const href = wallUuid !== undefined && WALL_UUID.test(wallUuid) ? `${path}?wall=${wallUuid}` : path;
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
