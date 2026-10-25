// Which printed code a board page was reached through, read in the browser
// (#4415).
//
// A board QR encodes `/b/{slug}?src=qr&medium=…`, and the `/b/{slug}` hop carries
// the pair onto `/b/{slug}/{angle}/list`. That list page is stored at the edge
// with a shared `s-maxage`, so its HTML cannot say whether THIS visit came off a
// code: the medium is read here, from the address bar, after the page loads.
//
// Two readers need it, and they run in an order nobody controls: the landing
// tracker, which counts the scan and then strips the pair from the address bar,
// and the store buttons, whose link id says `.board` after a scan. So the first
// read REMEMBERS the landing for the page it was made on, and every later read
// on that page gets the same answer after the strip. The parser is
// `parseBoardQrLanding` (`@boardsesh/analytics`): the gym funnel's strict one,
// narrowed to the two mediums a board code prints, so `medium=poster` on a
// board page is not a scan. Nothing here restates the vocabulary.

import { parseBoardQrLanding, type BoardQrMedium, type GymQrSearchParams } from '@boardsesh/analytics';

type RememberedLanding = { pathname: string; medium: BoardQrMedium };

// Memory, not storage, like `getSessionInboundCampaign`: a reload of the
// stripped URL is a new document with nothing to read, which is right, because
// a reload is not a second scan.
let rememberedLanding: RememberedLanding | undefined;

/**
 * A search string in the shape `parseGymQrLanding` reads, with a repeated param
 * kept as an array so the parser rejects it (`?medium=kiosk&medium=board` is a
 * mangled URL, not a scan) instead of one value being picked.
 */
export function searchToGymQrParams(search: string): GymQrSearchParams {
  const params: GymQrSearchParams = {};
  for (const [paramName, paramValue] of new URLSearchParams(search)) {
    const existing = params[paramName];
    if (existing === undefined) params[paramName] = paramValue;
    else params[paramName] = Array.isArray(existing) ? [...existing, paramValue] : [existing, paramValue];
  }
  return params;
}

/**
 * Capture a QR landing from the address bar, then return the printed medium
 * this page was reached through: `null` for a visit that did not come off a
 * code, and always `null` on the server.
 *
 * Not a pure read, on purpose. When the URL carries a valid pair it is stored
 * for this pathname, replacing any earlier landing, so a call after the
 * tracker's strip still gets the medium. Call it before stripping.
 *
 * The answer belongs to the page the code opened. A later client-side visit to
 * another page reads `null` there, and coming back to the scanned page reads
 * the medium again, which the tracker's own dedupe keeps from counting twice.
 */
export function captureBoardQrLandingMedium(): BoardQrMedium | null {
  if (typeof window === 'undefined') return null;
  const { pathname, search } = window.location;
  const landing = parseBoardQrLanding(searchToGymQrParams(search));
  if (landing) rememberedLanding = { pathname, medium: landing.medium };
  return rememberedLanding?.pathname === pathname ? rememberedLanding.medium : null;
}

/** Test-only: the remembered landing outlives every unmount. */
export function __resetBoardQrLandingForTests(): void {
  rememberedLanding = undefined;
}
