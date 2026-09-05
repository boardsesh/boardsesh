/**
 * Pure utility functions for queue event processing.
 * No React, no DOM — works in any JS runtime.
 */

type UuidItem = {
  uuid: string;
};

/**
 * Idempotent insert: if an item with the same uuid already exists in the queue,
 * returns the original array unchanged (referential identity preserved).
 * Optionally inserts at a specific position.
 */
export function insertQueueItemIdempotent<T extends UuidItem>(queue: T[], item: T, position?: number): T[] {
  if (queue.some((existingItem) => existingItem.uuid === item.uuid)) {
    return queue;
  }

  const nextQueue = [...queue];
  if (position !== undefined && position >= 0 && position <= nextQueue.length) {
    nextQueue.splice(position, 0, item);
    return nextQueue;
  }

  nextQueue.push(item);
  return nextQueue;
}

export type QueueSequenceDecision = 'apply' | 'ignore-stale' | 'gap';

/**
 * Determine what to do with an incoming queue event based on its sequence number
 * relative to the last-known sequence.
 *
 * - null lastSequence: first event, always apply
 * - eventSequence <= lastSequence: stale duplicate, ignore
 * - eventSequence === lastSequence + 1: contiguous, apply
 * - eventSequence > lastSequence + 1: gap detected, caller should request resync
 */
export function evaluateQueueEventSequence(lastSequence: number | null, eventSequence: number): QueueSequenceDecision {
  if (lastSequence === null) {
    return 'apply';
  }

  if (eventSequence <= lastSequence) {
    return 'ignore-stale';
  }

  if (eventSequence > lastSequence + 1) {
    return 'gap';
  }

  return 'apply';
}

/**
 * Climb fields that are ONE climber's private view of a climb rather than a
 * property of the climb, and must never cross the party-queue wire.
 *
 * `myDifficulty` is the grade the signed-in climber gave a climb themselves
 * (#4796 / #4828). A queue item's `climb` is a full climb record — its own type
 * comments say the grade fields ride the queue so a party-peer broadcast
 * renders without a refetch — so anything left on it is serialized straight
 * onto every peer's row. A peer seeing "V10" next to a climb because someone
 * else in the session graded it V10 is worse than seeing no personal grade at
 * all: it is unattributed, it is wrong for them, and their next full-queue
 * write pushes it back to everyone.
 */
export const PRIVATE_CLIMB_FIELDS = ['myDifficulty'] as const;

/**
 * A copy of `climb` with every field in `PRIVATE_CLIMB_FIELDS` removed.
 *
 * Deliberately structural (`object`, key deletion) rather than typed against a
 * particular Climb: the wire mappers on both platforms enumerate their fields,
 * so this is the belt to their braces — it also catches a mapper that ever
 * starts spreading, which is how a private field would actually escape.
 * Returns the input unchanged (same reference) when there is nothing to strip,
 * so the common path allocates nothing.
 *
 * The wire boundary that calls it is `toClimbQueueItemInput` in
 * `@boardsesh/queue-react` — the one place a queue item is turned into the
 * payload peers receive.
 */
export function stripPrivateClimbFields<TClimb extends object>(climb: TClimb): TClimb {
  const present = PRIVATE_CLIMB_FIELDS.filter((field) => field in climb);
  if (present.length === 0) return climb;
  const stripped = { ...(climb as Record<string, unknown>) };
  for (const field of present) delete stripped[field];
  return stripped as TClimb;
}
