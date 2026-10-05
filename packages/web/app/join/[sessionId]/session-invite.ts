// What the session invite page knows about the session it is for (#6004).
//
// One lookup, shared by nothing else: the page body calls it once. It goes
// through the backend's unauthenticated `sessionInvitePreview` query and not
// the database, so what a link holder may learn (a display name, a board or gym
// name only when that row is public, never a roster or an id) is decided in one
// place for www and the app.

import { formatBoardDisplayName, parseBoardPath, parseNamedBoardPath } from '@boardsesh/board-config';
import type { SessionInvitePreview, SessionInviteState } from '@boardsesh/shared-schema';
import { GET_SESSION_INVITE_PREVIEW, type GetSessionInvitePreviewResponse } from '@boardsesh/graphql/operations';
import { executeAuthenticatedGraphQL } from '@/app/lib/graphql/server-graphql';
import { SessionIdSchema } from '@/app/lib/validation/session';

/**
 * The four states the backend reports, plus `unavailable`: the backend did not
 * answer (down, or its rate limit refused us). The page must not call that
 * "not found"; the session may be running fine.
 */
export type SessionInvitePageState = SessionInviteState | 'unavailable';

export type SessionInvite = {
  state: SessionInvitePageState;
  hostName: string | null;
  /** The board's own name when it is public, otherwise the board type read off the path. Null when neither is known. */
  boardLabel: string | null;
  /** The wall angle the session runs at, when the path carries one. */
  boardAngle: number | null;
  gymName: string | null;
};

function withoutDetails(state: SessionInvitePageState): SessionInvite {
  return { state, hostName: null, boardLabel: null, boardAngle: null, gymName: null };
}

/**
 * A label for the board a session runs on.
 *
 * The board's name when the backend released it. Otherwise the board TYPE from
 * a config path (`kilter/1/10/1,20/40` reads as "Kilter"). A named-board path
 * (`/b/{slug}`) whose board is not public yields nothing: its slug is derived
 * from the name the backend just declined to give.
 */
export function inviteBoardLabel(preview: Pick<SessionInvitePreview, 'boardName' | 'boardPath'>): string | null {
  if (preview.boardName) return preview.boardName;
  if (!preview.boardPath) return null;
  const parsed = parseBoardPath(preview.boardPath);
  return parsed ? formatBoardDisplayName(parsed.boardName) : null;
}

/** The wall angle in a session's board path, for either path shape. */
export function inviteBoardAngle(boardPath: string | null): number | null {
  if (!boardPath) return null;
  return parseNamedBoardPath(boardPath)?.angle ?? parseBoardPath(boardPath)?.angle ?? null;
}

export function sessionInviteFromPreview(preview: SessionInvitePreview): SessionInvite {
  if (preview.state !== 'live' && preview.state !== 'dormant') return withoutDetails(preview.state);
  return {
    state: preview.state,
    hostName: preview.hostName,
    boardLabel: inviteBoardLabel(preview),
    boardAngle: inviteBoardAngle(preview.boardPath),
    gymName: preview.gymName,
  };
}

/**
 * Look up an invite. Never throws.
 *
 * A malformed id is `not_found` without a round trip: it cannot name a session,
 * and the backend would reject it as a validation error we would then have to
 * tell apart from an outage.
 */
export async function fetchSessionInvite(sessionId: string): Promise<SessionInvite> {
  if (!SessionIdSchema.safeParse(sessionId).success) return withoutDetails('not_found');
  try {
    const response = await executeAuthenticatedGraphQL<GetSessionInvitePreviewResponse>(GET_SESSION_INVITE_PREVIEW, {
      sessionId,
    });
    return sessionInviteFromPreview(response.sessionInvitePreview);
  } catch (error) {
    console.error('fetchSessionInvite failed:', error);
    return withoutDetails('unavailable');
  }
}
