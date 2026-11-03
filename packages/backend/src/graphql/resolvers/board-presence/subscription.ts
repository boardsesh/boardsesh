import { redactBoardEvent } from '../../../services/board-session-privacy';
import type { ConnectionContext, BoardPresenceEvent } from '@boardsesh/shared-schema';
import { pubsub } from '../../../pubsub/index';
import { kilterLiveSync } from '../../../services/kilter-live-sync';
import { createEagerAsyncIterator } from '../shared/async-iterators';
import { withSubscriptionCleanup } from '../shared/managed-subscription';
import { applyRateLimit } from '../shared/helpers';
import { assertValidBoardId, requireAnonReadableBoard } from './shared';
import { and, eq, isNull } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { assertSprayBoardIsReadable, readViewerIdForBoard, sprayStreamGate } from '../climbs/spray-read-access';

export const boardPresenceSubscriptions = {
  /**
   * Live "now on the wall" feed for a shared board. Auth-optional: board
   * presence is universal, so anonymous viewers are first-class (they need to
   * watch to see the holder + who's connected). A rate limit (so an anonymous
   * client can't loop board ids and grow the subscriber set unbounded) plus
   * `assertValidBoardId` bound it; it is otherwise membership-free. The board
   * id alone is the no-link reading (it can be counted); an Unlisted board's
   * feed opens when the caller also presents its uuid (`boardUuid`). Keyed on
   * the shared board_id; no driver.
   *
   * Eager subscribe: `createEagerAsyncIterator` awaits the Redis channel
   * subscribe before the first yield so a `reportBoardClimb` that lands during
   * setup isn't dropped.
   */
  boardNowPlaying: {
    subscribe: withSubscriptionCleanup(async function* (
      lifetime,
      _: unknown,
      { boardId, boardUuid }: { boardId: number; boardUuid?: string | null },
      ctx: ConnectionContext,
    ) {
      // Bumped to the same 60/min budget as the sibling anon-tolerant reads
      // for consistency. Since issue #2863 the WS context carries clientIp
      // (websocket/setup.ts resolves it from the upgrade request), so this
      // subscription shares the same anon `ip:` bucket as the HTTP-keyed reads
      // (boardConnection, boardPresenceStats) — the "multiple gym TVs behind
      // one NAT" caveat now applies here too. A TV re-subscribes on a config
      // poll rather than in a tight loop, so 60/min still leaves room for a
      // gym's worth of screens.
      await applyRateLimit(ctx, 60, 'boardNowPlaying');
      assertValidBoardId(boardId);
      // The row first: whose board it is decides whether a wall device's key reads
      // it as its owner (readViewerIdForBoard), and the spray rule below needs its
      // type and layout.
      const loadBoard = async () => {
        const [row] = await db
          .select({
            boardType: dbSchema.userBoards.boardType,
            layoutId: dbSchema.userBoards.layoutId,
            ownerId: dbSchema.userBoards.ownerId,
          })
          .from(dbSchema.userBoards)
          .where(and(eq(dbSchema.userBoards.id, boardId), isNull(dbSchema.userBoards.deletedAt)))
          .limit(1);
        return row;
      };
      // A controller key (no ctx.userId) is re-judged per event: the board can
      // change hands and the controller can be deleted while the socket is open.
      const isKeyReader = !ctx.userId && ctx.controllerOwnerUserId !== undefined;
      const presenceBoard = await loadBoard();
      // Read access for the gates and the climb half of the redaction: the
      // signed-in user, or a wall device's key owner on a board that owner owns.
      // The rate limit above, the Kilter live-sync lease and the names in the
      // redaction below stay on ctx.userId, so a key reads its owner's own boards
      // and nothing more.
      const readerId = await readViewerIdForBoard(ctx, presenceBoard);
      // Validates the id and applies the board gate: the no-link reading for the
      // id alone (not a private or Unlisted wall reached by counting ids), the
      // link reading when `boardUuid` is this board's own.
      await requireAnonReadableBoard(boardId, readerId, boardUuid);
      // …and the wall's own rule on top, because the board policy above does not
      // know the spray wall rule and `boardId` is a small integer. The events on this
      // channel carry the climb's name and frames (`reportBoardClimb`, and the
      // hardest-send name in `publishBoardStats`), so without this a signed-in
      // caller could walk the ids and watch a private spray wall live. The sibling
      // QUERIES were patched for exactly this; the subscription was missed.
      if (presenceBoard) {
        await assertSprayBoardIsReadable(presenceBoard, readerId, boardUuid, db);
      }

      const boardKey = String(boardId);

      const asyncIterator = await lifetime.own(
        createEagerAsyncIterator<BoardPresenceEvent>(async (push) => {
          const unsubscribe = await pubsub.subscribeBoardPresence(boardKey, push);
          // Replay a "Turn off all lights" that is still the wall's latest state
          // (#7015). The history backfill only carries climbs, so without this a
          // late joiner would put the cleared climb back on the wall. Pushed
          // through the iterator, after the live subscribe, so it passes the same
          // per-event access gate and redaction as live events, and a set that
          // lands in between outranks it by seq on the client.
          const activeClear = await pubsub.getActiveBoardClear(boardKey);
          if (activeClear) push({ __typename: 'BoardClimbCleared', ...activeClear });
          // The managed lifetime closes late setup and idle subscriptions.
          // Keep the polling lease in the same owned source as its listener.
          const stopWatching =
            !lifetime.closed && ctx.userId && presenceBoard?.boardType === 'kilter'
              ? kilterLiveSync.watch(boardId, ctx.userId, ctx.connectionId)
              : () => {};
          return () => {
            stopWatching();
            unsubscribe();
          };
        }, `boardNowPlaying:${boardId}`),
      );

      // Re-asked per event, because the check above ran once and the socket outlives
      // it: a wall going private, or a revoked gym membership, has to end a stream
      // that is already running. Ending the iterator is the subscription's empty
      // page — no error naming a wall the caller may no longer see.
      for await (const event of asyncIterator) {
        const eventReaderId = isKeyReader ? await readViewerIdForBoard(ctx, await loadBoard()) : readerId;
        await requireAnonReadableBoard(boardId, eventReaderId, boardUuid);
        const gate = sprayStreamGate(presenceBoard?.boardType, presenceBoard?.layoutId, eventReaderId, boardUuid, db);
        if (gate && !(await gate())) return;
        yield { boardNowPlaying: await redactBoardEvent(event, ctx.userId, boardId, boardUuid, eventReaderId) };
      }
    }),
  },
};
