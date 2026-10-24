// Which queue item a tick counts for (#5380, #6231). Ticks carry no queue item
// on the server, so the phone that logs one decides here, once, when the save is
// called, and both the rest timer (`lastTick`) and the workout's tick log use
// that one answer. Pure.

import type { ClimbQueueItem } from '@boardsesh/queue';

/** The part of the committed current queue item the rule reads. */
export type TickAttributionCandidate = Pick<ClimbQueueItem, 'uuid'> & { climb: Pick<ClimbQueueItem['climb'], 'uuid'> };

/**
 * The committed current queue item's uuid when the tick is for the climb on it,
 * else null. A tick logged on any other climb (one browsed in the player, one
 * from a list or the logbook) counts for no queue item, so it can never let the
 * rest timer move the wall on from the climb that is up, nor land in the
 * workout's tick log against it.
 */
export function attributeTickToQueueItem(climbUuid: string, current: TickAttributionCandidate | null): string | null {
  if (current === null || current.climb.uuid !== climbUuid) return null;
  return current.uuid;
}
