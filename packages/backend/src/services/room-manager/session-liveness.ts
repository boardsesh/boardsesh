import type { SessionUser } from '@boardsesh/shared-schema';
import type { RoomManagerDeps } from './types';

/**
 * What the live-presence stores say about one session right now.
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
export type SessionLiveness = {
  /** Live connections across every instance. Liveness reads this. */
  liveConnectionCount: number;
  /** Distinct participants, for display. Includes RECONNECTING participants. */
  participantCount: number;
  /** Whether the Redis session key still exists. Always false without Redis. */
  redisKeyExists: boolean;
  /** The live roster, when the caller asked for it; null otherwise. */
  roster: SessionUser[] | null;
};

export type SessionLivenessDeps = Pick<RoomManagerDeps, 'sessions' | 'redisStore' | 'distributedState'>;

export type ReadSessionLivenessOptions = {
  /**
   * Read the live roster too. When given, `participantCount` is the roster's
   * length, so a caller that needs both pays for one roster read, not two
   * (`getSessionParticipantCount` is itself a full roster fetch).
   */
  readRoster?: (sessionId: string) => Promise<SessionUser[]>;
};

/**
 * Batch-read liveness for a set of sessions: one Redis pipeline for the
 * session-key existence check, then the per-session connection / participant
 * counters in parallel. Shared by `findNearbySessions` and the live-sessions
 * listing so the two surfaces can never disagree about what "live" means.
 */
export async function readSessionLiveness(
  deps: SessionLivenessDeps,
  sessionIds: readonly string[],
  options: ReadSessionLivenessOptions = {},
): Promise<Map<string, SessionLiveness>> {
  const { sessions: sessionsMap, redisStore, distributedState } = deps;
  const uniqueSessionIds = [...new Set(sessionIds)];
  if (uniqueSessionIds.length === 0) return new Map();

  // Batch check Redis existence to avoid N+1 round trips.
  const redisExistsMap = redisStore ? await redisStore.batchExists(uniqueSessionIds) : new Map<string, boolean>();

  const entries = await Promise.all(
    uniqueSessionIds.map(async (sessionId): Promise<[string, SessionLiveness]> => {
      let liveConnectionCount: number;
      let participantCount: number;
      let roster: SessionUser[] | null = null;
      if (distributedState) {
        liveConnectionCount = await distributedState.getSessionMemberCount(sessionId);
        if (options.readRoster) {
          roster = await options.readRoster(sessionId);
          participantCount = roster.length;
        } else {
          participantCount = await distributedState.getSessionParticipantCount(sessionId);
        }
      } else {
        // Non-distributed fallback: the local session map holds connection ids
        // and has no participant/connection split, so use it for both unless a
        // roster (which IS deduped by participant) was read.
        liveConnectionCount = sessionsMap.get(sessionId)?.size || 0;
        if (options.readRoster) {
          roster = await options.readRoster(sessionId);
          participantCount = roster.length;
        } else {
          participantCount = liveConnectionCount;
        }
      }

      return [
        sessionId,
        {
          liveConnectionCount,
          participantCount,
          redisKeyExists: redisExistsMap.get(sessionId) || false,
          roster,
        },
      ];
    }),
  );

  return new Map(entries);
}

/**
 * The discovery liveness rule: somebody is connected, or the Redis session key
 * has not expired yet (a dormant session inside its TTL).
 */
export function hasLiveConnectionsOrSessionKey(liveness: SessionLiveness): boolean {
  return liveness.liveConnectionCount > 0 || liveness.redisKeyExists;
}
