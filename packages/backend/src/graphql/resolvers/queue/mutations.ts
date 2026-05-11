import type { ConnectionContext, ClimbQueueItem, QueueState } from '@boardsesh/shared-schema';
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
import { resolveContextAttribution, trackServer } from '../../../analytics/server-analytics';

// Debug logging flag - only log in development
const DEBUG = process.env.NODE_ENV === 'development';

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
      if (queue.some((i) => i.uuid === item.uuid)) {
        // Item already in queue - return without publishing event
        if (DEBUG) console.info('[addQueueItem] Item already in queue, skipping');
        return item;
      }

      if (position !== undefined && position >= 0 && position <= queue.length) {
        queue = [...queue.slice(0, position), item, ...queue.slice(position)];
      } else {
        queue = [...queue, item];
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
        item: item,
        position: actualPosition,
      });
    }

    logMutationMetrics('addQueueItem', performance.now() - startTime, sessionId, {
      queueSize: originalQueueLength,
    });

    if (itemWasAdded) {
      const attribution = resolveContextAttribution(ctx);
      trackServer('Queue Item Added', {
        distinctId: attribution.distinctId,
        properties: {
          sessionId,
          climbUuid: item.climb?.uuid ?? null,
          queueSizeBefore: originalQueueLength,
          positionExplicit: position !== undefined,
        },
      });
    }

    return item;
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

    const attribution = resolveContextAttribution(ctx);
    trackServer('Current Climb Set', {
      distinctId: attribution.distinctId,
      properties: {
        sessionId,
        climbUuid: item?.climb?.uuid ?? null,
        cleared: item === null,
        shouldAddToQueue: !!shouldAddToQueue,
      },
    });

    return item;
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

      const result = await roomManager.updateQueueState(sessionId, queue, currentClimb);
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
    let currentClimb = currentState.currentClimbQueueItem;

    // Update current climb if it was the replaced item
    if (currentClimb?.uuid === uuid) {
      currentClimb = item;
    }

    const { sequence, stateHash } = await roomManager.updateQueueState(sessionId, queue, currentClimb);

    // Publish as FullSync since replace is less common
    pubsub.publishQueueEvent(sessionId, {
      __typename: 'FullSync',
      sequence,
      state: { sequence, stateHash, queue, currentClimbQueueItem: currentClimb },
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

    const { sequence, stateHash } = await roomManager.updateQueueState(sessionId, queue, currentClimbQueueItem || null);

    const state: QueueState = {
      sequence,
      stateHash,
      queue,
      currentClimbQueueItem: currentClimbQueueItem || null,
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
