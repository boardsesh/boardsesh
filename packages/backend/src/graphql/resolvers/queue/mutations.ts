import type { ConnectionContext, ClimbQueueItem } from '@boardsesh/shared-schema';
import { GraphQLError } from 'graphql';
import {
  MAX_SYNCED_QUEUE_ITEMS,
  QUEUE_FULL,
  capHistory,
  clampInsertPosition,
  isUpNextFull,
  lineAfterDelta,
  normaliseOrphanCurrent,
  reorderAcrossLine,
  type CurrentClimbPlacement,
  type NowSlotState,
} from '@boardsesh/queue';
import { roomManager, VersionConflictError } from '../../../services/room-manager';
import { pubsub } from '../../../pubsub/index';
import { mirrorSessionClimb } from '../../../services/queue-mirror';
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
import { collectConcurrentAdds } from './set-queue-merge';
import { logMutationMetrics } from './mutation-metrics';
import { logger } from '../../../utils/logger';
import { isNowSlotSession } from '../../../services/queue-now-slot-rollout';
import { publishFullSync } from '../../../services/queue-now-slot-events';
import type { QueueWriteResult } from '../../../services/room-manager/types';
import {
  composeQueuePayload,
  maxPayloadItems,
  payloadNeedsStoredLine,
  type ComposedQueuePayload,
} from './now-slot-payload';

// Debug logging flag - only log in development
const DEBUG = process.env.NODE_ENV === 'development';

export const queueMutations = {
  /**
   * Add a climb to the queue at the specified position
   * Uses optimistic locking to prevent race conditions
   *
   * F3 (docs/current-climb-outside-queue.md, sections 1 and 5): the stored
   * line moves by `lineAfterDelta` at every percent. Inside
   * `QUEUE_NOW_SLOT_PERCENT` a position inside History with nothing current is
   * clamped to the head of Up next, a full Up next is refused with
   * `QUEUE_FULL`, and History is capped. An add that clamps, trims or
   * normalises a stored orphan is two writes: write 1 stores the add and
   * publishes `QueueItemAdded` (so the #3933 merge sees it), write 2 stores the
   * corrected array and publishes a `FullSync` under the next sequence.
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

    const nowSlotRules = isNowSlotSession(sessionId);
    // Track the original queue length for the metrics
    let originalQueueLength = 0;
    let addition: {
      write: QueueWriteResult;
      position: number;
      state: { queue: ClimbQueueItem[]; currentClimbQueueItem: ClimbQueueItem | null; historyCount: number };
      clamped: boolean;
      orphanNormalised: boolean;
    } | null;

    try {
      addition = await withQueueVersionRetry('addQueueItem', sessionId, async (currentState) => {
        if (DEBUG)
          logger.info(
            '[addQueueItem] Current state - queue size:',
            currentState.queue.length,
            'version:',
            currentState.version,
          );
        originalQueueLength = currentState.queue.length;

        // Only add if not already in queue
        if (currentState.queue.some((i) => i.uuid === item.uuid)) {
          // Item already in queue - return without publishing event
          if (DEBUG) logger.info('[addQueueItem] Item already in queue, skipping');
          return null;
        }

        if (nowSlotRules && isUpNextFull(normaliseOrphanCurrent(currentState), 1)) {
          throw new GraphQLError(`Up next is full (${MAX_SYNCED_QUEUE_ITEMS})`, {
            extensions: { code: QUEUE_FULL },
          });
        }

        // A shipped client's position indexes its own array, which never holds
        // a stored orphan, so the add is placed on the stored array and the
        // orphan (a room written before F3) is normalised after it.
        const { index, clamped } = nowSlotRules
          ? clampInsertPosition(currentState, position)
          : {
              index:
                position !== undefined && position >= 0 && position <= currentState.queue.length
                  ? position
                  : currentState.queue.length,
              clamped: false,
            };
        const historyCount = lineAfterDelta(currentState, { kind: 'add', index });
        const queueWithAdd = [...currentState.queue.slice(0, index), item, ...currentState.queue.slice(index)];
        const normalised = normaliseOrphanCurrent({
          queue: queueWithAdd,
          currentClimbQueueItem: currentState.currentClimbQueueItem,
          historyCount,
        });

        // Use updateQueueOnly with version check to avoid race conditions
        const write = await roomManager.updateQueueOnly(
          sessionId,
          normalised.queue,
          currentState.version,
          { currentClimbQueueItem: normalised.currentClimbQueueItem },
          normalised.historyCount,
        );
        return {
          write,
          position: normalised.queue.findIndex((queueItem) => queueItem.uuid === item.uuid),
          state: normalised,
          clamped,
          orphanNormalised: normalised.normalised,
        };
      });
    } catch (error) {
      if (error instanceof GraphQLError && error.extensions.code === QUEUE_FULL) {
        logMutationMetrics('addQueueItem', performance.now() - startTime, sessionId, {
          queueSize: originalQueueLength,
          nowSlotRules,
          queueFull: true,
        });
      }
      throw error;
    }

    let trimmedCount = 0;
    if (addition) {
      // Broadcast to subscribers with the actual position
      pubsub.publishQueueEvent(sessionId, {
        __typename: 'QueueItemAdded',
        sequence: addition.write.sequence,
        stateHash: addition.write.stateHash,
        stateHashOrdered: addition.write.stateHashOrdered,
        item: item,
        position: addition.position,
        // Same coercion as removeQueueItem/setCurrentClimb: an empty-string connectionId must
        // become null, because peers compare defensively and two anonymous clients would otherwise
        // echo-suppress each other's adds.
        clientId: ctx.connectionId || null,
      });

      const capped = nowSlotRules ? capHistory(addition.state, 0) : { ...addition.state, trimmedCount: 0 };
      if (addition.clamped || addition.orphanNormalised || capped.trimmedCount > 0) {
        try {
          const followUp = await roomManager.updateQueueState(
            sessionId,
            capped.queue,
            capped.currentClimbQueueItem,
            addition.write.version,
            capped.historyCount,
          );
          trimmedCount = capped.trimmedCount;
          publishFullSync(pubsub, sessionId, followUp, capped.queue, capped.currentClimbQueueItem);
        } catch (error) {
          // A crewmate's write landed in between and published its own event.
          // The array stays untrimmed until the next write trims it.
          if (!(error instanceof VersionConflictError)) throw error;
          logger.info(`[addQueueItem] Follow-up FullSync for session ${sessionId} lost its version; skipped`);
        }
      }
    }

    logMutationMetrics('addQueueItem', performance.now() - startTime, sessionId, {
      queueSize: originalQueueLength,
      nowSlotRules,
      clamped: addition?.clamped ?? false,
      trimmed: trimmedCount,
      queueFull: false,
    });
    return item;
  },

  /**
   * Remove a climb from the queue by UUID
   * Also clears current climb if it was removed
   *
   * F3: removing the current climb leaves the line at its index, and removing
   * a History entry with nothing current moves the line down one
   * (`lineAfterDelta`), so History stays History. A stored orphan is
   * normalised by this write, which then publishes a `FullSync`.
   */
  removeQueueItem: async (_: unknown, { uuid }: { uuid: string }, ctx: ConnectionContext) => {
    const startTime = performance.now();
    await applyRateLimit(ctx, RATE_LIMIT_SESSION, RATE_LIMIT_SESSION_OP);
    const sessionId = await requireSessionWithReconnectGrace(ctx);

    // Validate input
    validateInput(QueueItemIdSchema, uuid, 'uuid');

    const { write, state, orphanNormalised } = await withQueueVersionRetry(
      'removeQueueItem',
      sessionId,
      async (currentState) => {
        const historyCount = lineAfterDelta(currentState, { kind: 'remove', uuid });
        const queue = currentState.queue.filter((i) => i.uuid !== uuid);
        let currentClimb = currentState.currentClimbQueueItem;

        // Clear current climb if it was removed
        if (currentClimb?.uuid === uuid) {
          currentClimb = null;
        }

        const normalised = normaliseOrphanCurrent({ queue, currentClimbQueueItem: currentClimb, historyCount });
        const updated = await roomManager.updateQueueState(
          sessionId,
          normalised.queue,
          normalised.currentClimbQueueItem,
          currentState.version,
          normalised.historyCount,
        );
        return { write: updated, state: normalised, orphanNormalised: normalised.normalised };
      },
    );

    if (orphanNormalised) {
      publishFullSync(pubsub, sessionId, write, state.queue, state.currentClimbQueueItem);
    } else {
      pubsub.publishQueueEvent(sessionId, {
        __typename: 'QueueItemRemoved',
        sequence: write.sequence,
        stateHash: write.stateHash,
        stateHashOrdered: write.stateHashOrdered,
        uuid,
        // Same coercion as setCurrentClimb/publishPlaybackState: an empty-string connectionId must
        // become null, because peers compare defensively and two anonymous clients would otherwise
        // echo-suppress each other's removes.
        clientId: ctx.connectionId || null,
      });
    }

    logMutationMetrics('removeQueueItem', performance.now() - startTime, sessionId);
    return true;
  },

  /**
   * Reorder a queue item by moving it from oldIndex to newIndex
   *
   * F3: the line moves by `lineAfterDelta` at every percent. Inside
   * `QUEUE_NOW_SLOT_PERCENT`, with nothing current, an Up next entry dragged
   * above the line is clamped to the head of Up next (`reorderAcrossLine`): a
   * shipped phone sees one flat Up next list there, so this keeps its intent
   * instead of filing the climb under History. A clamped reorder, or one that
   * normalised a stored orphan, publishes a `FullSync`.
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

    const nowSlotRules = isNowSlotSession(sessionId);

    const { write, state, clamped, orphanNormalised } = await withQueueVersionRetry(
      'reorderQueueItem',
      sessionId,
      async (currentState) => {
        // `QueueIndexSchema` already rejected negatives above, so an in-range
        // upper bound is all that's left to check — and once it holds, the
        // reorder always writes. There is deliberately no "compute, maybe skip"
        // branch here: pre-seeding the result locals from `currentState` would
        // let a skipped write publish the pre-write sequence.
        if (oldIndex >= currentState.queue.length || newIndex >= currentState.queue.length) {
          throw new Error(`Invalid index: queue has ${currentState.queue.length} items`);
        }

        let queue: ClimbQueueItem[];
        let historyCount: number;
        let clamped = false;
        const acrossLine = nowSlotRules ? reorderAcrossLine(currentState, oldIndex, newIndex) : null;
        if (acrossLine) {
          queue = acrossLine.queue;
          historyCount = acrossLine.historyCount;
          clamped = acrossLine.clamped;
        } else {
          queue = [...currentState.queue];
          const [movedItem] = queue.splice(oldIndex, 1);
          queue.splice(newIndex, 0, movedItem);
          historyCount = lineAfterDelta(currentState, { kind: 'reorder', oldIndex, newIndex });
        }

        const normalised = normaliseOrphanCurrent({
          queue,
          currentClimbQueueItem: currentState.currentClimbQueueItem,
          historyCount,
        });
        // Use updateQueueOnly to avoid overwriting currentClimbQueueItem
        const updated = await roomManager.updateQueueOnly(
          sessionId,
          normalised.queue,
          currentState.version,
          { currentClimbQueueItem: normalised.currentClimbQueueItem },
          normalised.historyCount,
        );
        return { write: updated, state: normalised, clamped, orphanNormalised: normalised.normalised };
      },
    );

    if (clamped || orphanNormalised) {
      publishFullSync(pubsub, sessionId, write, state.queue, state.currentClimbQueueItem);
    } else {
      pubsub.publishQueueEvent(sessionId, {
        __typename: 'QueueReordered',
        sequence: write.sequence,
        stateHash: write.stateHash,
        // The v1 stateHash is unchanged by a reorder (sorted UUIDs); the ordered
        // v2 hash is what actually moves — this is the drift the watchdog now sees.
        stateHashOrdered: write.stateHashOrdered,
        uuid,
        oldIndex,
        newIndex,
      });
    }

    logMutationMetrics('reorderQueueItem', performance.now() - startTime, sessionId, {
      nowSlotRules,
      clamped,
      orphanNormalised,
    });
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
      placement,
    }: {
      item: ClimbQueueItem | null;
      shouldAddToQueue?: boolean | null;
      correlationId?: string;
      placement?: CurrentClimbPlacement | null;
    },
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

    // `shouldAddToQueue` is passed through with all three values: only an
    // explicit `false` (a shipped Next) can read as `next-from-line`, and an
    // absent one is the native socket (F3, section 1).
    const outcome = await setCurrentClimbAndPublish(
      sessionId,
      item,
      shouldAddToQueue,
      roomManager,
      pubsub,
      ctx.connectionId || null,
      correlationId || null,
      placement ?? null,
    );

    logMutationMetrics('setCurrentClimb', performance.now() - startTime, sessionId, {
      shouldAddToQueue: !!shouldAddToQueue,
      placement: placement ? 'explicit' : 'absent',
      rewrite: outcome.rewrite,
      event: outcome.event,
      trimmed: outcome.trimmedCount,
      nowSlotRules: outcome.nowSlotRules,
    });
    return item;
  },

  /**
   * Toggle the mirrored state of the current climb
   * Updates both the current climb and the queue item if present
   */
  mirrorCurrentClimb: async (
    _: unknown,
    { mirrored, expectedQueueItemUuid }: { mirrored: boolean; expectedQueueItemUuid?: string | null },
    ctx: ConnectionContext,
  ) => {
    const startTime = performance.now();
    await applyRateLimit(ctx, RATE_LIMIT_SESSION, RATE_LIMIT_SESSION_OP);
    const sessionId = await requireSessionWithReconnectGrace(ctx);
    const result = await mirrorSessionClimb(sessionId, mirrored, expectedQueueItemUuid);
    logMutationMetrics('mirrorCurrentClimb', performance.now() - startTime, sessionId);
    return result?.item ?? null;
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

    const { write, queue, currentClimb } = await withQueueVersionRetry(
      'replaceQueueItem',
      sessionId,
      async (currentState) => {
        const nextQueue = currentState.queue.map((i) => (i.uuid === uuid ? item : i));
        let nextCurrentClimb = currentState.currentClimbQueueItem;

        // Update current climb if it was the replaced item
        if (nextCurrentClimb?.uuid === uuid) {
          nextCurrentClimb = item;
        }

        // An in-place swap by uuid keeps every index, so the stored line
        // stands (F3); a stored orphan is normalised by this write.
        const normalised = normaliseOrphanCurrent({
          queue: nextQueue,
          currentClimbQueueItem: nextCurrentClimb,
          historyCount: currentState.historyCount,
        });
        const updated = await roomManager.updateQueueState(
          sessionId,
          normalised.queue,
          normalised.currentClimbQueueItem,
          currentState.version,
          normalised.historyCount,
        );
        return { write: updated, queue: normalised.queue, currentClimb: normalised.currentClimbQueueItem };
      },
    );

    // Publish as FullSync since replace is less common
    publishFullSync(pubsub, sessionId, write, queue, currentClimb);

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
      baselineSequence,
      historyCount: rawHistoryCount,
    }: {
      queue: ClimbQueueItem[];
      currentClimbQueueItem?: ClimbQueueItem;
      baselineSequence?: number | null;
      historyCount?: number | null;
    },
    ctx: ConnectionContext,
  ) => {
    const startTime = performance.now();
    await applyRateLimit(ctx, RATE_LIMIT_SET_QUEUE, RATE_LIMIT_SET_QUEUE_OP);
    const sessionId = await requireSessionWithReconnectGrace(ctx);

    // F3 (docs/current-climb-outside-queue.md, sections 2, 3 and 5): a
    // client-sent line goes through `QueueIndexSchema` first, then
    // `composeQueuePayload` clamps it. The caps apply to a `setQueue` that
    // carries `historyCount` whatever the percent says, and to every other
    // `setQueue` inside `QUEUE_NOW_SLOT_PERCENT`; there, a payload over 500 is
    // trimmed from History instead of thrown.
    const historyCountInput =
      rawHistoryCount === undefined || rawHistoryCount === null
        ? null
        : validateInput(QueueIndexSchema, rawHistoryCount, 'historyCount');
    const capsApply = historyCountInput !== null || isNowSlotSession(sessionId);

    // Validate queue size to prevent memory exhaustion, then validate each
    // item independently — one malformed/legacy item DROPS OUT instead of
    // rejecting the whole setQueue call. A single non-RFC-uuid queue item
    // used to reject the entire array here and wedge sync for a user's whole
    // queue indefinitely (issue #3857).
    // Outside the caps the guard is 501 when the payload's current climb is in
    // it, else 500: the climb on the wall doesn't count (section 5).
    const { items, droppedCount } = parseArrayTolerant(
      ClimbQueueItemSchema,
      rawQueue,
      'queue',
      maxPayloadItems(rawQueue, rawCurrentClimbQueueItem, capsApply),
    );
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
      // A current climb whose slot didn't survive tolerant parsing (or was
      // never in `queue` at all, an old solo snapshot) used to be cleared here.
      // Invariant 1 of F3, at every percent: it is inserted at the line
      // instead (`composeQueuePayload`), so it stays current and the climbs
      // after the line stay Up next.
      currentClimbQueueItem = validateInput(
        ClimbQueueItemSchema,
        rawCurrentClimbQueueItem,
        'currentClimbQueueItem',
      ) as ClimbQueueItem;
    }
    const needsStoredLine = payloadNeedsStoredLine(queue, currentClimbQueueItem, historyCountInput);
    // Throws `UpNextOverCapError` when the caps apply and Up next alone is
    // over 500, a climb current or not (section 5).
    const composePayload = (payloadQueue: ClimbQueueItem[], stored: NowSlotState<ClimbQueueItem> | null) =>
      composeQueuePayload({ queue: payloadQueue, currentClimbQueueItem, historyCountInput, stored, capsApply });

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
    // WITHOUT `baselineSequence`, and with a climb current in the payload,
    // the write is deliberately NOT wrapped in withQueueVersionRetry and
    // deliberately passes no `expectedVersion` (issue #3906): the payload is
    // entirely client-supplied, so there is nothing to recompute against a
    // concurrent write, and all it needs is a sequence number nobody else is
    // using — which the CAS allocates atomically. That is the legacy path,
    // still taken by pre-#3933 clients.
    //
    // F3: a write whose line has to be derived from the stored History
    // (nothing current, or a payload orphan, and no `historyCount`) reads the
    // stored state, so it is versioned and retried like any recompute; a
    // crewmate's removal between the read and the write would otherwise leave
    // the line one off. Only when the retries run out does it drop to the
    // blind write, composed from a fresh read.
    //
    // WITH `baselineSequence` — the last sequence the caller had APPLIED when
    // it composed this payload — the write merges instead (issue #3933). The
    // replay buffer is asked what happened in the window, any peer add the
    // caller never saw is re-appended, and the CAS runs against the version we
    // read so an add racing the merge itself conflicts and retries.
    //
    // Accepted residuals, deliberately not papered over — this NARROWS #3933,
    // it does not close it:
    //   - Adds that reach the queue via a FullSync-publishing mutation
    //     (replaceQueueItem, the controller navigation paths) carry no
    //     QueueItemAdded event, so the merge cannot see them and they are
    //     still lost inside the window.
    //   - The merge degrades to the legacy overwrite whenever the buffer can't
    //     describe the window completely (write still in flight, evicted past
    //     100 events, expired past the 5-minute TTL, Redis off). That re-opens
    //     the original race for those calls, by design: a partial merge that
    //     dropped an add would be the same bug with a fix's paint on it.
    //   - Closing it fully still means the mergeable-queue protocol rewrite the
    //     issue describes.
    const mergeBaseline =
      typeof baselineSequence === 'number' && Number.isInteger(baselineSequence) && baselineSequence >= 0
        ? baselineSequence
        : null;

    let writeResult: Awaited<ReturnType<typeof roomManager.updateQueueState>> | null = null;
    let finalState: ComposedQueuePayload | null = null;

    if (mergeBaseline !== null && pubsub.isRedisConnected()) {
      const incomingUuids = new Set(queue.map((item) => item.uuid));
      try {
        const merged = await withQueueVersionRetry('setQueue', sessionId, async (currentState) => {
          const outcome = await collectConcurrentAdds({
            sessionId,
            baselineSequence: mergeBaseline,
            incomingUuids,
            currentState,
            callerClientId: ctx.connectionId || null,
            readEvents: (id, since) => pubsub.getEventsSince(id, since),
          });

          if (outcome.status === 'degraded') {
            // Greppable: sustained volume here means the merge is not actually
            // protecting anyone and the buffer bounds need revisiting.
            logger.warn(
              `[setQueue] Concurrent-add merge degraded (${outcome.reason}) for session ${sessionId} at baseline ${mergeBaseline} — falling back to the legacy wholesale overwrite (#3933).`,
            );
            return null;
          }

          // Survivors are re-appended at the end, after the line, so they
          // land in Up next and leave the line where the payload put it.
          const composed = composePayload(
            outcome.survivors.length > 0 ? [...queue, ...outcome.survivors] : queue,
            currentState,
          );
          const write = await roomManager.updateQueueState(
            sessionId,
            composed.queue,
            composed.currentClimbQueueItem,
            currentState.version,
            composed.historyCount,
          );
          if (outcome.survivors.length > 0) {
            logger.info(
              `[setQueue] Re-appended ${outcome.survivors.length} climb(s) a party member added during the replace window for session ${sessionId} (#3933).`,
            );
          }
          return { write, composed };
        });

        if (merged) {
          writeResult = merged.write;
          finalState = merged.composed;
        }
      } catch (error) {
        // withQueueVersionRetry THROWS once it burns MAX_RETRIES. A wholesale
        // replace must not acquire a brand-new user-facing failure mode just
        // because the session is under write pressure — drop to the legacy
        // no-conflict overwrite, which is exactly what this call did before.
        if (!(error instanceof VersionConflictError)) throw error;
        logger.warn(
          `[setQueue] Concurrent-add merge exhausted its version-conflict retries for session ${sessionId} — falling back to the legacy wholesale overwrite (#3933).`,
        );
      }
    }

    if (!writeResult && needsStoredLine) {
      try {
        const versioned = await withQueueVersionRetry('setQueue', sessionId, async (currentState) => {
          const composed = composePayload(queue, currentState);
          const write = await roomManager.updateQueueState(
            sessionId,
            composed.queue,
            composed.currentClimbQueueItem,
            currentState.version,
            composed.historyCount,
          );
          return { write, composed };
        });
        writeResult = versioned.write;
        finalState = versioned.composed;
      } catch (error) {
        if (!(error instanceof VersionConflictError)) throw error;
        logger.warn(
          `[setQueue] Versioned line derivation exhausted its retries for session ${sessionId}; writing unversioned.`,
        );
      }
    }

    if (!writeResult || !finalState) {
      const composed = composePayload(queue, needsStoredLine ? await roomManager.getQueueState(sessionId) : null);
      writeResult = await roomManager.updateQueueState(
        sessionId,
        composed.queue,
        composed.currentClimbQueueItem,
        undefined,
        composed.historyCount,
      );
      finalState = composed;
    }

    const { stateHash, stateHashOrdered, previousStateHash, previousStateHashOrdered } = writeResult;

    if (
      previousStateHash !== null &&
      previousStateHash === stateHash &&
      previousStateHashOrdered !== null &&
      previousStateHashOrdered === stateHashOrdered
    ) {
      logger.warn(
        `[setQueue] Redundant full-queue resync for session ${sessionId} (hash=${stateHash}, queueSize=${finalState.queue.length}). Incoming queue matched server state in membership, order, and current climb — a wasted setQueue; check the caller re-pushing unchanged state.`,
      );
    }

    if (finalState.orphanInserted) {
      logger.info(
        `[setQueue] Inserted the payload's current climb at the History / Up next line for session ${sessionId} instead of clearing it (F3).`,
      );
    }

    const state = publishFullSync(pubsub, sessionId, writeResult, finalState.queue, finalState.currentClimbQueueItem);

    logMutationMetrics('setQueue', performance.now() - startTime, sessionId, {
      queueSize: finalState.queue.length,
      droppedCount,
      historyCount: historyCountInput !== null ? 'explicit' : 'absent',
      trimmed: finalState.trimmedCount,
      orphanInserted: finalState.orphanInserted,
      nowSlotRules: capsApply,
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
      // Forwarded verbatim so receivers can compare it to their own frame list.
      // Null for publishers that predate the field — receivers fall back to the
      // legacy clamp when they have nothing to compare against.
      frameCount: validatedInput.frameCount ?? null,
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
