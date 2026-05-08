import type { BoardSend, ConnectionContext, EventsReplayResponse } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import { sessionSends } from '../../../db/schema';
import { eq, desc } from 'drizzle-orm';
import { roomManager, type DiscoverableSession } from '../../../services/room-manager';
import { pubsub } from '../../../pubsub/index';
import { validateInput, requireSessionMember, requireAuthenticated } from '../shared/helpers';
import { SessionIdSchema, LatitudeSchema, LongitudeSchema, RadiusMetersSchema } from '../../../validation/schemas';
import { generateSessionSummary } from './session-summary';
import { getDistributedState } from '../../../services/distributed-state';

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

export const sessionQueries = {
  /**
   * Get a session by ID
   * Returns session info including users and queue state
   */
  session: async (_: unknown, { sessionId }: { sessionId: string }) => {
    // Validate session ID
    validateInput(SessionIdSchema, sessionId, 'sessionId');

    const users = await roomManager.getSessionUsers(sessionId);
    if (users.length === 0) return null;

    const queueState = await roomManager.getQueueState(sessionId);
    const sessionInfo = await roomManager.getSessionById(sessionId);

    return {
      id: sessionId,
      boardPath: sessionInfo?.boardPath || '',
      users,
      queueState,
      // These need connection context, but for Query we return defaults
      isLeader: false,
      clientId: '',
      goal: sessionInfo?.goal || null,
      isPublic: sessionInfo?.isPublic ?? true,
      startedAt: sessionInfo?.startedAt?.toISOString() || null,
      endedAt: sessionInfo?.endedAt?.toISOString() || null,
      isPermanent: sessionInfo?.isPermanent ?? false,
      color: sessionInfo?.color || null,
    };
  },

  /**
   * Get buffered events since a sequence number for delta sync (Phase 2)
   * Used during reconnection to catch up on missed events
   */
  eventsReplay: async (
    _: unknown,
    { sessionId, sinceSequence }: { sessionId: string; sinceSequence: number },
    ctx: ConnectionContext,
  ): Promise<EventsReplayResponse> => {
    // Validate inputs
    validateInput(SessionIdSchema, sessionId, 'sessionId');

    // Verify user is a member of the session
    await requireSessionMember(ctx, sessionId);

    // Get events from buffer
    const events = await pubsub.getEventsSince(sessionId, sinceSequence);

    // Get current sequence from queue state
    const queueState = await roomManager.getQueueState(sessionId);

    // EventsReplayResponse.events is typed as SubscriptionQueueEvent[] (the
    // client-side shape with aliased fields like `addedItem`/`currentItem`)
    // because the `EventsReplay` operation aliases the union fields. The
    // resolver works with the server-side QueueEvent[] and GraphQL does the
    // aliasing during response serialization, so the cast is safe.
    return {
      events,
      currentSequence: queueState.sequence,
    } as unknown as EventsReplayResponse;
  },

  boardSends: async (
    _: unknown,
    { sessionId, deduplicate = true }: { sessionId: string; deduplicate?: boolean },
    ctx: ConnectionContext,
  ): Promise<BoardSend[]> => {
    validateInput(SessionIdSchema, sessionId, 'sessionId');
    await requireSessionMember(ctx, sessionId);

    const rows = await db
      .select()
      .from(sessionSends)
      .where(eq(sessionSends.sessionId, sessionId))
      .orderBy(desc(sessionSends.createdAt), desc(sessionSends.id));

    if (!deduplicate) return rows.map(mapBoardSend);

    const seen = new Set<string>();
    const deduped: typeof rows = [];
    for (const row of rows) {
      if (seen.has(row.climbUuid)) continue;
      seen.add(row.climbUuid);
      deduped.push(row);
    }
    return deduped.map(mapBoardSend);
  },

  /**
   * Find nearby sessions using GPS coordinates
   * Returns discoverable sessions within the specified radius
   */
  nearbySessions: async (
    _: unknown,
    { latitude, longitude, radiusMeters }: { latitude: number; longitude: number; radiusMeters?: number },
  ): Promise<DiscoverableSession[]> => {
    // Validate GPS coordinates
    validateInput(LatitudeSchema, latitude, 'latitude');
    validateInput(LongitudeSchema, longitude, 'longitude');
    if (radiusMeters !== undefined) {
      validateInput(RadiusMetersSchema, radiusMeters, 'radiusMeters');
    }
    return roomManager.findNearbySessions(latitude, longitude, radiusMeters || undefined);
  },

  /**
   * Get sessions created by the authenticated user
   * Returns empty array if user is not authenticated
   */
  mySessions: async (_: unknown, __: unknown, ctx: ConnectionContext): Promise<DiscoverableSession[]> => {
    // For now, we use userId from context if available
    // In production, this should use authenticated user ID
    if (!ctx.userId) {
      return [];
    }

    const sessions = await roomManager.getUserSessions(ctx.userId);

    // Convert Session to DiscoverableSession format
    const distributedState = getDistributedState();
    return Promise.all(
      sessions.map(async (s) => {
        const participantCount = distributedState
          ? await distributedState.getSessionMemberCount(s.id)
          : roomManager.getSessionClients(s.id).length;
        const isActive = await roomManager.isSessionActive(s.id);

        return {
          id: s.id,
          name: s.name,
          boardPath: s.boardPath,
          latitude: s.latitude || 0,
          longitude: s.longitude || 0,
          createdAt: s.createdAt,
          createdByUserId: s.createdByUserId,
          participantCount,
          distance: 0, // Not applicable for own sessions
          isActive,
          goal: s.goal || null,
          isPublic: s.isPublic,
          isPermanent: s.isPermanent,
          color: s.color || null,
        };
      }),
    );
  },

  /**
   * Get a session summary with stats, grade distribution, and participants.
   * Available for ended sessions or active sessions with ticks.
   */
  sessionSummary: async (_: unknown, { sessionId }: { sessionId: string }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    validateInput(SessionIdSchema, sessionId, 'sessionId');
    return generateSessionSummary(sessionId);
  },
};
