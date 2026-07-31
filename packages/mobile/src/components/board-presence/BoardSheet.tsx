// Board sheet — "now on the wall" (the board-presence primary surface).
//
// A native BottomSheetModal (`@expo/ui/community/bottom-sheet`) sibling of
// QueueSheet, presented/dismissed through the shared sheet coordinator
// (`useManagedSheet`) so it never overlaps another sheet's transition. The wall's
// now-on-the-wall hero, VIRTUALIZED history list, stat tiles, pull-to-refresh and
// the "Switch board" footer all live in `NowOnTheWallPanel` (variant="sheet"),
// which this sheet renders as its body. Keeping the body in a shared panel lets
// the iPad shell render the same content inline as a standalone column
// (variant="column").
//
// State comes from `@boardsesh/board-presence-react`'s split current/feed
// contexts, which are inert when the `board-presence` flag is off — so this sheet
// is only ever opened from the board glyph when the flag is on. This wrapper keeps
// current/feed reads only for visible-history filtering and history-view
// analytics; the panel owns the volatile action state so the always-mounted
// wrapper doesn't re-render in ways that interfere with the native
// present()/dismiss() coordination.
//
// `NowOnTheWallPanel` (the presence-consuming hero/stats/history list) is gated on
// `isPresented` so a dismissed sheet mounts none of it and does zero list/hero
// work. `isPresented` flips true SYNCHRONOUSLY in `present()` (before the sheet's
// own animation starts) and false once the dismiss has fully SETTLED (see
// `handleFullyDismissed`); `handleSheetChange` re-arms it as a backstop for a
// re-present queued inside the dismiss settle window. `BoardHistoryViewed` fires
// once per presentation, keyed on `isPresented` — kept in this sheet-only wrapper
// so the inline iPad column never double-fires it.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet } from 'react-native';
import { BottomSheetModal } from '@expo/ui/community/bottom-sheet';
import { useManagedSheet, type DismissAndWaitResult } from '../../providers/sheet-presentation-provider';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { useBoardPresenceCurrent, useBoardPresenceFeed } from '@boardsesh/board-presence-react';
import { useTheme } from '../../providers/theme-provider';
import type { BoardConfig } from '../../providers/drawer-host-provider';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';
import { track } from '../../lib/analytics';
import { NowOnTheWallPanel } from './NowOnTheWallPanel';
import type { BoardSheetClimbAction, NowOnTheWallPanelHandle } from './NowOnTheWallPanel';

export type { BoardSheetClimbAction } from './NowOnTheWallPanel';

/**
 * Imperative handle — the host presents/dismisses the sheet by calling these
 * directly from the tap handler (PlayDrawer's proven pattern). Driving the sheet
 * from a `visible`-prop effect was a silent no-op in this build.
 */
export type BoardSheetHandle = {
  present: () => void;
  dismiss: () => void;
  /** Dismiss and resolve only after the native animation settles. */
  dismissAndWait: () => Promise<DismissAndWaitResult>;
};

type BoardSheetProps = {
  /** The active board label, shown as the sheet title. */
  boardLabel: string | null;
  /**
   * Active board config for the climb thumbnails. Passed by the host (NOT read
   * via `useDrawerHost`) so BoardSheet stays out of the drawer-host require cycle
   * and doesn't subscribe to that volatile context — re-renders from it were
   * interfering with `present()`, so the sheet never appeared.
   */
  boardConfig: BoardConfig | null;
  /** Request an animated close (header chevron) — the host calls `dismiss()`. */
  onClose: () => void;
  /** Optional: fired AFTER the dismiss animation has actually settled. */
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
  const panelRef = useRef<NowOnTheWallPanelHandle>(null);

  // Gates `NowOnTheWallPanel` (the presence-consuming hero/stats/history list) so
  // it does zero work while dismissed. Set true synchronously in `present()`
  // (before the sheet's own present animation) and false once the dismiss
  // animation has fully settled — see `handleFullyDismissed`.
  const [isPresented, setIsPresented] = useState(false);

  // Current/feed reads kept here only for visible-history filtering and
  // history-view analytics; the panel owns the wall-feed content and the
  // volatile action state, so those re-renders don't reach this always-mounted
  // wrapper.
  const { currentClimb } = useBoardPresenceCurrent();
  const { history } = useBoardPresenceFeed();
  const { boardId: boardPresenceBoardId } = useBoardPresenceControls();
  const boardPresenceBoardIdRef = useRef(boardPresenceBoardId);
  boardPresenceBoardIdRef.current = boardPresenceBoardId;

  const visibleHistory = useMemo(
    () =>
      currentClimb
        ? history.filter((historyClimb) => {
            return historyClimb.climbUuid !== currentClimb.climbUuid || historyClimb.seq !== currentClimb.seq;
          })
        : history,
    [currentClimb, history],
  );

  // Fires once per presentation, when history is FIRST non-empty while presented
  // — not only on present(), because presenting before the initial backfill
  // resolves would find an empty list and never fire for that presentation. The
  // ref resets on full dismiss so it re-arms per presentation. Mirrors web's
  // `BoardSheetBody`. Lives here (sheet-only) so the inline column never fires it.
  const historyViewedForPresentationRef = useRef(false);
  useEffect(() => {
    if (!isPresented || historyViewedForPresentationRef.current || visibleHistory.length === 0) return;
    historyViewedForPresentationRef.current = true;
    track(SHARED_EVENTS.BoardHistoryViewed, {
      boardId: boardPresenceBoardIdRef.current ?? undefined,
      itemCount: visibleHistory.length,
    });
  }, [isPresented, visibleHistory.length]);

  const snapPoints = useMemo(() => ['55%', '92%'], []);

  const invalidatePanelActions = useCallback(() => {
    panelRef.current?.invalidatePendingActions();
  }, []);

  // Fired once the dismiss animation has actually SETTLED (coordinator), not on
  // the synchronous early callback — so we never tear anything down mid-animation.
  // This is also where the panel unmounts (zero work while dismissed) and the
  // history-viewed guard re-arms for the next presentation.
  const handleFullyDismissed = useCallback(() => {
    invalidatePanelActions();
    historyViewedForPresentationRef.current = false;
    setIsPresented(false);
    onDismissed?.();
  }, [invalidatePanelActions, onDismissed]);

  // Present/dismiss route through the coordinator so the board sheet never
  // overlaps another sheet's transition (the iOS UIKit deadlock). The sheet stays
  // mounted (like QueueSheet) and is re-presented on the next open.
  const managed = useManagedSheet({ sheetRef, onFullyDismissed: handleFullyDismissed });

  useImperativeHandle(
    ref,
    () => ({
      present: () => {
        // Synchronous, before the sheet's own present animation starts, so the
        // panel mounts right away — no reliance on the sheet library's own
        // child-mounting timing.
        setIsPresented(true);
        managed.handle.present();
      },
      dismiss: () => {
        invalidatePanelActions();
        managed.handle.dismiss();
      },
      dismissAndWait: () => {
        invalidatePanelActions();
        return managed.handle.dismissAndWait();
      },
    }),
    [managed.handle, invalidatePanelActions],
  );

  // Re-mount backstop: a re-present queued inside a dismiss settle window gets its
  // isPresented(true) clobbered by the late-settling `handleFullyDismissed` BEFORE
  // the coordinator presents the native sheet — which would leave the sheet up
  // with the panel unmounted. index >= 0 means the sheet is really up, so re-mount
  // here; the synchronous set in `present()` is the fast path.
  const managedOnChange = managed.onChange;
  const handleSheetChange = useCallback(
    (index: number) => {
      if (index >= 0) {
        setIsPresented(true);
      }
      managedOnChange(index);
    },
    [managedOnChange],
  );
  const sheetDismissProps = useMemo(() => ({ onFullyDismissed: managed.onFullyDismissed }), [managed.onFullyDismissed]);

  return (
    <BottomSheetModal
      ref={sheetRef}
      index={0}
      snapPoints={snapPoints}
      // Height is driven by explicit snapPoints, so disable dynamic content
      // sizing — it doesn't play well with a BottomSheetFlatList (no bounded
      // content height to measure).
      enableDynamicSizing={false}
      enablePanDownToClose
      onChange={handleSheetChange}
      {...sheetDismissProps}
      handleIndicatorStyle={sheet.handleStyle}
      style={styles.sheet}
    >
      {isPresented ? (
        <NowOnTheWallPanel
          ref={panelRef}
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
      ) : null}
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
