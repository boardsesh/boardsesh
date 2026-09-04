import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { View, Pressable, StyleSheet, type FlatList } from 'react-native';
import { BottomSheetFlatList } from '@expo/ui/community/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { Climb, ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import { getPlaylistSuggestedClimbs, createPlaylistSuggestionSource, getQueueBoardKey } from '@boardsesh/queue';
import { buildQueueListModel, type QueueFlatRow } from '@boardsesh/play-view';
import { withSheetBottomInset } from '../sheet-content-inset';
import { QueueItemRow, type QueueItemRowBoard, POSITION_SLOT_WIDTH, SEPARATOR_INSET } from '../QueueItemRow';
import { ClimbListItemContent } from '../ClimbListItemContent';
import { Text } from '../Text';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { useQueueSessionId } from '../../providers/queue-provider';
import { usePartyProfile } from '../../providers/party-profile-provider';
import { hapticSelection } from '../../lib/haptics';
import { useBoardContinuationFeed } from '../../providers/queue/use-board-continuation-feed';
import { useQueueDrag } from './use-queue-drag';

// Synthetic suggestion-source id for tapping a climb from the queue sheet's
// suggestion feed — distinct from real playlist activations. This is a plain
// string identifier (PlaylistSuggestionSource.playlistUuid is typed `string`
// and nothing validates UUID format — the climbs list likewise uses 'climblist').
const QUEUE_SUGGESTION_SOURCE_ID = 'queue-suggestions';

type SuggestionRow = { type: 'suggestion'; climb: Climb };
type QueueListRow = QueueFlatRow | SuggestionRow;

// Show only the last 2 climbed by default; "show full history" expands the rest.
const HISTORY_DISPLAY_LIMIT = 2;

type QueueListProps = {
  queue: ClimbQueueItem[];
  currentItemUuid: string | null;
  board: QueueItemRowBoard;
  isEditMode: boolean;
  showHistory: boolean;
  showFullHistory: boolean;
  selectedItems: Set<string>;
  playlistSuggestionSource: PlaylistSuggestionSource | null;
  /** True while the queue sheet is presented. Gates the suggestion feed query
   *  so it only runs while the sheet is open — the sheet stays mounted (for the
   *  imperative present()), so without this the feed would fetch continuously
   *  for the whole session. */
  active: boolean;
  autoScrollOnMount?: boolean;
  onToggleSelect: (uuid: string) => void;
  onClimbPress: (item: ClimbQueueItem) => void;
  /** Long press a queue row → open the climb reaction menu. */
  onOpenActions?: (item: ClimbQueueItem) => void;
  onRemove: (uuid: string) => void;
  onShowFullHistory: () => void;
  onTickHistory: (item: ClimbQueueItem) => void;
  onSuggestionPress: (climb: Climb, source: PlaylistSuggestionSource) => void;
  reorderQueue: (uuid: string, oldIndex: number, newIndex: number) => void;
  onDraggingChange?: (dragging: boolean) => void;
};

function QueueListComponent({
  queue,
  currentItemUuid,
  board,
  isEditMode,
  showHistory,
  showFullHistory,
  selectedItems,
  playlistSuggestionSource,
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
}: QueueListProps) {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const insets = useSafeAreaInsets();
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
  // Gated on isLoading as well: `profile` and `sessionId` hydrate on racing async
  // paths, so a cold launch into a restored session can resolve the session first
  // and leave viewerUserId null for a frame — long enough to flash the viewer's
  // own face on their own rows before self-exclusion can suppress it.
  const { sessionId } = useQueueSessionId();
  const { profile, isLoading: isPartyProfileLoading } = usePartyProfile();
  const showAddedBy = sessionId != null && !isPartyProfileLoading;
  const viewerUserId = profile?.id ?? null;

  // Clear the queue toolbar (styles.listContent's spacing[10]) AND the Android
  // edge-to-edge navigation bar, so the last row never sits under the 3-button nav
  // bar when fully scrolled. withSheetBottomInset adds insets.bottom on top of the
  // toolbar padding (and returns the base unchanged when there's no inset).
  const listContentContainerStyle = useMemo(
    () => withSheetBottomInset(styles.listContent, insets.bottom),
    [insets.bottom],
  );

  const { flatRows, currentItemFlatIndex } = useMemo(
    () =>
      buildQueueListModel(queue, currentItemUuid, {
        showHistory,
        showFullHistory,
        historyDisplayLimit: HISTORY_DISPLAY_LIMIT,
      }),
    [queue, currentItemUuid, showHistory, showFullHistory],
  );

  // Suggested climbs flow directly after the queue rows — NO header, NO divider
  // (the intentional divergence from web). Playlist suggestions (when a playlist
  // is active) come first, then a popular (by-ascents) feed for the board tops
  // the list up. The feed query is gated on `active` (sheet presented), not on
  // the playlist source: the sheet stays mounted for the imperative present(),
  // so without this gate the feed would fetch for the whole session. Fetching
  // regardless of the source means suggestions never vanish when the source
  // flips or its climbs go empty; they fall back to the feed. Everything already
  // in the queue is excluded.
  const playlistSuggestions = useMemo(
    () => getPlaylistSuggestedClimbs(playlistSuggestionSource, queue),
    [playlistSuggestionSource, queue],
  );

  // Same hook — and therefore the same cached page — the queue provider re-anchors
  // `next` onto after a board switch, so the sheet and the swipe never disagree
  // about what comes next on this board.
  const { climbs: boardContinuationClimbs } = useBoardContinuationFeed(board, active);

  const suggestions = useMemo<Climb[]>(() => {
    const queued = new Set(queue.map((item) => item.climb?.uuid).filter((uuid): uuid is string => !!uuid));
    const seen = new Set<string>();
    const out: Climb[] = [];
    const add = (climbs: readonly Climb[]) => {
      for (const climb of climbs) {
        if (!climb?.uuid || queued.has(climb.uuid) || seen.has(climb.uuid)) continue;
        seen.add(climb.uuid);
        out.push(climb);
      }
    };
    add(playlistSuggestions);
    add(boardContinuationClimbs);
    return out;
  }, [playlistSuggestions, boardContinuationClimbs, queue]);

  const rows = useMemo<QueueListRow[]>(
    () => [...flatRows, ...suggestions.map((climb): SuggestionRow => ({ type: 'suggestion', climb }))],
    [flatRows, suggestions],
  );

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

  useEffect(() => {
    if (autoScrollOnMount && currentItemFlatIndex >= 0 && rows.length > 0) {
      const timer = setTimeout(() => {
        flatListRef.current?.scrollToIndex?.({
          index: currentItemFlatIndex,
          animated: true,
          viewPosition: 0.3,
        });
      }, 300);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [autoScrollOnMount, currentItemFlatIndex, rows.length]);

  const keyExtractor = useCallback((row: QueueListRow, index: number): string => {
    switch (row.type) {
      case 'history-show-all':
        return 'history-show-all';
      case 'history-divider':
        return 'history-divider';
      case 'history-item':
        return `history-${row.item.uuid}`;
      case 'current-item':
        return `current-${row.item.uuid}`;
      case 'future-item':
        return `future-${row.item.uuid}`;
      case 'suggestion':
        return `suggestion-${row.climb.uuid}`;
      default:
        return `row-${String(index)}`;
    }
  }, []);

  const handleSuggestionPress = useCallback(
    (climb: Climb) => {
      hapticSelection();
      // Build a suggestion source anchored at the tapped climb from the CURRENT
      // suggestions list, so the play drawer can keep swiping forward through the
      // rest of the suggestions (mirrors how the climbs-list browse activation
      // seeds a source from its loaded climbs).
      const source = createPlaylistSuggestionSource({
        playlistUuid: QUEUE_SUGGESTION_SOURCE_ID,
        activatedClimb: climb,
        climbs: suggestions,
        boardKey: getQueueBoardKey({
          board_name: board.boardName,
          layout_id: board.layoutId,
          size_id: board.sizeId,
          set_ids: board.setIds,
        }),
      });
      onSuggestionPress(climb, source);
    },
    [onSuggestionPress, suggestions, board],
  );

  const renderRow = useCallback(
    ({ item: row, index }: { item: QueueListRow; index: number }) => {
      switch (row.type) {
        case 'history-show-all':
          return (
            <Pressable
              onPress={onShowFullHistory}
              style={styles.showAllRow}
              accessibilityRole="button"
              accessibilityLabel={t('queueList.showFullHistoryAria', { count: row.hiddenCount })}
            >
              <Text variant="subheadline" color={brandColors.primary}>
                {t('queueList.showFullHistory', { count: row.hiddenCount })}
              </Text>
            </Pressable>
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
              isDraggable={!isEditMode}
              showAddedBy={showAddedBy}
              viewerUserId={viewerUserId}
            />
          );

        case 'suggestion':
          return (
            <View>
              <Pressable
                onPress={() => handleSuggestionPress(row.climb)}
                accessibilityRole="button"
                accessibilityLabel={row.climb.name}
                style={[styles.suggestionRow, { backgroundColor: systemColors.secondaryBackground }]}
              >
                <View style={styles.suggestionSpacer} />
                <ClimbListItemContent
                  climb={row.climb}
                  boardName={board.boardName}
                  layoutId={board.layoutId}
                  sizeId={board.sizeId}
                  setIds={board.setIds}
                  angle={board.angle}
                />
              </Pressable>
              <View style={[styles.separator, { backgroundColor: systemColors.separator }]} />
            </View>
          );

        default:
          return null;
      }
    },
    [
      board,
      dragControls,
      isEditMode,
      selectedItems,
      onClimbPress,
      onOpenActions,
      onRemove,
      onToggleSelect,
      onTickHistory,
      onShowFullHistory,
      handleSuggestionPress,
      showAddedBy,
      viewerUserId,
      systemColors.separator,
      systemColors.secondaryBackground,
      brandColors.primary,
      t,
    ],
  );

  if (rows.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text variant="body" color={iosSystemColors.systemGray}>
          {t('mobile.queueSheet.emptyQueue')}
        </Text>
      </View>
    );
  }

  return (
    <BottomSheetFlatList
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
    marginLeft: SEPARATOR_INSET,
  },
});
