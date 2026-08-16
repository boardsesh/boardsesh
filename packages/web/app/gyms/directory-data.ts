import 'server-only';
import * as Sentry from '@sentry/nextjs';
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

/**
 * A page of results, or an explicit failure.
 *
 * `ok: false` is a distinct outcome from an empty page, and keeping them apart
 * is the whole point of this type. Collapsing a timeout into `totalCount: 0`
 * rendered a fully-formed, confident directory whose lead paragraph read "0
 * gyms have a board listed on Boardsesh" — a false statement about the
 * catalogue, delivered with no hint anything went wrong. It also made a real
 * empty page indistinguishable from an outage, so the out-of-range `?page`
 * check could not tell "past the end" from "backend down" and would have 404ed
 * every page during an incident.
 */
export type DirectoryPageResult = { ok: true; gyms: GymDirectoryCard[]; totalCount: number } | { ok: false };

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

function reportDirectoryFailure(operation: string, error: unknown): void {
  console.error(`${operation} failed:`, error);
  // The flag module reports its own failures; so does this one. A directory
  // that quietly serves "0 gyms" during an outage is exactly the class of bug
  // nobody files, because the page looks fine.
  Sentry.captureException(error, { tags: { surface: 'gym-directory', operation } });
}

/**
 * One page of directory results. One request per page view — no drain-until-
 * done loop, here or in the client.
 */
export async function fetchDirectoryPage(query: DirectoryQuery): Promise<DirectoryPageResult> {
  const offset = (query.page - 1) * DIRECTORY_PAGE_SIZE;

  try {
    const response = await runDirectoryQuery({ input: toSearchGymsInput(query, offset, DIRECTORY_PAGE_SIZE) });
    const connection = response.searchGyms;
    return {
      ok: true,
      // A slugless gym cannot be linked. `requireSlug` should already have
      // excluded it; this is the render-side belt to that braces.
      gyms: connection.gyms.filter((gym) => Boolean(gym.slug)),
      totalCount: connection.totalCount,
    };
  } catch (error) {
    reportDirectoryFailure('fetchDirectoryPage', error);
    return { ok: false };
  }
}

export type FacetCounts = Record<DirectoryFacet, number>;
export type FacetCountsResult = { ok: true; counts: FacetCounts } | { ok: false };

async function fetchFacetTotal(boardTypes: string[]): Promise<number | null> {
  try {
    const response = await runFacetCountQuery({
      input: {
        ...(boardTypes.length > 0 ? { boardTypes } : {}),
        requireSlug: true,
        // `totalCount` is what we're after; one row is the cheapest page the
        // connection will hand back. It is still a full enriched row that gets
        // thrown away — see the note on `fetchFacetCounts`.
        limit: 1,
        offset: 0,
      },
    });
    return response.searchGyms.totalCount;
  } catch (error) {
    reportDirectoryFailure('fetchFacetTotal', error);
    return null;
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
 *
 * COST, known and accepted for now: four `searchGyms` calls that each enrich a
 * row they discard, purely to read `totalCount`. Cached for 15 minutes and
 * shared across every visitor and every page, so it is four queries per cold
 * render, not per request. A count-only backend path would remove them; it is
 * not worth a GraphQL addition in this PR.
 *
 * A single failed total fails the whole set rather than showing three real
 * numbers next to a fabricated zero.
 */
export async function fetchFacetCounts(): Promise<FacetCountsResult> {
  // Spelled out rather than mapped over BOARD_FACETS so the destructuring is a
  // real tuple and a renamed facet is a compile error, not a silent zero.
  const [all, kilter, moonboard, tension] = await Promise.all([
    fetchFacetTotal([]),
    fetchFacetTotal(['kilter']),
    fetchFacetTotal(['moonboard']),
    fetchFacetTotal(['tension']),
  ]);

  if (all === null || kilter === null || moonboard === null || tension === null) {
    return { ok: false };
  }

  return { ok: true, counts: { all, kilter, moonboard, tension } };
}
