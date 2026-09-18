// Durable chronology is paged independently of the sparse, bounded Redis window.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { boardHistoryEntryKey, mergeBoardHistory } from '@boardsesh/board-presence';
export { boardHistoryEntryKey } from '@boardsesh/board-presence';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { useBoardPresenceClient, useBoardPresenceFeed } from './board-presence-provider';
import { boardHistoryCursor } from './types';

const DEFAULT_PAGE_SIZE = 50;

/** Telemetry payload for a single resolved `loadOlder` page, handed to the
 * optional `onPageLoaded` callback so platforms can track it without this
 * renderer-agnostic package importing an analytics client. */
export type BoardHistoryPageLoadedInfo = {
  pageSize: number;
  /** Raw count `fetchHistory` returned for this page, BEFORE dedup against
   * already-known entries — matches the number `hasMore` is derived from. */
  returnedCount: number;
};

export type BoardHistoryPagination = {
  /** Durable pages retained independently of the live window. Merge with the
   * live history using mergeBoardHistory so richer live entries win overlaps. */
  olderHistory: BoardPresenceClimb[];
  isLoadingOlder: boolean;
  /** False once the server confirms there is no next page. True before the first `loadOlder` call (unknown yet). */
  hasMore: boolean;
  /** Fetch the next page back. No-op while a load is already in flight, once
   * `hasMore` is false, or when the active client doesn't implement
   * `fetchHistory` (e.g. a logged-out web client — `boardHistory` is
   * auth-required server-side). */
  loadOlder: () => void;
  refreshHistory: () => void;
  loadError: boolean;
};

function lowestKnownSeq(climbs: BoardPresenceClimb[]): number | null {
  if (climbs.length === 0) {
    return null;
  }
  return climbs.reduce((lowest, climb) => Math.min(lowest, climb.seq), Number.POSITIVE_INFINITY);
}

/**
 * Page backward through a board's durable history log, beyond the live feed's
 * in-memory window without using that sparse window as a durable cursor.
 */
export function useBoardHistoryPagination(
  pageSize = DEFAULT_PAGE_SIZE,
  onPageLoaded?: (info: BoardHistoryPageLoadedInfo) => void,
): BoardHistoryPagination {
  const { boardId, client } = useBoardPresenceClient();
  const { history: liveHistory } = useBoardPresenceFeed();

  const [loadError, setLoadError] = useState(false);
  const nextCursorRef = useRef<string | undefined>(undefined);
  const legacyCursorRef = useRef<ReturnType<typeof boardHistoryCursor> | undefined>(undefined);
  const [olderHistory, setOlderHistory] = useState<BoardPresenceClimb[]>([]);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  // Unknown until the first page resolves — default to true so the first
  // `loadOlder` call is never suppressed by this flag.
  const [hasMore, setHasMore] = useState(true);

  // Live refs so `loadOlder` stays identity-stable across renders while still
  // reading the current board/client/live-window/already-loaded state, and so
  // async continuations can validate they're still relevant.
  const boardIdRef = useRef(boardId);
  boardIdRef.current = boardId;
  const clientRef = useRef(client);
  clientRef.current = client;
  const liveHistoryRef = useRef(liveHistory);
  liveHistoryRef.current = liveHistory;
  const olderHistoryRef = useRef(olderHistory);
  olderHistoryRef.current = olderHistory;
  const isLoadingRef = useRef(false);
  const hasMoreRef = useRef(true);
  const onPageLoadedRef = useRef(onPageLoaded);
  onPageLoadedRef.current = onPageLoaded;
  // Bumped every time the bound board/client changes; an in-flight request's
  // continuation compares against this to detect a stale result. Paired with
  // `isActiveRef`, which the reset effect's cleanup flips off — covering both
  // a board switch AND an unmount the same way `use-board-presence` does.
  const generationRef = useRef(0);
  const isActiveRef = useRef(true);

  // Reset all paging state whenever the bound board or client changes (a new
  // board's durable history is a different cursor space entirely) — mirrors
  // `use-board-presence`'s per-board RESET.
  useEffect(() => {
    isActiveRef.current = true;
    nextCursorRef.current = undefined;
    legacyCursorRef.current = undefined;
    setLoadError(false);
    generationRef.current += 1;
    isLoadingRef.current = false;
    hasMoreRef.current = true;
    olderHistoryRef.current = [];
    setOlderHistory([]);
    setIsLoadingOlder(false);
    setHasMore(true);
    return () => {
      isActiveRef.current = false;
    };
  }, [boardId, client]);

  const loadOlder = useCallback(() => {
    const activeBoardId = boardIdRef.current;
    const activeClient = clientRef.current;
    if (
      activeBoardId === null ||
      activeClient === null ||
      (activeClient.fetchHistory === undefined && activeClient.fetchHistoryPage === undefined)
    ) {
      return;
    }
    if (isLoadingRef.current || !hasMoreRef.current) {
      return;
    }

    const knownClimbs = [...liveHistoryRef.current, ...olderHistoryRef.current];
    const minSeq = lowestKnownSeq(knownClimbs);
    const cursor = legacyCursorRef.current ?? (minSeq === null ? undefined : boardHistoryCursor(minSeq));

    const requestGeneration = generationRef.current;
    isLoadingRef.current = true;
    setIsLoadingOlder(true);
    setLoadError(false);

    const request = activeClient.fetchHistoryPage
      ? activeClient.fetchHistoryPage(activeBoardId, { limit: pageSize, before: nextCursorRef.current })
      : activeClient.fetchHistory!(activeBoardId, { limit: pageSize, before: cursor }).then((entries) => ({
          entries,
          nextCursor: entries.length === pageSize ? String(entries.at(-1)!.seq) : null,
        }));
    void request
      .then(({ entries: page, nextCursor }) => {
        if (!isActiveRef.current || generationRef.current !== requestGeneration) {
          return;
        }
        const knownKeys = new Set(
          (activeClient.fetchHistoryPage
            ? olderHistoryRef.current
            : [...liveHistoryRef.current, ...olderHistoryRef.current]
          ).map(boardHistoryEntryKey),
        );
        // Duplicates always defer to the already-known entry: the durable
        // `boardHistory` query re-resolves sender identity via a live DB join
        // and nulls `queueItemUuid`/`gradeColor`, so the same (climbUuid, seq)
        // can differ in shape from the live-feed/prior-page variant — the
        // live-feed shape is the richer one (mirrors the reducer's
        // `mergeHistory` policy).
        const deduped = page.filter((climb) => !knownKeys.has(boardHistoryEntryKey(climb)));
        const nextOlderHistory = mergeBoardHistory(olderHistoryRef.current, deduped);
        nextCursorRef.current = nextCursor ?? undefined;
        if (!activeClient.fetchHistoryPage && page.length) legacyCursorRef.current = boardHistoryCursor(page.at(-1)!);
        olderHistoryRef.current = nextOlderHistory;
        setOlderHistory(nextOlderHistory);
        const nextHasMore = nextCursor !== null;
        hasMoreRef.current = nextHasMore;
        setHasMore(nextHasMore);
        onPageLoadedRef.current?.({ pageSize, returnedCount: page.length });
      })
      .catch(() => {
        if (!isActiveRef.current || generationRef.current !== requestGeneration) {
          return;
        }
        // A failed page is retryable; it is not evidence that history ended.
        setLoadError(true);
      })
      .finally(() => {
        if (!isActiveRef.current || generationRef.current !== requestGeneration) {
          return;
        }
        isLoadingRef.current = false;
        setIsLoadingOlder(false);
      });
  }, [pageSize]);

  const refreshHistory = useCallback(() => {
    generationRef.current += 1;
    nextCursorRef.current = undefined;
    legacyCursorRef.current = undefined;
    isLoadingRef.current = false;
    hasMoreRef.current = true;
    setHasMore(true);
    loadOlder();
  }, [loadOlder]);

  useEffect(() => {
    // One initial page per mounted panel/board, never an automatic page drain.
    if (client?.fetchHistoryPage && boardId !== null) loadOlder();
    return client?.onReconnect?.(() => refreshHistory());
  }, [boardId, client, loadOlder, refreshHistory]);

  return useMemo<BoardHistoryPagination>(
    () => ({ olderHistory, isLoadingOlder, hasMore, loadOlder, refreshHistory, loadError }),
    [olderHistory, isLoadingOlder, hasMore, loadOlder, refreshHistory, loadError],
  );
}
