import { useCallback, useSyncExternalStore } from 'react';
import { useHasActiveClimb } from '../providers/queue-provider';
import { hasStoredLastPick, subscribeToLastPick } from '../lib/last-pick-store';

/**
 * Presence-only signal for "the bottom accessory has a climb to show": the local
 * queue head, or the climber's last pick (owner decision A, `useBarClimb`). A
 * presence-only boolean (flips on appear/disappear, not on climb-to-climb
 * change), so gating the native accessory mount on it doesn't churn the tab tree
 * on queue mutations.
 *
 * The accessory shows the queue head or the last pick (the wall's lit climb
 * moved to the top "On the wall" capsule) — kept as a named hook so
 * `useStickyAccessoryPresence` and the bottom-chrome arbitration have one stable
 * import for "should the accessory be mounted."
 *
 * Deliberately NOT `|| useHasWallClimb()` (the old behaviour). The accessory no
 * longer renders the wall climb, so for a spectator with no personal queue there is
 * nothing of theirs to show — mounting it on wall presence would float an EMPTY
 * UIKit host (`QueueBottomAccessory` reads the queue head and returns null). And
 * because no host is mounted in that case, there is no `NativeTabs.BottomAccessory`
 * snapshot to leave a doubled name on a presence-reconnect blip; the wall climb is
 * surfaced by the top capsule, a plain RN view immune to that UIKit issue.
 */
export function useHasAccessoryClimb(): boolean {
  // Owner decision A: the bar also shows the climber's last pick, so a preview
  // opened on an empty queue (every tap previews since 2.7) keeps a bar too.
  // One snapshot of the OR, so a pick starting or ending re-renders the host
  // (the whole tab tree, for TabLayout) only when the answer flips: with a
  // queue climb present, opening a preview or Back changes nothing here.
  const hasActiveClimb = useHasActiveClimb();
  const readHasAccessoryClimb = useCallback(() => hasActiveClimb || hasStoredLastPick(), [hasActiveClimb]);
  return useSyncExternalStore(subscribeToLastPick, readHasAccessoryClimb, readHasAccessoryClimb);
}
