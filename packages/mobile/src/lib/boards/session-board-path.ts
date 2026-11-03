import { buildBoardPath, parseNamedBoardPath, SHARED_CONFIG_FEED_SLUG_PREFIX } from '@boardsesh/board-config';

/** The board fields a session path needs. Everything else on `UserBoard` is irrelevant here. */
export type SessionBoardPathSource = {
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  slug?: string | null;
};

/**
 * The board path a party session broadcasts to its members.
 *
 * Every board with a slug keeps its own identity: `/b/{slug}/{angle}`. Handed
 * the positional tuple instead, a joiner goes down `resolveBoardForSession`'s
 * tuple branch, which reuses or mints that climber's own board row, bound to a
 * different board-presence id. The second climber's turn then never reaches the
 * first climber's feed or the gym's kiosk, and on a Relay mode MoonBoard the
 * crew can't see whose phone holds the wall (#7220).
 *
 * A home board is named too, private ones included. The backend names it to a
 * viewer only when they may read it: the owner, the board's audience, and the
 * live crew of a session the owner started on it (`isLiveSessionMemberOnHomeWall`).
 * Anyone else, and the join screen before the climber has joined, gets the
 * board's geometry instead (`projectSessionBoardPath`). A crewmate who joined on
 * that geometry moves onto the named board once the roster snapshot names it
 * (`session-board-adoption.ts`).
 *
 * Two boards keep the tuple:
 * - no slug, or an empty one (`/b//40` would read as the slug `"40"`);
 * - a shared per-config feed (`SHARED_CONFIG_FEED_SLUG_PREFIX`), which groups
 *   climbers across gyms and must never stand for one wall.
 *
 * Every site that sets a session's board path must go through here, or the first
 * angle change (which rebuilds the path) silently reverts a named session to the
 * tuple and separates everyone who joins after it.
 */
export function buildSessionBoardPath(board: SessionBoardPathSource, angleOverride?: number): string {
  const angle = angleOverride ?? board.angle;
  if (board.slug && !board.slug.startsWith(SHARED_CONFIG_FEED_SLUG_PREFIX)) return `/b/${board.slug}/${angle}`;
  return buildBoardPath(board.boardType, board.layoutId, board.sizeId, board.setIds, angle);
}

/** The fields an angle change also reads: a gym or ledless wall always keeps its name. */
export type AngleChangeBoardPathSource = SessionBoardPathSource & {
  gymId?: number | null;
  hasLeds?: boolean;
};

/**
 * The path an angle change broadcasts. An angle change keeps the session on its
 * wall; it must not move it. So a home board is named only when the session
 * already names it (or has no path yet). A crewmate still on a board of their
 * own (an older join, or a wall the session doesn't name to them) sends its
 * tuple, as before #7220: naming their own board would bind the host's session
 * to it, and the host's phone follows a named angle only on the same slug.
 * A gym or ledless wall is always named, as before, so a session converges on it.
 */
export function buildAngleChangeSessionBoardPath(
  board: AngleChangeBoardPathSource,
  newAngle: number,
  sessionBoardPath: string,
): string {
  const tuple = buildBoardPath(board.boardType, board.layoutId, board.sizeId, board.setIds, newAngle);
  const named = buildSessionBoardPath(board, newAngle);
  if (named === tuple) return tuple;
  if (board.gymId != null || board.hasLeds === false) return named;
  if (!sessionBoardPath || parseNamedBoardPath(sessionBoardPath)?.slug === board.slug) return named;
  return tuple;
}
