import type { ClimbQueueItem } from '@boardsesh/shared-schema';
import {
  capHistory,
  chooseQueueEvent,
  normaliseOrphanCurrent,
  placeOnWall,
  upNextStart,
  type CurrentClimbPlacement,
  type NowSlotQueueEvent,
  type NowSlotRewrite,
} from '@boardsesh/queue';
import type { RoomManager } from './room-manager/room-manager';
import { VersionConflictError, type QueueState, type QueueWriteResult } from './room-manager/types';
import type { pubsub as PubSubInstance } from '../pubsub/index';
import { MAX_RETRIES } from '../graphql/resolvers/shared/types';
import { isNowSlotSession } from './queue-now-slot-rollout';
import { publishFullSync, publishTrailingCurrentClimb } from './queue-now-slot-events';

export type SetCurrentClimbRewrite = NowSlotRewrite | 'legacy-pointer' | 'legacy-append';

export type SetCurrentClimbOutcome = {
  sequence: number;
  stateHash: string;
  queue: ClimbQueueItem[];
  /** The stored current climb: an existing entry when one was reused. */
  currentClimbQueueItem: ClimbQueueItem | null;
  historyCount: number;
  /** The array gained the request's item. */
  addedToQueue: boolean;
  /** Which placement row applied (the `rewrite` mutation metric). */
  rewrite: SetCurrentClimbRewrite;
  event: NowSlotQueueEvent;
  trimmedCount: number;
  /** The F3 placement rules ran (placement sent, or the session is inside the percent). */
  nowSlotRules: boolean;
};

type PlannedWrite = {
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
  historyCount: number;
  rewrite: SetCurrentClimbRewrite;
  event: NowSlotQueueEvent;
  trimmedCount: number;
};

/**
 * Today's rules (QUEUE_NOW_SLOT_PERCENT outside the session, no `placement`),
 * with the one exception F3 makes at every percent: no orphan is stored. A
 * stored orphan is normalised first, and an item that isn't queued and wasn't
 * asked to be added (the native socket's stale item) is inserted at the Now
 * slot instead of becoming an orphan current climb.
 */
function planLegacyWrite(
  stored: QueueState,
  item: ClimbQueueItem | null,
  shouldAddToQueue: boolean | null | undefined,
): PlannedWrite {
  const normalised = normaliseOrphanCurrent(stored);
  if (item === null) {
    const cleared = placeOnWall(normalised, null);
    return { ...cleared, event: normalised.normalised ? 'fullsync' : 'pointer', trimmedCount: 0 };
  }

  const { queue } = normalised;
  const currentIndex = normalised.currentClimbQueueItem
    ? queue.findIndex((queueItem) => queueItem.uuid === normalised.currentClimbQueueItem?.uuid)
    : -1;
  const existingIndex = queue.findIndex((queueItem) => queueItem.uuid === item.uuid);
  const reshaped = normalised.normalised;

  if (existingIndex >= 0) {
    // A pointer move, as today: the request's item becomes current.
    return {
      queue,
      currentClimbQueueItem: item,
      historyCount: existingIndex,
      rewrite: existingIndex === currentIndex ? 'none' : 'legacy-pointer',
      event: reshaped ? 'fullsync+trailing' : 'pointer',
      trimmedCount: 0,
    };
  }

  const nowSlot = upNextStart(queue, normalised.currentClimbQueueItem, normalised.historyCount);
  if (shouldAddToQueue === true) {
    // Insert right after the current climb (issue #2217); with nothing current
    // today's rule appends to the end of the queue.
    const insertIndex = currentIndex >= 0 ? currentIndex + 1 : queue.length;
    return {
      queue: [...queue.slice(0, insertIndex), item, ...queue.slice(insertIndex)],
      currentClimbQueueItem: item,
      historyCount: insertIndex,
      rewrite: insertIndex === nowSlot ? 'insert' : 'legacy-append',
      event: reshaped ? 'fullsync+trailing' : 'fullsync',
      trimmedCount: 0,
    };
  }

  // The native socket's Next / Previous with an item that already left the
  // queue. Today this stored an orphan; F3 inserts it at the Now slot, and the
  // trailing event keeps the locked phone's wall repaint.
  return {
    queue: [...queue.slice(0, nowSlot), item, ...queue.slice(nowSlot)],
    currentClimbQueueItem: item,
    historyCount: nowSlot,
    rewrite: 'insert',
    event: 'fullsync+trailing',
    trimmedCount: 0,
  };
}

/** The F3 rules: `placeOnWall`, then the History cap (section 5). */
function planNowSlotWrite(
  stored: QueueState,
  item: ClimbQueueItem | null,
  shouldAddToQueue: boolean | null | undefined,
  placement: CurrentClimbPlacement | null | undefined,
): PlannedWrite {
  const placed = placeOnWall(stored, item, placement, shouldAddToQueue);
  const capped = capHistory(placed, 0);
  const event = chooseQueueEvent(stored, { item, shouldAddToQueue, placement }, capped);
  return {
    queue: capped.queue,
    currentClimbQueueItem: capped.currentClimbQueueItem,
    historyCount: capped.historyCount,
    rewrite: placed.rewrite,
    event,
    trimmedCount: capped.trimmedCount,
  };
}

/**
 * Put a climb on the wall (or take it off with `item: null`) and publish the
 * resulting queue event. The GraphQL `setCurrentClimb` resolver and the widget
 * re-assert handler share it.
 *
 * F3 (#6666, docs/current-climb-outside-queue.md, sections 1-3): with
 * `placement`, or in a session inside `QUEUE_NOW_SLOT_PERCENT`, the request
 * goes through `placeOnWall` from `@boardsesh/queue` (an existing entry moves
 * into the Now slot instead of being copied, nothing jumps over unclimbed
 * climbs) and then `capHistory`. Otherwise today's rules apply, except that no
 * orphan is ever stored. The event comes from `chooseQueueEvent`: a pointer
 * `CurrentClimbChanged` only when a shipped reducer moving its pointer gets
 * exactly the stored array; else a `FullSync`, followed for every reshape by a
 * same-sequence `CurrentClimbChanged` outside the replay buffer so the native
 * socket still repaints the wall.
 *
 * `shouldAddToQueue` keeps its three values: `true` (a shipped row tap or
 * open), `false` (a shipped Next, Previous or track swipe), absent (the native
 * socket). Only an explicit `false` reads as an old phone's Next.
 */
export async function setCurrentClimbAndPublish(
  sessionId: string,
  item: ClimbQueueItem | null,
  shouldAddToQueue: boolean | null | undefined,
  roomManager: RoomManager,
  pubsub: typeof PubSubInstance,
  clientId?: string | null,
  correlationId?: string | null,
  placement?: CurrentClimbPlacement | null,
): Promise<SetCurrentClimbOutcome> {
  const nowSlotRules = placement != null || isNowSlotSession(sessionId);
  let plan: PlannedWrite | null = null;
  let write: QueueWriteResult | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const stored = await roomManager.getQueueState(sessionId);
    const attemptPlan = nowSlotRules
      ? planNowSlotWrite(stored, item, shouldAddToQueue, placement)
      : planLegacyWrite(stored, item, shouldAddToQueue);

    try {
      write = await roomManager.updateQueueState(
        sessionId,
        attemptPlan.queue,
        attemptPlan.currentClimbQueueItem,
        stored.version,
        attemptPlan.historyCount,
      );
      plan = attemptPlan;
      break;
    } catch (error) {
      if (error instanceof VersionConflictError && attempt < MAX_RETRIES - 1) {
        continue;
      }
      throw error;
    }
  }

  if (!plan || !write) {
    // Unreachable: the loop either broke with both set or threw.
    throw new Error(`setCurrentClimb wrote nothing for session ${sessionId}`);
  }

  const current = plan.currentClimbQueueItem;
  // A clear never gets the trailing event: `chooseQueueEvent` and the legacy
  // plan both send a clear that reshapes the array as a lone FullSync.
  const { event } = plan;

  if (current) {
    // Record the climb as the latest authoritative wall climb so the next
    // `confirmClimbOnWall` accepts it even if the driver navigates on before
    // the confirm arrives. Best-effort: don't fail the publish if the recency
    // record breaks (Redis hiccup).
    await roomManager.pushRecentClimb(sessionId, current.climb.uuid).catch(() => undefined);
  }

  if (event === 'pointer') {
    pubsub.publishQueueEvent(sessionId, {
      __typename: 'CurrentClimbChanged',
      sequence: write.sequence,
      stateHash: write.stateHash,
      stateHashOrdered: write.stateHashOrdered,
      item: current,
      clientId: clientId ?? null,
      correlationId: correlationId ?? null,
    });
  } else {
    publishFullSync(pubsub, sessionId, write, plan.queue, current);
    if (event === 'fullsync+trailing' && current) {
      publishTrailingCurrentClimb(pubsub, sessionId, write, current, clientId ?? null);
    }
  }

  return {
    sequence: write.sequence,
    stateHash: write.stateHash,
    queue: plan.queue,
    currentClimbQueueItem: current,
    historyCount: write.historyCount,
    addedToQueue: plan.rewrite === 'insert' || plan.rewrite === 'legacy-append',
    rewrite: plan.rewrite,
    event,
    trimmedCount: plan.trimmedCount,
    nowSlotRules,
  };
}

/**
 * Navigate to a specific queue item by index.
 *
 * Shared logic used by both the GraphQL `setCurrentClimb` mutation and the
 * REST widget-navigate endpoint so the optimistic-locking + event-publish
 * behaviour stays in one place.
 *
 * `targetIndex` indexes the stored array, as the caller read it. A stored
 * orphan current climb (a room written before F3) is inserted at the line
 * first (invariant 1), so it stays in History instead of vanishing; that
 * write publishes a `FullSync` plus the same-sequence trailing
 * `CurrentClimbChanged` instead of the pointer event.
 *
 * Returns the selected item and the resulting sequence number, or `null` when
 * the target index is out of bounds / the queue is empty.
 */
export async function navigateToQueueItem(
  sessionId: string,
  targetIndex: number,
  roomManager: RoomManager,
  pubsub: typeof PubSubInstance,
  clientId?: string,
  correlationId?: string,
): Promise<{ item: ClimbQueueItem; sequence: number } | null> {
  let navigation: {
    item: ClimbQueueItem;
    queue: ClimbQueueItem[];
    write: QueueWriteResult;
    normalised: boolean;
  } | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const currentState = await roomManager.getQueueState(sessionId);
    const { queue, version } = currentState;

    // Bounds check
    if (queue.length === 0 || targetIndex < 0 || targetIndex >= queue.length) {
      return null;
    }

    const item = queue[targetIndex];
    const normalised = normaliseOrphanCurrent(currentState);
    const itemIndex = normalised.queue.findIndex((queueItem) => queueItem.uuid === item.uuid);

    try {
      // The target becomes current, so the line is its index (F3).
      const write = await roomManager.updateQueueState(sessionId, normalised.queue, item, version, itemIndex);
      navigation = { item, queue: normalised.queue, write, normalised: normalised.normalised };
      break; // success
    } catch (error) {
      if (error instanceof VersionConflictError && attempt < MAX_RETRIES - 1) {
        continue; // retry
      }
      throw error;
    }
  }

  if (!navigation) return null;

  const { item, queue, write, normalised } = navigation;
  // Record the climb in the session's recent-climbs ring buffer so a
  // confirmClimbOnWall arriving after a quick navigate-on still correlates.
  // See setCurrentClimbAndPublish above for the rationale.
  await roomManager.pushRecentClimb(sessionId, item.climb.uuid).catch(() => undefined);
  if (normalised) {
    publishFullSync(pubsub, sessionId, write, queue, item);
    publishTrailingCurrentClimb(pubsub, sessionId, write, item, clientId ?? null);
  } else {
    pubsub.publishQueueEvent(sessionId, {
      __typename: 'CurrentClimbChanged',
      sequence: write.sequence,
      stateHash: write.stateHash,
      stateHashOrdered: write.stateHashOrdered,
      item,
      clientId: clientId ?? null,
      correlationId: correlationId ?? null,
    });
  }

  return { item, sequence: write.sequence };
}
