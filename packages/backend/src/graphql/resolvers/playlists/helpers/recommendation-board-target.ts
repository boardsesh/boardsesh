import { and, eq, isNull, sql } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import {
  getProductSize,
  getDefaultSizeForLayout,
  getSetsForLayoutAndSize,
} from '@boardsesh/board-constants/product-sizes';
import type { BoardName } from '@boardsesh/shared-schema';
import { rowsOf, type BoardTarget } from '@boardsesh/db/queries';
import { db } from '../../../../db/client';

/** Recommendations target Kilter & Tension boards (MoonBoard is single-size;
 * other boards are negligible). MoonBoard *sends* still inform the grade band. */
const RECOMMENDABLE_BOARDS = new Set(['kilter', 'tension']);

function parseSetIds(csv: string | null | undefined): number[] | null {
  if (!csv) return null;
  const ids = csv
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  return ids.length > 0 ? ids : null;
}

/** Rank key: height dominates, width breaks ties (the product's "biggest"). */
function sizeRank(boardType: string, sizeId: number): number {
  const size = getProductSize(boardType as BoardName, sizeId);
  if (!size) return -1;
  const height = size.edgeTop - size.edgeBottom;
  const width = size.edgeRight - size.edgeLeft;
  return height * 100000 + width;
}

/** The user's biggest registered Kilter/Tension board, or null. Precise. */
async function resolveRegisteredTarget(userId: string): Promise<BoardTarget | null> {
  const boards = await db
    .select({
      boardType: dbSchema.userBoards.boardType,
      layoutId: dbSchema.userBoards.layoutId,
      sizeId: dbSchema.userBoards.sizeId,
      setIds: dbSchema.userBoards.setIds,
      angle: dbSchema.userBoards.angle,
    })
    .from(dbSchema.userBoards)
    .where(and(eq(dbSchema.userBoards.ownerId, userId), isNull(dbSchema.userBoards.deletedAt)))
    // Stable order so ties in size rank resolve deterministically (lowest id).
    .orderBy(dbSchema.userBoards.id);

  const recommendable = boards.filter((board) => RECOMMENDABLE_BOARDS.has(board.boardType));
  if (recommendable.length === 0) return null;

  let best = recommendable[0];
  let bestRank = sizeRank(best.boardType, Number(best.sizeId));
  for (const board of recommendable.slice(1)) {
    const rank = sizeRank(board.boardType, Number(board.sizeId));
    if (rank > bestRank) {
      best = board;
      bestRank = rank;
    }
  }

  return {
    boardType: best.boardType,
    layoutId: Number(best.layoutId),
    sizeId: Number(best.sizeId),
    angle: Number(best.angle),
    setIds: parseSetIds(best.setIds),
  };
}

/**
 * Best-effort board for users with no registered board: board type + angle from
 * their send history, the dominant layout of the climbs they've ticked, and that
 * layout's canonical default size/sets. Approximate — registered boards win.
 */
async function resolveInferredTarget(userId: string): Promise<BoardTarget | null> {
  // Deterministic tie-breakers (board_type / angle / layout_id ASC) so identical
  // activity always resolves to the same inferred board across requests.
  const boardRows = rowsOf<{ board_type: string }>(
    await db.execute(sql`
      SELECT board_type FROM boardsesh_ticks
      WHERE user_id = ${userId} AND status IN ('flash', 'send') AND board_type IN ('kilter', 'tension')
      GROUP BY board_type ORDER BY COUNT(*) DESC, board_type ASC LIMIT 1
    `),
  );
  const boardType = boardRows[0]?.board_type;
  if (!boardType) return null;

  // Angle and dominant layout are independent given the board type — run together.
  const [angleRows, layoutRows] = await Promise.all([
    db.execute(sql`
      SELECT angle FROM boardsesh_ticks
      WHERE user_id = ${userId} AND status IN ('flash', 'send') AND board_type = ${boardType}
      GROUP BY angle ORDER BY COUNT(*) DESC, angle ASC LIMIT 1
    `),
    db.execute(sql`
      SELECT bc.layout_id FROM boardsesh_ticks t
      JOIN board_climbs bc ON bc.board_type = t.board_type AND bc.uuid = t.climb_uuid
      WHERE t.user_id = ${userId} AND t.board_type = ${boardType}
      GROUP BY bc.layout_id ORDER BY COUNT(*) DESC, bc.layout_id ASC LIMIT 1
    `),
  ]);
  const angle = Number(rowsOf<{ angle: number }>(angleRows)[0]?.angle ?? 40);
  const layoutId = Number(rowsOf<{ layout_id: number }>(layoutRows)[0]?.layout_id);
  if (!Number.isInteger(layoutId)) return null;

  const sizeId = getDefaultSizeForLayout(boardType as BoardName, layoutId);
  if (sizeId == null) return null;
  const setIds = getSetsForLayoutAndSize(boardType as BoardName, layoutId, sizeId).map((set) => set.id);

  return { boardType, layoutId, sizeId, angle, setIds: setIds.length > 0 ? setIds : null };
}

/** A specific board the user owns (uuid), validated against ownership. Null if
 * it isn't theirs, is deleted, or isn't a recommendable board type. */
async function resolveOwnedBoardByUuid(userId: string, boardUuid: string): Promise<BoardTarget | null> {
  const [board] = await db
    .select({
      boardType: dbSchema.userBoards.boardType,
      layoutId: dbSchema.userBoards.layoutId,
      sizeId: dbSchema.userBoards.sizeId,
      setIds: dbSchema.userBoards.setIds,
      angle: dbSchema.userBoards.angle,
    })
    .from(dbSchema.userBoards)
    .where(
      and(
        eq(dbSchema.userBoards.uuid, boardUuid),
        eq(dbSchema.userBoards.ownerId, userId),
        isNull(dbSchema.userBoards.deletedAt),
      ),
    )
    .limit(1);

  if (!board || !RECOMMENDABLE_BOARDS.has(board.boardType)) return null;
  return {
    boardType: board.boardType,
    layoutId: Number(board.layoutId),
    sizeId: Number(board.sizeId),
    angle: Number(board.angle),
    setIds: parseSetIds(board.setIds),
  };
}

export type BoardTargetOverride = {
  /** The specific owned board the user selected (wins over biggest/inferred). */
  boardUuid?: string | null;
  /** Override the resolved board's size (e.g. browsing a specific size). */
  sizeId?: number | null;
  /** Override the resolved board's angle. */
  angle?: number | null;
};

/**
 * Resolve which board to recommend for, in priority order: the selected owned
 * board (boardUuid) → biggest registered board → inferred from activity. An
 * unowned/unknown boardUuid falls through rather than failing. Size/angle
 * overrides apply on top. Returns null when nothing can be determined — the
 * per-user recommendation cards are then hidden and discovery falls back to the
 * public cohort playlists.
 */
export async function resolveRecommendationBoardTarget(
  userId: string,
  override?: BoardTargetOverride,
): Promise<BoardTarget | null> {
  const base =
    (override?.boardUuid ? await resolveOwnedBoardByUuid(userId, override.boardUuid) : null) ??
    (await resolveRegisteredTarget(userId)) ??
    (await resolveInferredTarget(userId));
  if (!base) return null;

  return {
    ...base,
    sizeId: override?.sizeId ?? base.sizeId,
    angle: override?.angle ?? base.angle,
  };
}
