import type { Climb } from '@boardsesh/queue';
import {
  fetchPlaylistPageWithRetry,
  PlaylistDrainWaitBudgetError,
  PLAYLIST_DRAIN_MAX_TOTAL_WAIT_MS,
  type CreatePageRetryPolicy,
  type DrainSleep,
  type DrainWaitBudget,
} from './drain-playlist-pages';

export const PLAYLIST_SUGGESTION_REFRESH_PAGE_SIZE = 100;
const MAX_PLAYLIST_SUGGESTION_REFRESH_PAGES = 10;
// Soft cap on the prefetched next-up swipe buffer per activation. Once the
// user swipes past the last loaded suggestion, the feed currently goes silent
// instead of paging the next batch in — tracked for follow-up as
// https://github.com/boardsesh/boardsesh/issues/2216 (infinite-scroll past
// the cap). Until then, 250 is enough for a full session for typical playlist
// sizes without burning a 10-page fetch on every activation.
const MAX_PLAYLIST_SUGGESTION_REFRESH_CLIMBS_AFTER_ACTIVE = 250;

type FetchPlaylistSuggestionPageArgs = {
  page: number;
  pageSize: number;
  signal: AbortSignal;
};

type PlaylistSuggestionPage = {
  climbs: Climb[];
  hasMore: boolean;
};

export function isAbortError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const abortCandidate = err as { name?: unknown; code?: unknown };
  return abortCandidate.name === 'AbortError' || abortCandidate.code === 20;
}

export async function fetchPlaylistSuggestionClimbs({
  activatedClimbUuid,
  signal,
  fetchPage,
  pageSize = PLAYLIST_SUGGESTION_REFRESH_PAGE_SIZE,
  maxPages = MAX_PLAYLIST_SUGGESTION_REFRESH_PAGES,
  maxClimbsAfterActivated = MAX_PLAYLIST_SUGGESTION_REFRESH_CLIMBS_AFTER_ACTIVE,
  createPageRetryPolicy,
  maxTotalWaitMs = PLAYLIST_DRAIN_MAX_TOTAL_WAIT_MS,
  sleep,
}: {
  activatedClimbUuid: string;
  signal: AbortSignal;
  fetchPage: (args: FetchPlaylistSuggestionPageArgs) => Promise<PlaylistSuggestionPage>;
  pageSize?: number;
  maxPages?: number;
  maxClimbsAfterActivated?: number;
  /**
   * Optional per-page retry policy factory. Omitted (the default) this helper
   * behaves exactly as it always has: the first rejection propagates and
   * nothing sleeps. Callers that share a rate-limited server bucket opt in so a
   * single throttled or dropped page doesn't kill the whole refresh.
   */
  createPageRetryPolicy?: CreatePageRetryPolicy;
  /**
   * Wall-clock ceiling on everything this refresh may SLEEP across all of its
   * pages. Without it a 10-page walk against a throttled bucket could stay
   * pending for minutes on a fire-and-forget prefetch; with it the refresh
   * stops early and returns the climbs it already has.
   */
  maxTotalWaitMs?: number;
  /** Injectable sleep for tests; defaults to an abortable setTimeout. */
  sleep?: DrainSleep;
}): Promise<Climb[]> {
  const fetchedClimbs: Climb[] = [];
  // One budget for the whole walk, not per page.
  const waitBudget: DrainWaitBudget = { remainingMs: maxTotalWaitMs };
  let page = 0;
  let hasMore = true;
  let activatedClimbSeen = false;
  let loadedClimbsAfterActivated = 0;

  while (hasMore && page < maxPages && loadedClimbsAfterActivated < maxClimbsAfterActivated && !signal.aborted) {
    let pageResult: PlaylistSuggestionPage;
    try {
      pageResult = await fetchPlaylistPageWithRetry({
        fetchPage,
        page,
        pageSize,
        signal,
        shouldRetryPage: createPageRetryPolicy?.(),
        sleep,
        waitBudget,
      });
    } catch (error) {
      // Out of wait budget: the swipe track is a prefetch, so stop with what we
      // have instead of failing the refresh on an internal signal. Every other
      // rejection still propagates the way it always has.
      if (error instanceof PlaylistDrainWaitBudgetError) break;
      throw error;
    }

    for (const pageClimb of pageResult.climbs) {
      if (pageClimb.uuid === activatedClimbUuid) {
        activatedClimbSeen = true;
        continue;
      }
      if (activatedClimbSeen) {
        loadedClimbsAfterActivated += 1;
      }
    }

    fetchedClimbs.push(...pageResult.climbs);
    hasMore = pageResult.hasMore;
    page += 1;
  }

  return fetchedClimbs;
}
