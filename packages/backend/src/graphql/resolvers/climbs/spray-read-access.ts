import { GraphQLError } from 'graphql';
import { sql } from 'drizzle-orm';
import { sprayLayoutVisibilitySql, sprayReferenceVisibilityCondition } from '@boardsesh/db/queries';
import { rowsFromResult } from '@boardsesh/db/client';
import { dbRead } from '../../../db/client';

/**
 * Read-side visibility for the climbs on a spray wall.
 *
 * A spray climb is an ordinary `board_climbs` row with `is_listed = true`, so every
 * predicate written for the eight catalogue boards reads it as public — and a
 * wall's `layout_id` comes out of a sequence, so it is guessable. Any read that
 * takes `boardType + layoutId` from a caller is therefore an enumeration of every
 * wall in the database unless it goes through here first.
 *
 * Two shapes, because the reads split two ways:
 *
 *  - a resolver that has already narrowed to ONE board type and layout calls
 *    {@link sprayLayoutIsReadable} and, when it answers false, returns an **empty
 *    page** — not an error, not a different shape, so a private wall's existence
 *    is not observable;
 *  - a query that spans board types (a user's climbs, an ascents feed) carries
 *    `sprayClimbVisibilityCondition` in its WHERE instead, which is a no-op on
 *    every other board type.
 *
 * The rule itself is the by-layout one — owner, gym member, or a public wall —
 * mirroring `viewerCanSeeSprayWallByLayout` in `../board/spray-walls.ts`.
 * `is_unlisted` is NOT an exemption: unlisted means reachable by uuid, and a layout
 * id is not a uuid.
 */

/**
 * True only for spray. Exported because call sites **must** short-circuit on it:
 *
 *     if (isSprayBoardType(boardType) && !(await sprayLayoutIsReadable(...))) return [];
 *
 * written that way, not as a bare `await`, so the eight catalogue boards pay
 * nothing — not even the microtask an `async` call costs. That is not premature
 * tuning: `recentBetaLinks` starts a single-flight CTE synchronously and its
 * concurrency tests assert the dedupe by counting calls before any await, so a
 * microtask ahead of it changes observable behaviour on the hot path.
 */
export function isSprayBoardType(boardType: string | null | undefined): boolean {
  return boardType === 'spray';
}

/**
 * Whether this caller may read the climbs on the wall at `layoutId`.
 *
 * Answers true immediately for a non-spray board type — the cheap path, and the
 * reason every call site can be unconditional. One round trip for spray.
 *
 * Pass `userId` as null/undefined for an anonymous reader; anything reachable
 * without signing in MUST pass null rather than a hopeful value.
 */
export async function sprayLayoutIsReadable(
  boardType: string | null | undefined,
  layoutId: number | null | undefined,
  userId: string | null | undefined,
): Promise<boolean> {
  if (!isSprayBoardType(boardType)) return true;
  // A spray read with no layout id cannot be scoped to a wall, so there is no wall
  // whose visibility could permit it.
  if (layoutId == null || !Number.isFinite(layoutId)) return false;

  const rows = rowsFromResult<{ visible: boolean }>(
    await dbRead.execute(sprayLayoutVisibilitySql(Number(layoutId), userId ?? null)),
  );
  return rows[0]?.visible === true;
}

/**
 * Throwing form for the board-presence reads, which resolve a board by its numeric
 * `user_boards.id` rather than a layout id.
 *
 * `assertAnonReadableBoard` returns early for ANY authenticated caller — its
 * docblock says the history feed is "intentionally public… no membership check" —
 * which is a defensible rule for a catalogue board someone else owns and the wrong
 * one for a photograph of a stranger's garage. Board ids are small integers, so
 * without this a signed-in caller could walk them and read a private wall's send
 * log: climb names, frames and grades.
 *
 * Reports "Board not found", the same message and code the anonymous gate uses, so
 * the two are indistinguishable.
 */
export async function assertSprayBoardIsReadable(
  board: { boardType: string; layoutId: number | string },
  viewerUserId: string | null | undefined,
): Promise<void> {
  if (!isSprayBoardType(board.boardType)) return;
  if (await sprayLayoutIsReadable(board.boardType, Number(board.layoutId), viewerUserId)) return;
  throw new GraphQLError('Board not found', { extensions: { code: 'NOT_FOUND' } });
}

/**
 * The wall rule for a `user_boards` ROW, for the board readers that resolve a
 * wall without ever going through `sprayWall*`.
 *
 * `board(boardUuid)` and `boardBySlug(slug)` deliberately let ANY signed-in
 * climber open a private board by a direct link — "direct private-board links
 * keep working for signed-in climbers" — because a private Kilter board is a
 * piece of gym furniture whose name gives nothing away. A spray wall is a
 * photograph of somebody's living room, it is **private by default** (inverted
 * from every other board type), and its row carries the wall's name and its
 * location. So those two readers need the wall's own rule, and they need the two
 * halves of it separately:
 *
 *  - `'capability'` — the caller presented the wall's uuid, an unguessable
 *    122-bit token, so an UNLISTED wall opens up. Mirrors `sprayWall(uuid)` and
 *    `viewerCanSeeSprayWall`.
 *  - `'enumerable'` — the caller presented a guessable key. A slug is derived
 *    from the wall's NAME, so it is a guess, not a capability. Mirrors
 *    `sprayWallByLayout` and `viewerCanSeeSprayWallByLayout`: no unlisted
 *    exemption.
 *
 * Answers true for every non-spray board, so the call site needs no branch.
 * A refused wall must be reported as the caller's "not found", never as an
 * error of its own — otherwise the response is an oracle.
 */
export async function sprayBoardRowIsReadable(
  board: { boardType: string; layoutId: number | null; isUnlisted?: boolean | null },
  viewerUserId: string | null | undefined,
  lookupKey: 'capability' | 'enumerable',
): Promise<boolean> {
  if (!isSprayBoardType(board.boardType)) return true;
  if (lookupKey === 'capability' && board.isUnlisted === true) return true;
  return sprayLayoutIsReadable(board.boardType, board.layoutId, viewerUserId);
}

/**
 * Whether the viewer may reach the climb behind a bare CLIMB UUID, for the
 * readers that hold a reference to a climb and never join `board_climbs` at all
 * — a comment thread, the proposals on a climb.
 *
 * Phrased through {@link sprayReferenceVisibilityCondition}, so it is the same
 * "there is no INVISIBLE spray climb behind this reference" rule the reference
 * queries carry in their WHERE, and so a reference whose climb row is missing
 * survives. Answers true for every non-spray climb, so a call site needs no
 * board-type branch — and the caller must answer an unreadable climb with its
 * own EMPTY PAGE, never an error.
 */
export async function sprayClimbUuidIsReadable(
  climbUuid: string,
  viewerUserId: string | null | undefined,
): Promise<boolean> {
  const rows = rowsFromResult<{ visible: boolean }>(
    await dbRead.execute(
      sql`SELECT ${sprayReferenceVisibilityCondition(
        { boardType: sql`'spray'`, climbUuid: sql`${climbUuid}` },
        viewerUserId ?? null,
      )} AS visible`,
    ),
  );
  return rows[0]?.visible === true;
}

/**
 * The same question for a PROPOSAL uuid, for the comment threads hung off one.
 *
 * A `hide` proposal persists its reason as a comment with
 * `entity_type = 'proposal'` (`social/proposals/mutations.ts`), so the thread on
 * a proposal is prose about a climb — written by someone who could see it, read
 * by anyone holding the proposal uuid. The proposal names its climb, so the
 * wall's rule reaches it one hop away.
 *
 * True for a proposal that does not exist and for one on any other board type,
 * so the caller needs no branch beyond the entity type.
 */
export async function sprayProposalUuidIsReadable(
  proposalUuid: string,
  viewerUserId: string | null | undefined,
): Promise<boolean> {
  const rows = rowsFromResult<{ visible: boolean }>(
    await dbRead.execute(
      sql`SELECT NOT EXISTS (
        SELECT 1
        FROM climb_proposals cp
        WHERE cp.uuid = ${proposalUuid}
          AND NOT (${sprayReferenceVisibilityCondition(
            { boardType: sql`cp.board_type`, climbUuid: sql`cp.climb_uuid` },
            viewerUserId ?? null,
          )})
      ) AS visible`,
    ),
  );
  return rows[0]?.visible === true;
}
