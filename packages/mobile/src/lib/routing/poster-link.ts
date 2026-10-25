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

function asList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * The www URL for a `/poster/...` route, on `WEB_BASE_URL` whatever host the
 * link came in on. The router hands the segments and values back decoded, so
 * both are encoded again. Empty and dot segments are dropped: they name no page.
 */
export function posterPageUrlFromRoute(params: PosterRouteParams): string {
  const segments = asList(params.rest)
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .map(encodeURIComponent);
  const query = Object.entries(params)
    .filter(([name]) => name !== 'rest')
    .flatMap(([name, value]) =>
      asList(value).map((entry) => `${encodeURIComponent(name)}=${encodeURIComponent(entry)}`),
    );
  const path = segments.length > 0 ? `/poster/${segments.join('/')}` : '/poster';
  return `${WEB_BASE_URL}${path}${query.length > 0 ? `?${query.join('&')}` : ''}`;
}
