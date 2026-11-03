import { normaliseSetIds, SHARED_CONFIG_FEED_SLUG_PREFIX } from '@boardsesh/board-config';
import type { UserBoard } from '@boardsesh/shared-schema';

/**
 * Moving a crewmate onto the host's home wall once they have joined (#7220).
 *
 * The join screen reads the session before the climber is in it. For a private
 * or unlisted home wall the backend then names no board, only its geometry
 * (`projectSessionBoardPath`): an invite is not the wall's link. The screen
 * resolves that geometry to a board of the climber's own and joins on it. Once
 * they are in the live roster the session's roster snapshot names the wall
 * (`/b/{slug}/{angle}`), because joining the owner's session lends the crew its
 * board (`isLiveSessionMemberOnHomeWall`). This module lets that one snapshot
 * move them onto it, so their presence binds to the owner's board id and they
 * see who holds it.
 *
 * Deliberately narrow, so it never changes how a board resolves anywhere else:
 * - only after a join the join screen made on a geometry path, for that session;
 * - only while the climber is still on the board that join set;
 * - only onto a named board with the same configuration as that geometry, so a
 *   host who switched walls in the meantime doesn't drag the climber with them;
 * - never onto a shared per-config feed;
 * - once: the first path the session sends after the join spends it, whether
 *   it moves them or not, and it lapses after `ADOPTION_WINDOW_MS` regardless.
 */

/** How long a join waits for the session to name its wall. A snapshot lands within seconds. */
export const ADOPTION_WINDOW_MS = 2 * 60 * 1000;

type BoardConfig = Pick<UserBoard, 'boardType' | 'layoutId' | 'sizeId' | 'setIds'>;

type PendingAdoption = {
  sessionId: string;
  /** The board the join set as active. A climber who left it since keeps their choice. */
  joinedBoardUuid: string;
  expiresAt: number;
  config: BoardConfig;
  /** The slug lookup the join used (`fetchBoardBySlug`), injected so the realtime engine needs no GraphQL hooks. */
  fetchBoardBySlug: (slug: string) => Promise<UserBoard | null>;
};

// One join at a time: a later join replaces an earlier expectation.
let pendingAdoption: PendingAdoption | null = null;

/** The join screen joined `sessionId` on `joinedBoard`, resolved from the session's geometry path. */
export function expectSessionBoardAdoption(
  sessionId: string,
  joinedBoard: UserBoard,
  fetchBoardBySlug: (slug: string) => Promise<UserBoard | null>,
  now: number = Date.now(),
): void {
  pendingAdoption = {
    sessionId,
    joinedBoardUuid: joinedBoard.uuid,
    expiresAt: now + ADOPTION_WINDOW_MS,
    fetchBoardBySlug,
    config: {
      boardType: joinedBoard.boardType,
      layoutId: joinedBoard.layoutId,
      sizeId: joinedBoard.sizeId,
      setIds: joinedBoard.setIds,
    },
  };
}

/** Drop the expectation, for one session or any. */
export function clearSessionBoardAdoption(sessionId?: string): void {
  if (sessionId === undefined || pendingAdoption?.sessionId === sessionId) pendingAdoption = null;
}

function sameConfig(left: BoardConfig, right: BoardConfig): boolean {
  return (
    left.boardType === right.boardType &&
    left.layoutId === right.layoutId &&
    left.sizeId === right.sizeId &&
    normaliseSetIds(left.setIds) === normaliseSetIds(right.setIds)
  );
}

/** Whether a named path seen in `sessionId` may move a climber now on `activeBoard`. */
export function mayAdoptNamedSessionBoard(
  sessionId: string,
  activeBoard: Pick<UserBoard, 'uuid'>,
  now: number = Date.now(),
): boolean {
  return (
    pendingAdoption !== null &&
    pendingAdoption.sessionId === sessionId &&
    pendingAdoption.joinedBoardUuid === activeBoard.uuid &&
    now < pendingAdoption.expiresAt
  );
}

/** Look the named board up, or null when there is no expectation or the climber may not read it. */
export async function fetchNamedSessionBoard(slug: string): Promise<UserBoard | null> {
  const lookup = pendingAdoption?.fetchBoardBySlug;
  return lookup ? lookup(slug) : null;
}

/**
 * The board to move onto, at the path's angle, or null to stay. Spends the
 * expectation either way. `namedBoard` is the slug's lookup, null
 * when the climber may not read it.
 */
export function takeNamedSessionBoardAdoption(
  sessionId: string,
  activeBoard: Pick<UserBoard, 'uuid'>,
  namedBoard: UserBoard | null,
  namedAngle: number | null | undefined,
  now: number = Date.now(),
): UserBoard | null {
  const pending = pendingAdoption;
  if (!pending || !mayAdoptNamedSessionBoard(sessionId, activeBoard, now)) return null;
  // Spent on this first named path, whatever it names.
  pendingAdoption = null;
  if (!namedBoard || namedBoard.uuid === activeBoard.uuid || !namedBoard.slug) return null;
  if (namedBoard.slug.startsWith(SHARED_CONFIG_FEED_SLUG_PREFIX)) return null;
  if (!sameConfig(pending.config, namedBoard)) return null;
  const angle = namedAngle ?? namedBoard.angle;
  return namedBoard.angle === angle ? namedBoard : { ...namedBoard, angle };
}
