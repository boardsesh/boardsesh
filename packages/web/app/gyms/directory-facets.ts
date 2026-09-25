import { CATALOGUE_BOARD_TYPES } from '@boardsesh/board-constants';
import type { BoardName } from '@boardsesh/shared-schema';
import {
  appendGymBoardFilterParams,
  countSelectedSizeGroups,
  parseGymBoardFilter,
  setBoardTypesFilter,
  toggleBoardTypeFilter,
  type GymBoardFilter,
} from '@boardsesh/gym-filters';

/**
 * The four directory surfaces. `all` is `/gyms`; the other three are the only
 * board types with enough linked boards to justify their own indexable route
 * (moonboard ~2.6k, kilter ~1.8k, tension ~465 — DB-04 on #3666).
 *
 * These are LITERAL route folders, not a `[facet]` dynamic segment, and that is
 * the point: `/gyms/soill` is then a plain 404 with no runtime check to get
 * wrong, and the launch sitemap (#4381) has four static paths to enumerate
 * rather than a list it has to keep in sync with a regex.
 */
export const DIRECTORY_FACETS = ['all', 'kilter', 'moonboard', 'tension'] as const;
export type DirectoryFacet = (typeof DIRECTORY_FACETS)[number];

/** The clean, self-canonical base URL of each facet. Never carries a query string. */
export const FACET_BASE_PATHS: Record<DirectoryFacet, string> = {
  all: '/gyms',
  kilter: '/gyms/kilter',
  moonboard: '/gyms/moonboard',
  tension: '/gyms/tension',
};

/** Facets other than `all`, in the order they render. */
export const BOARD_FACETS = ['kilter', 'moonboard', 'tension'] as const;
export type BoardFacet = (typeof BOARD_FACETS)[number];

/** Cards per page. The issue's AC: the first 24 gyms are server-rendered. */
export const DIRECTORY_PAGE_SIZE = 24;

/**
 * Hard ceiling on `?page`. Deep pagination is a crawl trap and, past a few
 * hundred gyms, nobody pages by hand — they search.
 *
 * Anything above it is a `notFound()`, NOT a clamp. Clamping produced a 200
 * that contradicted itself: `?page=40` against a two-page list rendered the
 * empty state while the nav highlighted page 2, i.e. an unbounded supply of
 * 200-status empty URLs on a page we intend to make indexable.
 *
 * 40 x 24 = 960 gyms reachable by paging, against ~4,740 listed. That is a
 * deliberate cap on the crawl path, not on the catalog: the long tail is meant
 * to be reached through search and through #4381's sitemap, which enumerates
 * every gym directly.
 */
export const DIRECTORY_MAX_PAGE = 40;

/** Longest `?q` we pass through to the backend. */
const MAX_QUERY_LENGTH = 80;

const MIN_RADIUS_KM = 1;
const MAX_RADIUS_KM = 500;

/**
 * Board types the directory will accept as a `?boardType=` filter on `/gyms`.
 * Deliberately the whole vocabulary: the long-tail types (grasshopper, decoy,
 * soill, touchstone) are reachable ONLY this way — they get no standalone route
 * — and the three facets are here too so `/gyms?boardType=kilter` behaves
 * instead of silently dropping the filter.
 *
 * `CATALOGUE_BOARD_TYPES`, not every key of `BOARD_TYPE_LABELS`: `spray` has a
 * label but is not a board model a gym is found by, so it must not become a
 * directory facet or a `?boardType=` value.
 *
 * The parsing is done by `@boardsesh/gym-filters`, which reads the same
 * `CATALOGUE_BOARD_TYPES`. This stays exported as the directory's statement of
 * its own vocabulary — what the chip row renders, and what the tests pin.
 */
// The cast is the one place this package asserts the catalogue's own vocabulary
// is the `BoardName` union. `CATALOGUE_BOARD_TYPES` is typed `readonly string[]`
// upstream on purpose — `isCatalogueBoardType` fails OPEN so a board added
// without touching that file still renders its chips — but every value in the
// list is a BoardName, and the chip row needs to say so to call into the shared
// filter package without a cast at each site.
export const FILTERABLE_BOARD_TYPES = CATALOGUE_BOARD_TYPES as readonly BoardName[];

/** Next.js' `searchParams` shape: a repeated param arrives as an array. */
export type DirectorySearchParams = Record<string, string | string[] | undefined>;

/**
 * The directory's whole request: the shared board filter (`boardTypes`,
 * `layoutIds`, `sizeIds`, `angles`, `multiBoardTypeOnly` — see
 * `@boardsesh/gym-filters`) plus the four things only this page has.
 *
 * Flat rather than nested so the shared toggles apply to it directly: they are
 * generic over their carrier, so `setBoardTypesFilter(query, ['kilter'])` keeps
 * `page`, `query` and the coordinates untouched without this file unpacking and
 * rebuilding the board half.
 *
 * `boardTypes` is REQUIRED here (the shared type has it optional) because every
 * caller in this package reads `.length` on it and a facet route always has
 * exactly one. It is `BoardName[]`, not `string[]`: the parser already validates
 * against the catalogue, and typing it loosely only forced a cast at every call
 * into the shared package.
 */
export type DirectoryQuery = Omit<GymBoardFilter, 'boardTypes'> & {
  /** Display label only; coordinates determine the selected search area. */
  place?: string;
  /** Free-text search, trimmed and length-capped. Empty string means "no search". */
  query: string;
  /** Board types to filter on. Fixed to `[facet]` on a facet route. */
  boardTypes: BoardName[];
  /** Proximity origin. Both coordinates are present or both are null. */
  latitude: number | null;
  longitude: number | null;
  radiusKm: number | null;
  /** 1-based. */
  page: number;
};

function firstValue(raw: string | string[] | undefined): string | undefined {
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/** Directory coordinate precision: ~110 m, which is finer than any gym search needs. */
const COORDINATE_DECIMALS = 3;

function roundCoordinate(value: number | null): number | null {
  if (value === null) return null;
  const factor = 10 ** COORDINATE_DECIMALS;
  return Math.round(value * factor) / factor;
}

function parseFiniteNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Read the directory's query params off a request.
 *
 * Everything is validated rather than forwarded: a coordinate outside its real
 * range, a `page` of `-3`, a `boardType` nobody has ever built are all dropped
 * here so the page renders its clean default instead of the backend deciding
 * what a nonsense filter means.
 */
export function parseDirectoryQuery(facet: DirectoryFacet, searchParams: DirectorySearchParams): DirectoryQuery {
  const query = (firstValue(searchParams.q) ?? '').trim().slice(0, MAX_QUERY_LENGTH);

  // The whole board half — types, layouts, sizes, angles — comes from the shared
  // package, which validates each tier against the catalogue and drops what it
  // cannot place. A facet route IS its filter, so it is passed as the locked
  // board type: honouring `?boardType=` there would let
  // `/gyms/kilter?boardType=tension` render Tension gyms under a Kilter h1, and
  // locking it is also what unlocks the layout tier on `/gyms/kilter` with no
  // query param at all (one board type, which is what layouts need).
  const boardFilter = parseGymBoardFilter(
    searchParams,
    facet === 'all' ? {} : { lockedBoardTypes: [facet as BoardName] },
  );

  const latitude = parseFiniteNumber(firstValue(searchParams.lat));
  const longitude = parseFiniteNumber(firstValue(searchParams.lng));
  const hasValidOrigin =
    latitude !== null &&
    longitude !== null &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180;

  const rawRadius = parseFiniteNumber(firstValue(searchParams.radius));
  const radiusKm =
    hasValidOrigin && rawRadius !== null ? Math.min(Math.max(rawRadius, MIN_RADIUS_KM), MAX_RADIUS_KM) : null;

  // Floored and floored-at-one only. Deliberately NOT clamped at the top: a
  // page past the end has to reach the renderer so it can 404, because a clamp
  // serves a 200 whose URL and highlighted page number disagree. `?page=0`,
  // negatives and non-numeric all mean "page one" and are not errors.
  const rawPage = parseFiniteNumber(firstValue(searchParams.page));
  const page = rawPage === null ? 1 : Math.max(Math.floor(rawPage), 1);

  return {
    ...(hasValidOrigin && firstValue(searchParams.place)?.trim()
      ? { place: firstValue(searchParams.place)!.trim().slice(0, 200) }
      : {}),
    ...boardFilter,
    query,
    boardTypes: [...(boardFilter.boardTypes ?? [])],
    // Rounded to the same precision near-me mode already uses client-side
    // (`COORDINATE_DECIMALS` in near-me-model). Every other axis of this URL is
    // a bounded enumeration; a raw float is not, and `buildDirectoryHref` echoes
    // whatever it is handed, so an unrounded coordinate is an unbounded supply
    // of distinct cache keys for what is visibly the same search.
    latitude: hasValidOrigin ? roundCoordinate(latitude) : null,
    longitude: hasValidOrigin ? roundCoordinate(longitude) : null,
    radiusKm,
    page,
  };
}

/**
 * Rebuild a directory URL for a given page, keeping every other filter.
 *
 * Params are emitted in a fixed order so the same filter state always produces
 * the same string — one cache key, one crawlable URL, instead of one per
 * accidental ordering. `page=1` is omitted so page one and the clean base are
 * the same URL rather than two that canonicalise to each other.
 */
export function buildDirectoryHref(facet: DirectoryFacet, query: DirectoryQuery, page: number): string {
  const params = new URLSearchParams();

  if (query.query) {
    params.set('q', query.query);
  }
  // The board block, in the shared package's fixed order. Facet routes carry
  // their board type in the path, never in the query; layout, size and angle are
  // query-borne on every route, because a facet route pins the TYPE, not the wall.
  appendGymBoardFilterParams(params, query, { omitBoardTypes: facet !== 'all' });
  if (query.latitude !== null && query.longitude !== null) {
    if (query.place) params.set('place', query.place);
    params.set('lat', String(query.latitude));
    params.set('lng', String(query.longitude));
    if (query.radiusKm !== null) {
      params.set('radius', String(query.radiusKm));
    }
  }
  if (page > 1) {
    params.set('page', String(page));
  }

  const search = params.toString();
  return search ? `${FACET_BASE_PATHS[facet]}?${search}` : FACET_BASE_PATHS[facet];
}

/**
 * The URL a facet chip points at.
 *
 * Keeps the free text and the location, drops the board filter and the page.
 * Clicking "Kilter" from `/gyms?q=bristol` has to stay a search for Bristol —
 * silently throwing the search away turns a filter into a reset. Page resets
 * because page 3 of one filter has nothing to do with page 3 of another, and
 * the board filter is replaced rather than merged because that is what the chip
 * means: "All gyms" clears it, a board chip becomes it.
 */
export function buildFacetSwitchHref(target: DirectoryFacet, query: DirectoryQuery): string {
  // Through `setBoardTypesFilter`, not a bare spread: a Kilter `?layout=8` must
  // not ride onto `/gyms/moonboard`, where layout 8 is nothing at all.
  // `parseDirectoryQuery` would drop it on arrival anyway, but that costs an ugly
  // URL and a wasted cache entry for a filter the page never applies.
  const switched = setBoardTypesFilter(query, target === 'all' ? [] : [target as BoardName]);
  return buildDirectoryHref(target, { ...switched, boardTypes: [...(switched.boardTypes ?? [])], page: 1 }, 1);
}

/**
 * The href a board-type chip points at: the same search with that type toggled.
 *
 * Toggling, not replacing — which is what `buildFacetSwitchHref` below does for
 * the facet chips, and the reason both exist. A visitor narrowing to "Kilter or
 * Tension" is doing something the directory has always been able to answer
 * (`?boardType=` has always been repeatable); it was only ever the chip row that
 * could not express it.
 *
 * Routed through `setBoardTypesFilter`, so the layout/size/angle tiers clear
 * themselves whenever the selection stops being exactly one board type. Landing
 * on a facet route when the result is a single facet board type keeps the three
 * SEO pages as the canonical home of that search rather than minting a
 * `?boardType=kilter` twin of `/gyms/kilter`.
 */
export function buildBoardTypeToggleHref(facet: DirectoryFacet, query: DirectoryQuery, boardType: string): string {
  const toggled = toggleBoardTypeFilter(query, boardType as BoardName);
  const boardTypes = [...(toggled.boardTypes ?? [])].sort();
  const target: DirectoryFacet =
    boardTypes.length === 1 && (BOARD_FACETS as readonly string[]).includes(boardTypes[0])
      ? (boardTypes[0] as DirectoryFacet)
      : 'all';
  return buildDirectoryHref(target, { ...toggled, boardTypes, page: 1 }, 1);
}

/**
 * How many of the narrow filters are on — the number beside "Narrow it down",
 * and the test for whether to server-open the disclosure.
 *
 * Counts SELECTIONS, not tiers: two angles is two, because that is what the
 * visitor will look for when they wonder why the list is short. Board type is
 * excluded — it is the always-visible row above, not something the disclosure
 * is hiding.
 */
export function countNarrowFilters(query: DirectoryQuery): number {
  return (
    (query.layoutIds?.length ?? 0) +
    // Size CHIPS, not Aurora ids: one click on the Homewall's "10x10" selects
    // three ids, and reporting three would contradict the one chip the row
    // shows and the one entry the summary lists.
    countSelectedSizeGroups(query) +
    (query.angles?.length ?? 0) +
    (query.multiBoardTypeOnly ? 1 : 0)
  );
}

/**
 * Clear every narrow filter, keeping the board type, the text and the location.
 *
 * Deliberately not a reset to the facet base: a visitor who filtered to a 12x12
 * Kilter near Sydney and then clears is asking to widen the wall, not to throw
 * away where they are.
 */
export function buildClearFiltersHref(facet: DirectoryFacet, query: DirectoryQuery): string {
  return buildDirectoryHref(
    facet,
    { ...query, layoutIds: undefined, sizeIds: undefined, angles: undefined, multiBoardTypeOnly: undefined, page: 1 },
    1,
  );
}

/**
 * Whether this request is a SEARCH, in the sense `Gym Directory Searched`
 * means it (#4374: "on search/filter application").
 *
 * Three things it deliberately excludes, each of which would inflate the event
 * past usefulness:
 *
 *  - **A facet pageview.** On `/gyms/kilter` the board type IS the route, not a
 *    filter the visitor applied. Counting it made every facet pageview a search
 *    with `queryLength: 0`, which is most of the events on the page.
 *  - **Pagination.** `?page=N` is a full navigation, so the tracker remounts
 *    and fires again; page 2 of one search is not a second search.
 *  - **A bare `/gyms` visit.**
 *
 * What counts: free text, a location, or an explicit `?boardType=` on the
 * unfaceted route — the three things a visitor actually does to the list.
 */
export function isSearchApplication(facet: DirectoryFacet, query: DirectoryQuery): boolean {
  if (query.page !== 1) {
    return false;
  }
  if (query.query.length > 0 || query.latitude !== null) {
    return true;
  }
  // A layout, size or angle is a filter the visitor applied on ANY route,
  // including a facet one: `/gyms/kilter?layout=8` is a deliberate narrowing,
  // where the bare `/gyms/kilter` below is just a pageview. Deliberately its own
  // clause rather than folded into the `facet === 'all'` one, which would lose
  // every deep search made from a facet route.
  if (
    (query.layoutIds?.length ?? 0) > 0 ||
    (query.sizeIds?.length ?? 0) > 0 ||
    (query.angles?.length ?? 0) > 0 ||
    // The gym-level toggle is a filter application too. It is the only one a
    // visitor can apply with nothing else set, so leaving it out made
    // `?boards=2plus` on its own invisible to the funnel.
    query.multiBoardTypeOnly === true
  ) {
    return true;
  }
  return facet === 'all' && query.boardTypes.length > 0;
}

const EARTH_RADIUS_KM = 6371;

/**
 * Great-circle distance in km.
 *
 * Computed here rather than read off the API because `searchGyms` returns no
 * distance field, and the directory only ever needs it relative to an origin
 * the REQUEST supplied. Without `?lat`/`?lng` there is no origin, so there is
 * no distance — and a gym with a pin but no address then shows no location line
 * at all, which is correct. There is no city column to fall back on and a
 * synthesised locality would be a lie.
 */
export function distanceKm(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const deltaLat = toRadians(to.latitude - from.latitude);
  const deltaLng = toRadians(to.longitude - from.longitude);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(from.latitude)) * Math.cos(toRadians(to.latitude)) * Math.sin(deltaLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * The page numbers to render as anchors, plus the neighbours a crawler needs.
 * A window rather than every page: 200 numbered links is a crawl budget bonfire.
 */
export function paginationWindow(currentPage: number, totalPages: number, windowSize = 5): number[] {
  if (totalPages <= 1) return [];
  const half = Math.floor(windowSize / 2);
  let start = Math.max(1, currentPage - half);
  const end = Math.min(totalPages, start + windowSize - 1);
  start = Math.max(1, end - windowSize + 1);
  const pages: number[] = [];
  for (let page = start; page <= end; page += 1) {
    pages.push(page);
  }
  return pages;
}
