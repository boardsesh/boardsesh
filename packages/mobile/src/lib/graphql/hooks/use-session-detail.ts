import { useQuery } from '@tanstack/react-query';
import {
  GET_SESSION_DETAIL,
  GET_SESSION_INVITE_PREVIEW,
  type GetSessionDetailQueryResponse,
  type GetSessionInvitePreviewResponse,
} from '@boardsesh/graphql/operations';
import type { SessionInvitePreview } from '@boardsesh/shared-schema';
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
 * A session preview as the join screen reads it. `invite` is set only when the
 * preview was rebuilt from `sessionInvitePreview` because `session` had nothing
 * to say (see {@link useSessionPreview}).
 */
export type JoinSessionPreview = SessionPreview & {
  invite?: {
    /**
     * `dormant`: the session is running and nobody is connected. Joinable.
     * `host_away`: running, nobody connected, and the backend would not say
     * which wall it is on (a spray wall that is not open to everyone). It
     * cannot be joined from here; it can once the host is connected again,
     * because `session` then answers with the path.
     * `ended`: it is over.
     */
    state: 'dormant' | 'host_away' | 'ended';
    /** The host's display name, which an empty roster cannot supply. */
    hostName: string | null;
  };
};

/**
 * Turn an invite preview into the shape the join screen already renders.
 *
 * Only what the invite preview knows is real here: the id, the board path, the
 * state and the host's name. The roster is empty because nobody is connected,
 * which is the whole reason this path ran. `name`, `color`, `goal`, `startedAt`
 * and `isPublic` are not part of an invite preview and the join screen reads
 * none of them; they are filled with their empty values, not guesses.
 *
 * Returns null for a missing session only. A running session with no board
 * path comes back as `host_away`, never null: null renders "Session not found",
 * which is the wrong thing to tell someone whose invite is good (#6004).
 */
export function sessionPreviewFromInvite(invite: SessionInvitePreview): JoinSessionPreview | null {
  if (invite.state !== 'dormant' && invite.state !== 'ended') return null;
  const state = invite.state === 'dormant' && !invite.boardPath ? 'host_away' : invite.state;
  return {
    id: invite.sessionId,
    name: null,
    boardPath: invite.boardPath ?? '',
    color: null,
    goal: null,
    isPublic: false,
    startedAt: null,
    endedAt: null,
    users: [],
    invite: { state, hostName: invite.hostName },
  };
}

/**
 * Read-only session preview for the join-confirmation screen: host, board,
 * participant roster, and whether the session has ended. Does NOT join the
 * session — see `QueueProvider.joinSession`.
 *
 * `inviteFallback` is for the join screen only. `session` returns null whenever
 * the live roster is empty, so an invite opened while the host's phone is
 * asleep used to read as "Session not found" for a session that was still
 * running, and an ended one read the same way (#6004). With the option on, a
 * null answer is followed by `sessionInvitePreview`, which reads the durable
 * row: a dormant session comes back joinable, an ended one comes back as
 * ended, and one whose wall the backend will not name comes back as
 * `host_away`. It caches under its own key, so the in-session readers of this hook
 * never see a rebuilt preview.
 *
 * A backend that predates `sessionInvitePreview` rejects the second query; that
 * is swallowed and the answer stays null, which is what this hook returned
 * before.
 */
export function useSessionPreview(sessionId: string | undefined, options?: { inviteFallback?: boolean }) {
  const inviteFallback = options?.inviteFallback === true;
  return useQuery<JoinSessionPreview | null>({
    queryKey: inviteFallback ? ['sessionPreview', sessionId, 'inviteFallback'] : ['sessionPreview', sessionId],
    queryFn: () => fetchSessionPreview(sessionId, inviteFallback),
    enabled: !!sessionId,
    // Preview reflects live presence; keep it fresh while the screen is open.
    staleTime: 10 * 1000,
  });
}

/** The fetch behind {@link useSessionPreview}. Exported for tests. */
export async function fetchSessionPreview(
  sessionId: string | undefined,
  inviteFallback: boolean,
): Promise<JoinSessionPreview | null> {
  const { session } = await getHttpClient().request<GetSessionQueryResponse>(GET_SESSION, { sessionId });
  if (session || !inviteFallback) return session;
  try {
    const { sessionInvitePreview } = await getHttpClient().request<GetSessionInvitePreviewResponse>(
      GET_SESSION_INVITE_PREVIEW,
      { sessionId },
    );
    return sessionPreviewFromInvite(sessionInvitePreview);
  } catch {
    return null;
  }
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
