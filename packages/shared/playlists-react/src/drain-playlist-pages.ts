// Bounded, resumable, abortable page drain for "replace the queue with this
// whole playlist".
//
// The old drain was a bare `while (hasMore)` loop with no cap, no pacing and no
// per-page retry, and every page landed in ONE try/catch — so a single
// rate-limited or dropped page threw away every page already fetched and the
// user got "Couldn't start playlist" instead of a queue (#4622). Retrying
// restarted at page 0 and spent the same server budget again.
//
// Three properties this module guarantees:
//   1. Bounded fan-out. `maxPages` caps how many requests one activation can
//      issue, so a huge playlist can never burn a whole per-minute server
//      budget in one burst — and a `hasMore`-forever resolver bug can never spin
//      the client forever.
//   2. Resume, never restart. A retried page re-requests the SAME page number
//      and keeps everything already accumulated.
//   3. Partial beats nothing. The drain never throws for a page failure; it
//      returns what it has plus why it stopped, so the caller can seed a working
//      queue from a partial result instead of failing the whole activation.
//
// The retry POLICY (which errors are worth re-sending, and how long to wait) is
// injected as `createPageRetryPolicy` rather than imported: this package stays
// free of transport and error-shape dependencies, per CLAUDE.md's "inject every
// platform I/O" rule for shared packages. It is a factory, not a function,
// because a policy needs per-page state to keep separate budgets per error
// class.

import type { Climb } from '@boardsesh/queue';
import { isAbortError } from './fetch-playlist-suggestion-climbs';

/**
 * Page cap for a queue-replacement drain: 30 pages x 100 climbs = 3000 climbs.
 *
 * The backend caps `smartPlaylist` at 60 requests per fixed 60s window keyed on
 * the user (packages/backend/.../smart-playlists.ts), and the playlist detail
 * list spends part of that budget itself while the climber scrolls. Half the
 * budget leaves room for a second activation in the same window, and 3000
 * climbs is far past a session's worth of climbing.
 */
export const PLAYLIST_QUEUE_REPLACE_MAX_PAGES = 30;

/**
 * Wall-clock ceiling on everything the drain is allowed to SLEEP across all of
 * its retries. One full server window: a drain that would need to wait longer
 * than that gives up and hands back what it has, so a pathological playlist can
 * never hang a queue replacement indefinitely.
 */
export const PLAYLIST_DRAIN_MAX_TOTAL_WAIT_MS = 60_000;

/** One page of a playlist fetch. */
export type PlaylistPage = {
  climbs: Climb[];
  hasMore: boolean;
};

/** Fetches one page. The signal must be forwarded to the underlying request. */
export type PlaylistPageFetcher = (args: {
  page: number;
  pageSize: number;
  signal: AbortSignal;
}) => Promise<PlaylistPage>;

/**
 * Retry policy for a failed page. Returns how long to wait before re-sending
 * the SAME page, or `null` to give up on it.
 *
 * `attempt` counts EVERY retry of this page so far regardless of what failed —
 * 0 on the first failure, 1 on the second, and so on. It is not a per-class
 * count, so a policy with separate budgets per error class must keep its own
 * counters and ignore this. A policy instance is scoped to ONE page precisely
 * so it can (a transient network drop must not spend the page's rate-limit
 * retry).
 */
export type ShouldRetryPage = (error: unknown, attempt: number) => number | null;

/**
 * Builds a fresh, page-scoped retry policy. The drain calls this once per page
 * so a stateful policy starts every page with full budgets.
 */
export type CreatePageRetryPolicy = () => ShouldRetryPage;

/** Injectable sleep so tests never wait on real timers. */
export type DrainSleep = (ms: number, signal: AbortSignal) => Promise<void>;

/** Why the drain stopped. Only `exhausted` means the whole playlist was read. */
export type DrainStopReason = 'exhausted' | 'page-cap' | 'wait-budget' | 'aborted' | 'error';

export type DrainPlaylistPagesResult = {
  /** Everything that landed, in page order. Populated even on a partial stop. */
  climbs: Climb[];
  pagesFetched: number;
  /** True only when the server said there was nothing more to read. */
  complete: boolean;
  stoppedBy: DrainStopReason;
  /** The rejection that ended the drain, when one did. */
  error?: unknown;
};

/**
 * Mutable wait accounting shared across every page of one page walk. Build one
 * before the loop and hand the same object to every page, so the ceiling is on
 * the whole walk rather than per page.
 */
export type DrainWaitBudget = { remainingMs: number };

function createAbortError(): Error {
  const abortError = new Error('Playlist page drain aborted');
  abortError.name = 'AbortError';
  return abortError;
}

/**
 * Internal signal that a page asked for a backoff longer than the drain had
 * left in its wait budget. Carries the underlying rejection so the caller still
 * gets a real error to report.
 */
export class PlaylistDrainWaitBudgetError extends Error {
  readonly pageError: unknown;

  constructor(pageError: unknown) {
    super('Playlist page drain exceeded its total wait budget');
    this.name = 'PlaylistDrainWaitBudgetError';
    this.pageError = pageError;
  }
}

/**
 * `setTimeout` that settles early when the signal aborts, so cancelling a
 * playlist activation during a 46-second rate-limit backoff is instant instead
 * of waiting the backoff out.
 */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
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
 * Fetch one page, re-sending the SAME page while the injected policy asks for a
 * retry and the shared wait budget can afford it.
 *
 * Aborts are never retried — a cancelled activation must stop, not back off.
 * Without a `shouldRetryPage` this is exactly a bare `fetchPage` call: the first
 * rejection propagates and nothing sleeps.
 */
export async function fetchPlaylistPageWithRetry({
  fetchPage,
  page,
  pageSize,
  signal,
  shouldRetryPage,
  sleep = abortableSleep,
  waitBudget,
}: {
  fetchPage: PlaylistPageFetcher;
  page: number;
  pageSize: number;
  signal: AbortSignal;
  shouldRetryPage?: ShouldRetryPage;
  sleep?: DrainSleep;
  waitBudget?: DrainWaitBudget;
}): Promise<PlaylistPage> {
  let attempt = 0;
  for (;;) {
    try {
      return await fetchPage({ page, pageSize, signal });
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (!shouldRetryPage) throw error;
      const waitMs = shouldRetryPage(error, attempt);
      if (waitMs === null) throw error;
      if (waitBudget) {
        if (waitMs > waitBudget.remainingMs) throw new PlaylistDrainWaitBudgetError(error);
        waitBudget.remainingMs -= waitMs;
      }
      await sleep(waitMs, signal);
      attempt += 1;
    }
  }
}

/**
 * Page through a playlist until the server runs out, the page cap is hit, the
 * wait budget is spent, the caller aborts, or a page gives up.
 *
 * Never throws for a page failure — the partial climbs and the stop reason come
 * back in the result so the caller can decide between "good enough" and
 * "genuinely failed".
 */
export async function drainPlaylistPages({
  fetchPage,
  signal,
  pageSize,
  maxPages = PLAYLIST_QUEUE_REPLACE_MAX_PAGES,
  createPageRetryPolicy,
  sleep = abortableSleep,
  maxTotalWaitMs = PLAYLIST_DRAIN_MAX_TOTAL_WAIT_MS,
}: {
  fetchPage: PlaylistPageFetcher;
  signal: AbortSignal;
  pageSize: number;
  maxPages?: number;
  /** Built once per page, so each page starts with fresh per-class budgets. */
  createPageRetryPolicy?: CreatePageRetryPolicy;
  sleep?: DrainSleep;
  maxTotalWaitMs?: number;
}): Promise<DrainPlaylistPagesResult> {
  const climbs: Climb[] = [];
  const waitBudget: DrainWaitBudget = { remainingMs: maxTotalWaitMs };
  let page = 0;
  let hasMore = true;

  while (hasMore && page < maxPages && !signal.aborted) {
    let pageResult: PlaylistPage;
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
      if (isAbortError(error)) {
        return { climbs, pagesFetched: page, complete: false, stoppedBy: 'aborted' };
      }
      if (error instanceof PlaylistDrainWaitBudgetError) {
        return { climbs, pagesFetched: page, complete: false, stoppedBy: 'wait-budget', error: error.pageError };
      }
      return { climbs, pagesFetched: page, complete: false, stoppedBy: 'error', error };
    }
    climbs.push(...pageResult.climbs);
    hasMore = pageResult.hasMore;
    page += 1;
  }

  if (!hasMore) return { climbs, pagesFetched: page, complete: true, stoppedBy: 'exhausted' };
  if (signal.aborted) return { climbs, pagesFetched: page, complete: false, stoppedBy: 'aborted' };
  return { climbs, pagesFetched: page, complete: false, stoppedBy: 'page-cap' };
}
