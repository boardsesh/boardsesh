// The www poster page a `/poster/...` link that reached the app points at.
//
// `/poster/*` is a print page on www, and the iOS association file stopped
// claiming it (#6778). A phone refetches that file about once a week, so until
// then a poster link tapped in Mail or Messages can still open the app, which
// has no such screen. `app/poster/[...rest].tsx` hands the same URL to the
// in-app browser; this rebuilds it from what the router parsed.

import { WEB_BASE_URL } from '../env';

/** What Expo Router hands the catch-all: the segments as `rest`, every query param by name. */
export type PosterRouteParams = Record<string, string | string[] | undefined>;

/** An unlisted Spraywall's capability, as its share link carries it (spray-share.ts). */
const WALL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The print layouts the www poster page offers. */
const POSTER_LAYOUTS: ReadonlySet<string> = new Set(['photo', 'plain', 'cards']);

function asList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** A param the page reads, given once. A repeated one is a hand-edited URL and is dropped. */
function single(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * The www URL for a `/poster/...` route, on `WEB_BASE_URL` whatever host the
 * link came in on. The router hands the segments back decoded, so they are
 * encoded again; empty and dot segments are dropped, since they name no page.
 *
 * Only the two params the poster page reads survive, and only in their known
 * shapes: `wall` as a uuid and `layout` as one of the page's layouts. Anything
 * else on the link stays behind.
 */
export function posterPageUrlFromRoute(params: PosterRouteParams): string {
  const segments = asList(params.rest)
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .map(encodeURIComponent);
  const wall = single(params.wall);
  const layout = single(params.layout);
  const query = [
    wall !== null && WALL_UUID.test(wall) ? `wall=${wall.toLowerCase()}` : null,
    layout !== null && POSTER_LAYOUTS.has(layout) ? `layout=${layout}` : null,
  ].filter((part): part is string => part !== null);
  const path = segments.length > 0 ? `/poster/${segments.join('/')}` : '/poster';
  return `${WEB_BASE_URL}${path}${query.length > 0 ? `?${query.join('&')}` : ''}`;
}
