import { useRef, useSyncExternalStore } from 'react';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { useQueue } from '../../providers/queue-provider';
import { NativeAccessoryClimbRow } from './NativeAccessoryClimbRow';
import { getCredentialGeneration, subscribeToCredentialChanges } from '../../lib/privacy/privacy-cache';

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
function useRetainedAccessoryClimb(currentClimb: ClimbQueueItem | null): ClimbQueueItem | null {
  const generation = useSyncExternalStore(
    subscribeToCredentialChanges,
    getCredentialGeneration,
    getCredentialGeneration,
  );
  const retained = useRef({ generation, climb: currentClimb, withdrawn: null as ClimbQueueItem | null });
  if (retained.current.generation !== generation) {
    // The provider may not have painted its cleared queue yet. Do not adopt
    // that same old object again while the sticky UIKit host remains mounted.
    retained.current = { generation, climb: null, withdrawn: currentClimb };
  }
  if (currentClimb && currentClimb !== retained.current.withdrawn) retained.current.climb = currentClimb;
  return retained.current.climb;
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
  const { state, sessionId } = useQueue();
  // The accessory shows the local queue head only — never the wall's lit climb
  // (that lives in the top "On the wall" strip now). Retained across a presence
  // blip so the live platter never blanks while the host is held open.
  const resolvedItem = state.currentClimbQueueItem;
  const currentItem = useRetainedAccessoryClimb(resolvedItem);

  if (!currentItem) return null;
  const currentClimb = currentItem.climb;

  // A retained row during rehydration cannot prove that the real solo queue
  // currently contains this climb. Capture metadata belongs to the actual head.
  const testID =
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' &&
    process.env.EXPO_PUBLIC_SCREENSHOT_CPP_URL &&
    sessionId === null &&
    resolvedItem != null &&
    resolvedItem.uuid === currentItem.uuid
      ? `cpp-accessory-climb-${currentClimb.uuid}`
      : undefined;
  return (
    <NativeAccessoryClimbRow
      climb={currentClimb}
      queueItemUuid={currentItem.uuid}
      placement={placement}
      testID={testID}
    />
  );
}
