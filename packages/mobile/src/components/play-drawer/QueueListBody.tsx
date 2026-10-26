import { PressableSurface } from '../PressableSurface';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { upNextStart, type Climb, type ClimbQueueItem, type PlaylistSuggestionSource } from '@boardsesh/queue';
import { QueueSheetHeader } from './QueueSheetHeader';
import { QueueList } from './QueueList';
import { Text } from '../Text';
import type { QueueItemRowBoard } from '../QueueItemRow';
import { usePlaylistSuggestionSource, useQueueActions, useQueueSessionId } from '../../providers/queue-provider';
import { useTheme } from '../../providers/theme-provider';
import { hapticWarning } from '../../lib/haptics';
import type { QueueContentSnapshot } from '../../lib/queue-undo';
import { getCredentialGeneration } from '../../lib/privacy/privacy-cache';
import { UndoSnackbar } from '../UndoSnackbar';
import { brandColors } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';
import { useWindowBottomInset } from '../../hooks/use-window-bottom-inset';

// Long enough to notice and reach for the button; the removal is already live
// for the crew, so it isn't held open forever.
const QUEUE_UNDO_DURATION = 8000;

/** What one Undo would put back: the queue as it was, and what was taken out. */
type PendingQueueUndo = {
  nonce: number;
  kind: 'cleared' | 'removed';
  /** The session the removal happened in; the offer dies with it. */
  scope: string;
  credentialGeneration: number;
  before: QueueContentSnapshot;
  playlistSuggestionSource: PlaylistSuggestionSource | null;
  removedUuids: ReadonlySet<string>;
};

type QueueListBodyProps = {
  board: QueueItemRowBoard;
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
  historyCount: number | null | undefined;
  /** True while the list is on screen. Gates the suggestion feed (see QueueList). */
  active: boolean;
  /** `sheet`: inside QueueSheet. `panel`: the landscape iPad player's side panel. */
  presentation: 'sheet' | 'panel';
  /** The header's fold-away chevron. The side panel has nothing to close. */
  onClose?: () => void;
  onClimbPress: (item: ClimbQueueItem) => void;
  /** Long press a queue row → open the climb reaction menu. */
  onOpenActions?: (item: ClimbQueueItem) => void;
  onSuggestionPress: (climb: Climb, source: PlaylistSuggestionSource) => void;
  onTickHistory: (item: ClimbQueueItem) => void;
  onDraggingChange?: (dragging: boolean) => void;
};

export type QueueListBodyHandle = {
  /** Leave edit mode, drop the selection, fold History and retire the Undo. */
  reset: () => void;
};

/**
 * The queue as the climber edits it: the header (History, Edit, Clear), the
 * list, the Undo after a removal and the bulk Remove bar. QueueSheet presents it
 * in a sheet; the landscape iPad player shows it in its Up next panel. Returns
 * siblings, so the host decides the container (the sheet's own content view, or
 * a flex column in the panel).
 */
export const QueueListBody = forwardRef<QueueListBodyHandle, QueueListBodyProps>(function QueueListBody(
  {
    board,
    queue,
    currentClimbQueueItem,
    historyCount,
    active,
    presentation,
    onClose,
    onClimbPress,
    onOpenActions,
    onSuggestionPress,
    onTickHistory,
    onDraggingChange,
  },
  ref,
) {
  const { t } = useTranslation('session');
  // A native sheet clears the WINDOW's bottom inset, never the mount point's
  // (#3776; docs/mobile-sheets-vs-routes.md). The panel's footer already sits
  // above the home indicator.
  const windowBottomInset = useWindowBottomInset();
  const bottomInset = presentation === 'sheet' ? windowBottomInset : 0;
  const { systemColors } = useTheme();

  const {
    removeQueueItems,
    clearQueue,
    reorderQueue,
    restoreQueueItems,
    getQueueSnapshot,
    setPlaylistSuggestionSource,
  } = useQueueActions();
  const playlistSuggestionSource = usePlaylistSuggestionSource();
  const { undoScope } = useQueueSessionId();

  const [isEditMode, setIsEditMode] = useState(false);
  const [showHistory, setShowHistory] = useState(true);
  const [showFullHistory, setShowFullHistory] = useState(false);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  // The Undo offered after a clear or bulk remove (HIG "Undo and redo"). Lives
  // in the body, not a root portal: the native sheet would cover a portal.
  const [pendingUndo, setPendingUndo] = useState<PendingQueueUndo | null>(null);
  const undoNonceRef = useRef(0);
  // Session, board and account changes retire the offer, including solo mode.
  // Otherwise Undo would write the prior queue into the new climbing context.
  useEffect(() => {
    setPendingUndo((pending) => (pending && pending.scope !== undoScope ? null : pending));
  }, [undoScope]);

  const currentItemUuid = currentClimbQueueItem?.uuid ?? null;

  useImperativeHandle(
    ref,
    () => ({
      reset: () => {
        setIsEditMode(false);
        setSelectedItems(new Set());
        setShowFullHistory(false);
        setPendingUndo(null);
      },
    }),
    [],
  );

  const handleToggleEditMode = useCallback(() => {
    setIsEditMode((prev) => {
      if (prev) {
        setSelectedItems(new Set());
      }
      return !prev;
    });
  }, []);

  const handleToggleHistory = useCallback(() => {
    setShowHistory((prev) => !prev);
  }, []);

  const handleShowFullHistory = useCallback(() => {
    setShowFullHistory(true);
  }, []);

  const handleToggleSelect = useCallback((uuid: string) => {
    setSelectedItems((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) {
        next.delete(uuid);
      } else {
        next.add(uuid);
      }
      return next;
    });
  }, []);

  // Snapshot the LIVE queue (not the sheet's frozen copy) before a removal, so
  // the Undo knows exactly what this climber took out.
  const offerUndo = useCallback(
    (kind: PendingQueueUndo['kind'], before: QueueContentSnapshot, removedUuids: ReadonlySet<string>) => {
      undoNonceRef.current += 1;
      setPendingUndo({
        nonce: undoNonceRef.current,
        kind,
        scope: undoScope,
        credentialGeneration: getCredentialGeneration(),
        before,
        playlistSuggestionSource,
        removedUuids,
      });
    },
    [playlistSuggestionSource, undoScope],
  );

  const handleClearAll = useCallback(() => {
    const before = getQueueSnapshot();
    hapticWarning();
    clearQueue();
    setIsEditMode(false);
    setSelectedItems(new Set());
    if (before.queue.length > 0) {
      offerUndo('cleared', before, new Set(before.queue.map((item) => item.uuid)));
    }
  }, [clearQueue, getQueueSnapshot, offerUndo]);

  const handleBulkRemove = useCallback(() => {
    const before = getQueueSnapshot();
    const removedUuids = new Set(selectedItems);
    removeQueueItems([...removedUuids]);
    setSelectedItems(new Set());
    setIsEditMode(false);
    offerUndo('removed', before, removedUuids);
  }, [selectedItems, removeQueueItems, getQueueSnapshot, offerUndo]);

  // The provider composes the restore when the removal lane finishes. Crew
  // additions, removals and reorders made during that wait stay in the payload.
  const handleUndo = useCallback(() => {
    if (
      !pendingUndo ||
      pendingUndo.scope !== undoScope ||
      pendingUndo.credentialGeneration !== getCredentialGeneration()
    )
      return;
    // Merge at wire-send time, after the removal lane finishes. A peer may
    // change the queue between this tap and then.
    restoreQueueItems(pendingUndo.before, pendingUndo.removedUuids, pendingUndo.scope);
    // A clear also dropped the playlist feed behind the queue; bring it back
    // unless something else has taken its place since.
    if (pendingUndo.kind === 'cleared' && pendingUndo.playlistSuggestionSource && !playlistSuggestionSource) {
      setPlaylistSuggestionSource(pendingUndo.playlistSuggestionSource);
    }
    setPendingUndo(null);
  }, [pendingUndo, undoScope, restoreQueueItems, playlistSuggestionSource, setPlaylistSuggestionSource]);

  const handleUndoDismiss = useCallback(() => setPendingUndo(null), []);

  const handleRemove = useCallback(
    (uuid: string) => {
      const before = getQueueSnapshot();
      if (!before.queue.some((item) => item.uuid === uuid)) return;
      const removedUuids = new Set([uuid]);
      removeQueueItems([uuid]);
      offerUndo('removed', before, removedUuids);
    },
    [getQueueSnapshot, removeQueueItems, offerUndo],
  );

  const viewOnlyMode = queue.length === 0;
  // The header is titled "Up next", so it counts what is still ahead: everything
  // after the current climb, not History or the current climb itself. With
  // nothing current it starts at the line (F3 now-slot mode), or counts the
  // whole queue in legacy mode, where `historyCount` is null.
  const upNextCount = useMemo(
    () => queue.length - upNextStart(queue, currentClimbQueueItem, historyCount),
    [queue, currentClimbQueueItem, historyCount],
  );

  return (
    <>
      <QueueSheetHeader
        isEditMode={isEditMode}
        showHistory={showHistory}
        selectedCount={selectedItems.size}
        queueCount={upNextCount}
        viewOnlyMode={viewOnlyMode}
        onToggleEditMode={handleToggleEditMode}
        onToggleHistory={handleToggleHistory}
        onClose={onClose}
        onClearAll={handleClearAll}
      />

      <QueueList
        queue={queue}
        currentItemUuid={currentItemUuid}
        historyCount={historyCount ?? null}
        board={board}
        isEditMode={isEditMode}
        showHistory={showHistory}
        showFullHistory={showFullHistory}
        selectedItems={selectedItems}
        playlistSuggestionSource={playlistSuggestionSource}
        active={active}
        autoScrollOnMount={active}
        onToggleSelect={handleToggleSelect}
        onClimbPress={onClimbPress}
        onOpenActions={onOpenActions}
        onRemove={handleRemove}
        onShowFullHistory={handleShowFullHistory}
        onTickHistory={onTickHistory}
        onSuggestionPress={onSuggestionPress}
        reorderQueue={reorderQueue}
        onDraggingChange={onDraggingChange}
        presentation={presentation}
      />

      {pendingUndo ? (
        <UndoSnackbar
          visible
          nonce={pendingUndo.nonce}
          message={
            pendingUndo.kind === 'cleared'
              ? t('mobile.queueSheet.cleared')
              : t('mobile.queueSheet.removed', { count: pendingUndo.removedUuids.size })
          }
          undoLabel={t('mobile.queueSheet.undo')}
          undoAccessibilityLabel={t('mobile.queueSheet.undoAria')}
          onUndo={handleUndo}
          onDismiss={handleUndoDismiss}
          duration={QUEUE_UNDO_DURATION}
          bottom={bottomInset + spacing[3]}
        />
      ) : null}

      {isEditMode && selectedItems.size > 0 && (
        <View
          style={[
            styles.bulkBar,
            {
              paddingBottom: bottomInset + spacing[3],
              backgroundColor: systemColors.background,
              borderTopColor: systemColors.separator,
            },
          ]}
        >
          <PressableSurface
            onPress={handleBulkRemove}
            accessibilityRole="button"
            accessibilityLabel={t('queueDrawer.removeItems', { count: selectedItems.size })}
            style={styles.bulkButton}
          >
            <Text variant="headline" color={iosSystemColors.white}>
              {t('queueDrawer.removeItems', { count: selectedItems.size })}
            </Text>
          </PressableSurface>
        </View>
      )}
    </>
  );
});

const styles = StyleSheet.create({
  bulkBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  bulkButton: {
    backgroundColor: brandColors.error,
    borderRadius: 12,
    paddingVertical: spacing[3],
    alignItems: 'center',
    justifyContent: 'center',
  },
});
