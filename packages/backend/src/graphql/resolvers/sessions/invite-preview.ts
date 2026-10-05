import type { SessionInvitePreview } from '@boardsesh/shared-schema';
import { eq } from 'drizzle-orm';
import { parseBoardPath } from '@boardsesh/board-config';
import * as dbSchema from '@boardsesh/db/schema';
import { roomManager } from '../../../services/room-manager';
import { dbRead } from '../../../db/client';
import { isSprayBoardType, sprayLayoutIsReadable } from '../climbs/spray-read-access';

/**
 * The public face of a session invite link (#6004).
 *
 * The invite page on www and the app's join screen both need to say whose
 * session a link points at and where it is, for someone who may have no
 * account and no app. `session` cannot answer that: it returns null whenever
 * the live roster is empty, so an invite opened while the host's phone is
 * asleep reads as "not found" for a session that is still running, and it
 * knows nothing about the gym.
 *
 * WHAT A LINK HOLDER LEARNS, and nothing else:
 *
 *  - the state: live, dormant, ended or not_found;
 *  - the host's display name (never the email, never an id);
 *  - the board path, which `session` already hands the same caller, unless it
 *    points at a spray wall an anonymous visitor cannot read;
 *  - the board's name and the gym's name, each only when that row is one an
 *    anonymous visitor could already open on its own page.
 *
 * No roster, no participant count, no queue, no user or board ids. An ended or
 * missing session returns the state alone.
 *
 * `isPublic` on the session is NOT a gate here. It controls whether a session
 * appears in live-session listings; `joinSession` lets any link holder into a
 * session with `isPublic = false`, so the invite page describing it tells them
 * nothing the link does not already give them.
 *
 * The answer never depends on who is asking, so a signed-in caller sees
 * exactly what an anonymous one does and a private board stays unnamed even
 * for its owner. The caller that needs more is a member, and has `session`.
 */

const { boardSessions, userBoards, gyms, users, userProfiles } = dbSchema;

/** The state alone: what an ended or missing session returns. */
function stateOnly(sessionId: string, state: 'ended' | 'not_found'): SessionInvitePreview {
  return { sessionId, state, hostName: null, boardName: null, boardPath: null, gymName: null };
}

/** Something@something.tld, with no spaces: the shape of an address, not of a handle like "@alex". */
const EMAIL_SHAPED = /^\S+@\S+\.\S+$/;

/**
 * A name fit to show a stranger, or null.
 *
 * `users.name` is whatever the sign-up flow stored, and an OAuth or legacy
 * account can carry the email address there. An address is exactly what this
 * query must never return, so a candidate shaped like one is skipped.
 */
function publicDisplayName(...candidates: Array<string | null>): string | null {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed && !EMAIL_SHAPED.test(trimmed)) return trimmed;
  }
  return null;
}

export async function resolveSessionInvitePreview(sessionId: string): Promise<SessionInvitePreview> {
  const rows = await dbRead
    .select({
      status: boardSessions.status,
      endedAt: boardSessions.endedAt,
      origin: boardSessions.origin,
      boardPath: boardSessions.boardPath,
      profileDisplayName: userProfiles.displayName,
      accountName: users.name,
      boardName: userBoards.name,
      boardType: userBoards.boardType,
      boardLayoutId: userBoards.layoutId,
      boardIsPublic: userBoards.isPublic,
      boardIsUnlisted: userBoards.isUnlisted,
      boardHidesLocation: userBoards.hideLocation,
      boardDeletedAt: userBoards.deletedAt,
      gymName: gyms.name,
      gymIsPublic: gyms.isPublic,
      gymDeletedAt: gyms.deletedAt,
    })
    .from(boardSessions)
    .leftJoin(users, eq(users.id, boardSessions.createdByUserId))
    .leftJoin(userProfiles, eq(userProfiles.userId, boardSessions.createdByUserId))
    .leftJoin(userBoards, eq(userBoards.id, boardSessions.boardId))
    .leftJoin(gyms, eq(gyms.id, userBoards.gymId))
    .where(eq(boardSessions.id, sessionId))
    .limit(1);

  const row = rows[0];
  // An inferred session is rebuilt from one climber's tick timing; nobody
  // started it and there is no wall to join, so its id must not resolve here.
  // The null board path is the same fact seen from the column (a CHECK ties the
  // two together) and guards a row that slipped past it.
  if (!row || row.origin !== 'explicit' || row.boardPath === null) {
    return stateOnly(sessionId, 'not_found');
  }

  // Same durable ended test as `sessionStatus`: status, with endedAt ORed in
  // against a skewed row.
  if (row.status === 'ended' || row.endedAt != null) {
    return stateOnly(sessionId, 'ended');
  }

  // Presence decides live against dormant, and nothing else: only the count is
  // read, the roster itself never leaves this function.
  const connectedUsers = await roomManager.getSessionUsers(sessionId);
  const state = connectedUsers.length > 0 ? 'live' : 'dormant';

  // A spray wall that an anonymous visitor cannot read is private to everyone
  // but its owner and its gym, and its layout id comes out of a sequence. Two
  // places can name such a wall: the attached board row, and a config path
  // (`spray/{layoutId}/...`) whether or not a board is attached.
  const attachedWallIsHidden =
    isSprayBoardType(row.boardType) && !(await sprayLayoutIsReadable(row.boardType, row.boardLayoutId, null));
  const pathBoard = parseBoardPath(row.boardPath);
  const pathWallIsHidden =
    pathBoard !== null &&
    isSprayBoardType(pathBoard.boardName) &&
    !(await sprayLayoutIsReadable(pathBoard.boardName, pathBoard.layoutId, null));
  const wallIsHidden = attachedWallIsHidden || pathWallIsHidden;

  // The board is named only when its own page is open to anyone: public,
  // listed, not deleted, and not a hidden spray wall. `boardName` is null on
  // the row when no board is attached.
  const boardIsOpenToAnyone =
    row.boardName !== null &&
    row.boardIsPublic === true &&
    row.boardIsUnlisted === false &&
    row.boardDeletedAt === null &&
    !wallIsHidden;

  // A gym says where the wall stands, so it rides on the board's visibility
  // and on the board not hiding its location, as well as on the gym's own.
  const gymIsOpenToAnyone =
    boardIsOpenToAnyone &&
    row.boardHidesLocation === false &&
    row.gymName !== null &&
    row.gymIsPublic === true &&
    row.gymDeletedAt === null;

  return {
    sessionId,
    state,
    hostName: publicDisplayName(row.profileDisplayName, row.accountName),
    boardName: boardIsOpenToAnyone ? row.boardName : null,
    // The path is what `session` already hands this caller for a live session,
    // and the app needs it to join. A hidden spray wall is the exception: its
    // path carries the wall's layout id or slug, so it is withheld and the
    // session reads as joinable with nothing said about where.
    boardPath: wallIsHidden ? null : row.boardPath,
    gymName: gymIsOpenToAnyone ? row.gymName : null,
  };
}
