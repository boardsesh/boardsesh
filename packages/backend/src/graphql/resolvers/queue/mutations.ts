import type { ConnectionContext, ClimbQueueItem, QueueState } from '@boardsesh/shared-schema';
import { roomManager } from '../../../services/room-manager';
import { pubsub } from '../../../pubsub/index';
import { setCurrentClimbAndPublish } from '../../../services/queue-navigation';
import {
  requireSessionWithReconnectGrace,
  applyRateLimit,
  validateInput,
  parseArrayTolerant,
  RATE_LIMIT_SESSION,
  RATE_LIMIT_SESSION_OP,
  RATE_LIMIT_PLAYBACK,
  RATE_LIMIT_PLAYBACK_OP,
  RATE_LIMIT_SET_QUEUE,
  RATE_LIMIT_SET_QUEUE_OP,
} from '../shared/helpers';
import {
  ClimbQueueItemSchema,
  PlaybackStateInputSchema,
  QueueIndexSchema,
  QueueItemIdSchema,
} from '../../../validation/schemas';
import { withQueueVersionRetry } from '../shared/queue-retry';
import { logMutationMetrics } from './mutation-metrics';
import { logger } from '../../../utils/logger';

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
    await applyRateLimit(ctx, RATE_LIMIT_SESSION, RATE_LIMIT_SESSION_OP);
    const sessionId = await requireSessionWithReconnectGrace(ctx);

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
    let resultStateHashOrdered = '';

    await withQueueVersionRetry('addQueueItem', sessionId, async (currentState) => {
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
        itemWasAdded = false;
        return;
      }

      if (position !== undefined && position >= 0 && position <= queue.length) {
        queue = [...queue.slice(0, position), item, ...queue.slice(position)];
      } else {
        queue = [...queue, item];
      }

      // Use updateQueueOnly with version check to avoid race conditions
      const result = await roomManager.updateQueueOnly(sessionId, queue, currentState.version, currentState);
      itemWasAdded = true;
      resultSequence = result.sequence;
      resultStateHash = result.stateHash;
      resultStateHashOrdered = result.stateHashOrdered;
    });

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
        stateHashOrdered: resultStateHashOrdered,
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
    await applyRateLimit(ctx, RATE_LIMIT_SESSION, RATE_LIMIT_SESSION_OP);
    const sessionId = await requireSessionWithReconnectGrace(ctx);

    // Validate input
    validateInput(QueueItemIdSchema, uuid, 'uuid');

    const { sequence, stateHash, stateHashOrdered } = await withQueueVersionRetry(
      'removeQueueItem',
      sessionId,
      async (currentState) => {
        const queue = currentState.queue.filter((i) => i.uuid !== uuid);
        let currentClimb = currentState.currentClimbQueueItem;

        // Clear current climb if it was removed
        if (currentClimb?.uuid === uuid) {
          currentClimb = null;
        }

        return roomManager.updateQueueState(sessionId, queue, currentClimb, currentState.version);
      },
    );

    pubsub.publishQueueEvent(sessionId, {
      __typename: 'QueueItemRemoved',
      sequence,
      stateHash,
      stateHashOrdered,
      uuid,
      // Same coercion as setCurrentClimb/publishPlaybackState: an empty-string connectionId must
      // become null, because peers compare defensively and two anonymous clients would otherwise
      // echo-suppress each other's removes.
      clientId: ctx.connectionId || null,
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
    await applyRateLimit(ctx, RATE_LIMIT_SESSION, RATE_LIMIT_SESSION_OP);
    const sessionId = await requireSessionWithReconnectGrace(ctx);

    // Validate inputs
    validateInput(QueueItemIdSchema, uuid, 'uuid');
    validateInput(QueueIndexSchema, oldIndex, 'oldIndex');
    validateInput(QueueIndexSchema, newIndex, 'newIndex');

    let resultSequence = 0;
    let resultStateHash = '';
    let resultStateHashOrdered = '';

    await withQueueVersionRetry('reorderQueueItem', sessionId, async (currentState) => {
      const queue = [...currentState.queue];

      // `QueueIndexSchema` already rejected negatives above, so an in-range
      // upper bound is all that's left to check — and once it holds, the
      // reorder always writes. There is deliberately no "compute, maybe skip"
      // branch here: pre-seeding the result locals from `currentState` would
      // let a skipped write publish the pre-write sequence.
      if (oldIndex >= queue.length || newIndex >= queue.length) {
        throw new Error(`Invalid index: queue has ${queue.length} items`);
      }

      const [movedItem] = queue.splice(oldIndex, 1);
      queue.splice(newIndex, 0, movedItem);
      // Use updateQueueOnly to avoid overwriting currentClimbQueueItem
      const result = await roomManager.updateQueueOnly(sessionId, queue, currentState.version, currentState);
      resultSequence = result.sequence;
      resultStateHash = result.stateHash;
      resultStateHashOrdered = result.stateHashOrdered;
    });

    pubsub.publishQueueEvent(sessionId, {
      __typename: 'QueueReordered',
      sequence: resultSequence,
      stateHash: resultStateHash,
      // The v1 stateHash is unchanged by a reorder (sorted UUIDs); the ordered
      // v2 hash is what actually moves — this is the drift the watchdog now sees.
      stateHashOrdered: resultStateHashOrdered,
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
    await applyRateLimit(ctx, RATE_LIMIT_SESSION, RATE_LIMIT_SESSION_OP);
    const sessionId = await requireSessionWithReconnectGrace(ctx);

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

    await setCurrentClimbAndPublish(
      sessionId,
      item,
      !!shouldAddToQueue,
      roomManager,
      pubsub,
      ctx.connectionId || null,
      correlationId || null,
    );

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
    await applyRateLimit(ctx, RATE_LIMIT_SESSION, RATE_LIMIT_SESSION_OP);
    const sessionId = await requireSessionWithReconnectGrace(ctx);

    const mirrorResult = await withQueueVersionRetry('mirrorCurrentClimb', sessionId, async (currentState) => {
      // No current climb means there's nothing to mirror. Don't publish a
      // no-op ClimbMirrored event — it clutters logs, occupies bus
      // bandwidth, and (because sequence/stateHash don't advance) is fragile
      // under co-sequencing with FullSync replay.
      if (!currentState.currentClimbQueueItem) {
        return null;
      }

      // Update the mirrored state
      const currentClimb: ClimbQueueItem = {
        ...currentState.currentClimbQueueItem,
        climb: { ...currentState.currentClimbQueueItem.climb, mirrored },
      };

      // Also update in queue if present
      const queue = currentState.queue.map((i) =>
        i.uuid === currentClimb.uuid ? { ...i, climb: { ...i.climb, mirrored } } : i,
      );

      const updated = await roomManager.updateQueueState(sessionId, queue, currentClimb, currentState.version);
      return { currentClimb, ...updated };
    });

    if (!mirrorResult) {
      logMutationMetrics('mirrorCurrentClimb', performance.now() - startTime, sessionId);
      return null;
    }

    pubsub.publishQueueEvent(sessionId, {
      __typename: 'ClimbMirrored',
      sequence: mirrorResult.sequence,
      stateHash: mirrorResult.stateHash,
      stateHashOrdered: mirrorResult.stateHashOrdered,
      uuid: mirrorResult.currentClimb.uuid,
      mirrored,
    });

    logMutationMetrics('mirrorCurrentClimb', performance.now() - startTime, sessionId);
    return mirrorResult.currentClimb;
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
    await applyRateLimit(ctx, RATE_LIMIT_SESSION, RATE_LIMIT_SESSION_OP);
    const sessionId = await requireSessionWithReconnectGrace(ctx);

    // Validate input
    validateInput(QueueItemIdSchema, uuid, 'uuid');
    validateInput(ClimbQueueItemSchema, item, 'item');

    const { sequence, stateHash, stateHashOrdered, queue, currentClimb } = await withQueueVersionRetry(
      'replaceQueueItem',
      sessionId,
      async (currentState) => {
        const nextQueue = currentState.queue.map((i) => (i.uuid === uuid ? item : i));
        let nextCurrentClimb = currentState.currentClimbQueueItem;

        // Update current climb if it was the replaced item
        if (nextCurrentClimb?.uuid === uuid) {
          nextCurrentClimb = item;
        }

        const updated = await roomManager.updateQueueState(
          sessionId,
          nextQueue,
          nextCurrentClimb,
          currentState.version,
        );
        return { ...updated, queue: nextQueue, currentClimb: nextCurrentClimb };
      },
    );

    // Publish as FullSync since replace is less common
    pubsub.publishQueueEvent(sessionId, {
      __typename: 'FullSync',
      sequence,
      state: { sequence, stateHash, stateHashOrdered, queue, currentClimbQueueItem: currentClimb },
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
    {
      queue: rawQueue,
      currentClimbQueueItem: rawCurrentClimbQueueItem,
    }: { queue: ClimbQueueItem[]; currentClimbQueueItem?: ClimbQueueItem },
    ctx: ConnectionContext,
  ) => {
    const startTime = performance.now();
    await applyRateLimit(ctx, RATE_LIMIT_SET_QUEUE, RATE_LIMIT_SET_QUEUE_OP);
    const sessionId = await requireSessionWithReconnectGrace(ctx);

    // Validate queue size to prevent memory exhaustion, then validate each
    // item independently — one malformed/legacy item DROPS OUT instead of
    // rejecting the whole setQueue call. A single non-RFC-uuid queue item
    // used to reject the entire array here and wedge sync for a user's whole
    // queue indefinitely (issue #3857).
    const { items, droppedCount } = parseArrayTolerant(ClimbQueueItemSchema, rawQueue, 'queue', 500);
    // ClimbQueueItemSchema's `.nullish()` fields infer as `T | null | undefined`,
    // one shade looser than the hand-written `ClimbQueueItem` type (`T | null`) —
    // both mean "absent" downstream (JSON/Redis storage, reducer `===` checks),
    // so the cast is safe. Same shape `validateInput` callers elsewhere in this
    // file already return without capturing/typing the result at all.
    const queue = items as ClimbQueueItem[];
    if (droppedCount > 0) {
      // parseArrayTolerant already threw above if rawQueue weren't array-shaped,
      // so by this point .length is always meaningful.
      logger.warn(
        `[setQueue] Dropped ${droppedCount}/${rawQueue.length} invalid queue item(s) for session ${sessionId} instead of rejecting the whole queue.`,
      );
    }

    let currentClimbQueueItem: ClimbQueueItem | null = null;
    if (rawCurrentClimbQueueItem) {
      currentClimbQueueItem = validateInput(
        ClimbQueueItemSchema,
        rawCurrentClimbQueueItem,
        'currentClimbQueueItem',
      ) as ClimbQueueItem;
      // A current-climb pointer whose slot didn't survive tolerant parsing
      // (or was never in `queue` at all) would dangle — clients index into
      // `queue` by this uuid. Fall back to no current climb rather than ship
      // a reference to a slot that isn't there.
      if (!queue.some((item) => item.uuid === currentClimbQueueItem?.uuid)) {
        logger.warn(
          `[setQueue] currentClimbQueueItem uuid not present in the (post-filter) queue for session ${sessionId} — clearing current climb instead of leaving a dangling pointer.`,
        );
        currentClimbQueueItem = null;
      }
    }

    // updateQueueState returns the prior state hashes from the same Redis
    // read it already does internally, so this no-op check costs nothing
    // extra. It surfaces a genuinely redundant full-queue resync: a setQueue
    // whose incoming queue matched what the server already had in membership,
    // order, AND current climb — nothing changed, so the FullSync below was
    // pointless work. Look at the *caller* that re-pushed unchanged state, not
    // the state hash.
    //
    // We require BOTH hashes to match. Comparing only the order-insensitive v1
    // hash misreported a legitimate reorder (same members, different order) as
    // a no-op, because v1 is blind to reordering — the whole reason the
    // order-sensitive v2 hash exists. Web's queue-edit reorder pushes a full
    // setQueue (not the reorderQueueItem delta), so a v1-only check fired this
    // warning on every drag-to-reorder and blamed the publisher's hash for a
    // drift that wasn't there (issue #2387). v2 moves on a reorder, so gating
    // on both hashes lets a real reorder through silently while still catching
    // a true no-op.
    //
    // Deliberately NOT wrapped in withQueueVersionRetry, and deliberately
    // passes no `expectedVersion` (issue #3906). Every other mutation derives
    // its new queue from the current one, so a concurrent write has to be
    // detected and recomputed against. setQueue's payload is entirely
    // client-supplied — there is nothing to recompute, and replacing server
    // state wholesale is the mutation's contract. All it needs is a sequence
    // number nobody else is using, which the CAS now allocates atomically.
    // Known consequence: a peer's addQueueItem landing inside this window is
    // still overwritten. That is inherent to a full-state push (and web's
    // drag-to-reorder takes this path), tracked separately rather than papered
    // over here.
    const { sequence, stateHash, stateHashOrdered, previousStateHash, previousStateHashOrdered } =
      await roomManager.updateQueueState(sessionId, queue, currentClimbQueueItem);

    if (
      previousStateHash !== null &&
      previousStateHash === stateHash &&
      previousStateHashOrdered !== null &&
      previousStateHashOrdered === stateHashOrdered
    ) {
      logger.warn(
        `[setQueue] Redundant full-queue resync for session ${sessionId} (hash=${stateHash}, queueSize=${queue.length}). Incoming queue matched server state in membership, order, and current climb — a wasted setQueue; check the caller re-pushing unchanged state.`,
      );
    }

    const state: QueueState = {
      sequence,
      stateHash,
      stateHashOrdered,
      queue,
      currentClimbQueueItem,
    };

    pubsub.publishQueueEvent(sessionId, {
      __typename: 'FullSync',
      sequence,
      state,
    });

    logMutationMetrics('setQueue', performance.now() - startTime, sessionId, {
      queueSize: queue.length,
      droppedCount,
    });
    return state;
  },

  /**
   * Broadcast the current playback state for a variable-speed climb so other
   * party members converge to the same frame/playing/speed without round
   * trips. The server stamps `anchorTimestamp` so peers can extrapolate
   * elapsed frames. Echo-suppressed by `clientId` on receipt.
   *
   * Playback events are intentionally not buffered for delta replay (skipped
   * in `publishQueueEvent`, `pubsub/index.ts`) — they're superseded by the
   * next broadcast and have no value when a peer reconnects mid-playback.
   * Sequence numbers are taken from the room manager's monotonic counter for
   * ordering consistency with other queue events, but are reused rather than
   * incremented, so they are non-monotonic/duplicate across playback events —
   * another reason they must never enter the replay buffer.
   */
  publishPlaybackState: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    await applyRateLimit(ctx, RATE_LIMIT_PLAYBACK, RATE_LIMIT_PLAYBACK_OP);
    const sessionId = await requireSessionWithReconnectGrace(ctx);
    const validatedInput = validateInput(PlaybackStateInputSchema, input, 'input');

    const currentState = await roomManager.getQueueState(sessionId);

    pubsub.publishQueueEvent(sessionId, {
      __typename: 'PlaybackStateChanged',
      sequence: currentState.sequence,
      climbUuid: validatedInput.climbUuid,
      frameIndex: validatedInput.frameIndex,
      isPlaying: validatedInput.isPlaying,
      speed: validatedInput.speed,
      paceMs: validatedInput.paceMs,
      anchorTimestamp: String(Date.now()),
      // Prefer the publisher-supplied client identifier (the playback engine's
      // stable id) so echo suppression on the publisher's own clients works
      // even when a single WebSocket connection drives multiple engines. Fall
      // back to the connection id when the client doesn't send one. Coerce
      // empty strings (from contexts with no connectionId yet) to null —
      // peers compare to null defensively and would otherwise echo-suppress
      // each other's events.
      clientId: validatedInput.clientId || ctx.connectionId || null,
    });

    return true;
  },
};
