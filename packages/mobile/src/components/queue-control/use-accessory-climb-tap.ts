import { useCallback, useMemo } from 'react';
import { Gesture, type GestureType } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { useQueue } from '../../providers/queue-provider';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { climbToQueueItem } from '../../lib/climb-to-queue-item';
import { hapticLight } from '../../lib/haptics';
import { useWallOrQueueCurrentClimb } from './use-wall-or-queue-climb';

/**
 * Tap-to-open behind the bottom accessory bar (`ClimbCapsule` and the iOS 26
 * native bottom accessory `NativeAccessoryClimbRow`). The bar now mirrors the
 * board's status (the wall's lit climb when a feed is live), so the old
 * swipe-to-step-the-queue carousel and its peeking neighbours were removed — a
 * single tap opens whatever the bar is showing.
 */
export type AccessoryClimbTap = {
  /** Tap → open the play drawer for the displayed climb. */
  openGesture: GestureType;
  /**
   * The same open-the-displayed-climb action as a plain callback, for non-gesture
   * callers (e.g. the bar's board control opening the read-only "Now on the wall"
   * view when a teammate drives).
   */
  openPlay: () => void;
  /** Local queue head; the wrappers re-apply `useWallOrQueueCurrentClimb` for display. */
  currentItem: ClimbQueueItem | null | undefined;
};

export function useAccessoryClimbTap(): AccessoryClimbTap {
  const { state } = useQueue();
  const { openPlayDrawer } = useDrawerHost();
  const { currentClimbQueueItem } = state;

  // Open whatever the accessory is showing: the wall's lit climb when a feed is
  // live, else the local queue head — useWallOrQueueCurrentClimb already folds the
  // local head in as its fallback, so this is the single source of truth for the
  // open target.
  const accessoryClimb = useWallOrQueueCurrentClimb(currentClimbQueueItem?.climb ?? null);

  const handleOpenPlay = useCallback(() => {
    if (!accessoryClimb) return;
    hapticLight();
    // When the bar mirrors the local queue head, open it active (it already IS
    // current, so openDrawer won't re-append it). When a live feed makes the bar
    // show a peer-driven WALL climb that isn't your current, open it as a
    // read-only "Now on the wall" view (`previewIsWallClimb`) — it's physically
    // lit right now, so there's no "Set active" takeover; you're just looking at
    // someone else's wall. Both are queue-bar opens, so keep the
    // `current_queue_item` analytics source.
    if (accessoryClimb.uuid === currentClimbQueueItem?.climb.uuid) {
      openPlayDrawer(accessoryClimb, { source: 'current_queue_item' });
    } else {
      openPlayDrawer(accessoryClimb, {
        previewQueueItem: climbToQueueItem(accessoryClimb),
        previewIsWallClimb: true,
        source: 'current_queue_item',
      });
    }
  }, [openPlayDrawer, accessoryClimb, currentClimbQueueItem]);

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
