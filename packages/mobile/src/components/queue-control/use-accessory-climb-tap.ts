import { useCallback, useMemo } from 'react';
import { Gesture, type GestureType } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { useQueue, useActiveClimbQueueItemUuid } from '../../providers/queue-provider';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { climbToQueueItem } from '../../lib/climb-to-queue-item';
import { hapticLight } from '../../lib/haptics';
import { dismissAccessory } from '../../lib/accessory-dismiss-store';
import { useIsActivelyClimbing } from '../../hooks/use-actively-climbing';
import { useWallOrQueueCurrentClimb } from './use-wall-or-queue-climb';

// A downward drag past this distance (or a firm downward flick) tucks the bar away.
const DISMISS_TRANSLATION_THRESHOLD = 40;
const DISMISS_VELOCITY_THRESHOLD = 600;

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
  /** Downward swipe → tuck the bar away (JS bar composes this with `openGesture`). */
  dismissGesture: GestureType;
  /** Imperative dismiss for the native platter's explicit hide control. */
  dismiss: () => void;
  /** Whether the bar may be dismissed right now (false while actively climbing). */
  canDismiss: boolean;
  /** Local queue head; the wrappers re-apply `useWallOrQueueCurrentClimb` for display. */
  currentItem: ClimbQueueItem | null | undefined;
};

export function useAccessoryClimbTap(): AccessoryClimbTap {
  const { state } = useQueue();
  const { openPlayDrawer } = useDrawerHost();
  const { currentClimbQueueItem } = state;
  const activeQueueItemUuid = useActiveClimbQueueItemUuid();
  const isActivelyClimbing = useIsActivelyClimbing();
  // The bar is dismissible only when there's a climb to dismiss and no climbing
  // signal — an active climber keeps one-tap return / tick, so no hide affordance.
  const canDismiss = !isActivelyClimbing && activeQueueItemUuid !== null;

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
    // view-only preview (badged) — you're looking at someone else's wall, not
    // taking it over until you choose to. Both are queue-bar opens, so keep the
    // `current_queue_item` analytics source.
    if (accessoryClimb.uuid === currentClimbQueueItem?.climb.uuid) {
      openPlayDrawer(accessoryClimb, { source: 'current_queue_item' });
    } else {
      openPlayDrawer(accessoryClimb, {
        previewQueueItem: climbToQueueItem(accessoryClimb),
        source: 'current_queue_item',
      });
    }
  }, [openPlayDrawer, accessoryClimb, currentClimbQueueItem]);

  const dismiss = useCallback(() => {
    if (!activeQueueItemUuid) return;
    hapticLight();
    // UI-only: tuck the strip away for this queue item. Never mutates the queue.
    dismissAccessory(activeQueueItemUuid);
  }, [activeQueueItemUuid]);

  const openGesture = useMemo(
    () =>
      Gesture.Tap()
        .maxDuration(250)
        .onEnd((_event, success) => {
          'worklet';
          // Only open on a recognized tap — never on a cancelled one (the tap loses
          // to the dismiss Pan under Gesture.Exclusive on the JS bar).
          if (!success) return;
          runOnJS(handleOpenPlay)();
        }),
    [handleOpenPlay],
  );

  // Activates only on a downward drag (and bails on an upward one), so it never
  // competes with the tap for a quick press. Disabled entirely while climbing.
  const dismissGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(canDismiss)
        .activeOffsetY(12)
        .failOffsetY(-12)
        .onEnd((event) => {
          'worklet';
          if (event.translationY > DISMISS_TRANSLATION_THRESHOLD || event.velocityY > DISMISS_VELOCITY_THRESHOLD) {
            runOnJS(dismiss)();
          }
        }),
    [canDismiss, dismiss],
  );

  return { openGesture, dismissGesture, dismiss, canDismiss, currentItem: currentClimbQueueItem };
}
