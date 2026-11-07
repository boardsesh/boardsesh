import { useRef, useSyncExternalStore } from 'react';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { useQueueData, useQueueSessionId } from '../../providers/queue-provider';
import type { AccessoryPlacement } from '../../lib/analytics-board-connect';
import { NativeAccessoryClimbRow } from './NativeAccessoryClimbRow';
import { useBarClimb } from './use-bar-climb';
import type { MiniPlayerHost } from './mini-player-controls';
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
 * The Material card keeps the same rule, so a rehydrate never blanks it either.
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

type MiniPlayerAccessoryBodyProps = {
  /** UIKit's placement on the iOS 26 accessory; the Material card is always `regular`. */
  placement: AccessoryPlacement;
  /** Who draws the bar around the row: the native platter or the Material card. */
  host: MiniPlayerHost;
};

/**
 * The MiniPlayer's content, shared by the iOS 26 tab-bar bottom accessory
 * ({@link QueueBottomAccessory}) and the Material card
 * (`FloatingMiniPlayerCard`): the bar's climb plus its controls. That climb is
 * the climber's last pick, or the queue's current when THAT changed after it
 * (`useBarClimb`, owner decision A).
 *
 * This is the single source of truth for the displayed climb and the single
 * render gate. It renders {@link NativeAccessoryClimbRow} directly (no extra
 * wrapper) so the platter holds exactly one placement-sized row — a second nested
 * gate/wrapper used to let the content blank for a frame inside the live host,
 * which UIKit snapshotted as doubled text.
 *
 * It reads the queue through the narrow contexts only (the queue's head and the
 * session id), so a queue edit that leaves the head alone does not re-render it.
 */
export function MiniPlayerAccessoryBody({ placement, host }: MiniPlayerAccessoryBodyProps) {
  const { currentClimbQueueItem: head } = useQueueData();
  const { sessionId } = useQueueSessionId();
  // The climber's last pick or the queue's current, never the wall's lit climb
  // (that lives in the top "On the wall" strip). Retained across a presence
  // blip so the live platter never blanks while the host is held open.
  const bar = useBarClimb();
  const currentItem = useRetainedAccessoryClimb(bar.item);

  if (!currentItem) return null;
  // The pick's drawn copy (its mirror flip applied) while it is the one shown.
  const showsBar = currentItem === bar.item;
  const currentClimb = showsBar && bar.climb ? bar.climb : currentItem.climb;
  const pick = showsBar ? bar.pick : null;

  // A retained row during rehydration cannot prove that the real solo queue
  // currently contains this climb. Capture metadata belongs to the actual head.
  const testID =
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' &&
    process.env.EXPO_PUBLIC_SCREENSHOT_CPP_URL &&
    sessionId === null &&
    head != null &&
    head.uuid === currentItem.uuid
      ? `cpp-accessory-climb-${currentClimb.uuid}`
      : undefined;
  return (
    <NativeAccessoryClimbRow
      climb={currentClimb}
      queueItemUuid={currentItem.uuid}
      pick={pick}
      placement={placement}
      host={host}
      testID={testID}
    />
  );
}
