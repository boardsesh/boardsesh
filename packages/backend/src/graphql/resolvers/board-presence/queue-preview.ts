import type { ConnectionContext, BoardQueuePreview } from '@boardsesh/shared-schema';
import { pubsub } from '../../../pubsub/index';
import { createEagerAsyncIterator } from '../shared/async-iterators';
import { withSubscriptionCleanup } from '../shared/managed-subscription';
import { applyRateLimit } from '../shared/helpers';
import { requireReadablePresenceBoard } from './shared';
import { sprayStreamGate } from '../climbs/spray-read-access';
import { getBoardQueuePreviewSnapshot } from '../../../services/board-queue-preview';

export const boardQueuePreviewQueries = {
  /**
   * Redacted "Up next" snapshot of the party-session queue bound to a shared
   * board, for anonymous public displays (gym kiosks).
   *
   * Auth-optional. `requireAnonReadableBoard` hides private boards from
   * anonymous viewers behind the same NOT_FOUND as a missing board. The
   * double privacy gate (anon-readable board AND `isPublic` active session —
   * including the deliberately widened `is_public` semantics) plus the
   * binding resolution (Redis reverse key → newest-active DB fallback) and
   * the total redaction all live in
   * `services/board-queue-preview.ts` — one implementation shared with the
   * subscription seed and the live producer so the gates can never drift.
   * Returns null when no publicly previewable session is bound.
   */
  boardQueuePreview: async (
    _: unknown,
    { boardId }: { boardId: number },
    ctx: ConnectionContext,
  ): Promise<BoardQueuePreview | null> => {
    // 30/min, parity with boardNowPlaying — the snapshot does DB work
    // (binding resolution + gates + queue state). Honest limitation: for
    // anonymous WebSocket callers `applyRateLimit` keys on the connectionId,
    // so the cap is per-connection — reconnect churn mints fresh buckets
    // (same as every other anon WS limit in this domain).
    await applyRateLimit(ctx, 30, 'boardQueuePreview');
    // For anonymous viewers this already ran the exact `isBoardAnonReadable`
    // query gate 1 needs; pass the verification down so the snapshot doesn't
    // repeat it (logged-in viewers verified nothing — gate 1 still runs).
    // One row read: the anon gate plus a spray wall's own rule (private and
    // hidden = owner only).
    const { anonReadableVerified } = await requireReadablePresenceBoard(boardId, ctx.userId);
    return getBoardQueuePreviewSnapshot(boardId, { anonReadableVerified });
  },
};

export const boardQueuePreviewSubscriptions = {
  /**
   * Live redacted "Up next" previews for a shared board. Same audience and
   * anonymous existence-hiding as `boardNowPlaying`; every published event has
   * already passed the double privacy gate at the producer.
   *
   * Eager subscribe THEN seed: `createEagerAsyncIterator` awaits the Redis
   * channel subscribe before we compute the seed snapshot, so a producer
   * publish landing during setup queues in the iterator instead of being
   * dropped (pub/sub has no replay — the seed is the only initial state a
   * kiosk gets). A publish that lands between the subscribe and the seed
   * compute can deliver a snapshot slightly older than the seed right after
   * it; accepted — snapshots are self-contained and the next mutation's
   * publish converges (same accepted race as boardNowPlaying's backfill).
   */
  boardQueuePreview: {
    subscribe: withSubscriptionCleanup(async function* (
      lifetime,
      _: unknown,
      { boardId }: { boardId: number },
      ctx: ConnectionContext,
    ) {
      // 30/min, parity with boardNowPlaying (the seed does DB work). Anon WS
      // callers are keyed per-connection — see the query resolver's note.
      await applyRateLimit(ctx, 30, 'boardQueuePreview');
      // Same gate-1 dedup as the query resolver (see its comment).
      const { anonReadableVerified, board } = await requireReadablePresenceBoard(boardId, ctx.userId);
      // Re-checked per event, like `boardNowPlaying`: a wall going private or
      // hidden mid-stream has to end a stream that is already open. Null (no
      // cost) for every board that is not a spray wall.
      const gate = sprayStreamGate(board?.boardType, board?.layoutId, ctx.userId);

      const boardKey = String(boardId);

      const asyncIterable = await lifetime.own(
        createEagerAsyncIterator<BoardQueuePreview>(
          (push) => pubsub.subscribeBoardQueuePreview(boardKey, push),
          `boardQueuePreview:${boardId}`,
        ),
      );
      // One concrete iterator, shared by the loop and the finally below, so
      // cleanup always targets the iterator that owns the subscription.
      const eagerIterator = asyncIterable[Symbol.asyncIterator]();

      try {
        const seed = await getBoardQueuePreviewSnapshot(boardId, { anonReadableVerified });
        if (seed) {
          yield { boardQueuePreview: seed };
        }

        for (let result = await eagerIterator.next(); !result.done; result = await eagerIterator.next()) {
          if (gate && !(await gate())) return;
          yield { boardQueuePreview: result.value };
        }
      } finally {
        // The lifetime wrapper closes immediately on disconnect, even during
        // the seed lookup. Keep generator-exit cleanup too; return is idempotent.
        await eagerIterator.return?.(undefined);
      }
    }),
  },
};
