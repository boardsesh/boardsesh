import type { Climb } from '@boardsesh/queue';

export const PLAYLIST_SUGGESTION_REFRESH_PAGE_SIZE = 100;
// The furthest a swipe track goes: 10 pages of 100, the first 1,000 climbs of
// the list. Past it the track ends and the player shows its end card, the same
// as a list that really ended. Paging on demand (issue #6664) made this the one
// remaining bound, so it is the list's end rather than a buffer size.
export const MAX_PLAYLIST_TRACK_PAGES = 10;
// How far past the tapped climb the first load reaches. Only the first load:
// the player asks for one more page as the climber nears the end of what is
// loaded (`fetchPlaylistTrackPage`), so this is a head start, not a cap. Big
// enough that a typical session never waits on a page.
const PLAYLIST_TRACK_FIRST_LOAD_CLIMBS_AFTER_ACTIVE = 250;

// Runaway bound for the queue-replacement drain, NOT a product feature.
// Nothing on the server should get near it today: the four RECOMMENDED_* smart
// playlists are clamped to 6 pages by MAX_RECOMMENDATION_OFFSET, and both the
// logbook branch and `playlistClimbs` derive `hasMore` from real row counts. It
// exists so the next paging defect degrades into a short queue instead of
// draining until a rate limiter says stop — CLAUDE.md's mobile performance
// checklist bans drain-until-`hasMore` outright. Hitting it is a bug, so the
// mobile caller reports it to Sentry rather than telling the climber.
//
// 20 is chosen against the budget this guard exists to protect, not by feel:
//   20 pages x PLAYLIST_PAGE_MAX_ATTEMPTS (2) = 40 requests worst case,
//   against `applyRateLimit(ctx, 60, 'smartPlaylist')` — a fixed 60-per-60s
//   bucket keyed `${userId}:smartPlaylist` and SHARED with the list screen's
//   own infinite scroll. 40 leaves 20 requests of headroom; 30 pages would put
//   the worst case at exactly 60, i.e. sitting on the trip point.
// 20 x 100 climbs is still a 2,000-climb queue, far past any real session.
export const MAX_PLAYLIST_QUEUE_REPLACE_PAGES = 20;

// One retry per page. A dropped fetch on gym wifi recovers on the second try;
// a third almost never lands and just doubles the time to the error toast.
export const PLAYLIST_PAGE_MAX_ATTEMPTS = 2;
const PLAYLIST_PAGE_RETRY_DELAY_MS = 600;
const PLAYLIST_PAGE_RETRY_JITTER_MS = 250;
// A rate limit asking for longer than this is handed to the climber instead of
// held behind a spinner. The server hands out waits of up to 60 s.
// Per PAGE, not per drain: a fully rate-limited 20-page drain could still sleep
// ~60 s in total behind the caller's spinner. That needs a 2,000-climb playlist
// AND sustained 429s, so it is a known bound rather than a live risk; a
// drain-level deadline is the fix if it ever shows up.
export const PLAYLIST_RATE_LIMIT_MAX_WAIT_MS = 3_000;

type FetchPlaylistSuggestionPageArgs = {
  page: number;
  pageSize: number;
  signal: AbortSignal;
};

type PlaylistSuggestionPage = {
  climbs: Climb[];
  hasMore: boolean;
  /** How many climbs the whole list holds, when the query reports it. */
  totalCount?: number;
};

export type PlaylistDrainStopReason =
  /** The server said `hasMore: false`. The list is whole. */
  | 'complete'
  /** The runaway page bound stopped a server that still had more to give. */
  | 'page-cap'
  /** The caller's own `stopAfterPage` predicate ended the drain. Not a fault. */
  | 'caller-stop'
  /** A page added no climbs we had not already seen. The server is repeating itself. */
  | 'no-progress'
  /** The caller aborted between pages. */
  | 'aborted';

export type PlaylistDrainResult = {
  climbs: Climb[];
  stopReason: PlaylistDrainStopReason;
  pagesFetched: number;
  /** The list's total from the first page that reported one. */
  totalCount?: number;
  /** A page repeated a climb an earlier one already sent, so positions shifted. */
  droppedDuplicates?: boolean;
};

export type DrainPlaylistPagesArgs = {
  fetchPage: (args: FetchPlaylistSuggestionPageArgs) => Promise<PlaylistSuggestionPage>;
  signal: AbortSignal;
  pageSize: number;
  /** Required. There is deliberately no default that means "unlimited". */
  maxPages: number;
  /**
   * The page to start from. Defaults to the list's first. `maxPages` counts from
   * here, so a drain from page 4 with `maxPages: 1` fetches page 4 alone.
   */
  firstPage?: number;
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
  firstPage = 0,
  isRetryable = () => false,
  parseRetryAfterSeconds = () => null,
  stopAfterPage,
  sleep = defaultAbortableSleep,
  random = Math.random,
}: DrainPlaylistPagesArgs): Promise<PlaylistDrainResult> {
  const climbs: Climb[] = [];
  const seenClimbUuids = new Set<string>();
  let page = firstPage;
  let hasMore = true;
  let stopReason: PlaylistDrainStopReason = 'complete';
  let totalCount: number | undefined;
  let droppedDuplicates = false;

  const fetchPageWithRetry = async (pageIndex: number): Promise<PlaylistSuggestionPage> => {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        return await fetchPage({ page: pageIndex, pageSize, signal });
      } catch (error) {
        // Abort wins over everything — including the runtime's error shape. Only
        // ask the signal, which is authoritative; `name: 'AbortError'` is not.
        // RN's whatwg-fetch sets it, but expo/fetch throws a `FetchError` with
        // NO `name` and a "fetch failed:" prefix, which `isTransportNetworkError`
        // would happily classify as a retryable transport blip. Trusting the
        // shape alone turns a cancellation the climber asked for into a red
        // toast plus a Sentry event.
        if (signal.aborted || isAbortError(error)) throw createAbortError();
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
    if (page - firstPage >= maxPages) {
      stopReason = 'page-cap';
      break;
    }

    const pageResult = await fetchPageWithRetry(page);
    page += 1;
    if (totalCount === undefined && typeof pageResult.totalCount === 'number') totalCount = pageResult.totalCount;

    // Marking as we go, so a uuid repeated INSIDE one page is dropped too — a
    // filter-then-mark pass would let both copies through.
    const newClimbs: Climb[] = [];
    for (const pageClimb of pageResult.climbs) {
      if (seenClimbUuids.has(pageClimb.uuid)) {
        droppedDuplicates = true;
        continue;
      }
      seenClimbUuids.add(pageClimb.uuid);
      newClimbs.push(pageClimb);
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
      stopReason = 'caller-stop';
      break;
    }
  }

  return {
    climbs,
    stopReason,
    pagesFetched: page - firstPage,
    ...(totalCount === undefined ? {} : { totalCount }),
    ...(droppedDuplicates ? { droppedDuplicates } : {}),
  };
}

/**
 * The first load of a swipe track: pages from the top of the list until it
 * holds `maxClimbsAfterActivated` climbs past the tapped one.
 *
 * `nextPage` is where the track continues, or null when this load reached the
 * list's real end, the {@link MAX_PLAYLIST_TRACK_PAGES} bound, or a server that
 * stopped making progress; in each of those cases there is nothing more to ask
 * for. `total` is the list's count, left out when a page repeated a climb,
 * because a repeat shifts every position after it.
 */
export type PlaylistTrackLoad = {
  climbs: Climb[];
  nextPage: number | null;
  total?: number;
  /** A page repeated a climb, so positions shifted: no count from anywhere fits this track. */
  droppedDuplicates?: boolean;
};

export async function fetchPlaylistSuggestionClimbs({
  activatedClimbUuid,
  signal,
  fetchPage,
  pageSize = PLAYLIST_SUGGESTION_REFRESH_PAGE_SIZE,
  maxPages = MAX_PLAYLIST_TRACK_PAGES,
  maxClimbsAfterActivated = PLAYLIST_TRACK_FIRST_LOAD_CLIMBS_AFTER_ACTIVE,
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
} & Pick<
  DrainPlaylistPagesArgs,
  'isRetryable' | 'parseRetryAfterSeconds' | 'sleep' | 'random'
>): Promise<PlaylistTrackLoad> {
  let activatedClimbSeen = false;
  let loadedClimbsAfterActivated = 0;

  const { climbs, stopReason, pagesFetched, totalCount, droppedDuplicates } = await drainPlaylistPages({
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

  // Only a stop this function asked for leaves more to load: the server said
  // there was more, and the bound has not been reached.
  const nextPage = stopReason === 'caller-stop' && pagesFetched < maxPages ? pagesFetched : null;
  if (droppedDuplicates) return { climbs, nextPage, droppedDuplicates };
  return { climbs, nextPage, ...(totalCount === undefined ? {} : { total: totalCount }) };
}

/** One page past a track's loaded end. See {@link fetchPlaylistTrackPage}. */
export type PlaylistTrackPageLoad = {
  climbs: Climb[];
  /** The page after this one, or null when the list (or the track's bound) ended here. */
  nextPage: number | null;
  /**
   * True when the track's bound ended it while the server still had more: the
   * track is then shorter than the list, so a count of the list no longer fits.
   */
  cappedBeforeListEnd: boolean;
  totalCount?: number;
};

/**
 * Fetch page `page` of a swipe track and nothing else (issue #6664).
 *
 * The player calls this as the climber nears the end of what is loaded, one
 * page per approach: never a drain. Same retry policy as the drain. A page
 * past {@link MAX_PLAYLIST_TRACK_PAGES} is never fetched; the page before it
 * reports `nextPage: null`, which is the track's end.
 */
export async function fetchPlaylistTrackPage({
  page,
  signal,
  fetchPage,
  pageSize = PLAYLIST_SUGGESTION_REFRESH_PAGE_SIZE,
  isRetryable,
  parseRetryAfterSeconds,
  sleep,
  random,
}: {
  page: number;
  signal: AbortSignal;
  fetchPage: (args: FetchPlaylistSuggestionPageArgs) => Promise<PlaylistSuggestionPage>;
  pageSize?: number;
} & Pick<
  DrainPlaylistPagesArgs,
  'isRetryable' | 'parseRetryAfterSeconds' | 'sleep' | 'random'
>): Promise<PlaylistTrackPageLoad> {
  if (page >= MAX_PLAYLIST_TRACK_PAGES) return { climbs: [], nextPage: null, cappedBeforeListEnd: true };
  const { climbs, stopReason, totalCount } = await drainPlaylistPages({
    fetchPage,
    signal,
    pageSize,
    maxPages: 1,
    firstPage: page,
    isRetryable,
    parseRetryAfterSeconds,
    sleep,
    random,
  });
  if (stopReason === 'aborted') throw createAbortError();
  // `page-cap` here means "the server has more after this one page".
  const serverHasMore = stopReason === 'page-cap';
  const nextPage = serverHasMore && page + 1 < MAX_PLAYLIST_TRACK_PAGES ? page + 1 : null;
  return {
    climbs,
    nextPage,
    cappedBeforeListEnd: serverHasMore && nextPage === null,
    ...(totalCount === undefined ? {} : { totalCount }),
  };
}
