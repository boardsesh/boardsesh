import { buildSessionStatsUpdatedEvent } from './live-session-stats';
import { canAccessResource } from '../../../services/privacy';
import {
  projectSessionBoardPath,
  redactSessionUsers,
  sessionParticipantId,
  sessionEventParticipantId,
} from '../../../services/board-session-privacy';
import type { ConnectionContext, SessionEvent } from '@boardsesh/shared-schema';
import { pubsub } from '../../../pubsub/index';
import {
  clientPathEvent,
  movesSessionWall,
  type SessionBoardPathChangedMessage,
} from '../../../services/session-wall-refresh';
import { roomManager } from '../../../services/room-manager';
import { requireSessionMember } from '../shared/helpers';
import { createEagerAsyncIterator } from '../shared/async-iterators';
import { withSubscriptionCleanup } from '../shared/managed-subscription';

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
    subscribe: withSubscriptionCleanup(async function* (
      lifetime,
      _: unknown,
      { sessionId }: { sessionId: string },
      ctx: ConnectionContext,
    ) {
      // Verify user is a member of the session they're subscribing to
      // Uses retry logic to handle race conditions with joinSession
      await requireSessionMember(ctx, sessionId);

      const asyncIterable = await lifetime.own(
        createEagerAsyncIterator<SessionEvent>(
          (push) => pubsub.subscribeSession(sessionId, push),
          `sessionUpdates:${sessionId}`,
        ),
      );
      // One concrete iterator, shared by the loop and the finally below, so
      // cleanup always targets the iterator that owns the subscription.
      const eagerIterator = asyncIterable[Symbol.asyncIterator]();

      try {
        // Seed compute. This is a NEW failure surface: if getSessionUsers /
        // getSessionById reject (they run after requireSessionMember passed), the
        // generator throws and the subscription errors with NO in-place retry.
        // That's a deliberate non-goal for this PR — the client's graphql-ws
        // reconnect re-runs JOIN_SESSION + resubscribe, which re-seeds the roster,
        // so a failed seed self-heals on the next reconnect rather than needing a
        // bespoke retry here.
        const [users, session] = await Promise.all([
          roomManager.getSessionUsers(sessionId),
          roomManager.getSessionById(sessionId),
        ]);
        if (!(await canAccessResource('session', sessionId, ctx.userId))) return;
        const protocolIds = new Map(
          users.map((user) => [user.id, user.userId ? sessionParticipantId(sessionId, user.userId) : user.id]),
        );
        const protocolId = (id: string) => sessionEventParticipantId(sessionId, id, protocolIds);
        yield {
          sessionUpdates: {
            __typename: 'SessionRosterSnapshot',
            users: await redactSessionUsers(users, ctx.userId, sessionId),
            // boardPath is String! on the wire. Emit the empty-string sentinel
            // (not null) in the unreachable session-vanished-mid-subscribe case:
            // a null would raise a non-null-field violation that nulls the entire
            // sessionUpdates payload and silently drops the seed. Clients treat ''
            // as "keep current" (applySessionRuntimeEvent's `|| prev.boardPath`).
            boardPath: await projectSessionBoardPath(session?.boardPath ?? '', ctx.userId),
          } as SessionEvent,
        };

        for (let result = await eagerIterator.next(); !result.done; result = await eagerIterator.next()) {
          if (!(await canAccessResource('session', sessionId, ctx.userId))) return;
          const event = result.value;
          if (event.__typename === 'UserJoined' || event.__typename === 'UserPresenceChanged') {
            protocolIds.set(
              event.user.id,
              event.user.userId ? sessionParticipantId(sessionId, event.user.userId) : event.user.id,
            );
            yield {
              sessionUpdates: {
                ...event,
                user: (
                  await redactSessionUsers(
                    [{ ...event.user, avatarUrl: event.user.avatarUrl ?? undefined }],
                    ctx.userId,
                    sessionId,
                  )
                )[0],
              },
            };
          } else if (event.__typename === 'UserLeft') {
            yield { sessionUpdates: { ...event, userId: protocolId(event.userId) } };
          } else if (event.__typename === 'LeaderChanged') {
            yield { sessionUpdates: { ...event, leaderId: protocolId(event.leaderId) } };
          } else if (event.__typename === 'SessionBoardPathChanged') {
            const pathEvent = clientPathEvent(event);
            const { pathUnchanged } = event as SessionBoardPathChangedMessage;
            // The member who chose the path presented its link in that request.
            const projectPathEvent = () =>
              projectSessionBoardPath(event.boardPath, ctx.userId, {
                presentedByViewer: !!ctx.participantId && event.changedByParticipantId === ctx.participantId,
              });
            if (!movesSessionWall(event)) {
              // An angle change keeps the wall, so every name stays as projected.
              yield { sessionUpdates: { ...pathEvent, boardPath: await projectPathEvent() } };
              continue;
            }
            const users = await roomManager.getSessionUsers(sessionId);
            const roster = await redactSessionUsers(users, ctx.userId, sessionId);
            // The snapshot follows this path event, so it projects the path the
            // same way; a wall that moved under an unchanged path uses ordinary
            // current board standing, like any other snapshot.
            const boardPath = pathUnchanged
              ? await projectSessionBoardPath(
                  (await roomManager.getSessionById(sessionId))?.boardPath ?? '',
                  ctx.userId,
                )
              : await projectPathEvent();
            for (const user of users) {
              protocolIds.set(user.id, user.userId ? sessionParticipantId(sessionId, user.userId) : user.id);
            }
            // Installed clients already handle presence deltas. Withdraw old
            // names before publishing the destination, then replace the roster
            // for clients that understand the authoritative snapshot. A wall
            // that moved under an unchanged path sends no path event.
            for (const user of roster) {
              yield { sessionUpdates: { __typename: 'UserPresenceChanged' as const, user } };
            }
            if (!pathUnchanged) yield { sessionUpdates: { ...pathEvent, boardPath } };
            yield { sessionUpdates: { __typename: 'SessionRosterSnapshot' as const, users: roster, boardPath } };
          } else if (event.__typename === 'SessionStatsUpdated') {
            const visibleStats = await buildSessionStatsUpdatedEvent(sessionId, ctx);
            if (visibleStats) yield { sessionUpdates: visibleStats };
          } else {
            yield { sessionUpdates: result.value };
          }
        }
      } finally {
        // The lifetime wrapper closes immediately on disconnect, even during
        // the seed lookup. Keep generator-exit cleanup too; return is idempotent.
        await eagerIterator.return?.(undefined);
      }
    }),
  },
};
