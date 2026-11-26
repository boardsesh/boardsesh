import { useCallback, useMemo, useRef, useEffect, useLayoutEffect } from 'react';
import { type FlashListRef, type ViewToken } from '@shopify/flash-list';
import type { Climb } from '@boardsesh/shared-schema';
import { type ClimbListColumns } from '../../components/climb-list-thumbnail-metrics';
import { shouldFetchNextPage, type NextPageTrigger } from '../../lib/climb-list-pagination';
import { createVisibleRowsStore } from '../../components/ClimbListScrollAhead';
import type { RefObject } from 'react';
import type { NextPageInput } from '../../lib/climb-list-pagination';
import type { ClimberScrollTracker } from '../../lib/climber-scroll-tracker';

const PAGE_SIZE = 30;
type PaginationState = Pick<
  NextPageInput,
  | 'hasNextPage'
  | 'isPlaceholderData'
  | 'isLoading'
  | 'isFetchingNextPage'
  | 'isRefetching'
  | 'lastFetchFailed'
  | 'loadedCount'
>;
type Options = PaginationState & {
  searchKey: string;
  listColumns: ClimbListColumns;
  listRef: RefObject<FlashListRef<Climb> | null>;
  topClearance: number;
  resetScrollToTop: () => void;
  /**
   * Whether the climber scrolled since the last page ask. After a search's first
   * ask each further one needs it, so rows that lay out at zero height cannot
   * page the whole search in (`climb-list-pagination`).
   */
  climberScroll: ClimberScrollTracker;
  fetchNextPage: () => Promise<{ isFetchNextPageError: boolean }>;
};
/** Owns list position and pagination together, so a result-set reset invalidates both. */
export function useClimbsListLifecycle(options: Options) {
  const { searchKey, listColumns, listRef, resetScrollToTop, climberScroll } = options;
  const latest = useRef(options);
  latest.current = options;
  const visibleRowsStore = useMemo(() => createVisibleRowsStore(), []);
  const generation = useRef(0);
  const isLoadingMoreRef = useRef(false);
  const endReachedPendingRef = useRef(false);
  const loadedCountAtLastFetchRef = useRef<number | null>(null);
  const lastNextPageFailureAtRef = useRef<number | null>(null);
  const columnChangeTopIndexRef = useRef<number | null>(null);
  const savedColumnsRef = useRef(listColumns);
  const previousSearchKey = useRef(searchKey);
  useLayoutEffect(() => {
    if (previousSearchKey.current === searchKey) return;
    previousSearchKey.current = searchKey;
    generation.current += 1;
    isLoadingMoreRef.current = false;
    resetScrollToTop();
    visibleRowsStore.set(0, 0);
    columnChangeTopIndexRef.current = null;
    endReachedPendingRef.current = false;
    loadedCountAtLastFetchRef.current = null;
    lastNextPageFailureAtRef.current = null;
    // The scroll to the top can cut a fling short with no end event to follow,
    // and the new search's first ask needs no scroll anyway.
    climberScroll.forgetGesture();
  }, [searchKey, resetScrollToTop, visibleRowsStore, climberScroll]);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  const maybeFetchNextPage = useCallback(
    (trigger: NextPageTrigger) => {
      const pagination = latest.current;
      const failedAt = lastNextPageFailureAtRef.current;
      if (
        !shouldFetchNextPage({
          ...pagination,
          climbsPerRow: pagination.listColumns,
          trigger,
          fetchInFlight: isLoadingMoreRef.current,
          msSinceLastFailure: failedAt === null ? null : Date.now() - failedAt,
          loadedCountAtLastFetch: loadedCountAtLastFetchRef.current,
          climberScrolledSinceLastFetch: climberScroll.hasScrolled(),
          firstVisibleIndex: visibleRowsStore.getFirst(),
          lastVisibleIndex: visibleRowsStore.getLast(),
          endReachedPending: endReachedPendingRef.current,
          pageSize: PAGE_SIZE,
        })
      )
        return;
      endReachedPendingRef.current = false;
      loadedCountAtLastFetchRef.current = pagination.loadedCount;
      climberScroll.reset();
      isLoadingMoreRef.current = true;
      const requestedGeneration = ++generation.current;
      void pagination
        .fetchNextPage()
        .then((result) => {
          if (generation.current === requestedGeneration)
            lastNextPageFailureAtRef.current = result.isFetchNextPageError ? Date.now() : null;
        })
        .catch(() => {
          if (generation.current === requestedGeneration) lastNextPageFailureAtRef.current = Date.now();
        })
        .finally(() => {
          if (generation.current === requestedGeneration) isLoadingMoreRef.current = false;
        });
    },
    [visibleRowsStore, climberScroll],
  );
  const handleEndReached = useCallback(() => {
    const pagination = latest.current;
    if (pagination.hasNextPage && !pagination.isPlaceholderData) endReachedPendingRef.current = true;
    maybeFetchNextPage('scroll');
  }, [maybeFetchNextPage]);
  useLayoutEffect(() => {
    if (savedColumnsRef.current === listColumns) return;
    savedColumnsRef.current = listColumns;
    if (columnChangeTopIndexRef.current !== null) return;
    const firstVisibleIndex = visibleRowsStore.getFirst();
    columnChangeTopIndexRef.current = firstVisibleIndex > 0 ? firstVisibleIndex : null;
  }, [listColumns, visibleRowsStore]);

  const handleListLoad = useCallback(() => {
    const index = columnChangeTopIndexRef.current;
    columnChangeTopIndexRef.current = null;
    if (index === null || index >= latest.current.loadedCount) return;
    void listRef.current?.scrollToIndex({ index, animated: false, viewOffset: -latest.current.topClearance });
  }, [listRef]);
  const handleViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken<Climb>[] }) => {
      let firstVisibleIndex = Number.POSITIVE_INFINITY;
      let lastVisibleIndex = -1;
      for (const viewable of viewableItems) {
        if (viewable.index == null) continue;
        if (viewable.index < firstVisibleIndex) firstVisibleIndex = viewable.index;
        if (viewable.index > lastVisibleIndex) lastVisibleIndex = viewable.index;
      }
      if (lastVisibleIndex < 0) return;
      visibleRowsStore.set(firstVisibleIndex, lastVisibleIndex);
      maybeFetchNextPage('scroll');
    },
    [visibleRowsStore, maybeFetchNextPage],
  );

  useEffect(() => {
    if (!options.isFetchingNextPage) isLoadingMoreRef.current = false;
  }, [options.isFetchingNextPage]);

  useEffect(() => {
    if (!options.hasNextPage) endReachedPendingRef.current = false;
    maybeFetchNextPage('settle');
  }, [
    maybeFetchNextPage,
    options.hasNextPage,
    options.isPlaceholderData,
    options.isLoading,
    options.isFetchingNextPage,
    options.lastFetchFailed,
    options.isRefetching,
    options.loadedCount,
  ]);
  const resetPendingFetch = useCallback(() => {
    generation.current += 1;
    isLoadingMoreRef.current = false;
  }, []);
  return { visibleRowsStore, handleEndReached, handleListLoad, handleViewableItemsChanged, resetPendingFetch };
}
