import { BOARD_TYPE_LABELS } from '@boardsesh/board-constants';

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
 */
export const FILTERABLE_BOARD_TYPES: readonly string[] = Object.keys(BOARD_TYPE_LABELS);

/** Next.js' `searchParams` shape: a repeated param arrives as an array. */
export type DirectorySearchParams = Record<string, string | string[] | undefined>;

export type DirectoryQuery = {
  /** Free-text search, trimmed and length-capped. Empty string means "no search". */
  query: string;
  /** Board types to filter on. Fixed to `[facet]` on a facet route. */
  boardTypes: string[];
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

function allValues(raw: string | string[] | undefined): string[] {
  if (Array.isArray(raw)) return raw;
  return raw === undefined ? [] : [raw];
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

  // A facet route IS its filter. Honouring `?boardType=` there would let
  // `/gyms/kilter?boardType=tension` render Tension gyms under a Kilter h1.
  const boardTypes =
    facet === 'all'
      ? [...new Set(allValues(searchParams.boardType).map((value) => value.trim().toLowerCase()))].filter((value) =>
          FILTERABLE_BOARD_TYPES.includes(value),
        )
      : [facet];

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
    query,
    boardTypes: boardTypes.sort(),
    latitude: hasValidOrigin ? latitude : null,
    longitude: hasValidOrigin ? longitude : null,
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
  // Facet routes carry their board type in the path, never in the query.
  if (facet === 'all') {
    for (const boardType of query.boardTypes) {
      params.append('boardType', boardType);
    }
  }
  if (query.latitude !== null && query.longitude !== null) {
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
  return buildDirectoryHref(target, { ...query, boardTypes: target === 'all' ? [] : [target], page: 1 }, 1);
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
