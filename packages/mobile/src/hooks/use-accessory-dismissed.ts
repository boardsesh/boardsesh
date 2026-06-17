import { useActiveClimbQueueItemUuid } from '../providers/queue-provider';
import { useDismissedAccessoryUuid } from '../lib/accessory-dismiss-store';
import { useIsActivelyClimbing } from './use-actively-climbing';

/**
 * Whether the active-climb accessory bar should be hidden right now.
 *
 * Hidden only when the user explicitly dismissed THIS climb — the persisted
 * dismissed uuid still matches the current queue-item uuid — AND there is no live
 * climbing signal. Any climbing signal forces the bar back (see
 * {@link useIsActivelyClimbing}); a new climb becoming current changes the uuid and
 * clears the match for free, so a stale dismiss can never suppress a fresh climb.
 */
export function useAccessoryDismissed(): boolean {
  const dismissedUuid = useDismissedAccessoryUuid();
  const activeQueueItemUuid = useActiveClimbQueueItemUuid();
  const isActivelyClimbing = useIsActivelyClimbing();
  return !isActivelyClimbing && activeQueueItemUuid !== null && dismissedUuid === activeQueueItemUuid;
}
