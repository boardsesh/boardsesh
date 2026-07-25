import type { ConnectionContext, SessionEvent } from '@boardsesh/shared-schema';
import { pubsub } from '../../../pubsub/index';
import { roomManager } from '../../../services/room-manager';
import { requireSessionMember } from '../shared/helpers';
import { createEagerAsyncIterator } from '../shared/async-iterators';

export const sessionSubscriptions = {
  /**
   * Subscribe to real-time session events.
   *
   * Eager subscribe THEN seed (mirrors `queueUpdates`' FullSync and
   * `boardQueuePreview`'s snapshot): `createEagerAsyncIterator` awaits the Redis
   * channel subscribe before we compute the roster seed, so a delta published
   * during setup queues in the iterator instead of being dropped (session
   * pub/sub has no replay). The first yielded event is a `SessionRosterSnapshot`
   * carrying the authoritative roster + boardPath — without it the roster's only
   * baseline is the JOIN_SESSION response, and any delta dropped between
   * instances (Redis publish failure) or in the JOIN-to-subscribe window
   * silently diverges a member's crew list until they fully rejoin (#2860). A
   * delta that lands between the subscribe and the seed compute can deliver a
   * roster event slightly older than the seed right after it; accepted — the
   * snapshot is a self-contained REPLACE on the client and the next delta
   * converges.
   */
  sessionUpdates: {
    subscribe: async function* (_: unknown, { sessionId }: { sessionId: string }, ctx: ConnectionContext) {
      // Verify user is a member of the session they're subscribing to
      // Uses retry logic to handle race conditions with joinSession
      await requireSessionMember(ctx, sessionId);

      const asyncIterable = await createEagerAsyncIterator<SessionEvent>(
        (push) => pubsub.subscribeSession(sessionId, push),
        `sessionUpdates:${sessionId}`,
      );
      // One concrete iterator, shared by the loop and the finally below, so
      // cleanup always targets the iterator that owns the subscription.
      const eagerIterator = asyncIterable[Symbol.asyncIterator]();

      try {
        const [users, session] = await Promise.all([
          roomManager.getSessionUsers(sessionId),
          roomManager.getSessionById(sessionId),
        ]);
        yield {
          sessionUpdates: {
            __typename: 'SessionRosterSnapshot',
            users,
            boardPath: session?.boardPath ?? null,
          } as SessionEvent,
        };

        for (let result = await eagerIterator.next(); !result.done; result = await eagerIterator.next()) {
          yield { sessionUpdates: result.value };
        }
      } finally {
        // graphql-ws can call `.return()` on this generator while the seed above
        // is still being computed (client disconnects during setup). The queued
        // return then completes at the seed `yield` — before the loop ever
        // starts — so without this finally the eager iterator would never be
        // closed and the pubsub callback + Redis channel subscription would leak
        // permanently. Closing here covers every exit path; `.return()` is
        // idempotent, so a loop that already finished cleanly is unaffected.
        await eagerIterator.return?.(undefined);
      }
    },
  },
};
