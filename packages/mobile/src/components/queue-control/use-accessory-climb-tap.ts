import { useCallback, useMemo } from 'react';
import { Gesture, type GestureType } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { useQueue } from '../../providers/queue-provider';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { hapticLight } from '../../lib/haptics';

/**
 * Tap-to-open behind the bottom accessory bar (`ClimbCapsule` and the iOS 26
 * native bottom accessory `NativeAccessoryClimbRow`). The bar shows the local
 * queue head, so a single tap opens it. (The wall's lit climb has its own surface
 * — the top "On the wall" strip — which opens its own read-only preview via
 * {@link useOpenWallPreview}.)
 */
export type AccessoryClimbTap = {
  /** Tap → open the play drawer for the queue head. */
  openGesture: GestureType;
  /** The same open-the-queue-head action as a plain callback, for non-gesture callers. */
  openPlay: () => void;
  /** Local queue head. */
  currentItem: ClimbQueueItem | null | undefined;
};

export function useAccessoryClimbTap(): AccessoryClimbTap {
  const { state } = useQueue();
  const { openPlayDrawer } = useDrawerHost();
  const { currentClimbQueueItem } = state;

  const accessoryClimb = currentClimbQueueItem?.climb ?? null;

  const handleOpenPlay = useCallback(() => {
    if (!accessoryClimb) return;
    hapticLight();
    // It already IS current, so openDrawer won't re-append it.
    openPlayDrawer(accessoryClimb, {});
  }, [openPlayDrawer, accessoryClimb]);

  const openGesture = useMemo(
    () =>
      Gesture.Tap()
        .maxDuration(250)
        .onEnd(() => {
          'worklet';
          runOnJS(handleOpenPlay)();
        }),
    [handleOpenPlay],
  );

  return { openGesture, openPlay: handleOpenPlay, currentItem: currentClimbQueueItem };
}
