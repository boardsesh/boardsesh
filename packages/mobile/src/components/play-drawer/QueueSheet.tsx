import { MEDIUM_LARGE_SNAP_POINTS } from '../sheet-snap-points';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModal } from '@expo/ui/community/bottom-sheet';
import { useManagedSheet, type DismissAndWaitResult } from '../../providers/sheet-presentation-provider';
import type { Climb, ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import { QueueListBody, type QueueListBodyHandle } from './QueueListBody';
import type { QueueItemRowBoard } from '../QueueItemRow';
import { useQueueData } from '../../providers/queue-provider';
import { useTheme } from '../../providers/theme-provider';
import { usePrivacyScopedState } from '../../hooks/use-privacy-scoped-state';
import { sanitizeQueueSnapshot } from '../../lib/queue-privacy';
import { useSheetBackgroundStyle } from '../use-sheet-background-style';
import { useLogAscentSheetHost } from '../tick/use-log-ascent-sheet-host';
import type { QueueHistoryTickHandler } from './use-queue-sheet-handlers';
import { getCredentialGeneration } from '../../lib/privacy/privacy-cache';
import type { ClimbActionsTarget } from '../../providers/drawer-host-provider';

type QueueSheetProps = {
  board: QueueItemRowBoard;
  /** Request an animated close (header button) — calls the imperative handle's
   *  `dismiss()` on the host side. */
  onClose: () => void;
  /** Optional: fired AFTER the dismiss animation finishes. The imperative model
   *  no longer needs this to unmount, so callers may omit it. */
  onDismissed?: () => void;
  onClimbPress: (item: ClimbQueueItem) => void;
  /** Resolve the row's native menu target. */
  onOpenActions?: (item: ClimbQueueItem) => ClimbActionsTarget | null | undefined;
  onSuggestionPress: (climb: Climb, source: PlaylistSuggestionSource) => void;
  onTickHistory: QueueHistoryTickHandler;
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
  /** Layout-only close: keep an open Tick intact, then fold once it finishes.
   * Passing false withdraws the request when the layout changes back. */
  dismissWhenUncovered: (requested: boolean) => void;
};

export const QueueSheet = forwardRef<QueueSheetHandle, QueueSheetProps>(function QueueSheet(
  { board, onClose, onDismissed, onClimbPress, onOpenActions, onSuggestionPress, onTickHistory },
  ref,
) {
  const { sheet } = useTheme();
  const sheetBackgroundStyle = useSheetBackgroundStyle();
  const sheetRef = useRef<BottomSheetModal>(null);
  const bodyRef = useRef<QueueListBodyHandle>(null);
  const resetTickRef = useRef<() => void>(() => {});
  const tickOpenRequest = useRef(0);
  useEffect(
    () => () => {
      tickOpenRequest.current += 1;
    },
    [],
  );
  const liveQueueData = useQueueData();

  const [isDragging, setIsDragging] = useState(false);
  const [dismissWhenUncovered, setDismissWhenUncovered] = useState(false);
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

  const snapPoints = MEDIUM_LARGE_SNAP_POINTS;

  // Both QueueSheet instances (root + /play copy, PR #3337) stay mounted the whole
  // session. Freeze the hidden one's queue data to a referentially stable snapshot
  // so it bails out of the memoized QueueList instead of rebuilding
  // buildQueueListModel on every queue nav elsewhere; the visible sheet tracks live.
  // Derive-during-render (compiler-safe) — no ref writes, no effect lag.
  const activeOrPresented = isActive || isPresented;
  const [snapshot, setSnapshot] = usePrivacyScopedState(liveQueueData);
  if (activeOrPresented && snapshot !== liveQueueData) setSnapshot(liveQueueData);
  const { queue, currentClimbQueueItem, historyCount } = snapshot ?? sanitizeQueueSnapshot(liveQueueData);

  // The modal's dismiss animation has actually SETTLED (coordinator: header
  // request, backdrop, or pan-down). Reset local UI state; the sheet stays
  // mounted (imperative model) and is re-presented on the next open.
  const handleFullyDismissed = useCallback(() => {
    tickOpenRequest.current += 1;
    resetTickRef.current();
    setIsActive(false);
    bodyRef.current?.reset();
    onDismissed?.();
  }, [onDismissed]);

  // Present/dismiss route through the coordinator so they never overlap another
  // sheet's transition (the iOS UIKit deadlock).
  const invalidateTickRequest = useCallback(() => {
    tickOpenRequest.current += 1;
  }, []);
  const managed = useManagedSheet({
    sheetRef,
    onFullyDismissed: handleFullyDismissed,
    onDisplaced: invalidateTickRequest,
  });
  const {
    openLogAscent,
    reset: resetTick,
    sheet: tickSheet,
    hasRequest: hasTickRequest,
  } = useLogAscentSheetHost(`queue-tick:${managed.sheetId}`, managed.sheetId);
  resetTickRef.current = resetTick;
  useEffect(() => {
    if (!dismissWhenUncovered || hasTickRequest) return;
    invalidateTickRequest();
    managed.handle.dismiss();
  }, [dismissWhenUncovered, hasTickRequest, invalidateTickRequest, managed.handle]);
  const handleTickHistory = useCallback(
    async (item: ClimbQueueItem) => {
      const request = ++tickOpenRequest.current;
      const credentialGeneration = getCredentialGeneration();
      const outcome = await managed.waitForPresentation();
      if (
        outcome.status !== 'presented' ||
        request !== tickOpenRequest.current ||
        credentialGeneration !== getCredentialGeneration()
      )
        return;
      onTickHistory(item, openLogAscent);
    },
    [managed.waitForPresentation, onTickHistory, openLogAscent],
  );

  // Track presented state off the native onChange (index >= 0 = a real snap) so
  // it stays correct even when the COORDINATOR re-presents this sheet after a
  // handoff — that path drives the native ref directly, not the imperative
  // present() below, so deriving isPresented from present() alone would desync
  // (no auto-scroll to the current climb on a re-present).
  const handleSheetChange = useCallback(
    (index: number) => {
      if (index < 0) invalidateTickRequest();
      managed.onChange(index);
      setIsPresented(index >= 0);
    },
    [managed, invalidateTickRequest],
  );

  useImperativeHandle(
    ref,
    () => ({
      present: () => {
        setDismissWhenUncovered(false);
        setIsActive(true);
        managed.handle.present();
      },
      dismiss: () => {
        invalidateTickRequest();
        managed.handle.dismiss();
      },
      dismissAndWait: () => {
        invalidateTickRequest();
        return managed.handle.dismissAndWait();
      },
      dismissWhenUncovered: setDismissWhenUncovered,
    }),
    [managed.handle, invalidateTickRequest],
  );

  const sheetContent = (
    <View style={styles.content}>
      <QueueListBody
        ref={bodyRef}
        board={board}
        queue={queue}
        currentClimbQueueItem={currentClimbQueueItem}
        historyCount={historyCount}
        active={isPresented}
        presentation="sheet"
        onClose={onClose}
        onClimbPress={onClimbPress}
        onOpenActions={onOpenActions}
        onSuggestionPress={onSuggestionPress}
        onTickHistory={handleTickHistory}
        onDraggingChange={setIsDragging}
      />
      {/* This Host belongs to the queue's presented view controller. A sibling
        beside QueueSheet would still present from under the player. */}
      {tickSheet}
    </View>
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
      backgroundStyle={sheetBackgroundStyle}
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
  content: { flex: 1 },
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
});
