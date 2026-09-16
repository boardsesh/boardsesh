import type { RoomManagerDeps } from './types';

/**
 * The two presence signals every liveness rule is built from, and nothing
 * more — cheap enough to read for a whole candidate list before deciding which
 * sessions deserve a roster fetch.
 */
export type SessionConnectionLiveness = {
  /** Live connections across every instance. `0 ⟺ no live connections`. */
  liveConnectionCount: number;
  /** Whether the Redis session key still exists. Always false without Redis. */
  redisKeyExists: boolean;
};

/**
 * Connection liveness plus the display head-count.
 *
 * Liveness and the displayed head-count come from two different counters.
 * `liveConnectionCount` counts live *connections* — its `0 ⟺ no live
 * connections` contract is what liveness depends on. `participantCount` counts
 * distinct *participants* (deduped), and deliberately still includes an
 * authenticated user parked in their RECONNECTING grace window (0 live
 * connections). Gating visibility on the participant count would advertise a
 * solo climber's session as active while they're mid-reconnect with nobody
 * actually connected, so liveness uses the connection count and the deduped
 * participant count is display-only.
 */
export type SessionLiveness = SessionConnectionLiveness & {
  /** Distinct participants, for display. Includes RECONNECTING participants. */
  participantCount: number;
};

export type SessionLivenessDeps = Pick<RoomManagerDeps, 'sessions' | 'redisStore' | 'distributedState'>;

/**
 * Batch-read the connection signals: one Redis pipeline for session-key
 * existence, then each session's live connection count in parallel. No roster
 * or participant read — `getSessionParticipantCount` is a full roster fetch, so
 * callers that filter first should read rosters only for what survives.
 *
 * Both `findNearbySessions` and the live-sessions listing read presence
 * through here, so they agree on the signals. They do NOT apply the same rule
 * to them: nearby counts a session live while its Redis key exists at all,
 * while the live-sessions listing also caps a connection-less session to 20
 * minutes since its last durable activity.
 */
export async function readSessionConnectionLiveness(
  deps: SessionLivenessDeps,
  sessionIds: readonly string[],
): Promise<Map<string, SessionConnectionLiveness>> {
  const { sessions: sessionsMap, redisStore, distributedState } = deps;
  const uniqueSessionIds = [...new Set(sessionIds)];
  if (uniqueSessionIds.length === 0) return new Map();

  // Batch check Redis existence to avoid N+1 round trips.
  const redisExistsMap = redisStore ? await redisStore.batchExists(uniqueSessionIds) : new Map<string, boolean>();

  const entries = await Promise.all(
    uniqueSessionIds.map(async (sessionId): Promise<[string, SessionConnectionLiveness]> => {
      // Non-distributed fallback: the local session map holds connection ids.
      const liveConnectionCount = distributedState
        ? await distributedState.getSessionMemberCount(sessionId)
        : sessionsMap.get(sessionId)?.size || 0;
      return [sessionId, { liveConnectionCount, redisKeyExists: redisExistsMap.get(sessionId) || false }];
    }),
  );

  return new Map(entries);
}

/**
 * `readSessionConnectionLiveness` plus each session's display participant
 * count. Without distributed state the local session map has no
 * participant/connection split, so the connection count doubles as the
 * participant count there.
 */
export async function readSessionLiveness(
  deps: SessionLivenessDeps,
  sessionIds: readonly string[],
): Promise<Map<string, SessionLiveness>> {
  const connectionLiveness = await readSessionConnectionLiveness(deps, sessionIds);
  const { distributedState } = deps;

  const entries = await Promise.all(
    [...connectionLiveness].map(async ([sessionId, liveness]): Promise<[string, SessionLiveness]> => {
      const participantCount = distributedState
        ? await distributedState.getSessionParticipantCount(sessionId)
        : liveness.liveConnectionCount;
      return [sessionId, { ...liveness, participantCount }];
    }),
  );

  return new Map(entries);
}

/**
 * The discovery liveness rule: somebody is connected, or the Redis session key
 * has not expired yet (a dormant session inside its TTL).
 */
export function hasLiveConnectionsOrSessionKey(liveness: SessionConnectionLiveness): boolean {
  return liveness.liveConnectionCount > 0 || liveness.redisKeyExists;
}
