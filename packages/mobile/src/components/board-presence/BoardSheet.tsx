// Board sheet — "now on the wall" (the board-presence primary surface).
//
// A gorhom BottomSheetModal sibling of QueueSheet: same visible→present/dismiss
// split, GlassSheetBackground, stackBehavior="push". (No FullWindowOverlay — it
// prevented the sheet from presenting in this app; QueueSheet/PlayDrawer omit it.)
// The wall's now-on-the-wall hero, VIRTUALIZED history list, stat tiles and the
// "Switch board" footer all live in `NowOnTheWallPanel` (variant="sheet"), which
// this sheet renders as its body. Keeping the body in a shared panel lets the
// iPad shell render the same content as a standalone column (variant="column").
//
// State comes from `@boardsesh/board-presence-react`'s split current/feed
// contexts, which are inert when the `board-presence` flag is off — so this
// sheet is only ever opened from the board glyph when the flag is on. This
// wrapper keeps its own cheap current/feed reads ONLY for the history-count and
// now-playing analytics; the panel owns the volatile action state so the
// wrapper doesn't re-render in ways that interfered with gorhom's `present()`.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { Platform, StyleSheet } from 'react-native';
import { BottomSheetModal, BottomSheetBackdrop, type BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { useBoardPresenceCurrent, useBoardPresenceFeed } from '@boardsesh/board-presence-react';
import { GlassSheetBackground } from '../GlassSheetBackground';
import { useTheme } from '../../providers/theme-provider';
import type { BoardConfig } from '../../providers/drawer-host-provider';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';
import { track } from '../../lib/analytics';
import { NowOnTheWallPanel } from './NowOnTheWallPanel';

export type { BoardSheetClimbAction } from './NowOnTheWallPanel';
import type { BoardSheetClimbAction } from './NowOnTheWallPanel';

/**
 * Imperative handle — the host presents/dismisses the sheet by calling these
 * directly from the tap handler (PlayDrawer's proven pattern). Driving gorhom's
 * `present()` from a `visible`-prop effect was a silent no-op in this build.
 */
export type BoardSheetHandle = {
  present: () => void;
  dismiss: () => void;
};

type BoardSheetProps = {
  /** The active board label, shown as the sheet title. */
  boardLabel: string | null;
  /**
   * Active board config for the climb thumbnails. Passed by the host (NOT read
   * via `useDrawerHost`) so BoardSheet stays out of the drawer-host require cycle
   * and doesn't subscribe to that volatile context — re-renders from it were
   * interfering with gorhom's `present()`, so the sheet never appeared.
   */
  boardConfig: BoardConfig | null;
  /** Request an animated close (header chevron) — the host calls `dismiss()`. */
  onClose: () => void;
  /** Optional: fired AFTER the dismiss animation finishes (gorhom `onDismiss`). */
  onDismissed?: () => void;
  /** Open the existing board switcher from the footer control. */
  onSwitchBoard: () => void;
  /** Activate/open a climb from the wall feed. BoardSheet closes itself after this. */
  onClimbPress?: (action: BoardSheetClimbAction) => void;
  /** Swipe action: append this wall-feed climb to the queue. */
  onAddToQueue?: (action: BoardSheetClimbAction) => void;
  /** Swipe action: open the add-to-playlist sheet for this climb. */
  onOpenPlaylist?: (action: BoardSheetClimbAction) => void;
  /** Long press action: open the existing climb actions sheet. */
  onOpenActions?: (action: BoardSheetClimbAction) => void;
};

export const BoardSheet = forwardRef<BoardSheetHandle, BoardSheetProps>(function BoardSheet(
  {
    boardLabel,
    boardConfig,
    onClose,
    onDismissed,
    onSwitchBoard,
    onClimbPress,
    onAddToQueue,
    onOpenPlaylist,
    onOpenActions,
  },
  ref,
) {
  const { sheet } = useTheme();
  const sheetRef = useRef<BottomSheetModal>(null);

  // Cheap current/feed reads kept here ONLY for the now-playing + history-view
  // analytics. The action/loading state that re-renders on every interaction
  // lives in NowOnTheWallPanel, out of this gorhom-`present()`-sensitive wrapper.
  const { currentClimb } = useBoardPresenceCurrent();
  const { history } = useBoardPresenceFeed();
  const { boardId: boardPresenceBoardId } = useBoardPresenceControls();
  const boardPresenceBoardIdRef = useRef(boardPresenceBoardId);
  boardPresenceBoardIdRef.current = boardPresenceBoardId;
  const visibleHistoryCount = useMemo(
    () =>
      currentClimb
        ? history.filter((historyClimb) => {
            return historyClimb.climbUuid !== currentClimb.climbUuid || historyClimb.seq !== currentClimb.seq;
          }).length
        : history.length,
    [currentClimb, history],
  );
  const historyCountRef = useRef(visibleHistoryCount);
  historyCountRef.current = visibleHistoryCount;

  const lastReceivedWallClimbRef = useRef<string | null>(null);
  useEffect(() => {
    const currentClimbUuid = currentClimb?.climbUuid;
    if (!currentClimbUuid) return;
    if (lastReceivedWallClimbRef.current === currentClimbUuid) return;
    lastReceivedWallClimbRef.current = currentClimbUuid;
    track(SHARED_EVENTS.BoardNowPlayingReceived, {
      boardId: boardPresenceBoardIdRef.current ?? undefined,
      climbUuid: currentClimbUuid,
    });
  }, [currentClimb?.climbUuid]);

  const snapPoints = useMemo(() => ['55%', '92%'], []);

  useImperativeHandle(ref, () => ({
    present: () => {
      if (historyCountRef.current > 0) {
        track(SHARED_EVENTS.BoardHistoryViewed, {
          boardId: boardPresenceBoardIdRef.current ?? undefined,
          itemCount: historyCountRef.current,
        });
      }
      sheetRef.current?.present();
    },
    dismiss: () => {
      // The panel owns its in-flight action state now, so it (not this handle)
      // invalidates pending GET_CLIMB resolves. Every user dismiss path routes
      // through a panel control that invalidates first (header chevron →
      // handleClose, footer → handleSwitchBoard, row tap → close-on-success), and
      // runInteractiveAction's generation/board-signature guards drop any late
      // resolve regardless — so a bare programmatic dismiss here is safe. A future
      // programmatic dismiss that bypasses those controls should invalidate too.
      sheetRef.current?.dismiss();
    },
  }));

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={sheet.scrimOpacity}
        pressBehavior="close"
      />
    ),
    [sheet.scrimOpacity],
  );

  return (
    <BottomSheetModal
      ref={sheetRef}
      index={0}
      snapPoints={snapPoints}
      // Height is driven by explicit snapPoints, so disable gorhom's dynamic
      // content sizing — it doesn't play well with a BottomSheetFlatList (no
      // bounded content height to measure).
      enableDynamicSizing={false}
      stackBehavior="push"
      enablePanDownToClose
      backdropComponent={renderBackdrop}
      onDismiss={onDismissed}
      handleIndicatorStyle={sheet.handleStyle}
      backgroundComponent={GlassSheetBackground}
      style={styles.sheet}
    >
      <NowOnTheWallPanel
        variant="sheet"
        boardLabel={boardLabel}
        boardConfig={boardConfig}
        onClose={onClose}
        onSwitchBoard={onSwitchBoard}
        onClimbPress={onClimbPress}
        onAddToQueue={onAddToQueue}
        onOpenPlaylist={onOpenPlaylist}
        onOpenActions={onOpenActions}
      />
    </BottomSheetModal>
  );
});

const styles = StyleSheet.create({
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
