import { GraphQLError } from 'graphql';
import { eq } from 'drizzle-orm';
import type { ConnectionContext, ClimbQueueItem, QueueState } from '@boardsesh/shared-schema';
import { boardSessions } from '@boardsesh/db/schema/app';
import { roomManager, VersionConflictError } from '../../../services/room-manager';
import { pubsub } from '../../../pubsub/index';
import { setCurrentClimbAndPublish } from '../../../services/queue-navigation';
import { db } from '../../../db/client';
import { requireSession, applyRateLimit, validateInput, MAX_RETRIES } from '../shared/helpers';
import {
  ClimbQueueItemSchema,
  QueueIndexSchema,
  QueueItemIdSchema,
  QueueArraySchema,
} from '../../../validation/schemas';
import { logMutationMetrics } from './mutation-metrics';
import { logger } from '../../../utils/logger';

/**
 * Reject a queue mutation when the session's shared-playlist mode is off.
 *
 * The new default for sessions is `shared_playlist_enabled = false`. In that
 * mode the queue is local per-user; server-side mutations are not allowed.
 * Returning a typed error lets the client adapter fall back to writing to
 * IndexedDB without surfacing a generic error to the user.
 *
 * Cached as a single `SELECT` per call — adds ~1ms to every queue mutation,
 * acceptable for the safety guarantee.
 */
async function assertSharedPlaylistEnabled(sessionId: string): Promise<void> {
  const rows = await db
    .select({ sharedPlaylistEnabled: boardSessions.sharedPlaylistEnabled })
    .from(boardSessions)
    .where(eq(boardSessions.id, sessionId))
    .limit(1);
  const row = rows[0];
  // No row → session was never created via createSession (legacy / in-memory
  // only). We allow the mutation through; the downstream insert will fail
  // cleanly if persistence is required. This matches the existing behaviour
  // before this gate was added.
  if (!row) return;
  if (!row.sharedPlaylistEnabled) {
    throw new GraphQLError('Shared playlist is disabled for this session', {
      extensions: { code: 'SHARED_PLAYLIST_DISABLED' } as const,
    });
  }
}

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
    await assertSharedPlaylistEnabled(sessionId);

    // Validate input
    validateInput(ClimbQueueItemSchema, item, 'item');
    if (position !== undefined) {
      validateInput(QueueIndexSchema, position, 'position');
    }

    if (DEBUG)
      logger.info(
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
    let resultStateHash = '';

    // Retry loop for optimistic locking
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // Get current state and update
      const currentState = await roomManager.getQueueState(sessionId);
      if (DEBUG)
        logger.info(
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
        if (DEBUG) logger.info('[addQueueItem] Item already in queue, skipping');
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
        resultStateHash = result.stateHash;
        break; // Success, exit retry loop
      } catch (error) {
        if (error instanceof VersionConflictError && attempt < MAX_RETRIES - 1) {
          if (DEBUG) logger.info(`[addQueueItem] Version conflict, retrying (attempt ${attempt + 1}/${MAX_RETRIES})`);
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
        stateHash: resultStateHash,
        item: item,
        position: actualPosition,
      });
    }

    logMutationMetrics('addQueueItem', performance.now() - startTime, sessionId, {
      queueSize: originalQueueLength,
    });
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
    await assertSharedPlaylistEnabled(sessionId);

    // Validate input
    validateInput(QueueItemIdSchema, uuid, 'uuid');

    const currentState = await roomManager.getQueueState(sessionId);
    const queue = currentState.queue.filter((i) => i.uuid !== uuid);
    let currentClimb = currentState.currentClimbQueueItem;

    // Clear current climb if it was removed
    if (currentClimb?.uuid === uuid) {
      currentClimb = null;
    }

    const { sequence, stateHash } = await roomManager.updateQueueState(sessionId, queue, currentClimb);

    pubsub.publishQueueEvent(sessionId, {
      __typename: 'QueueItemRemoved',
      sequence,
      stateHash,
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
    await assertSharedPlaylistEnabled(sessionId);

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
    let resultStateHash = currentState.stateHash;

    if (oldIndex >= 0 && oldIndex < queue.length && newIndex >= 0 && newIndex < queue.length) {
      const [movedItem] = queue.splice(oldIndex, 1);
      queue.splice(newIndex, 0, movedItem);
      // Use updateQueueOnly to avoid overwriting currentClimbQueueItem
      const result = await roomManager.updateQueueOnly(sessionId, queue);
      resultSequence = result.sequence;
      resultStateHash = result.stateHash;
    }

    pubsub.publishQueueEvent(sessionId, {
      __typename: 'QueueReordered',
      sequence: resultSequence,
      stateHash: resultStateHash,
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
    await assertSharedPlaylistEnabled(sessionId);

    // Validate input
    if (item !== null) {
      validateInput(ClimbQueueItemSchema, item, 'item');
    }

    // Debug: track who's setting null
    if (DEBUG) {
      if (item === null) {
        logger.info(
          '[setCurrentClimb] Setting current climb to NULL by client:',
          ctx.connectionId,
          'session:',
          sessionId,
        );
      } else {
        logger.info(
          '[setCurrentClimb] Setting current climb to:',
          item.climb?.name,
          'by client:',
          ctx.connectionId,
          'correlationId:',
          correlationId,
        );
      }
    }

    if (item === null) {
      // Null-item path: clear current climb without queue changes. Retains the
      // pre-extract behaviour (the shared helper assumes a non-null item).
      let sequence = 0;
      let stateHash = '';
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const currentState = await roomManager.getQueueState(sessionId);
        try {
          const result = await roomManager.updateQueueState(sessionId, currentState.queue, null, currentState.version);
          sequence = result.sequence;
          stateHash = result.stateHash;
          break;
        } catch (error) {
          if (error instanceof VersionConflictError && attempt < MAX_RETRIES - 1) {
            if (DEBUG)
              logger.info(
                `[setCurrentClimb] Version conflict (null), retrying (attempt ${attempt + 1}/${MAX_RETRIES})`,
              );
            continue;
          }
          throw error;
        }
      }
      pubsub.publishQueueEvent(sessionId, {
        __typename: 'CurrentClimbChanged',
        sequence,
        stateHash,
        item: null,
        clientId: ctx.connectionId || null,
        correlationId: correlationId || null,
      });
    } else {
      await setCurrentClimbAndPublish(
        sessionId,
        item,
        !!shouldAddToQueue,
        roomManager,
        pubsub,
        ctx.connectionId || null,
        correlationId || null,
      );
    }

    logMutationMetrics('setCurrentClimb', performance.now() - startTime, sessionId, {
      shouldAddToQueue: !!shouldAddToQueue,
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
    await assertSharedPlaylistEnabled(sessionId);

    const currentState = await roomManager.getQueueState(sessionId);
    let currentClimb = currentState.currentClimbQueueItem;

    // No current climb means there's nothing to mirror. Don't publish a
    // no-op ClimbMirrored event — it clutters logs, occupies bus
    // bandwidth, and (because sequence/stateHash don't advance) is fragile
    // under co-sequencing with FullSync replay.
    if (!currentClimb) {
      logMutationMetrics('mirrorCurrentClimb', performance.now() - startTime, sessionId);
      return null;
    }

    // Update the mirrored state
    currentClimb = {
      ...currentClimb,
      climb: { ...currentClimb.climb, mirrored },
    };

    // Also update in queue if present
    const queue = currentState.queue.map((i) =>
      i.uuid === currentClimb!.uuid ? { ...i, climb: { ...i.climb, mirrored } } : i,
    );

    const { sequence, stateHash } = await roomManager.updateQueueState(sessionId, queue, currentClimb);

    pubsub.publishQueueEvent(sessionId, {
      __typename: 'ClimbMirrored',
      sequence,
      stateHash,
      uuid: currentClimb.uuid,
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
    await assertSharedPlaylistEnabled(sessionId);

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
    await assertSharedPlaylistEnabled(sessionId);

    // Validate queue size to prevent memory exhaustion
    validateInput(QueueArraySchema, queue, 'queue');
    if (currentClimbQueueItem) {
      validateInput(ClimbQueueItemSchema, currentClimbQueueItem, 'currentClimbQueueItem');
    }

    // updateQueueState returns `previousStateHash` from the same Redis
    // read it already does internally, so this no-op check costs nothing
    // extra. The client's 60s state-hash watchdog (see
    // packages/web/app/components/persistent-session/hooks/use-session-subscriptions.ts)
    // triggers setQueue when it thinks local and server state have
    // diverged. If the resulting hash matches what the server already
    // had, the client was wrong about the drift — usually a bug in the
    // local hash computation or event processor — and the loop will fire
    // again next minute. The warn surfaces those loops.
    const { sequence, stateHash, previousStateHash } = await roomManager.updateQueueState(
      sessionId,
      queue,
      currentClimbQueueItem || null,
    );

    if (previousStateHash !== null && previousStateHash === stateHash) {
      logger.warn(
        `[setQueue] No-op resync for session ${sessionId} (hash=${stateHash}, queueSize=${queue.length}). Client state already matched server — investigate hash-drift on the publisher.`,
      );
    }

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
