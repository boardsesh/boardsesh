import { useCallback, useMemo } from 'react';
import { Gesture, type GestureType } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import type { LastPick } from '../../lib/last-pick-store';
import { hapticLight } from '../../lib/haptics';
import { barOpenOptions, useBarClimb } from './use-bar-climb';

/**
 * Tap-to-open behind the bottom accessory bar (`ClimbCapsule` and the iOS 26
 * native bottom accessory `NativeAccessoryClimbRow`). The bar shows the
 * climber's last pick or the queue's current climb (`useBarClimb`), so a
 * single tap opens that one: a pick as the same preview, with its list, its
 * deferred commit and its mirror; the current climb as before. (The wall's lit
 * climb has its own surface — the top "On the wall" strip — which opens its
 * own read-only preview via {@link useOpenWallPreview}.)
 */
export type AccessoryClimbTap = {
  /** Tap → open the play drawer for the bar's climb. */
  openGesture: GestureType;
  /** The same open as a plain callback, for non-gesture callers. */
  openPlay: () => void;
  /** Stage the bar's climb before a Link performs its own native navigation. */
  preparePlay: () => boolean;
  /** The item the bar shows: the last pick's, or the queue's current. */
  currentItem: ClimbQueueItem | null | undefined;
  /** The last pick on the bar, or null while it shows the queue's current climb. */
  pick: LastPick | null;
};

export function useAccessoryClimbTap(): AccessoryClimbTap {
  const { openPlayDrawer } = useDrawerHost();
  const { item, pick } = useBarClimb();

  // The preview's own item, not the bar's drawn copy: the player puts the flip back itself.
  const accessoryClimb = item?.climb ?? null;

  const handleOpenPlay = useCallback(() => {
    if (!accessoryClimb) return;
    hapticLight();
    openPlayDrawer(accessoryClimb, barOpenOptions(pick));
  }, [openPlayDrawer, accessoryClimb, pick]);

  const preparePlay = useCallback(() => {
    if (!accessoryClimb) return false;
    hapticLight();
    openPlayDrawer(accessoryClimb, { ...barOpenOptions(pick), navigate: false });
    return true;
  }, [openPlayDrawer, accessoryClimb, pick]);

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

  return { openGesture, openPlay: handleOpenPlay, preparePlay, currentItem: item, pick };
}
