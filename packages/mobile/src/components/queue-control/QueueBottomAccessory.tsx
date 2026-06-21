import { useMemo, useRef } from 'react';
import { useWindowDimensions } from 'react-native';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import type { Climb } from '@boardsesh/queue';
import { useQueue } from '../../providers/queue-provider';
import {
  glassSize,
  NATIVE_BOTTOM_ACCESSORY_MAX_WIDTH,
  NATIVE_BOTTOM_ACCESSORY_SCREEN_GUTTER,
} from '../../theme/layout';
import { NativeAccessoryClimbRow } from './NativeAccessoryClimbRow';
import { useWallOrQueueCurrentClimb } from './use-wall-or-queue-climb';

/**
 * Hold the last shown climb while this component stays mounted. The mount itself
 * is gated by the sticky presence boolean (see useStickyAccessoryPresence), which
 * keeps the UIKit host alive across a brief presence blip — board-presence
 * reconnect, queue rehydrate. Without retaining the climb, the raw selector below
 * resolves null during that same blip and the row unmounts/remounts inside the
 * live host: the exact empty→content transition (and a blank platter for the
 * window) UIKit snapshots as doubled text. Tying retention to the mount lifecycle
 * — rather than a second timer — keeps it consistent with the presence hold by
 * construction: the host unmount is the single thing that finally clears it.
 */
function useRetainedAccessoryClimb(currentClimb: Climb | null): Climb | null {
  const lastClimbRef = useRef<Climb | null>(currentClimb);
  if (currentClimb) lastClimbRef.current = currentClimb;
  return currentClimb ?? lastClimbRef.current;
}

/**
 * iOS 26 tab-bar bottom accessory content. UIKit supplies the outer Liquid Glass
 * platter and swaps this subtree between regular and inline placements as the
 * tab bar minimizes, so the content stays bare: current climb plus tick only.
 *
 * This is the single source of truth for the displayed climb and the single
 * render gate. It renders {@link NativeAccessoryClimbRow} directly (no extra
 * wrapper) so the platter holds exactly one placement-sized row — a second nested
 * gate/wrapper used to let the content blank for a frame inside the live host,
 * which UIKit snapshotted as doubled text.
 */
export function QueueBottomAccessory() {
  const placement = NativeTabs.BottomAccessory.usePlacement();
  const { width: screenWidth } = useWindowDimensions();
  const { state } = useQueue();
  // Show the accessory when there's a local queue climb OR a live wall climb
  // (the flag-gated source flip — see useWallOrQueueCurrentClimb), retained across
  // a presence blip so the live platter never blanks while the host is held open.
  const resolvedClimb = useWallOrQueueCurrentClimb(state.currentClimbQueueItem?.climb ?? null);
  const currentClimb = useRetainedAccessoryClimb(resolvedClimb);

  const accessoryWidth = useMemo(() => {
    return Math.max(
      glassSize.standard * 2,
      Math.min(NATIVE_BOTTOM_ACCESSORY_MAX_WIDTH, screenWidth - NATIVE_BOTTOM_ACCESSORY_SCREEN_GUTTER),
    );
  }, [screenWidth]);

  if (!currentClimb) return null;

  return <NativeAccessoryClimbRow climb={currentClimb} placement={placement} width={accessoryWidth} />;
}
