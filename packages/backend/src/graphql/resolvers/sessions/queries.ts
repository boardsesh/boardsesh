import type {
  ConnectionContext,
  EventsReplayResponse,
  SessionHealthExport,
  SessionStatus,
} from '@boardsesh/shared-schema';
import { eq } from 'drizzle-orm';
import { roomManager, type DiscoverableSession } from '../../../services/room-manager';
import { pubsub } from '../../../pubsub/index';
import { validateInput, requireSessionMember, requireAuthenticated } from '../shared/helpers';
import { SessionIdSchema, LatitudeSchema, LongitudeSchema, RadiusMetersSchema } from '../../../validation/schemas';
import { generateSessionHealthExport, generateSessionSummary } from './session-summary';
import { getDistributedState } from '../../../services/distributed-state';
import { buildSessionPayload } from './helpers';
import { dbRead } from '../../../db/client';
import { sessions } from '../../../db/schema';

export const sessionQueries = {
  /**
   * Get a session by ID
   * Returns session info including users and queue state
   */
  session: async (_: unknown, { sessionId }: { sessionId: string }, ctx: ConnectionContext) => {
    // Validate session ID
    validateInput(SessionIdSchema, sessionId, 'sessionId');

    // The membership check guards the rest of the payload — no session means
    // no payload. Fetch users explicitly so we can early-return null without
    // paying for the remaining lookups, then hand the pre-resolved list to
    // the helper.
    const users = await roomManager.getSessionUsers(sessionId);
    if (users.length === 0) return null;

    // Query result: no WebSocket context, so `isLeader` is always false and
    // `clientId` is empty. Participant ID falls back through the helper's
    // default (ctx.participantId ?? ctx.connectionId ?? '').
    return buildSessionPayload(sessionId, ctx, {
      users,
      isLeader: false,
      clientId: '',
    });
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

    return {
      events,
      currentSequence: queueState.sequence,
    };
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

  /**
   * Get viewer-specific session data for Apple Health. This is narrower than
   * sessionSummary by design: Health workouts are personal records.
   */
  sessionHealthExport: async (
    _: unknown,
    { sessionId }: { sessionId: string },
    ctx: ConnectionContext,
  ): Promise<SessionHealthExport | null> => {
    requireAuthenticated(ctx);
    validateInput(SessionIdSchema, sessionId, 'sessionId');
    if (!ctx.userId) throw new Error('Authentication required to perform this operation');
    return generateSessionHealthExport(sessionId, ctx.userId);
  },

  /**
   * Presence-independent lifecycle check. Reads the durable session row so an
   * ended session reads as ended even with zero connected participants — unlike
   * `session`, which returns null whenever the live roster is empty and so can't
   * tell an ended session apart from a dormant-but-active one. Clients call this
   * on cold start to decide whether to restore or drop a persisted session id
   * (#2683). No auth: it exposes only existence + ended-state, and auth may not
   * be restored yet at cold start. Returns the bare SessionStatus enum; null
   * means no such session.
   */
  sessionStatus: async (_: unknown, { sessionId }: { sessionId: string }): Promise<SessionStatus | null> => {
    validateInput(SessionIdSchema, sessionId, 'sessionId');
    const rows = await dbRead
      .select({ status: sessions.status, endedAt: sessions.endedAt })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    // Ended-ness is the only durable signal. endedAt is ORed in as insurance
    // against a skewed row (endSession and the inactivity sweep set status and
    // endedAt together, so it can only diverge via manual edits). Everything
    // else — including 'inactive', which the legacy DB CHECK (backend
    // migration 0005) still permits but nothing writes — normalizes to
    // 'active': a dormant row is exactly the restore-safe case this query
    // exists to preserve (#2683).
    return row.status === 'ended' || row.endedAt != null ? 'ended' : 'active';
  },
};
