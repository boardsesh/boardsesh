import { useCallback, useMemo, useRef, useState, type RefObject } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { useFocusEffect } from 'expo-router';

/** What the hook needs from the sheet's scroll body: an offset restore. */
type ScrollRestoreTarget = { scrollTo: (options: { y: number; animated: boolean }) => void };

type UseSheetSubRouteOptions = {
  /**
   * Whether the sheet that pushed the route still stands for the same search
   * (still mounted, not dismissed, same board) and so may come back. Read when
   * the screen regains focus; a stale presentation stays closed.
   */
  canResume: () => boolean;
};

export type SheetSubRoute<ScrollHandle extends ScrollRestoreTarget> = {
  /** Attach to the sheet's scroll body; the hook restores its offset on return. */
  scrollRef: RefObject<ScrollHandle | null>;
  /** True while a pushed route is on top: pass `open: !suspended` to the sheet coordinator. */
  suspended: boolean;
  /**
   * Key the native sheet host with this. It changes on every return, so each
   * re-present is a first present: on iOS re-presenting an already-mounted
   * SwiftUI host loses the detent height bound and the body stops scrolling (#3330).
   */
  presentEpoch: number;
  /** True from `suspend()` until the sheet re-presents (or `cancelResume()`). */
  isAwaitingReturn: () => boolean;
  /**
   * Call right before pushing the route: snapshots the scroll offset and
   * dismisses the native sheet without unmounting it.
   */
  suspend: () => void;
  /**
   * The pushed route finished the job itself (e.g. "Show N climbs") and the
   * parent is closing the sheet: do not re-present it when focus returns.
   */
  cancelResume: () => void;
  /** Pass to the scroll body's `onScroll`. */
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  /** Pass to the scroll body's `onContentSizeChange`: restores the offset once per return. */
  onContentSizeChange: () => void;
};

/**
 * Lets a native filter sheet push a picker ROUTE (setters, holds, zone) and come
 * back the way it left. Native sheets cannot stack, so the sheet suspends: it
 * dismisses its native host without unmounting while the route is on top, then
 * re-presents under a fresh key when the screen regains focus, with its scroll
 * position restored. See docs/mobile-sheets-vs-routes.md.
 *
 * The sheet keeps its own close and dismiss handling; it should ignore a native
 * close while `isAwaitingReturn()` or `suspended` is true, since that close is
 * the suspend itself.
 */
export function useSheetSubRoute<ScrollHandle extends ScrollRestoreTarget>({
  canResume,
}: UseSheetSubRouteOptions): SheetSubRoute<ScrollHandle> {
  const scrollRef = useRef<ScrollHandle | null>(null);
  const [suspended, setSuspended] = useState(false);
  const [presentEpoch, setPresentEpoch] = useState(0);
  // Distinguishes "returned from a sub-route" from the initial focus-on-mount.
  const awaitingReturnRef = useRef(false);
  // Latest scroll offset, captured on scroll into a ref (no re-render).
  const scrollOffsetRef = useRef(0);
  // Snapshotted at suspend: the remounted scroll body's initial onScroll (y=0)
  // can land before onContentSizeChange, so a live read would restore to 0.
  const pendingRestoreOffsetRef = useRef(0);
  // The epoch whose offset has already been restored — makes the restore
  // one-shot per remount, not re-fire on later content growth.
  const restoredScrollEpochRef = useRef(0);
  const canResumeRef = useRef(canResume);
  canResumeRef.current = canResume;

  const isAwaitingReturn = useCallback(() => awaitingReturnRef.current, []);

  const suspend = useCallback(() => {
    pendingRestoreOffsetRef.current = scrollOffsetRef.current;
    awaitingReturnRef.current = true;
    setSuspended(true);
  }, []);

  const cancelResume = useCallback(() => {
    awaitingReturnRef.current = false;
  }, []);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollOffsetRef.current = event.nativeEvent.contentOffset.y;
  }, []);

  // One-shot per epoch: a repeat restore on later content growth (e.g. a section
  // expanding) would yank the user's scroll position. The first mount (epoch 0)
  // has nothing to restore.
  const onContentSizeChange = useCallback(() => {
    if (restoredScrollEpochRef.current === presentEpoch) return;
    restoredScrollEpochRef.current = presentEpoch;
    scrollRef.current?.scrollTo({ y: pendingRestoreOffsetRef.current, animated: false });
  }, [presentEpoch]);

  // Re-present after the pushed route pops (back chevron OR swipe-back both
  // re-focus this screen). On initial mount the screen is already focused with
  // nothing pending, so this is a no-op until a route has actually been pushed.
  useFocusEffect(
    useCallback(() => {
      if (awaitingReturnRef.current && canResumeRef.current()) {
        awaitingReturnRef.current = false;
        setSuspended(false);
        setPresentEpoch((epoch) => epoch + 1);
      }
    }, []),
  );

  return useMemo(
    () => ({
      scrollRef,
      suspended,
      presentEpoch,
      isAwaitingReturn,
      suspend,
      cancelResume,
      onScroll,
      onContentSizeChange,
    }),
    [suspended, presentEpoch, isAwaitingReturn, suspend, cancelResume, onScroll, onContentSizeChange],
  );
}
