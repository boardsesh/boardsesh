import type { Climb } from '@boardsesh/queue';

export const PLAYLIST_SUGGESTION_REFRESH_PAGE_SIZE = 100;
const MAX_PLAYLIST_SUGGESTION_REFRESH_PAGES = 10;
// Soft cap on the prefetched next-up swipe buffer per activation. Once the
// user swipes past the last loaded suggestion, the feed currently goes silent
// instead of paging the next batch in — tracked for follow-up as
// https://github.com/boardsesh/boardsesh/issues/2216 (infinite-scroll past
// the cap). Until then, 250 is enough for a full session for typical playlist
// sizes without burning a 10-page fetch on every activation.
const MAX_PLAYLIST_SUGGESTION_REFRESH_CLIMBS_AFTER_ACTIVE = 250;

// Runaway bound for the queue-replacement drain, NOT a product feature.
// Nothing on the server should get near it today: the four RECOMMENDED_* smart
// playlists are clamped to 6 pages by MAX_RECOMMENDATION_OFFSET, and both the
// logbook branch and `playlistClimbs` derive `hasMore` from real row counts. It
// exists so the next paging defect degrades into a short queue instead of
// draining until a rate limiter says stop — CLAUDE.md's mobile performance
// checklist bans drain-until-`hasMore` outright. Hitting it is a bug, so the
// mobile caller reports it to Sentry rather than telling the climber.
export const MAX_PLAYLIST_QUEUE_REPLACE_PAGES = 30;

// One retry per page. A dropped fetch on gym wifi recovers on the second try;
// a third almost never lands and just doubles the time to the error toast.
export const PLAYLIST_PAGE_MAX_ATTEMPTS = 2;
const PLAYLIST_PAGE_RETRY_DELAY_MS = 600;
const PLAYLIST_PAGE_RETRY_JITTER_MS = 250;
// A rate limit asking for longer than this is handed to the climber instead of
// held behind a spinner. The server hands out waits of up to 60 s.
export const PLAYLIST_RATE_LIMIT_MAX_WAIT_MS = 3_000;

type FetchPlaylistSuggestionPageArgs = {
  page: number;
  pageSize: number;
  signal: AbortSignal;
};

type PlaylistSuggestionPage = {
  climbs: Climb[];
  hasMore: boolean;
};

export type PlaylistDrainStopReason =
  /** The server said `hasMore: false`. The list is whole. */
  | 'complete'
  /** A client-side cap stopped a server that still had more to give. */
  | 'page-cap'
  /** A page added no climbs we had not already seen. The server is repeating itself. */
  | 'no-progress'
  /** The caller aborted between pages. */
  | 'aborted';

export type PlaylistDrainResult = {
  climbs: Climb[];
  stopReason: PlaylistDrainStopReason;
  pagesFetched: number;
};

export type DrainPlaylistPagesArgs = {
  fetchPage: (args: FetchPlaylistSuggestionPageArgs) => Promise<PlaylistSuggestionPage>;
  signal: AbortSignal;
  pageSize: number;
  /** Required. There is deliberately no default that means "unlimited". */
  maxPages: number;
  /**
   * True when the error is a transient transport failure worth one more try.
   * Injected so this package needs no dependency on `@boardsesh/offline-sync`
   * (which web does not have); mobile passes `isTransportNetworkError`.
   * Defaults to never retrying — a caller that wants retries must ask for them.
   */
  isRetryable?: (error: unknown) => boolean;
  /**
   * Seconds the server asked us to wait, or null when this is not a rate limit.
   * Injected for the same reason; mobile passes `parseRateLimitError`.
   */
  parseRetryAfterSeconds?: (error: unknown) => number | null;
  /**
   * Stop the drain after this page even though the server has more. Receives the
   * climbs this page actually added (duplicates already filtered out).
   *
   * Only called while `hasMore` is still true — on the final page the drain is
   * ending anyway, so there is nothing left to stop. Do not use it as a
   * see-every-page hook: it will miss the last one.
   */
  stopAfterPage?: (newClimbs: Climb[]) => boolean;
  /** Injectable so tests do not wait on real timers. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Injectable so retry jitter is deterministic under test. */
  random?: () => number;
};

export function isAbortError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const abortCandidate = err as { name?: unknown; code?: unknown };
  return abortCandidate.name === 'AbortError' || abortCandidate.code === 20;
}

function createAbortError(): Error {
  const abortError = new Error('Playlist page drain aborted');
  abortError.name = 'AbortError';
  return abortError;
}

/**
 * `setTimeout` that loses to its abort signal.
 *
 * Load-bearing: without the abort listener a cancelled activation sits out its
 * retry delay and then replaces a queue the climber has already moved on from.
 * The timer is cleared on abort so nothing fires late.
 *
 * `packages/sync-runtime/src/daemon.ts` has an equivalent `sleepWithAbort`, but
 * that package is daemon-side and pulling it into the RN/web bundle graph for
 * twelve lines is the wrong trade. A third caller should extract these into a
 * shared async-utils package.
 */
function defaultAbortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(createAbortError());
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      reject(createAbortError());
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Page through a playlist until the server runs out, something stops making
 * progress, or a bound is hit — retrying only what is worth retrying.
 *
 * Retry policy, in order of precedence:
 *   1. abort wins over everything and is never retried;
 *   2. a short `RATE_LIMITED` is waited out and the same page re-issued; a long
 *      one is rethrown so the climber gets an answer instead of a spinner;
 *   3. a transport failure (`isRetryable`) gets one more attempt;
 *   4. anything else — a GraphQL validation error, a 4xx, the logbook resolver's
 *      `User not found` — is rethrown immediately. Retrying a deterministic
 *      server verdict buys nothing and doubles the time to the same toast.
 *
 * Retrying a page is safe because the drain is a read: climbs are appended only
 * on success, and duplicates are filtered by uuid regardless.
 *
 * Deliberately NOT here: pacing. Both rate-limit tiers count requests per 60 s
 * window, so any delay short enough to be acceptable inside an interactive tap
 * gives no rate-limit protection at all — it only adds latency. Terminating the
 * loop is `maxPages`' job.
 */
export async function drainPlaylistPages({
  fetchPage,
  signal,
  pageSize,
  maxPages,
  isRetryable = () => false,
  parseRetryAfterSeconds = () => null,
  stopAfterPage,
  sleep = defaultAbortableSleep,
  random = Math.random,
}: DrainPlaylistPagesArgs): Promise<PlaylistDrainResult> {
  const climbs: Climb[] = [];
  const seenClimbUuids = new Set<string>();
  let page = 0;
  let hasMore = true;
  let stopReason: PlaylistDrainStopReason = 'complete';

  const fetchPageWithRetry = async (pageIndex: number): Promise<PlaylistSuggestionPage> => {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        return await fetchPage({ page: pageIndex, pageSize, signal });
      } catch (error) {
        if (isAbortError(error)) throw error;
        if (attempt >= PLAYLIST_PAGE_MAX_ATTEMPTS) throw error;

        const retryAfterSeconds = parseRetryAfterSeconds(error);
        if (retryAfterSeconds !== null) {
          const waitMs = retryAfterSeconds * 1000;
          if (waitMs > PLAYLIST_RATE_LIMIT_MAX_WAIT_MS) throw error;
          await sleep(waitMs + random() * PLAYLIST_PAGE_RETRY_JITTER_MS, signal);
          continue;
        }

        if (!isRetryable(error)) throw error;
        await sleep(PLAYLIST_PAGE_RETRY_DELAY_MS + random() * PLAYLIST_PAGE_RETRY_JITTER_MS, signal);
      }
    }
  };

  while (hasMore) {
    if (signal.aborted) {
      stopReason = 'aborted';
      break;
    }
    if (page >= maxPages) {
      stopReason = 'page-cap';
      break;
    }

    const pageResult = await fetchPageWithRetry(page);
    page += 1;

    const newClimbs = pageResult.climbs.filter((pageClimb) => !seenClimbUuids.has(pageClimb.uuid));
    for (const newClimb of newClimbs) {
      seenClimbUuids.add(newClimb.uuid);
    }
    climbs.push(...newClimbs);
    hasMore = pageResult.hasMore;

    if (newClimbs.length === 0) {
      // An empty final page is a legitimately empty list. An empty page the
      // server claims to have more after is the defect class `52d9a631f` fixed
      // on the backend: a clamped offset re-serving the same rows forever.
      stopReason = hasMore ? 'no-progress' : 'complete';
      break;
    }

    if (hasMore && stopAfterPage?.(newClimbs)) {
      stopReason = 'page-cap';
      break;
    }
  }

  return { climbs, stopReason, pagesFetched: page };
}

export async function fetchPlaylistSuggestionClimbs({
  activatedClimbUuid,
  signal,
  fetchPage,
  pageSize = PLAYLIST_SUGGESTION_REFRESH_PAGE_SIZE,
  maxPages = MAX_PLAYLIST_SUGGESTION_REFRESH_PAGES,
  maxClimbsAfterActivated = MAX_PLAYLIST_SUGGESTION_REFRESH_CLIMBS_AFTER_ACTIVE,
  isRetryable,
  parseRetryAfterSeconds,
  sleep,
  random,
}: {
  activatedClimbUuid: string;
  signal: AbortSignal;
  fetchPage: (args: FetchPlaylistSuggestionPageArgs) => Promise<PlaylistSuggestionPage>;
  pageSize?: number;
  maxPages?: number;
  maxClimbsAfterActivated?: number;
} & Pick<DrainPlaylistPagesArgs, 'isRetryable' | 'parseRetryAfterSeconds' | 'sleep' | 'random'>): Promise<Climb[]> {
  let activatedClimbSeen = false;
  let loadedClimbsAfterActivated = 0;

  const { climbs } = await drainPlaylistPages({
    fetchPage,
    signal,
    pageSize,
    maxPages,
    isRetryable,
    parseRetryAfterSeconds,
    sleep,
    random,
    stopAfterPage: (newClimbs) => {
      for (const newClimb of newClimbs) {
        if (newClimb.uuid === activatedClimbUuid) {
          activatedClimbSeen = true;
          continue;
        }
        if (activatedClimbSeen) {
          loadedClimbsAfterActivated += 1;
        }
      }
      return loadedClimbsAfterActivated >= maxClimbsAfterActivated;
    },
  });

  return climbs;
}
