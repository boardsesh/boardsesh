import { useQuery } from '@tanstack/react-query';
import { GET_SESSION_DETAIL, type GetSessionDetailQueryResponse } from '@boardsesh/graphql/operations';
import {
  GET_SESSION,
  GET_SESSION_OWNER,
  type GetSessionOwnerQueryResponse,
  type GetSessionQueryResponse,
  type SessionPreview,
} from '../operations';
import { getHttpClient } from '../client';

const SESSION_DETAIL_STALE_TIME_MS = 30 * 1000;

/**
 * Full detail for a single past session (the Strava-style activity view):
 * aggregate stats, participant breakdown, grade distribution, and the full
 * per-climb tick list. Backed by the shared `GET_SESSION_DETAIL` operation,
 * which is reused unchanged from web.
 */
export function useSessionDetail(sessionId: string | undefined) {
  return useQuery({
    queryKey: ['sessionDetail', sessionId],
    queryFn: () =>
      getHttpClient()
        .request<GetSessionDetailQueryResponse>(GET_SESSION_DETAIL, { sessionId })
        .then((response) => response.sessionDetail),
    enabled: !!sessionId,
    staleTime: SESSION_DETAIL_STALE_TIME_MS,
  });
}

/**
 * Read-only session preview for the join-confirmation screen: host, board,
 * participant roster, and whether the session has ended. Does NOT join the
 * session — see `QueueProvider.joinSession`.
 */
export function useSessionPreview(sessionId: string | undefined) {
  return useQuery<SessionPreview | null>({
    queryKey: ['sessionPreview', sessionId],
    queryFn: () =>
      getHttpClient()
        .request<GetSessionQueryResponse>(GET_SESSION, { sessionId })
        .then((response) => response.session),
    enabled: !!sessionId,
    // Preview reflects live presence; keep it fresh while the screen is open.
    staleTime: 10 * 1000,
  });
}

/**
 * Database user UUID of whoever started a session, or null when the server
 * won't say (non-member, anonymous creator, or a bundle newer than the backend
 * — see GET_SESSION_OWNER's note on why this is its own document).
 *
 * Unlike `useSessionDetail`, this resolves for a ZERO-TICK session: sessionDetail
 * returns null until the first ascent is logged, which is exactly when someone
 * joins a friend's fresh party and wants back out of it. Ownership never changes
 * for a given session id, so this is cached hard.
 */
export function useSessionOwnerUserId(sessionId: string | undefined) {
  return useQuery<string | null>({
    queryKey: ['sessionOwner', sessionId],
    queryFn: () =>
      getHttpClient()
        .request<GetSessionOwnerQueryResponse>(GET_SESSION_OWNER, { sessionId })
        .then((response) => response.session?.createdByUserId ?? null),
    enabled: !!sessionId,
    // Immutable for the life of a session — no reason to ever refetch it.
    staleTime: Infinity,
    // A failure here must degrade to "ownership unknown", never to a retry
    // storm behind a confirmation sheet the climber is staring at.
    retry: 1,
  });
}
