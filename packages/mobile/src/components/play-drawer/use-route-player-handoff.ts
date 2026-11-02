import { useCallback, useEffect, useRef, type RefObject } from 'react';
import {
  PLAYER_SCROLL_HANDOFF_TTL_MS,
  registerRoutePlayer,
  takePlayerScrollHandoff,
  usePendingPlayerScrollHandoff,
  useReportRoutePlayerBusy,
  type RoutePlayerPreview,
} from './route-player-handoff';

type ScrollTarget = { scrollTo: (options: { y: number; animated: boolean }) => void };

/**
 * The player's side of `route-player-handoff`. The route player registers its
 * live state (climb, preview, offset) and publishes whether it is busy; a pane
 * that `acceptsHandoff` takes an armed offset for the climb it shows, asks for
 * the below-fold sections (they mount lazily, and the offset usually points into
 * them) and scrolls there once its content is tall enough.
 *
 * Returns the ScrollView's `onContentSizeChange`. Inert unless a handoff is
 * armed, which only the phone split's route-to-pane swap does.
 */
export function useRoutePlayerHandoff({
  isPane,
  acceptsHandoff,
  busy,
  displayedClimbUuid,
  preview,
  scrollRef,
  readScrollOffset,
  viewportHeight,
  requestBelowFoldContent,
}: {
  isPane: boolean;
  acceptsHandoff: boolean;
  /** A sheet, sub-drawer or tick composer is open on the route. */
  busy: boolean;
  displayedClimbUuid: string | undefined;
  preview: RoutePlayerPreview | null;
  scrollRef: RefObject<ScrollTarget | null>;
  readScrollOffset: () => number;
  viewportHeight: number;
  requestBelowFoldContent: () => void;
}): (contentWidth: number, contentHeight: number) => void {
  const displayedClimbUuidRef = useRef(displayedClimbUuid);
  displayedClimbUuidRef.current = displayedClimbUuid;
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const readScrollOffsetRef = useRef(readScrollOffset);
  readScrollOffsetRef.current = readScrollOffset;
  const viewportHeightRef = useRef(viewportHeight);
  viewportHeightRef.current = viewportHeight;

  useEffect(() => {
    if (isPane) return undefined;
    return registerRoutePlayer(() => ({
      climbUuid: displayedClimbUuidRef.current ?? null,
      offsetY: readScrollOffsetRef.current(),
      preview: previewRef.current,
    }));
  }, [isPane]);
  useReportRoutePlayerBusy('player', busy, !isPane);

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
