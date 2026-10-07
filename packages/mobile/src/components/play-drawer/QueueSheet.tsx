import { PressableSurface } from '../PressableSurface';
import { MEDIUM_LARGE_SNAP_POINTS } from '../sheet-snap-points';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { View, Platform, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModal } from '@expo/ui/community/bottom-sheet';
import { useManagedSheet, type DismissAndWaitResult } from '../../providers/sheet-presentation-provider';
import { useTranslation } from 'react-i18next';
import type { Climb, ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import { QueueSheetHeader } from './QueueSheetHeader';
import { QueueList } from './QueueList';
import { Text } from '../Text';
import type { QueueItemRowBoard } from '../QueueItemRow';
import {
  usePlaylistSuggestionSource,
  useQueueData,
  useQueueActions,
  useQueueSessionId,
} from '../../providers/queue-provider';
import { useTheme } from '../../providers/theme-provider';
import { hapticWarning } from '../../lib/haptics';
import type { QueueContentSnapshot } from '../../lib/queue-undo';
import { getPrivacyRevocationGeneration } from '../../lib/privacy/privacy-cache';
import { usePrivacyScopedState } from '../../hooks/use-privacy-scoped-state';
import { sanitizeQueueSnapshot } from '../../lib/queue-privacy';
import { UndoSnackbar } from '../UndoSnackbar';
import { brandColors } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';
import { useIosSheetBackgroundStyle } from '../use-ios-sheet-background-style';
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
  privacyGeneration: number;
  before: QueueContentSnapshot;
  playlistSuggestionSource: PlaylistSuggestionSource | null;
  removedUuids: ReadonlySet<string>;
};

type QueueSheetProps = {
  board: QueueItemRowBoard;
  /** Request an animated close (header button) — calls the imperative handle's
   *  `dismiss()` on the host side. */
  onClose: () => void;
  /** Optional: fired AFTER the dismiss animation finishes. The imperative model
   *  no longer needs this to unmount, so callers may omit it. */
  onDismissed?: () => void;
  onClimbPress: (item: ClimbQueueItem) => void;
  /** Long press a queue row → open the climb reaction menu. */
  onOpenActions?: (item: ClimbQueueItem) => void;
  onSuggestionPress: (climb: Climb, source: PlaylistSuggestionSource) => void;
  onTickHistory: (item: ClimbQueueItem) => void;
};

/**
 * Imperative handle exposed to DrawerHostProvider. The sheet is opened by calling
 * `present()` synchronously from the tap handler (the same pattern PlayDrawer
 * uses) rather than driving it from a `visible`-prop effect.
 */
export type QueueSheetHandle = {
  present: () => void;
  dismiss: () => void;
  /** Dismiss and resolve only after the native animation settles. */
  dismissAndWait: () => Promise<DismissAndWaitResult>;
};

export const QueueSheet = forwardRef<QueueSheetHandle, QueueSheetProps>(function QueueSheet(
  { board, onClose, onDismissed, onClimbPress, onOpenActions, onSuggestionPress, onTickHistory },
  ref,
) {
  const { t } = useTranslation('session');
  // Native sheet: clear the WINDOW's bottom inset, never the mount point's
  // (#3776; docs/mobile-sheets-vs-routes.md).
  const windowBottomInset = useWindowBottomInset();
  const { systemColors, sheet } = useTheme();
  const iosBackgroundStyle = useIosSheetBackgroundStyle();
  const sheetRef = useRef<BottomSheetModal>(null);

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
  const liveQueueData = useQueueData();

  const [isEditMode, setIsEditMode] = useState(false);
  const [showHistory, setShowHistory] = useState(true);
  const [showFullHistory, setShowFullHistory] = useState(false);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [isDragging, setIsDragging] = useState(false);
  // Tracks whether the sheet is currently presented so the list only
  // auto-scrolls to the current item on a real open (not on background mounts).
  const [isPresented, setIsPresented] = useState(false);
  // Flipped true in present() and cleared once the dismiss settles. present()
  // calls managed.handle.present() first, so the native sheet begins animating
  // one render before this setState commits — but that same re-render refreshes
  // the frozen snapshot below (activeOrPresented turns true), so the live queue
  // lands before any stale frame is user-visible. OR'd with the native
  // isPresented so the imperative-open path and the coordinator's re-present
  // path both read active.
  const [isActive, setIsActive] = useState(false);
  // The Undo offered after a clear or bulk remove (HIG "Undo and redo"). Lives
  // in the sheet, not a root portal: the native sheet would cover a portal.
  const [pendingUndo, setPendingUndo] = useState<PendingQueueUndo | null>(null);
  const undoNonceRef = useRef(0);
  // Session, board, account and privacy changes retire the offer, including solo mode.
  // Otherwise Undo would write the prior queue into the new climbing context.
  useEffect(() => {
    setPendingUndo((pending) => (pending && pending.scope !== undoScope ? null : pending));
  }, [undoScope]);

  const snapPoints = MEDIUM_LARGE_SNAP_POINTS;

  // Both QueueSheet instances (root + /play copy, PR #3337) stay mounted the whole
  // session. Freeze the hidden one's queue data to a referentially stable snapshot
  // so it bails out of the memoized QueueList instead of rebuilding
  // buildQueueListModel on every queue nav elsewhere; the visible sheet tracks live.
  // Derive-during-render (compiler-safe) — no ref writes, no effect lag.
  const activeOrPresented = isActive || isPresented;
  const [snapshot, setSnapshot] = usePrivacyScopedState(liveQueueData, sanitizeQueueSnapshot);
  if (activeOrPresented && snapshot !== liveQueueData) setSnapshot(liveQueueData);
  const { queue, currentClimbQueueItem } = snapshot ?? sanitizeQueueSnapshot(liveQueueData);

  const currentItemUuid = currentClimbQueueItem?.uuid ?? null;

  const resetState = useCallback(() => {
    setIsEditMode(false);
    setSelectedItems(new Set());
    setShowFullHistory(false);
    setPendingUndo(null);
  }, []);

  // The modal's dismiss animation has actually SETTLED (coordinator: header
  // request, backdrop, or pan-down). Reset local UI state; the sheet stays
  // mounted (imperative model) and is re-presented on the next open.
  const handleFullyDismissed = useCallback(() => {
    setIsActive(false);
    resetState();
    onDismissed?.();
  }, [resetState, onDismissed]);

  // Present/dismiss route through the coordinator so they never overlap another
  // sheet's transition (the iOS UIKit deadlock).
  const managed = useManagedSheet({ sheetRef, onFullyDismissed: handleFullyDismissed });

  // Track presented state off the native onChange (index >= 0 = a real snap) so
  // it stays correct even when the COORDINATOR re-presents this sheet after a
  // handoff — that path drives the native ref directly, not the imperative
  // present() below, so deriving isPresented from present() alone would desync
  // (no auto-scroll to the current climb on a re-present).
  const handleSheetChange = useCallback(
    (index: number) => {
      managed.onChange(index);
      setIsPresented(index >= 0);
    },
    [managed],
  );

  useImperativeHandle(
    ref,
    () => ({
      present: () => {
        setIsActive(true);
        managed.handle.present();
      },
      dismiss: () => {
        managed.handle.dismiss();
      },
      dismissAndWait: () => managed.handle.dismissAndWait(),
    }),
    [managed.handle],
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
        privacyGeneration: getPrivacyRevocationGeneration(),
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
      pendingUndo.privacyGeneration !== getPrivacyRevocationGeneration()
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

  const sheetContent = (
    <>
      <QueueSheetHeader
        isEditMode={isEditMode}
        showHistory={showHistory}
        selectedCount={selectedItems.size}
        queueCount={queue.length}
        viewOnlyMode={viewOnlyMode}
        onToggleEditMode={handleToggleEditMode}
        onToggleHistory={handleToggleHistory}
        onClose={onClose}
        onClearAll={handleClearAll}
      />

      <QueueList
        queue={queue}
        currentItemUuid={currentItemUuid}
        board={board}
        isEditMode={isEditMode}
        showHistory={showHistory}
        showFullHistory={showFullHistory}
        selectedItems={selectedItems}
        playlistSuggestionSource={playlistSuggestionSource}
        active={isPresented}
        autoScrollOnMount={isPresented}
        onToggleSelect={handleToggleSelect}
        onClimbPress={onClimbPress}
        onOpenActions={onOpenActions}
        onRemove={handleRemove}
        onShowFullHistory={handleShowFullHistory}
        onTickHistory={onTickHistory}
        onSuggestionPress={onSuggestionPress}
        reorderQueue={reorderQueue}
        onDraggingChange={setIsDragging}
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
          bottom={insets.bottom + spacing[3]}
        />
      ) : null}

      {isEditMode && selectedItems.size > 0 && (
        <View
          style={[
            styles.bulkBar,
            {
              paddingBottom: windowBottomInset + spacing[3],
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

  return (
    <BottomSheetModal
      ref={sheetRef}
      index={0}
      snapPoints={snapPoints}
      enablePanDownToClose
      // Freeze the sheet pan while a row is being dragged so scroll-to-expand
      // never fights the reorder gesture.
      enableContentPanningGesture={!isDragging}
      enableHandlePanningGesture={!isDragging}
      onChange={handleSheetChange}
      onFullyDismissed={managed.onFullyDismissed}
      handleIndicatorStyle={sheet.handleStyle}
      backgroundStyle={iosBackgroundStyle}
      style={styles.sheet}
    >
      {Platform.OS === 'android' ? (
        // Expo's Android sheet uses a separate dialog window. Its RN content
        // needs its own gesture root so row recognizers receive
        // the native pointer stream (#5923).
        <GestureHandlerRootView style={styles.gestureRoot}>{sheetContent}</GestureHandlerRootView>
      ) : (
        sheetContent
      )}
    </BottomSheetModal>
  );
});

const styles = StyleSheet.create({
  gestureRoot: { flex: 1 },
  sheet: {
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -4 },
        shadowOpacity: 0.1,
        shadowRadius: 12,
      },
      android: {
        elevation: 16,
      },
    }),
  },
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
