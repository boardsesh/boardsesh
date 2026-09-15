import { GraphQLError } from 'graphql';
import { sprayLayoutVisibilitySql } from '@boardsesh/db/queries';
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
