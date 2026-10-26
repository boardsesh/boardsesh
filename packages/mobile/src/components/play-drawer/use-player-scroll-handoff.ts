import { useCallback, useEffect, useRef, type RefObject } from 'react';
import {
  PLAYER_SCROLL_HANDOFF_TTL_MS,
  registerRoutePlayerScroll,
  takePlayerScrollHandoff,
  usePendingPlayerScrollHandoff,
} from './player-scroll-handoff';

type ScrollTarget = { scrollTo: (options: { y: number; animated: boolean }) => void };

/**
 * The player's side of `player-scroll-handoff`. The route player registers its
 * live offset; a pane that `acceptsHandoff` takes an armed offset for the climb
 * it shows, asks for the below-fold sections (they mount lazily, and the offset
 * usually points into them) and scrolls there once its content is tall enough.
 *
 * Returns the ScrollView's `onContentSizeChange`. Inert unless a handoff is
 * armed, which only the phone split's route-to-pane swap does.
 */
export function usePlayerScrollHandoff({
  isPane,
  acceptsHandoff,
  displayedClimbUuid,
  scrollRef,
  readScrollOffset,
  viewportHeight,
  requestBelowFoldContent,
}: {
  isPane: boolean;
  acceptsHandoff: boolean;
  displayedClimbUuid: string | undefined;
  scrollRef: RefObject<ScrollTarget | null>;
  readScrollOffset: () => number;
  viewportHeight: number;
  requestBelowFoldContent: () => void;
}): (contentWidth: number, contentHeight: number) => void {
  const displayedClimbUuidRef = useRef(displayedClimbUuid);
  displayedClimbUuidRef.current = displayedClimbUuid;
  const readScrollOffsetRef = useRef(readScrollOffset);
  readScrollOffsetRef.current = readScrollOffset;
  const viewportHeightRef = useRef(viewportHeight);
  viewportHeightRef.current = viewportHeight;

  useEffect(() => {
    if (isPane) return undefined;
    return registerRoutePlayerScroll(() => {
      const climbUuid = displayedClimbUuidRef.current;
      return climbUuid ? { climbUuid, offsetY: readScrollOffsetRef.current() } : null;
    });
  }, [isPane]);

  const pendingHandoff = usePendingPlayerScrollHandoff();
  const restoreRef = useRef<{ offsetY: number; takenAt: number } | null>(null);
  useEffect(() => {
    if (!isPane || !acceptsHandoff || !pendingHandoff || !displayedClimbUuid) return;
    const offsetY = takePlayerScrollHandoff(displayedClimbUuid);
    if (offsetY === null) return;
    restoreRef.current = { offsetY, takenAt: Date.now() };
    requestBelowFoldContent();
  }, [isPane, acceptsHandoff, pendingHandoff, displayedClimbUuid, requestBelowFoldContent]);

  return useCallback(
    (_contentWidth: number, contentHeight: number) => {
      const restore = restoreRef.current;
      if (!restore) return;
      if (Date.now() - restore.takenAt > PLAYER_SCROLL_HANDOFF_TTL_MS) {
        restoreRef.current = null;
        return;
      }
      const maxOffset = contentHeight - viewportHeightRef.current;
      if (maxOffset <= 0) return;
      scrollRef.current?.scrollTo({ y: Math.min(restore.offsetY, maxOffset), animated: false });
      // The sections arrive in steps; keep following them until the saved offset fits.
      if (maxOffset >= restore.offsetY) restoreRef.current = null;
    },
    [scrollRef],
  );
}
