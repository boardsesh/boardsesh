import type { AccessoryPlacement } from '../../lib/analytics-board-connect';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { NativeAccessoryClimbRow } from './NativeAccessoryClimbRow';
import { useBarClimb } from './use-bar-climb';
import type { MiniPlayerHost } from './mini-player-controls';

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
  // The climber's last pick or the queue's current, never the wall's lit climb
  // (that lives in the top "On the wall" strip). Retained across a presence
  // blip so the live platter never blanks while the host is held open.
  const { boardConfig } = useDrawerHost();
  const { item, climb, pick } = useBarClimb(boardConfig, true);
  if (!item || !climb) return null;

  return (
    <NativeAccessoryClimbRow climb={climb} queueItemUuid={item.uuid} pick={pick} placement={placement} host={host} />
  );
}
