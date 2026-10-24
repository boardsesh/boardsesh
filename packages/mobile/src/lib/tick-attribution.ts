// Which queue item a tick counts for (#5380, #6231). Ticks carry no queue item
// on the server, so the phone that logs one decides here, once, when the save is
// called, and both the rest timer (`lastTick`) and the workout's tick log use
// that one answer. Pure.

import type { ClimbQueueItem } from '@boardsesh/queue';

/** The part of the committed current queue item the rule reads. */
export type TickAttributionCandidate = Pick<ClimbQueueItem, 'uuid'> & {
  climb: Pick<ClimbQueueItem['climb'], 'uuid' | 'angle'>;
};

/** The part of a tick the rule reads: the climb it was logged on, at the angle it was logged at. */
export type TickAttributionTick = { climbUuid: string; angle: number };

/**
 * The committed current queue item's uuid when the tick is for the climb on it,
 * at the angle the wall is lighting it at, else null. A tick logged on any other
 * climb (one browsed in the player, one from a list or the logbook) counts for no
 * queue item, so it can never let the rest timer move the wall on from the climb
 * that is up, nor land in the workout's tick log against it.
 *
 * Nor can the right climb at another angle: the ascent form lets the climber
 * pick one, and a 30° send logged while the climb is up at 40° is a send from
 * another session, not of the climb on the wall. The queue item's `climb.angle`
 * is the angle it is on the wall at: the queue keeps the current climb on the
 * board's angle (`REGRADE_CLIMBS`), and lighting it reports that same field as
 * the wall's angle (board presence). A queue item with no usable angle counts no
 * tick: without one there is no telling, and a missed tick only keeps a climb up,
 * where a wrong one moves the wall.
 */
export function attributeTickToQueueItem(
  tick: TickAttributionTick,
  current: TickAttributionCandidate | null,
): string | null {
  if (current === null || current.climb.uuid !== tick.climbUuid) return null;
  // Typed as a number, but a queue item rebuilt from the wire can carry none.
  const wallAngle: unknown = current.climb.angle;
  if (typeof wallAngle !== 'number' || !Number.isFinite(wallAngle) || wallAngle !== tick.angle) return null;
  return current.uuid;
}
