// Which code a board page or a climb page was reached through, read in the
// browser (#4415).
//
// Five kinds of landing share this module:
//
//  - **board**: a board QR encodes `/b/{slug}?src=qr&medium=…` (`kiosk` or
//    `board`), and the `/b/{slug}` hop carries the pair onto
//    `/b/{slug}/{angle}/list`.
//  - **climb**: the code beside "Open in your browser" on a laptop encodes the
//    climb page itself, `…/view/{climb}?src=qr&medium=desktop`.
//  - **list**: the same laptop code on a board's climb list encodes the list,
//    `…/{angle}/list?src=qr&medium=desktop`. On `/b/{slug}/{angle}/list` it
//    shares the page with the board codes; each kind reads only its own
//    mediums, so one scan is never both.
//  - **setter**, **playlist** and **home**: the same laptop code on a
//    setter's page (`/setter/{name}?src=qr&medium=desktop`), on a public
//    playlist (`/playlists/{uuid}?src=qr&medium=desktop`) and in the home
//    hero (`/?src=qr&medium=desktop`).
//
// Both pages are stored at the edge with a shared `s-maxage`, so their HTML
// cannot say whether THIS visit came off a code: the medium is read here, from
// the address bar, after the page loads.
//
// Two readers need it, and they run in an order nobody controls: the landing
// tracker, which counts the scan and then strips the pair from the address bar,
// and the store buttons, whose link id says `.board` or `.desktop` after a scan.
// So the first read REMEMBERS the landing for the page it was made on, and every
// later read on that page gets the same answer after the strip. The parsers are
// `parseBoardQrLanding` and `parseClimbQrLanding` (`@boardsesh/analytics`; a
// list's laptop code prints the climb code's `desktop`): the gym funnel's
// strict one, narrowed to the mediums each kind of code prints, so
// `medium=poster` on a board page is not a scan. Nothing here restates the
// vocabulary.

import {
  parseBoardQrLanding,
  parseClimbQrLanding,
  type BoardQrMedium,
  type ClimbQrMedium,
  type GymQrSearchParams,
} from '@boardsesh/analytics';

/** Which kind of code a page is landed on through. */
export type QrLandingKind = 'board' | 'climb' | 'list' | 'setter' | 'playlist' | 'home';

/** A landing with the medium its kind of code prints. */
export type QrLanding =
  | { kind: 'board'; medium: BoardQrMedium }
  | { kind: 'climb'; medium: ClimbQrMedium }
  | { kind: 'list'; medium: ClimbQrMedium }
  | { kind: 'setter'; medium: ClimbQrMedium }
  | { kind: 'playlist'; medium: ClimbQrMedium }
  | { kind: 'home'; medium: ClimbQrMedium };

/** Any medium a landing can carry, for a store link's id. */
export type QrLandingMedium = QrLanding['medium'];

type RememberedLanding = { pathname: string; landing: QrLanding };

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

function parseLanding(kind: QrLandingKind, params: GymQrSearchParams): QrLanding | null {
  if (kind === 'board') {
    const boardLanding = parseBoardQrLanding(params);
    return boardLanding ? { kind, medium: boardLanding.medium } : null;
  }
  // A board list's, a setter's, a playlist's and the home page's laptop code is
  // the climb page's code pointed at that page.
  const desktopLanding = parseClimbQrLanding(params);
  return desktopLanding ? { kind, medium: desktopLanding.medium } : null;
}

/**
 * Capture a landing of this kind from the address bar, then return it: `null`
 * for a visit that did not come off this kind of code, and always `null` on
 * the server.
 *
 * Not a pure read, on purpose. When the URL carries a valid pair it is stored
 * for this pathname, replacing any earlier landing, so a call after the
 * tracker's strip still gets the medium. Call it before stripping.
 *
 * The answer belongs to the page the code opened. A later client-side visit to
 * another page reads `null` there, and coming back to the scanned page reads
 * the medium again, which the tracker's own dedupe keeps from counting twice.
 */
export function captureQrLanding(kind: QrLandingKind): QrLanding | null {
  if (typeof window === 'undefined') return null;
  const { pathname, search } = window.location;
  const landing = parseLanding(kind, searchToGymQrParams(search));
  if (landing) rememberedLanding = { pathname, landing };
  if (rememberedLanding?.pathname !== pathname || rememberedLanding.landing.kind !== kind) return null;
  return rememberedLanding.landing;
}

/** The medium of `captureQrLanding`, for a store link's id or a scan-only line. */
export function captureQrLandingMedium(kind: QrLandingKind): QrLandingMedium | null {
  return captureQrLanding(kind)?.medium ?? null;
}

/** Test-only: the remembered landing outlives every unmount. */
export function __resetQrLandingForTests(): void {
  rememberedLanding = undefined;
}
