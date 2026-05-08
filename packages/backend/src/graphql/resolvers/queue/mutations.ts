import type { BoardSend, ConnectionContext, ClimbQueueItem, QueueState, UserPick } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import { sessionSends } from '../../../db/schema';
import { roomManager, VersionConflictError } from '../../../services/room-manager';
import { pubsub } from '../../../pubsub/index';
import { requireSession, applyRateLimit, validateInput, MAX_RETRIES } from '../shared/helpers';
import {
  ClimbQueueItemSchema,
  QueueIndexSchema,
  QueueItemIdSchema,
  QueueArraySchema,
} from '../../../validation/schemas';
import { logMutationMetrics } from './mutation-metrics';

// Debug logging flag - only log in development
const DEBUG = process.env.NODE_ENV === 'development';

function getActorUserId(ctx: ConnectionContext): string {
  return ctx.userId || ctx.connectionId;
}

function isOwnedByCaller(item: ClimbQueueItem | undefined, ctx: ConnectionContext): boolean {
  if (!item) return false;
  const actorUserId = getActorUserId(ctx);
  return (
    item.addedByUser?.id === actorUserId ||
    item.addedByUser?.id === ctx.userId ||
    item.addedBy === actorUserId ||
    item.addedBy === ctx.connectionId
  );
}

function upsertPick(picks: UserPick[], userId: string, item: ClimbQueueItem): UserPick[] {
  const pick: UserPick = { userId, item, updatedAt: new Date().toISOString() };
  const index = picks.findIndex((p) => p.userId === userId);
  if (index === -1) return [...picks, pick];
  const next = [...picks];
  next[index] = pick;
  return next;
}

function removePick(picks: UserPick[], userId: string): UserPick[] {
  return picks.filter((pick) => pick.userId !== userId);
}

function findPick(picks: UserPick[], userId: string): ClimbQueueItem | null {
  return picks.find((pick) => pick.userId === userId)?.item ?? null;
}

function mapBoardSend(row: typeof sessionSends.$inferSelect): BoardSend {
  return {
    id: String(row.id),
    sessionId: row.sessionId,
    item: row.item,
    climbUuid: row.climbUuid,
    sentByUserId: row.sentByUserId,
    activeClimberUserId: row.activeClimberUserId,
    correlationId: row.correlationId,
    sequence: row.sequence,
    createdAt: row.createdAt.toISOString(),
  };
}

async function appendBoardSend({
  sessionId,
  item,
  sentByUserId,
  activeClimberUserId,
  correlationId,
  sequence,
}: {
  sessionId: string;
  item: ClimbQueueItem;
  sentByUserId: string;
  activeClimberUserId: string;
  correlationId?: string | null;
  sequence: number;
}): Promise<BoardSend> {
  const [row] = await db
    .insert(sessionSends)
    .values({
      sessionId,
      item,
      climbUuid: item.climb.uuid,
      sentByUserId,
      activeClimberUserId,
      correlationId: correlationId || null,
      sequence,
    })
    .returning();

  if (!row) throw new Error('Failed to append board send');
  return mapBoardSend(row);
}

export const queueMutations = {
  /**
   * Add a climb to the queue at the specified position
   * Uses optimistic locking to prevent race conditions
   */
  addQueueItem: async (
    _: unknown,
    { item, position }: { item: ClimbQueueItem; position?: number },
    ctx: ConnectionContext,
  ) => {
    const startTime = performance.now();
    await applyRateLimit(ctx); // Apply default rate limit
    const sessionId = requireSession(ctx);

    // Validate input
    validateInput(ClimbQueueItemSchema, item, 'item');
    if (position !== undefined) {
      validateInput(QueueIndexSchema, position, 'position');
    }

    const actorUserId = getActorUserId(ctx);
    const queueItem: ClimbQueueItem = {
      ...item,
      addedBy: actorUserId,
    };

    if (DEBUG)
      console.info(
        '[addQueueItem] Adding item:',
        item.climb?.name,
        'by client:',
        ctx.connectionId,
        'at position:',
        position,
      );

    // Track the original queue length for position calculation
    let originalQueueLength = 0;
    let itemWasAdded = false;
    let resultSequence = 0;

    // Retry loop for optimistic locking
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // Get current state and update
      const currentState = await roomManager.getQueueState(sessionId);
      if (DEBUG)
        console.info(
          '[addQueueItem] Current state - queue size:',
          currentState.queue.length,
          'version:',
          currentState.version,
        );
      let queue = currentState.queue;
      originalQueueLength = queue.length;

      // Only add if not already in queue
      if (queue.some((i) => i.uuid === queueItem.uuid)) {
        // Item already in queue - return without publishing event
        if (DEBUG) console.info('[addQueueItem] Item already in queue, skipping');
        return queueItem;
      }

      if (position !== undefined && position >= 0 && position <= queue.length) {
        queue = [...queue.slice(0, position), queueItem, ...queue.slice(position)];
      } else {
        queue = [...queue, queueItem];
      }

      try {
        // Use updateQueueOnly with version check to avoid race conditions
        const result = await roomManager.updateQueueOnly(sessionId, queue, currentState.version);
        itemWasAdded = true;
        resultSequence = result.sequence;
        break; // Success, exit retry loop
      } catch (error) {
        if (error instanceof VersionConflictError && attempt < MAX_RETRIES - 1) {
          if (DEBUG) console.info(`[addQueueItem] Version conflict, retrying (attempt ${attempt + 1}/${MAX_RETRIES})`);
          continue; // Retry
        }
        throw error; // Re-throw if not a version conflict or max retries exceeded
      }
    }

    // Only publish event if item was actually added
    if (itemWasAdded) {
      // Calculate actual position where item was inserted
      // If position was valid, item is at that index; otherwise it was appended
      const actualPosition =
        position !== undefined && position >= 0 && position <= originalQueueLength ? position : originalQueueLength; // Item was appended at end of original queue

      // Broadcast to subscribers with the actual position
      pubsub.publishQueueEvent(sessionId, {
        __typename: 'QueueItemAdded',
        sequence: resultSequence,
        item: queueItem,
        position: actualPosition,
      });
    }

    logMutationMetrics('addQueueItem', performance.now() - startTime, sessionId, {
      queueSize: originalQueueLength,
    });
    return queueItem;
  },

  /**
   * Remove a climb from the queue by UUID
   * Also clears current climb if it was removed
   */
  removeQueueItem: async (_: unknown, { uuid }: { uuid: string }, ctx: ConnectionContext) => {
    const startTime = performance.now();
    await applyRateLimit(ctx);
    const sessionId = requireSession(ctx);

    // Validate input
    validateInput(QueueItemIdSchema, uuid, 'uuid');

    const currentState = await roomManager.getQueueState(sessionId);
    const removedItem = currentState.queue.find((i) => i.uuid === uuid);
    if (removedItem && !isOwnedByCaller(removedItem, ctx)) {
      throw new Error('You can only remove queue items you added');
    }
    const queue = currentState.queue.filter((i) => i.uuid !== uuid);
    let currentClimb = currentState.currentClimbQueueItem;

    // Clear current climb if it was removed
    if (currentClimb?.uuid === uuid) {
      currentClimb = null;
    }

    const { sequence } = await roomManager.updateQueueState(sessionId, queue, currentClimb);

    pubsub.publishQueueEvent(sessionId, {
      __typename: 'QueueItemRemoved',
      sequence,
      uuid,
    });

    logMutationMetrics('removeQueueItem', performance.now() - startTime, sessionId);
    return true;
  },

  /**
   * Reorder a queue item by moving it from oldIndex to newIndex
   */
  reorderQueueItem: async (
    _: unknown,
    { uuid, oldIndex, newIndex }: { uuid: string; oldIndex: number; newIndex: number },
    ctx: ConnectionContext,
  ) => {
    const startTime = performance.now();
    await applyRateLimit(ctx);
    const sessionId = requireSession(ctx);

    // Validate inputs
    validateInput(QueueItemIdSchema, uuid, 'uuid');
    validateInput(QueueIndexSchema, oldIndex, 'oldIndex');
    validateInput(QueueIndexSchema, newIndex, 'newIndex');

    const currentState = await roomManager.getQueueState(sessionId);
    const queue = [...currentState.queue];

    // Validate indices are within bounds
    if (oldIndex >= queue.length || newIndex >= queue.length) {
      throw new Error(`Invalid index: queue has ${queue.length} items`);
    }

    if (!isOwnedByCaller(queue[oldIndex], ctx)) {
      throw new Error('You can only reorder queue items you added');
    }

    let resultSequence = currentState.sequence;

    if (oldIndex >= 0 && oldIndex < queue.length && newIndex >= 0 && newIndex < queue.length) {
      const [movedItem] = queue.splice(oldIndex, 1);
      queue.splice(newIndex, 0, movedItem);
      // Use updateQueueOnly to avoid overwriting currentClimbQueueItem
      const result = await roomManager.updateQueueOnly(sessionId, queue);
      resultSequence = result.sequence;
    }

    pubsub.publishQueueEvent(sessionId, {
      __typename: 'QueueReordered',
      sequence: resultSequence,
      uuid,
      oldIndex,
      newIndex,
    });

    logMutationMetrics('reorderQueueItem', performance.now() - startTime, sessionId);
    return true;
  },

  /**
   * Set the current climb being attempted
   * Optionally adds the climb to the queue if not already present
   * Uses optimistic locking to prevent race conditions
   */
  setCurrentClimb: async (
    _: unknown,
    {
      item,
      shouldAddToQueue,
      correlationId,
    }: { item: ClimbQueueItem | null; shouldAddToQueue?: boolean; correlationId?: string },
    ctx: ConnectionContext,
  ) => {
    const startTime = performance.now();
    await applyRateLimit(ctx);
    const sessionId = requireSession(ctx);

    // Validate input
    if (item !== null) {
      validateInput(ClimbQueueItemSchema, item, 'item');
    }

    // Debug: track who's setting null
    if (DEBUG) {
      if (item === null) {
        console.info(
          '[setCurrentClimb] Setting current climb to NULL by client:',
          ctx.connectionId,
          'session:',
          sessionId,
        );
      } else {
        console.info(
          '[setCurrentClimb] Setting current climb to:',
          item.climb?.name,
          'by client:',
          ctx.connectionId,
          'correlationId:',
          correlationId,
        );
      }
    }

    // Retry loop for optimistic locking
    let sequence = 0;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const currentState = await roomManager.getQueueState(sessionId);
      let queue = currentState.queue;

      // Optionally add to queue if not already present
      if (shouldAddToQueue && item && !queue.some((i) => i.uuid === item.uuid)) {
        queue = [...queue, item];
      }

      try {
        const result = await roomManager.updateQueueState(sessionId, queue, item, currentState.version);
        sequence = result.sequence;
        break; // Success, exit retry loop
      } catch (error) {
        if (error instanceof VersionConflictError && attempt < MAX_RETRIES - 1) {
          if (DEBUG)
            console.info(`[setCurrentClimb] Version conflict, retrying (attempt ${attempt + 1}/${MAX_RETRIES})`);
          continue; // Retry
        }
        throw error; // Re-throw if not a version conflict or max retries exceeded
      }
    }

    pubsub.publishQueueEvent(sessionId, {
      __typename: 'CurrentClimbChanged',
      sequence,
      item: item,
      clientId: ctx.connectionId || null,
      correlationId: correlationId || null,
    });

    logMutationMetrics('setCurrentClimb', performance.now() - startTime, sessionId, {
      shouldAddToQueue: !!shouldAddToQueue,
    });
    return item;
  },

  /**
   * Update the caller's personal pick. If the caller is active, mirror it to the board.
   */
  setMyPick: async (
    _: unknown,
    { item, correlationId }: { item: ClimbQueueItem; correlationId?: string },
    ctx: ConnectionContext,
  ) => {
    const startTime = performance.now();
    await applyRateLimit(ctx, 240);
    const sessionId = requireSession(ctx);
    const actorUserId = getActorUserId(ctx);

    validateInput(ClimbQueueItemSchema, item, 'item');

    const currentState = await roomManager.getQueueState(sessionId);
    const isActive = currentState.activeClimberUserId === actorUserId;
    const nextPicks = upsertPick(currentState.picks, actorUserId, item);
    const eventCount = isActive ? 3 : 1;
    const result = await roomManager.updateQueueState(
      sessionId,
      currentState.queue,
      isActive ? item : currentState.currentClimbQueueItem,
      currentState.version,
      {
        picks: nextPicks,
        activeClimberUserId: currentState.activeClimberUserId,
        sequenceIncrement: eventCount,
      },
    );
    const firstSequence = result.sequence - eventCount + 1;

    pubsub.publishQueueEvent(sessionId, {
      __typename: 'PickChanged',
      sequence: firstSequence,
      userId: actorUserId,
      pick: item,
      correlationId: correlationId || null,
    });

    if (isActive) {
      const boardSend = await appendBoardSend({
        sessionId,
        item,
        sentByUserId: actorUserId,
        activeClimberUserId: actorUserId,
        correlationId,
        sequence: firstSequence + 2,
      });

      pubsub.publishQueueEvent(sessionId, {
        __typename: 'CurrentClimbChanged',
        sequence: firstSequence + 1,
        item,
        clientId: ctx.connectionId || null,
        correlationId: correlationId || null,
      });
      pubsub.publishQueueEvent(sessionId, {
        __typename: 'BoardSendAdded',
        sequence: firstSequence + 2,
        boardSend,
      });
    }

    logMutationMetrics('setMyPick', performance.now() - startTime, sessionId, { active: isActive });
    return nextPicks.find((pick) => pick.userId === actorUserId)!;
  },

  /**
   * Make the caller's existing pick the active board climb.
   */
  claimTurn: async (_: unknown, { correlationId }: { correlationId?: string }, ctx: ConnectionContext) => {
    const startTime = performance.now();
    await applyRateLimit(ctx);
    const sessionId = requireSession(ctx);
    const actorUserId = getActorUserId(ctx);

    const currentState = await roomManager.getQueueState(sessionId);
    const pick = findPick(currentState.picks, actorUserId);
    if (!pick) {
      throw new Error('Set a pick before claiming the turn');
    }

    const eventCount = 3;
    const result = await roomManager.updateQueueState(sessionId, currentState.queue, pick, currentState.version, {
      picks: currentState.picks,
      activeClimberUserId: actorUserId,
      sequenceIncrement: eventCount,
    });
    const firstSequence = result.sequence - eventCount + 1;
    const boardSend = await appendBoardSend({
      sessionId,
      item: pick,
      sentByUserId: actorUserId,
      activeClimberUserId: actorUserId,
      correlationId,
      sequence: firstSequence + 2,
    });

    pubsub.publishQueueEvent(sessionId, {
      __typename: 'ActiveClimberChanged',
      sequence: firstSequence,
      userId: actorUserId,
      correlationId: correlationId || null,
    });
    pubsub.publishQueueEvent(sessionId, {
      __typename: 'CurrentClimbChanged',
      sequence: firstSequence + 1,
      item: pick,
      clientId: ctx.connectionId || null,
      correlationId: correlationId || null,
    });
    pubsub.publishQueueEvent(sessionId, {
      __typename: 'BoardSendAdded',
      sequence: firstSequence + 2,
      boardSend,
    });

    logMutationMetrics('claimTurn', performance.now() - startTime, sessionId);
    return pick;
  },

  /**
   * Hand the active board state to another participant's existing pick.
   */
  yieldTurn: async (
    _: unknown,
    { toUserId, correlationId }: { toUserId: string; correlationId?: string },
    ctx: ConnectionContext,
  ) => {
    const startTime = performance.now();
    await applyRateLimit(ctx);
    const sessionId = requireSession(ctx);
    const actorUserId = getActorUserId(ctx);

    if (!toUserId || toUserId.length > 100) {
      throw new Error('Invalid target user');
    }

    const currentState = await roomManager.getQueueState(sessionId);
    const pick = findPick(currentState.picks, toUserId);
    if (!pick) {
      throw new Error('Target user has no pick');
    }

    const eventCount = 3;
    const result = await roomManager.updateQueueState(sessionId, currentState.queue, pick, currentState.version, {
      picks: currentState.picks,
      activeClimberUserId: toUserId,
      sequenceIncrement: eventCount,
    });
    const firstSequence = result.sequence - eventCount + 1;
    const boardSend = await appendBoardSend({
      sessionId,
      item: pick,
      sentByUserId: actorUserId,
      activeClimberUserId: toUserId,
      correlationId,
      sequence: firstSequence + 2,
    });

    pubsub.publishQueueEvent(sessionId, {
      __typename: 'ActiveClimberChanged',
      sequence: firstSequence,
      userId: toUserId,
      correlationId: correlationId || null,
    });
    pubsub.publishQueueEvent(sessionId, {
      __typename: 'CurrentClimbChanged',
      sequence: firstSequence + 1,
      item: pick,
      clientId: ctx.connectionId || null,
      correlationId: correlationId || null,
    });
    pubsub.publishQueueEvent(sessionId, {
      __typename: 'BoardSendAdded',
      sequence: firstSequence + 2,
      boardSend,
    });

    logMutationMetrics('yieldTurn', performance.now() - startTime, sessionId);
    return pick;
  },

  /**
   * Clear the caller's personal pick.
   */
  clearMyPick: async (_: unknown, __: unknown, ctx: ConnectionContext) => {
    const startTime = performance.now();
    await applyRateLimit(ctx);
    const sessionId = requireSession(ctx);
    const actorUserId = getActorUserId(ctx);

    const currentState = await roomManager.getQueueState(sessionId);
    const wasActive = currentState.activeClimberUserId === actorUserId;
    const nextPicks = removePick(currentState.picks, actorUserId);
    const eventCount = wasActive ? 2 : 1;
    const result = await roomManager.updateQueueState(
      sessionId,
      currentState.queue,
      currentState.currentClimbQueueItem,
      currentState.version,
      {
        picks: nextPicks,
        activeClimberUserId: wasActive ? null : currentState.activeClimberUserId,
        sequenceIncrement: eventCount,
      },
    );
    const firstSequence = result.sequence - eventCount + 1;

    pubsub.publishQueueEvent(sessionId, {
      __typename: 'PickChanged',
      sequence: firstSequence,
      userId: actorUserId,
      pick: null,
      correlationId: null,
    });

    if (wasActive) {
      pubsub.publishQueueEvent(sessionId, {
        __typename: 'ActiveClimberChanged',
        sequence: firstSequence + 1,
        userId: null,
        correlationId: null,
      });
    }

    logMutationMetrics('clearMyPick', performance.now() - startTime, sessionId, { active: wasActive });
    return true;
  },

  /**
   * Toggle the mirrored state of the current climb
   * Updates both the current climb and the queue item if present
   */
  mirrorCurrentClimb: async (_: unknown, { mirrored }: { mirrored: boolean }, ctx: ConnectionContext) => {
    const startTime = performance.now();
    await applyRateLimit(ctx);
    const sessionId = requireSession(ctx);

    const currentState = await roomManager.getQueueState(sessionId);
    let currentClimb = currentState.currentClimbQueueItem;
    let sequence = currentState.sequence;

    if (currentClimb) {
      // Update the mirrored state
      currentClimb = {
        ...currentClimb,
        climb: { ...currentClimb.climb, mirrored },
      };

      // Also update in queue if present
      const queue = currentState.queue.map((i) =>
        i.uuid === currentClimb!.uuid ? { ...i, climb: { ...i.climb, mirrored } } : i,
      );
      const picks = currentState.picks.map((pick) =>
        pick.item.uuid === currentClimb!.uuid
          ? { ...pick, item: currentClimb!, updatedAt: new Date().toISOString() }
          : pick,
      );

      const result = await roomManager.updateQueueState(sessionId, queue, currentClimb, undefined, {
        picks,
        activeClimberUserId: currentState.activeClimberUserId,
      });
      sequence = result.sequence;
    }

    pubsub.publishQueueEvent(sessionId, {
      __typename: 'ClimbMirrored',
      sequence,
      mirrored,
    });

    logMutationMetrics('mirrorCurrentClimb', performance.now() - startTime, sessionId);
    return currentClimb;
  },

  /**
   * Replace a queue item with a new item
   * Also updates current climb if it was the replaced item
   */
  replaceQueueItem: async (
    _: unknown,
    { uuid, item }: { uuid: string; item: ClimbQueueItem },
    ctx: ConnectionContext,
  ) => {
    const startTime = performance.now();
    await applyRateLimit(ctx);
    const sessionId = requireSession(ctx);

    // Validate input
    validateInput(QueueItemIdSchema, uuid, 'uuid');
    validateInput(ClimbQueueItemSchema, item, 'item');

    const currentState = await roomManager.getQueueState(sessionId);
    const queue = currentState.queue.map((i) => (i.uuid === uuid ? item : i));
    const picks = currentState.picks.map((pick) =>
      pick.item.uuid === uuid ? { ...pick, item, updatedAt: new Date().toISOString() } : pick,
    );
    let currentClimb = currentState.currentClimbQueueItem;

    // Update current climb if it was the replaced item
    if (currentClimb?.uuid === uuid) {
      currentClimb = item;
    }

    const { sequence, stateHash } = await roomManager.updateQueueState(sessionId, queue, currentClimb, undefined, {
      picks,
      activeClimberUserId: currentState.activeClimberUserId,
    });

    // Publish as FullSync since replace is less common
    pubsub.publishQueueEvent(sessionId, {
      __typename: 'FullSync',
      sequence,
      state: {
        sequence,
        stateHash,
        queue,
        currentClimbQueueItem: currentClimb,
        picks,
        activeClimberUserId: currentState.activeClimberUserId,
      },
    });

    logMutationMetrics('replaceQueueItem', performance.now() - startTime, sessionId);
    return item;
  },

  /**
   * Bulk replace the entire queue and current climb
   * Used for synchronizing from external sources
   */
  setQueue: async (
    _: unknown,
    { queue, currentClimbQueueItem }: { queue: ClimbQueueItem[]; currentClimbQueueItem?: ClimbQueueItem },
    ctx: ConnectionContext,
  ) => {
    const startTime = performance.now();
    await applyRateLimit(ctx, 30); // Lower limit for bulk operations
    const sessionId = requireSession(ctx);

    // Validate queue size to prevent memory exhaustion
    validateInput(QueueArraySchema, queue, 'queue');
    if (currentClimbQueueItem) {
      validateInput(ClimbQueueItemSchema, currentClimbQueueItem, 'currentClimbQueueItem');
    }

    const currentState = await roomManager.getQueueState(sessionId);
    const { sequence, stateHash } = await roomManager.updateQueueState(
      sessionId,
      queue,
      currentClimbQueueItem || null,
      currentState.version,
      {
        picks: currentState.picks,
        activeClimberUserId: currentState.activeClimberUserId,
      },
    );

    const state: QueueState = {
      sequence,
      stateHash,
      queue,
      currentClimbQueueItem: currentClimbQueueItem || null,
      picks: currentState.picks,
      activeClimberUserId: currentState.activeClimberUserId,
    };

    pubsub.publishQueueEvent(sessionId, {
      __typename: 'FullSync',
      sequence,
      state,
    });

    logMutationMetrics('setQueue', performance.now() - startTime, sessionId, {
      queueSize: queue.length,
    });
    return state;
  },
};
