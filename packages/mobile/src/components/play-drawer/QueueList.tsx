import { PressableSurface } from '../PressableSurface';
import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { FlatList, View, StyleSheet, useWindowDimensions } from 'react-native';
import { BottomSheetFlatList } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import type { Climb, ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import { createPlaylistSuggestionSource, getQueueBoardKey, reanchorPlaylistSuggestionSource } from '@boardsesh/queue';
import {
  buildQueueListModel,
  resolveThenFromListItems,
  type QueueFlatRow,
  type QueueWalkBoard,
} from '@boardsesh/play-view';
import { withSheetBottomInset } from '../sheet-content-inset';
import { QueueItemRow, type QueueItemRowBoard, POSITION_SLOT_WIDTH, QUEUE_ROW_LEADING_INSET } from '../QueueItemRow';
import { climbRowSeparatorInset, climbRowReorderHeight, DEFAULT_CLIMB_ROW_SURFACE } from '../climb-row-layout';
import { boardSupportsMirroring } from '@boardsesh/board-config';
import { resolveClimbRenderBoard } from '../../lib/boards/climb-render-board';
import { ClimbListItemContent } from '../ClimbListItemContent';
import { Text } from '../Text';
import { SectionHeader } from '../SectionHeader';
import { spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { useClimbRowDisplay } from '../../lib/climb-row-display-preference';
import { useQueueSessionId } from '../../providers/queue-provider';
import { usePartyProfile } from '../../providers/party-profile-provider';
import { useAuth } from '../../providers/auth-provider';
import { hapticSelection } from '../../lib/haptics';
import { useBoardContinuationFeed } from '../../providers/queue/use-board-continuation-feed';
import { useQueueDrag } from './use-queue-drag';
import { useWindowBottomInset } from '../../hooks/use-window-bottom-inset';
import type { ClimbActionsTarget } from '../../providers/drawer-host-provider';

// Synthetic suggestion-source id for tapping a climb from the queue sheet's
// "Popular on this board" rows — distinct from real playlist activations. This
// is a plain string identifier (PlaylistSuggestionSource.playlistUuid is typed
// `string` and nothing validates UUID format — the climbs list likewise uses
// 'climblist').
const QUEUE_SUGGESTION_SOURCE_ID = 'queue-suggestions';

/**
 * A climb below the queue: `thenFrom`, one a swipe reaches after Up next (the
 * list part of the walk); `popular`, one from the board's popular feed that no
 * swipe reaches (#5403).
 */
type OffQueueSection = 'thenFrom' | 'popular';
type OffQueueRow = { type: 'off-queue'; section: OffQueueSection; climb: Climb; key: string };
type SectionKey = 'history' | 'now' | 'upNext' | OffQueueSection;
// A label row above a section. The first section below the queue also gets a
// divider, so its climbs stop reading as queued ones.
type SectionHeaderRow = { type: 'section-header'; section: SectionKey; divider: boolean };
type QueueListRow = QueueFlatRow | OffQueueRow | SectionHeaderRow;

const NO_ITEMS: readonly ClimbQueueItem[] = [];

type QueueListProps = {
  queue: ClimbQueueItem[];
  /**
   * The queue's current climb (`currentClimbQueueItem`), the object the player
   * and `nextClimb` walk from. The "Then from" walk starts here too, so a
   * current climb the queue doesn't hold yet (a commit before the server's
   * echo) walks as the swipe does, not from the line.
   */
  currentItem: ClimbQueueItem | null;
  /** F3 now-slot mode: the History / Up next line with nothing current; null in legacy mode. */
  historyCount?: number | null;
  board: QueueItemRowBoard;
  isEditMode: boolean;
  showHistory: boolean;
  showFullHistory: boolean;
  selectedItems: Set<string>;
  playlistSuggestionSource: PlaylistSuggestionSource | null;
  /**
   * The board the swipe walk is filtered against (`useQueueWalkBoard`), so the
   * "Then from" rows walk past the queued climbs a swipe does. Absent: board-blind.
   */
  walkBoard?: QueueWalkBoard;
  /** True while the queue sheet is presented. Gates the popular feed query and
   *  the "Then from" walk so they only run while the sheet is open — the sheet
   *  stays mounted (for the imperative present()), so without this the feed
   *  would fetch continuously for the whole session. */
  active: boolean;
  autoScrollOnMount?: boolean;
  onToggleSelect: (uuid: string) => void;
  onClimbPress: (item: ClimbQueueItem) => void;
  /** Resolve the row's native menu target. */
  onOpenActions?: (item: ClimbQueueItem) => ClimbActionsTarget | null | undefined;
  onRemove: (uuid: string) => void;
  onShowFullHistory: () => void;
  onTickHistory: (item: ClimbQueueItem) => void;
  onSuggestionPress: (climb: Climb, source: PlaylistSuggestionSource) => void;
  reorderQueue: (uuid: string, oldIndex: number, newIndex: number) => void;
  onDraggingChange?: (dragging: boolean) => void;
  /**
   * `sheet` (default): inside QueueSheet, clearing the window's bottom inset.
   * `panel`: the landscape iPad player's side panel, a plain list whose footer
   * already sits above the home indicator.
   */
  presentation?: 'sheet' | 'panel';
};

function QueueListComponent({
  queue,
  currentItem,
  historyCount = null,
  board,
  isEditMode,
  showHistory,
  showFullHistory,
  selectedItems,
  playlistSuggestionSource,
  walkBoard,
  active,
  autoScrollOnMount,
  onToggleSelect,
  onClimbPress,
  onOpenActions,
  onRemove,
  onShowFullHistory,
  onTickHistory,
  onSuggestionPress,
  reorderQueue,
  onDraggingChange,
  presentation = 'sheet',
}: QueueListProps) {
  const { t } = useTranslation('session');
  const { systemColors, brandColors, textStyles } = useTheme();
  const { fontScale } = useWindowDimensions();
  // A suggestion row's separator starts under its text, like the queue rows'
  // above it: past the thumbnail only while the climber shows one. A boolean
  // that changes when a setting does, so it is safe among `renderRow`'s deps.
  const rowDisplay = useClimbRowDisplay();
  const hasThumbnail = rowDisplay.thumbnail;
  // In QueueSheet (a native sheet) the list clears the WINDOW's bottom inset,
  // never the mount point's (#3776). The side panel's footer clears it instead.
  const windowBottomInset = useWindowBottomInset();
  const listBottomInset = presentation === 'sheet' ? windowBottomInset : 0;
  const flatListRef = useRef<FlatList<QueueListRow> | null>(null);

  // Attribution is a session artifact: faces appear while a party session is
  // joined and stay put when a peer leaves. Deliberately NOT useIsSharedSession()
  // — that resolves to `sessionActive && distinctUserCount > 1`, so the last peer
  // leaving (or presence flapping) would wipe every face off a queue still full
  // of the crew's climbs. And deliberately paired with viewerUserId: the queue
  // provider stamps SOLO adds too, so without the self-exclusion a one-person
  // session would show the viewer's own face on every row. Neither value is read
  // from the live `sessionUsers` roster, which is recreated by every session
  // stats push.
  // Account identity can hydrate after the session. Hold faces until it is
  // known so the viewer's account-stamped rows never flash their own avatar.
  // Anonymous viewers can still see public peer attribution without a profile.
  const { sessionId } = useQueueSessionId();
  const { authenticatedUserId, isAuthenticated } = usePartyProfile();
  const { isLoading: isAuthLoading } = useAuth();
  const showAddedBy = sessionId != null && !isAuthLoading && (!isAuthenticated || !!authenticatedUserId);
  const viewerUserId = isAuthenticated ? authenticatedUserId : null;

  // Clear the queue toolbar (styles.listContent's spacing[10]) AND the Android
  // edge-to-edge navigation bar, so the last row never sits under the 3-button nav
  // bar when fully scrolled. withSheetBottomInset adds the window inset on top of the
  // toolbar padding (and returns the base unchanged when there's no inset).
  const listContentContainerStyle = useMemo(
    () => withSheetBottomInset(styles.listContent, listBottomInset),
    [listBottomInset],
  );

  const currentItemUuid = currentItem?.uuid ?? null;
  const { flatRows, currentItemFlatIndex } = useMemo(
    () =>
      buildQueueListModel(queue, currentItemUuid, {
        showHistory,
        showFullHistory,
        historyCount,
      }),
    [queue, currentItemUuid, showHistory, showFullHistory, historyCount],
  );

  // Below the queue, two sections (Then-signposts, 2026-11-02). "Then from
  // Projects": the climbs swipes from the current climb reach after Up next, in
  // the order they reach them, under the list name the player's top bar uses.
  // It is the walk itself (`resolveThenFromListItems`, the selection every
  // swipe, Next and `nextClimb` make), so the rows can't drift from the swipe:
  // the parity test in play-view's queue-sheet-walk.test.ts holds them to it.
  // "Popular on this board": the board's feed, minus anything queued or in
  // Then from. No swipe reaches those (#5403), and the label says so.
  //
  // Both are gated on `active` (sheet presented), not on the list: the sheet
  // stays mounted for the imperative present(), so without the gate the feed
  // would fetch, and the walk run, for the whole session.
  const thenFromItems = useMemo(
    () =>
      active
        ? resolveThenFromListItems(queue, currentItem, playlistSuggestionSource, { ...walkBoard, historyCount })
        : NO_ITEMS,
    [active, queue, currentItem, playlistSuggestionSource, walkBoard, historyCount],
  );

  // Page 0 of the board's popular-by-ascents list, unfiltered on purpose: these
  // rows are how a climber finds something outside the filters they are browsing
  // with, and filtering them would leave a narrow filter with an empty area. The
  // queue provider no longer reads this feed at all — a swipe stops at the end of
  // the climber's own list rather than walking into it (issue #5403).
  const { climbs: boardContinuationClimbs } = useBoardContinuationFeed(board, active);

  // A swipe TRACK has one provenance (issue #5403). A tap on a Then from row
  // re-enters the list it came from; a tap on a popular row gets a track of the
  // popular rows only, so swiping off a filtered list never walks into climbs
  // the climber filtered out.
  const popularClimbs = useMemo(() => {
    const excluded = new Set<string>();
    for (const queueItem of queue) if (queueItem.climb?.uuid) excluded.add(queueItem.climb.uuid);
    for (const { climb } of thenFromItems) if (climb?.uuid) excluded.add(climb.uuid);
    const popular: Climb[] = [];
    for (const climb of boardContinuationClimbs) {
      if (!climb?.uuid || excluded.has(climb.uuid)) continue;
      excluded.add(climb.uuid);
      popular.push(climb);
    }
    return popular;
  }, [queue, thenFromItems, boardContinuationClimbs]);

  // What the top bar calls the list ("Projects"). A list nobody named, the
  // board feed a popular row's tap started among them, has no name up there
  // either, so the sheet doesn't invent one: "Then from the list".
  const trackLabel = playlistSuggestionSource?.label?.trim();
  const thenFromTitle = trackLabel
    ? t('queueList.sectionThenFrom', { list: trackLabel })
    : t('queueList.sectionThenFromUnnamed');

  // Section labels are inserted here rather than in the shared model: they are a
  // presentation choice of this sheet. A header exists only when its section has
  // rows. History's header sits above the "show all" row, Now's above the
  // current climb, Up next's above the first upcoming climb.
  const { rows, currentRowIndex } = useMemo(() => {
    const labelled: QueueListRow[] = [];
    let scrollIndex = -1;
    let upNextLabelled = false;
    flatRows.forEach((row, index) => {
      if (index === 0 && (row.type === 'history-show-all' || row.type === 'history-item')) {
        labelled.push({ type: 'section-header', section: 'history', divider: false });
      }
      if (row.type === 'current-item') {
        labelled.push({ type: 'section-header', section: 'now', divider: false });
      }
      if (row.type === 'future-item' && !upNextLabelled) {
        labelled.push({ type: 'section-header', section: 'upNext', divider: false });
        upNextLabelled = true;
      }
      // The model's index counts rows without headers; re-find it in this list.
      if (index === currentItemFlatIndex) scrollIndex = labelled.length;
      labelled.push(row);
    });
    if (thenFromItems.length > 0) {
      labelled.push({ type: 'section-header', section: 'thenFrom', divider: true });
      for (const { uuid, climb } of thenFromItems) {
        labelled.push({ type: 'off-queue', section: 'thenFrom', climb, key: uuid });
      }
    }
    if (popularClimbs.length > 0) {
      labelled.push({ type: 'section-header', section: 'popular', divider: thenFromItems.length === 0 });
      for (const climb of popularClimbs) {
        labelled.push({ type: 'off-queue', section: 'popular', climb, key: climb.uuid });
      }
    }
    return { rows: labelled, currentRowIndex: scrollIndex };
  }, [flatRows, currentItemFlatIndex, thenFromItems, popularClimbs]);

  const reorderRowHeight = useMemo(() => {
    const futureRows = [];
    for (const row of flatRows) {
      if (row.type !== 'future-item') continue;
      const rowBoard = resolveClimbRenderBoard(row.item.climb, board)?.boardConfig ?? board;
      const statsAngle = row.item.climb && 'statsAngle' in row.item.climb ? row.item.climb.statsAngle : null;
      futureRows.push({
        supportsMirroring: boardSupportsMirroring(
          rowBoard.boardName as import('@boardsesh/shared-schema').BoardName,
          rowBoard.layoutId,
        ),
        hasSetAngleMarker: typeof statsAngle === 'number' && statsAngle !== rowBoard.angle,
      });
    }
    return climbRowReorderHeight({
      rows: futureRows,
      display: rowDisplay,
      surface: DEFAULT_CLIMB_ROW_SURFACE,
      fontScale,
      typeScale: textStyles,
    });
  }, [flatRows, board, rowDisplay, fontScale, textStyles]);

  // The contiguous draggable window: the `future-item` rows (upcoming queue).
  const { firstFutureRowIndex, lastFutureRowIndex, firstFutureQueueIndex } = useMemo(() => {
    let first = -1;
    let last = -1;
    let firstQueue = -1;
    rows.forEach((row, index) => {
      if (row.type === 'future-item') {
        if (first === -1) {
          first = index;
          firstQueue = row.queueIndex;
        }
        last = index;
      }
    });
    return { firstFutureRowIndex: first, lastFutureRowIndex: last, firstFutureQueueIndex: firstQueue };
  }, [rows]);

  const { isDragging, controls: dragControls } = useQueueDrag({
    reorderQueue,
    firstFutureRowIndex,
    lastFutureRowIndex,
    firstFutureQueueIndex,
  });

  useEffect(() => {
    onDraggingChange?.(isDragging);
  }, [isDragging, onDraggingChange]);

  // The sheet re-centres whenever its rows move while open. The side panel stays
  // up for the whole session, so it re-centres only when it comes forward or the
  // current climb changes: a crew add or a suggestion page landing must not yank
  // a climber who scrolled away back to the current row.
  const currentRowIndexRef = useRef(currentRowIndex);
  currentRowIndexRef.current = currentRowIndex;
  const scrollTrigger = presentation === 'panel' ? currentItemUuid : `${currentRowIndex}:${rows.length}`;
  useEffect(() => {
    const index = currentRowIndexRef.current;
    if (autoScrollOnMount && index >= 0) {
      const timer = setTimeout(() => {
        flatListRef.current?.scrollToIndex?.({
          index,
          animated: true,
          viewPosition: 0.3,
        });
      }, 300);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [autoScrollOnMount, scrollTrigger]);

  const keyExtractor = useCallback((row: QueueListRow, index: number): string => {
    switch (row.type) {
      case 'history-show-all':
        return 'history-show-all';
      case 'history-divider':
        return 'history-divider';
      case 'section-header':
        return `section-${row.section}`;
      case 'history-item':
        return `history-${row.item.uuid}`;
      case 'current-item':
        return `current-${row.item.uuid}`;
      case 'future-item':
        return `future-${row.item.uuid}`;
      case 'off-queue':
        return `${row.section}-${row.key}`;
      default:
        return `row-${String(index)}`;
    }
  }, []);

  // Read at the tap through refs, so a feed page or a step along the list
  // doesn't hand every off-queue row a new handler.
  const popularClimbsRef = useRef(popularClimbs);
  popularClimbsRef.current = popularClimbs;
  const playlistSuggestionSourceRef = useRef(playlistSuggestionSource);
  playlistSuggestionSourceRef.current = playlistSuggestionSource;
  const handleOffQueuePress = useCallback(
    (climb: Climb, section: OffQueueSection) => {
      hapticSelection();
      // One provenance per track (issue #5403). A Then from row re-enters the
      // list it is on, re-anchored on the tapped climb, and nothing from the
      // board feed joins it. A popular row gets a track of popular climbs only.
      if (section === 'thenFrom') {
        // A Then from row only exists while the list does, so this cannot come
        // back null in practice; the guard keeps the tap from being dropped.
        const reanchored = reanchorPlaylistSuggestionSource(playlistSuggestionSourceRef.current, climb.uuid);
        if (reanchored) onSuggestionPress(climb, reanchored);
        return;
      }
      onSuggestionPress(
        climb,
        createPlaylistSuggestionSource({
          playlistUuid: QUEUE_SUGGESTION_SOURCE_ID,
          activatedClimb: climb,
          climbs: popularClimbsRef.current,
          boardKey: getQueueBoardKey({
            board_name: board.boardName,
            layout_id: board.layoutId,
            size_id: board.sizeId,
            set_ids: board.setIds,
          }),
        }),
      );
    },
    [onSuggestionPress, board],
  );

  const renderRow = useCallback(
    ({ item: row, index }: { item: QueueListRow; index: number }) => {
      switch (row.type) {
        case 'history-show-all':
          return (
            <PressableSurface
              onPress={onShowFullHistory}
              style={styles.showAllRow}
              accessibilityRole="button"
              accessibilityLabel={t('queueList.showFullHistoryAria', { count: row.hiddenCount })}
            >
              <Text variant="subheadline" color={brandColors.primary}>
                {t('queueList.showFullHistory', { count: row.hiddenCount })}
              </Text>
            </PressableSurface>
          );

        case 'section-header':
          return (
            <View>
              {row.divider ? (
                <View
                  testID="queue-off-queue-divider"
                  style={[styles.sectionDivider, { backgroundColor: systemColors.separator }]}
                />
              ) : null}
              {/* Literal keys, so the i18n orphan check can see each one. */}
              <SectionHeader
                title={
                  row.section === 'history'
                    ? t('queueList.sectionHistory')
                    : row.section === 'now'
                      ? t('queueList.sectionNow')
                      : row.section === 'upNext'
                        ? t('queueList.sectionUpNext')
                        : row.section === 'thenFrom'
                          ? thenFromTitle
                          : t('queueList.sectionPopular')
                }
              />
            </View>
          );

        case 'history-divider':
          return <View style={[styles.divider, { backgroundColor: systemColors.separator }]} />;

        case 'history-item':
          return (
            <QueueItemRow
              item={row.item}
              position={row.queueIndex + 1}
              board={board}
              isCurrentClimb={false}
              isHistoryItem
              isEditMode={isEditMode}
              isSelected={selectedItems.has(row.item.uuid)}
              onPress={onClimbPress}
              onOpenActions={onOpenActions}
              onRemove={onRemove}
              onToggleSelect={onToggleSelect}
              onTickHistory={onTickHistory}
              showAddedBy={showAddedBy}
              viewerUserId={viewerUserId}
            />
          );

        case 'current-item':
          return (
            <QueueItemRow
              item={row.item}
              position={row.queueIndex + 1}
              board={board}
              isCurrentClimb
              isEditMode={isEditMode}
              isSelected={selectedItems.has(row.item.uuid)}
              onPress={onClimbPress}
              onOpenActions={onOpenActions}
              onRemove={onRemove}
              onToggleSelect={onToggleSelect}
              showAddedBy={showAddedBy}
              viewerUserId={viewerUserId}
            />
          );

        case 'future-item':
          return (
            <QueueItemRow
              item={row.item}
              position={row.queueIndex + 1}
              board={board}
              isCurrentClimb={false}
              isEditMode={isEditMode}
              isSelected={selectedItems.has(row.item.uuid)}
              onPress={onClimbPress}
              onOpenActions={onOpenActions}
              onRemove={onRemove}
              onToggleSelect={onToggleSelect}
              drag={dragControls}
              rowIndex={index}
              queueIndex={row.queueIndex}
              showcaseAvatarAnchor={process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' && index === firstFutureRowIndex}
              isDraggable={!isEditMode}
              minimumHeight={reorderRowHeight}
              showAddedBy={showAddedBy}
              viewerUserId={viewerUserId}
            />
          );

        case 'off-queue':
          return (
            <OffQueueClimbRow
              climb={row.climb}
              section={row.section}
              board={board}
              hasThumbnail={hasThumbnail}
              onPress={handleOffQueuePress}
            />
          );

        default:
          return null;
      }
    },
    [
      board,
      dragControls,
      reorderRowHeight,
      firstFutureRowIndex,
      isEditMode,
      selectedItems,
      onClimbPress,
      onOpenActions,
      onRemove,
      onToggleSelect,
      onTickHistory,
      onShowFullHistory,
      handleOffQueuePress,
      thenFromTitle,
      showAddedBy,
      viewerUserId,
      hasThumbnail,
      systemColors.separator,
      brandColors.primary,
      t,
    ],
  );

  if (rows.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text variant="body" color={systemColors.secondaryLabel}>
          {t('mobile.queueSheet.emptyQueue')}
        </Text>
      </View>
    );
  }

  // The same list either way: BottomSheetFlatList is RN's FlatList on native,
  // but the browser build swaps in a sheet-bound list that needs a sheet around it.
  const ListComponent = presentation === 'sheet' ? BottomSheetFlatList : FlatList;
  return (
    <ListComponent
      ref={flatListRef}
      data={rows}
      keyExtractor={keyExtractor}
      renderItem={renderRow}
      contentContainerStyle={listContentContainerStyle}
      showsVerticalScrollIndicator={false}
      scrollEnabled={!isDragging}
      onScrollToIndexFailed={() => {
        // Silently handle if scroll target isn't rendered yet
      }}
    />
  );
}

type OffQueueClimbRowProps = {
  climb: Climb;
  section: OffQueueSection;
  board: QueueItemRowBoard;
  hasThumbnail: boolean;
  onPress: (climb: Climb, section: OffQueueSection) => void;
};

/**
 * One climb below the queue (Then from, or Popular on this board). Memoized so
 * a page of the feed landing, or a queue change elsewhere, re-renders only the
 * rows whose climb changed: a long list puts a few hundred of these in the sheet.
 */
const OffQueueClimbRow = memo(function OffQueueClimbRow({
  climb,
  section,
  board,
  hasThumbnail,
  onPress,
}: OffQueueClimbRowProps) {
  const { systemColors } = useTheme();
  const handlePress = useCallback(() => onPress(climb, section), [onPress, climb, section]);
  return (
    <View>
      <PressableSurface
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityLabel={climb.name}
        style={[styles.suggestionRow, { backgroundColor: systemColors.secondaryBackground }]}
      >
        <View style={styles.suggestionSpacer} />
        <ClimbListItemContent
          climb={climb}
          boardName={board.boardName}
          layoutId={board.layoutId}
          sizeId={board.sizeId}
          setIds={board.setIds}
          angle={board.angle}
        />
      </PressableSurface>
      <View
        style={[
          styles.separator,
          {
            marginStart: climbRowSeparatorInset(hasThumbnail, QUEUE_ROW_LEADING_INSET),
            backgroundColor: systemColors.separator,
          },
        ]}
      />
    </View>
  );
});

// Memoized so a hidden, always-mounted QueueSheet (which freezes its queue
// snapshot) skips reconciling the list — and buildQueueListModel — on every
// unrelated queue nav elsewhere. Relies on the sheet keeping its props stable.
export const QueueList = memo(QueueListComponent);

const styles = StyleSheet.create({
  listContent: {
    paddingBottom: spacing[10],
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing[16],
  },
  showAllRow: {
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[4],
    alignItems: 'center',
  },
  sectionDivider: {
    height: StyleSheet.hairlineWidth,
    marginTop: spacing[2],
    marginHorizontal: spacing[4],
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: spacing[1],
    marginHorizontal: spacing[4],
  },
  suggestionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: spacing[3],
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[3],
  },
  suggestionSpacer: {
    width: POSITION_SLOT_WIDTH,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
  },
});
