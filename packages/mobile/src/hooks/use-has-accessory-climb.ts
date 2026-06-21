import { useHasActiveClimb } from '../providers/queue-provider';
import { useHasWallClimb } from '../components/queue-control/use-wall-or-queue-climb';

/**
 * Presence-only signal for "the bottom accessory has a climb to show": the local
 * queue head OR a live wall (board-presence) climb. Both inputs are presence-only
 * booleans (flip on appear/disappear, not on climb-to-climb change), so the
 * combined value is too.
 *
 * Gating the native accessory mount and the bottom-chrome arbitration on THIS —
 * rather than the local-queue-only `useHasActiveClimb` — keeps the UIKit
 * `NativeTabs.BottomAccessory` host mounted while a wall climb is continuously
 * present. Without it, a board-level climb change churned local presence, the host
 * unmounted/remounted, and UIKit left a stale snapshot stacked under the new one
 * (the doubled name + grade). It also lets a wall-only climb (no local queue) show
 * the accessory at all.
 */
export function useHasAccessoryClimb(): boolean {
  const hasLocalClimb = useHasActiveClimb();
  const hasWallClimb = useHasWallClimb();
  return hasLocalClimb || hasWallClimb;
}
