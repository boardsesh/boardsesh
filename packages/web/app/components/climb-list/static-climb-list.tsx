'use client';

import React, { useCallback, useEffect } from 'react';
import Box from '@mui/material/Box';
import { usePathname } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import type { LogbookEntry } from '@boardsesh/board-react';
import ErrorBoundary from '@/app/components/error-boundary';
import StaticClimbRow, { type StaticClimbRowVariant } from '@/app/components/climb-list/static-climb-row';
import { useInfiniteScroll } from '@/app/hooks/use-infinite-scroll';
import { LIST_ROW_HEIGHT } from '@/app/lib/climb-list-constants';
import { themeTokens } from '@/app/theme/theme-config';
import type { BoardImageDetails, Climb } from '@/app/lib/types';
import type { ClimbThumbnailCrop } from '@/app/lib/climb-thumbnail-crop';

/**
 * The crawlable climb list: every row is a real `<a href>` to the canonical
 * config-tuple view URL, and the first render — server or client — emits those
 * anchors.
 *
 * Two consumers shape this prop surface; don't narrow it without checking both.
 *  - `climb-list/multiboard-climb-list.tsx` serves `/playlists/[uuid]`,
 *    `/setter/[username]` and `/profile/{id}/climbs`, and needs
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
  thumbnailCropsByClimb?: Record<string, ClimbThumbnailCrop>;
  /** Board used for any climb without an entry in `boardDetailsByClimb`. */
  boardDetails: BoardImageDetails;
  /** Explicit physical-board identity supplied by a named-board front door. */
  boardSlug?: string;
  /** Per-climb board override, keyed by climb uuid — cross-board lists need it. */
  boardDetailsByClimb?: Record<string, BoardImageDetails>;
  /**
   * Climbs with no resolvable canonical URL, keyed by uuid. Their rows render
   * as plain rows instead of anchors. The session page needs it: a tick whose
   * catalog lookup missed carries no name, layout or frames, so a link would
   * point at an invented board and a climb that doesn't resolve.
   */
  unlinkedClimbUuids?: ReadonlySet<string>;
  /**
   * One key per entry of `climbs`, for a list that holds a climb more than
   * once (a workout's 4x4 sets, #6903). Defaults to the climb's uuid.
   */
  rowKeys?: readonly string[];
  /** Rows drawn faded, by row key: a workout climb the climber skipped on the session page. */
  dimmedRowKeys?: ReadonlySet<string>;
  /** Viewer's ticks for the ascent badges. Absent on anonymous/crawler renders. */
  logbook?: readonly LogbookEntry[];
  /**
   * Virtualize the rows (default). Set `false` on the SSR front doors.
   *
   * The virtualized path renders a viewport-sized window, and on the server
   * that viewport is the 375×812 `initialRect` below — about 18 rows. That is
   * plenty for an infinite-scrolling in-app list and far short of the front
   * door's bar, which is ≥50 crawlable anchors on a fixed, `?page`-paginated
   * page of exactly 50 rows. Fifty fixed rows gain nothing from a virtualizer
   * and lose the anchors the page exists to emit, so the front door opts out
   * and maps every climb.
   *
   * The virtualized path is unchanged and stays the default:
   * `multiboard-climb-list.tsx` and `session-detail-content.tsx` depend on it,
   * including `ref={virtualizer.measureElement}` for the taller tick rows.
   */
  virtualize?: boolean;
  isFetching?: boolean;
  hasMore?: boolean;
  /**
   * Must be idempotent. Two paths call it — the five-rows-early virtualizer
   * effect and the bottom sentinel — and both gate on `!isFetching`, which a
   * caller may not flip synchronously, so a fast scroll can fire both in one
   * tick. Every current caller is React Query's `fetchNextPage`, which drops a
   * second call while the first is in flight.
   *
   * Optional so a static caller doesn't have to pass three dead props: a
   * paginated front door has no "load more".
   */
  onLoadMore?: () => void;
  header?: React.ReactNode;
  /** Rendered instead of the rows when there are no climbs. */
  emptyState?: React.ReactNode;
  hideEndMessage?: boolean;
  showBottomSpacer?: boolean;
  /** Extra content under a row, inside the measured wrapper but outside the link. */
  renderItemExtra?: (climb: Climb, rowKey: string) => React.ReactNode;
  /** `card` draws the app's rows: rounded cards, grade on a coloured chip. See `StaticClimbRow`. */
  rowVariant?: StaticClimbRowVariant;
  /** Name the setter on every row (default). A setter's own page turns it off. */
  showSetter?: boolean;
  /** Add each row's angle to its byline. */
  showAngle?: boolean;
  /**
   * `2` lays card rows out two to a line from the md breakpoint up. Only the
   * non-virtualized path reads it: the virtualizer measures one row per line.
   */
  columns?: 1 | 2;
  /**
   * Ask for the first row's thumbnail at `fetchpriority="high"` (default): on a
   * list page it is the largest thing in the first screen. A page that puts
   * bigger art above the list (the setter's most-sent cards) turns it off, so
   * the two do not compete for the first bytes.
   */
  prioritizeFirstRow?: boolean;
};

const sentinelBoxSx = { minHeight: `${themeTokens.spacing[5]}px` };

const noMoreClimbsBoxSx = {
  textAlign: 'center' as const,
  padding: `${themeTokens.spacing[5]}px`,
  color: 'var(--neutral-500)',
};

const noop = () => {};

const plainRowsSx = { width: '100%', backgroundColor: 'inherit' } as const;

// Card rows sit apart on the page ground instead of sharing hairlines.
const cardRowsSx = {
  ...plainRowsSx,
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr)',
  gap: `${themeTokens.spacing[2]}px`,
} as const;

const twoColumnCardRowsSx = {
  ...cardRowsSx,
  gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
  columnGap: { md: `${themeTokens.spacing[4]}px` },
} as const;

function plainRowsContainerSx(rowVariant: StaticClimbRowVariant, columns: 1 | 2) {
  if (rowVariant !== 'card') return plainRowsSx;
  return columns === 2 ? twoColumnCardRowsSx : cardRowsSx;
}

/** Row props every row shares, whichever path renders it. */
type SharedRowProps = {
  climbs: Climb[];
  thumbnailCropsByClimb?: Record<string, ClimbThumbnailCrop>;
  boardSlug?: string;
  resolveBoardDetails: (climb: Climb) => BoardImageDetails;
  unlinkedClimbUuids?: ReadonlySet<string>;
  rowKeys?: readonly string[];
  dimmedRowKeys?: ReadonlySet<string>;
  pathname: string;
  logbook?: readonly LogbookEntry[];
  renderItemExtra?: (climb: Climb, rowKey: string) => React.ReactNode;
  rowVariant: StaticClimbRowVariant;
  showSetter: boolean;
  showAngle: boolean;
  prioritizeFirstRow: boolean;
};

export default function StaticClimbList({
  climbs,
  thumbnailCropsByClimb,
  boardDetails,
  boardSlug,
  boardDetailsByClimb,
  unlinkedClimbUuids,
  rowKeys,
  dimmedRowKeys,
  logbook,
  virtualize = true,
  isFetching = false,
  hasMore = false,
  onLoadMore = noop,
  header,
  emptyState,
  hideEndMessage = false,
  showBottomSpacer = false,
  renderItemExtra,
  rowVariant = 'list',
  showSetter = true,
  showAngle = false,
  columns = 1,
  prioritizeFirstRow = true,
}: StaticClimbListProps) {
  // Read once at list level: ClimbThumbnail takes the pathname as a prop
  // rather than each row paying for its own context lookup.
  const pathname = usePathname();

  const resolveBoardDetails = useCallback(
    (climb: Climb) => boardDetailsByClimb?.[climb.uuid] ?? boardDetails,
    [boardDetailsByClimb, boardDetails],
  );

  const rowProps: SharedRowProps = {
    climbs,
    thumbnailCropsByClimb,
    boardSlug,
    resolveBoardDetails,
    unlinkedClimbUuids,
    rowKeys,
    dimmedRowKeys,
    pathname,
    logbook,
    renderItemExtra,
    rowVariant,
    showSetter,
    showAngle,
    prioritizeFirstRow,
  };

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
          {virtualize ? (
            <VirtualizedRows {...rowProps} hasMore={hasMore} isFetching={isFetching} onLoadMore={onLoadMore} />
          ) : (
            <PlainRows {...rowProps} columns={columns} />
          )}
        </ErrorBoundary>
      )}

      {/* Infinite scroll and its end message belong to the virtualized path.
          A non-virtualized list is a fixed, `?page`-paginated page with real
          prev/next anchors: there is nothing to load more of, and no "end" to
          announce. */}
      {virtualize && (
        <InfiniteScrollSentinel
          onLoadMore={onLoadMore}
          hasMore={hasMore}
          isFetching={isFetching}
          climbCount={climbs.length}
          hideEndMessage={hideEndMessage}
        />
      )}

      {showBottomSpacer && <Box sx={{ height: themeTokens.layout.bottomNavSpacer }} aria-hidden />}
    </Box>
  );
}

/**
 * Every climb, in document order, no windowing. The front door's 50 rows.
 */
function PlainRows({
  climbs,
  thumbnailCropsByClimb,
  boardSlug,
  resolveBoardDetails,
  unlinkedClimbUuids,
  rowKeys,
  dimmedRowKeys,
  pathname,
  logbook,
  renderItemExtra,
  rowVariant,
  showSetter,
  showAngle,
  prioritizeFirstRow,
  columns,
}: SharedRowProps & { columns: 1 | 2 }) {
  return (
    <Box sx={plainRowsContainerSx(rowVariant, columns)}>
      {climbs.map((climb, index) => {
        const rowKey = rowKeys?.[index] ?? climb.uuid;
        return (
          <div
            key={rowKey}
            data-index={index}
            style={{
              width: '100%',
              minHeight: LIST_ROW_HEIGHT,
              opacity: dimmedRowKeys?.has(rowKey) ? themeTokens.opacity.disabled : undefined,
            }}
          >
            <StaticClimbRow
              climb={climb}
              thumbnailCrop={thumbnailCropsByClimb?.[climb.uuid]}
              boardSlug={boardSlug}
              boardDetails={resolveBoardDetails(climb)}
              unlinked={unlinkedClimbUuids?.has(climb.uuid)}
              pathname={pathname}
              logbook={logbook}
              fetchPriority={prioritizeFirstRow && index === 0 ? 'high' : undefined}
              variant={rowVariant}
              showSetter={showSetter}
              showAngle={showAngle}
            />
            {renderItemExtra?.(climb, rowKey)}
          </div>
        );
      })}
    </Box>
  );
}

function InfiniteScrollSentinel({
  onLoadMore,
  hasMore,
  isFetching,
  climbCount,
  hideEndMessage,
}: {
  onLoadMore: () => void;
  hasMore: boolean;
  isFetching: boolean;
  climbCount: number;
  hideEndMessage: boolean;
}) {
  const { t } = useTranslation('climbs');
  const { sentinelRef } = useInfiniteScroll({ onLoadMore, hasMore, isFetching });

  return (
    <Box ref={sentinelRef} sx={sentinelBoxSx}>
      {!hasMore && climbCount > 0 && !hideEndMessage && <Box sx={noMoreClimbsBoxSx}>{t('list.noMore')}</Box>}
    </Box>
  );
}

function VirtualizedRows({
  climbs,
  thumbnailCropsByClimb,
  boardSlug,
  resolveBoardDetails,
  unlinkedClimbUuids,
  rowKeys,
  dimmedRowKeys,
  pathname,
  logbook,
  renderItemExtra,
  rowVariant,
  showSetter,
  showAngle,
  prioritizeFirstRow,
  hasMore,
  isFetching,
  onLoadMore,
}: SharedRowProps & { hasMore: boolean; isFetching: boolean; onLoadMore: () => void }) {
  // --- List virtualization ---
  // Overscan of 10 items (~1070px at the LIST_ROW_HEIGHT estimate) is enough
  // headroom for fast scrolling while keeping the LCP-time mount count low.
  // Production traces on the classic list showed overscan=25 mounting ~50 items
  // on first paint, each attaching virtualizer.measureElement (a
  // ResizeObserver) — that dominated the render delay (76% of LCP / 2.2s of
  // forced reflow).
  //
  // The estimate reserves unmounted space. Mounted rows stay in normal flow,
  // so responsive thumbnails and session details never overlap before the
  // virtualizer can measure their actual heights.
  const virtualizer = useWindowVirtualizer({
    count: climbs.length,
    estimateSize: () => LIST_ROW_HEIGHT,
    overscan: 10,
    getItemKey: (index) => rowKeys?.[index] ?? climbs[index]?.uuid ?? index,
    // Provide a fake viewport so the virtualizer renders items during SSR.
    // Without this, getVirtualItems() returns [] on the server and the list is
    // entirely client-rendered — which on this list would mean zero crawlable
    // anchors in the HTML, the one thing it exists to emit.
    initialRect: { width: 375, height: 812 },
  });

  const virtualItems = virtualizer.getVirtualItems();

  // Page five rows early so the next batch is in flight before the reader
  // reaches the bottom. The sentinel below still covers the case where the
  // whole list fits in one screen.
  const lastVirtualItem = virtualItems[virtualItems.length - 1];
  const leadingSpace = virtualItems[0]?.start ?? 0;
  const trailingSpace = Math.max(0, virtualizer.getTotalSize() - (lastVirtualItem?.end ?? 0));
  useEffect(() => {
    if (!lastVirtualItem) return;
    if (lastVirtualItem.index >= climbs.length - 5 && hasMore && !isFetching) {
      onLoadMore();
    }
  }, [lastVirtualItem, climbs.length, hasMore, isFetching, onLoadMore]);

  return (
    // Only the unmounted rows need estimated spacers. The contiguous mounted
    // window uses normal DOM flow, including before JavaScript runs.
    <div
      style={{
        width: '100%',
        backgroundColor: 'inherit',
      }}
    >
      <div aria-hidden="true" data-virtual-spacer="before" style={{ height: leadingSpace }} />
      {virtualItems.map((virtualItem) => {
        const climb = climbs[virtualItem.index];
        if (!climb) return null;
        const rowKey = rowKeys?.[virtualItem.index] ?? climb.uuid;
        return (
          <div
            key={virtualItem.key}
            ref={virtualizer.measureElement}
            data-index={virtualItem.index}
            style={{
              width: '100%',
              // This is a minimum, not an absolute-position interval. Larger
              // previews and extra session content establish their own height.
              minHeight: LIST_ROW_HEIGHT,
              boxSizing: 'border-box',
              opacity: dimmedRowKeys?.has(rowKey) ? themeTokens.opacity.disabled : undefined,
              // No `paint` here, unlike the classic list: paint
              // containment clips descendants to this box, and the row
              // is one big anchor whose keyboard focus ring is drawn
              // *outside* its border box (`outline-offset: 2px`, in
              // components/index.css). With `paint` the ring is clipped
              // away and tabbing through the list shows nothing.
              contain: 'layout style',
            }}
          >
            <StaticClimbRow
              climb={climb}
              thumbnailCrop={thumbnailCropsByClimb?.[climb.uuid]}
              boardSlug={boardSlug}
              boardDetails={resolveBoardDetails(climb)}
              unlinked={unlinkedClimbUuids?.has(climb.uuid)}
              pathname={pathname}
              logbook={logbook}
              fetchPriority={prioritizeFirstRow && virtualItem.index === 0 ? 'high' : undefined}
              variant={rowVariant}
              showSetter={showSetter}
              showAngle={showAngle}
            />
            {renderItemExtra?.(climb, rowKey)}
          </div>
        );
      })}
      <div aria-hidden="true" data-virtual-spacer="after" style={{ height: trailingSpace }} />
    </div>
  );
}
