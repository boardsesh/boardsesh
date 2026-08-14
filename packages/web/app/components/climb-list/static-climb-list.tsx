'use client';

import React, { useCallback, useEffect } from 'react';
import Box from '@mui/material/Box';
import { usePathname } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import type { LogbookEntry } from '@boardsesh/board-react';
import ErrorBoundary from '@/app/components/error-boundary';
import StaticClimbRow from '@/app/components/climb-list/static-climb-row';
import { useInfiniteScroll } from '@/app/hooks/use-infinite-scroll';
import { LIST_ROW_HEIGHT } from '@/app/lib/climb-list-constants';
import { themeTokens } from '@/app/theme/theme-config';
import type { BoardDetails, Climb } from '@/app/lib/types';

/**
 * The crawlable climb list: every row is a real `<a href>` to the canonical
 * config-tuple view URL, and the first render — server or client — emits those
 * anchors.
 *
 * Two consumers shape this prop surface; don't narrow it without checking both.
 *  - `climb-list/multiboard-climb-list.tsx` serves `/playlists/[uuid]`,
 *    `/setter/[username]`, `/profile/{id}/climbs` and `/discover/*`, and needs
 *    `boardDetailsByClimb` because its climbs span boards.
 *  - `session/[sessionId]/session-detail-content.tsx` (W-13a) renders the list
 *    twice with `renderItemExtra` for tick details — rows that legitimately
 *    exceed the LIST_ROW_HEIGHT floor, which is why the wrapper keeps
 *    `ref={virtualizer.measureElement}`.
 *
 * Deliberately absent versus `board-page/climbs-list.tsx`: the grid/list
 * toggle, the selection store, swipe hints, every drawer, and the add-to-queue
 * and wall-activation paths. Those live in the app.
 */
export type StaticClimbListProps = {
  climbs: Climb[];
  /** Board used for any climb without an entry in `boardDetailsByClimb`. */
  boardDetails: BoardDetails;
  /** Per-climb board override, keyed by climb uuid — cross-board lists need it. */
  boardDetailsByClimb?: Record<string, BoardDetails>;
  /** Viewer's ticks for the ascent badges. Absent on anonymous/crawler renders. */
  logbook?: readonly LogbookEntry[];
  isFetching: boolean;
  hasMore: boolean;
  /**
   * Must be idempotent. Two paths call it — the five-rows-early virtualizer
   * effect and the bottom sentinel — and both gate on `!isFetching`, which a
   * caller may not flip synchronously, so a fast scroll can fire both in one
   * tick. Every current caller is React Query's `fetchNextPage`, which drops a
   * second call while the first is in flight.
   */
  onLoadMore: () => void;
  header?: React.ReactNode;
  /** Rendered instead of the rows when there are no climbs. */
  emptyState?: React.ReactNode;
  hideEndMessage?: boolean;
  showBottomSpacer?: boolean;
  /** How many leading rows render from image layers rather than the canvas (LCP). */
  initialImageCount?: number;
  /** Extra content under a row, inside the measured wrapper but outside the link. */
  renderItemExtra?: (climb: Climb) => React.ReactNode;
};

const sentinelBoxSx = { minHeight: `${themeTokens.spacing[5]}px` };

const noMoreClimbsBoxSx = {
  textAlign: 'center' as const,
  padding: `${themeTokens.spacing[5]}px`,
  color: 'var(--neutral-400)',
};

export default function StaticClimbList({
  climbs,
  boardDetails,
  boardDetailsByClimb,
  logbook,
  isFetching,
  hasMore,
  onLoadMore,
  header,
  emptyState,
  hideEndMessage = false,
  showBottomSpacer = false,
  initialImageCount = 0,
  renderItemExtra,
}: StaticClimbListProps) {
  const { t } = useTranslation('climbs');
  // Read once at list level: ClimbThumbnail takes the pathname as a prop
  // rather than each row paying for its own context lookup.
  const pathname = usePathname();

  const { sentinelRef } = useInfiniteScroll({ onLoadMore, hasMore, isFetching });

  // --- List virtualization ---
  // Overscan of 10 items (~1070px at the LIST_ROW_HEIGHT estimate) is enough
  // headroom for fast scrolling while keeping the LCP-time mount count low.
  // Production traces on the classic list showed overscan=25 mounting ~50 items
  // on first paint, each attaching virtualizer.measureElement (a
  // ResizeObserver) — that dominated the render delay (76% of LCP / 2.2s of
  // forced reflow).
  //
  // The estimate matches the row wrapper's fixed minHeight below, so a row
  // measures to exactly the estimate on mount: no reflow shifting every row
  // beneath it (the loading-time CLS issue #3086 was filed for).
  const virtualizer = useWindowVirtualizer({
    count: climbs.length,
    estimateSize: () => LIST_ROW_HEIGHT,
    overscan: 10,
    getItemKey: (index) => climbs[index]?.uuid ?? index,
    // Provide a fake viewport so the virtualizer renders items during SSR.
    // Without this, getVirtualItems() returns [] on the server and the list is
    // entirely client-rendered — which on this list would mean zero crawlable
    // anchors in the HTML, the one thing it exists to emit.
    initialRect: { width: 375, height: 812 },
  });

  const virtualItems = virtualizer.getVirtualItems();

  const resolveBoardDetails = useCallback(
    (climb: Climb) => boardDetailsByClimb?.[climb.uuid] ?? boardDetails,
    [boardDetailsByClimb, boardDetails],
  );

  // Page five rows early so the next batch is in flight before the reader
  // reaches the bottom. The sentinel below still covers the case where the
  // whole list fits in one screen.
  const lastVirtualItem = virtualItems[virtualItems.length - 1];
  useEffect(() => {
    if (!lastVirtualItem) return;
    if (lastVirtualItem.index >= climbs.length - 5 && hasMore && !isFetching) {
      onLoadMore();
    }
  }, [lastVirtualItem, climbs.length, hasMore, isFetching, onLoadMore]);

  return (
    /*
     * translate="no" tells well-behaved browser translators (Chrome/Safari
     * auto-translate) to leave this subtree's DOM alone — they otherwise
     * replace text nodes React still holds references to. See issue #3604.
     */
    <Box translate="no">
      {header}

      {climbs.length === 0 ? (
        (emptyState ?? null)
      ) : (
        <ErrorBoundary recoverable>
          {/* Plain div with inline style, as in board-page/climbs-list: the
              height changes on every measure, so an sx object would mint a
              fresh emotion class per render. */}
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: '100%',
              position: 'relative',
              backgroundColor: 'inherit',
            }}
          >
            {virtualItems.map((virtualItem) => {
              const climb = climbs[virtualItem.index];
              if (!climb) return null;
              return (
                <div
                  key={virtualItem.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualItem.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    // Floor at the estimated row height so a plain row measures
                    // to exactly the estimate (no post-mount reflow / CLS).
                    // Rows with extra content below (renderItemExtra) still
                    // grow past this via measureElement.
                    minHeight: LIST_ROW_HEIGHT,
                    boxSizing: 'border-box',
                    transform: `translateY(${virtualItem.start}px)`,
                    contain: 'layout style paint',
                  }}
                >
                  <StaticClimbRow
                    climb={climb}
                    boardDetails={resolveBoardDetails(climb)}
                    pathname={pathname}
                    logbook={logbook}
                    preferImageLayers={virtualItem.index < initialImageCount}
                    fetchPriority={virtualItem.index === 0 ? 'high' : undefined}
                  />
                  {renderItemExtra?.(climb)}
                </div>
              );
            })}
          </div>
        </ErrorBoundary>
      )}

      <Box ref={sentinelRef} sx={sentinelBoxSx}>
        {!hasMore && climbs.length > 0 && !hideEndMessage && <Box sx={noMoreClimbsBoxSx}>{t('list.noMore')}</Box>}
      </Box>

      {showBottomSpacer && <Box sx={{ height: themeTokens.layout.bottomNavSpacer }} aria-hidden />}
    </Box>
  );
}
