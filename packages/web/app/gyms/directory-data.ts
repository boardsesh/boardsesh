import 'server-only';
import {
  SEARCH_GYMS_DIRECTORY,
  type GymDirectoryCard,
  type SearchGymsDirectoryQueryResponse,
} from '@boardsesh/graphql/operations';
import type { SearchGymsInput } from '@boardsesh/shared-schema';
import { createCachedGraphQLQuery } from '@/app/lib/graphql/server-cached-client';
import { DIRECTORY_PAGE_SIZE, type DirectoryFacet, type DirectoryQuery } from './directory-facets';

const DIRECTORY_CACHE_TAG = 'gym-directory';
const FACET_COUNT_CACHE_TAG = 'gym-directory-facet-counts';

/**
 * The catalog moves when a gym is added or a board is linked, i.e. a handful of
 * times a day. Five minutes keeps the page off the backend for a crawl without
 * making a new gym wait for a deploy to show up.
 */
const DIRECTORY_REVALIDATE_SECONDS = 300;
const FACET_COUNT_REVALIDATE_SECONDS = 900;

/** A wedged backend must cost a degraded page, not a hung request. */
const DIRECTORY_TIMEOUT_MS = 4_000;

export type DirectoryPage = {
  gyms: GymDirectoryCard[];
  totalCount: number;
  hasMore: boolean;
};

const EMPTY_PAGE: DirectoryPage = { gyms: [], totalCount: 0, hasMore: false };

const runDirectoryQuery = createCachedGraphQLQuery<SearchGymsDirectoryQueryResponse, { input: SearchGymsInput }>(
  SEARCH_GYMS_DIRECTORY,
  DIRECTORY_CACHE_TAG,
  DIRECTORY_REVALIDATE_SECONDS,
  DIRECTORY_TIMEOUT_MS,
);

// Same document, separate cache tag and a longer revalidate: the four facet
// totals are identical for every visitor and every page of results, so they
// should not be evicted every time somebody types a new search.
const runFacetCountQuery = createCachedGraphQLQuery<SearchGymsDirectoryQueryResponse, { input: SearchGymsInput }>(
  SEARCH_GYMS_DIRECTORY,
  FACET_COUNT_CACHE_TAG,
  FACET_COUNT_REVALIDATE_SECONDS,
  DIRECTORY_TIMEOUT_MS,
);

/**
 * Translate the parsed request into `SearchGymsInput`.
 *
 * `requireSlug` is the directory's whole reason for existing on this input:
 * every card links to `/gym/[slug]`, so a slugless row would render an anchor
 * to `/gym/undefined`. `searchGyms` already filters `is_public` and
 * `deleted_at IS NULL` (which covers merged twins — merging always sets it).
 */
export function toSearchGymsInput(query: DirectoryQuery, offset: number, limit: number): SearchGymsInput {
  return {
    ...(query.query ? { query: query.query } : {}),
    ...(query.boardTypes.length > 0 ? { boardTypes: query.boardTypes } : {}),
    ...(query.latitude !== null && query.longitude !== null
      ? { latitude: query.latitude, longitude: query.longitude }
      : {}),
    ...(query.radiusKm !== null ? { radiusKm: query.radiusKm } : {}),
    requireSlug: true,
    limit,
    offset,
  };
}

/**
 * One page of directory results. One request per page view — no drain-until-
 * `hasMore` loop, here or in the client.
 */
export async function fetchDirectoryPage(query: DirectoryQuery): Promise<DirectoryPage> {
  const offset = (query.page - 1) * DIRECTORY_PAGE_SIZE;

  try {
    const response = await runDirectoryQuery({ input: toSearchGymsInput(query, offset, DIRECTORY_PAGE_SIZE) });
    const connection = response.searchGyms;
    return {
      // A slugless gym cannot be linked. `requireSlug` should already have
      // excluded it; this is the render-side belt to that braces.
      gyms: connection.gyms.filter((gym) => Boolean(gym.slug)),
      totalCount: connection.totalCount,
      hasMore: connection.hasMore,
    };
  } catch (error) {
    console.error('fetchDirectoryPage failed:', error);
    return EMPTY_PAGE;
  }
}

export type FacetCounts = Record<DirectoryFacet, number>;

const EMPTY_FACET_COUNTS: FacetCounts = { all: 0, kilter: 0, moonboard: 0, tension: 0 };

async function fetchFacetTotal(boardTypes: string[]): Promise<number> {
  try {
    const response = await runFacetCountQuery({
      input: {
        ...(boardTypes.length > 0 ? { boardTypes } : {}),
        requireSlug: true,
        // `totalCount` is what we're after; one row is the cheapest non-zero
        // page the connection will hand back.
        limit: 1,
        offset: 0,
      },
    });
    return response.searchGyms.totalCount;
  } catch (error) {
    console.error('fetchFacetTotal failed:', error);
    return 0;
  }
}

/**
 * Live counts for the four facets.
 *
 * These count GYMS, one `totalCount` per board type — not boards. DB-04's
 * board-mix numbers (moonboard 2,586 / kilter 1,786 / tension 465) count
 * BOARDS and will not match what renders here; that is expected and the two are
 * not meant to be reconciled. The `countHint` string on the page says so to
 * readers as well.
 */
export async function fetchFacetCounts(): Promise<FacetCounts> {
  // Spelled out rather than mapped over BOARD_FACETS so the destructuring is a
  // real tuple and a renamed facet is a compile error, not a silent zero.
  const [all, kilter, moonboard, tension] = await Promise.all([
    fetchFacetTotal([]),
    fetchFacetTotal(['kilter']),
    fetchFacetTotal(['moonboard']),
    fetchFacetTotal(['tension']),
  ]);

  return { ...EMPTY_FACET_COUNTS, all, kilter, moonboard, tension };
}
