import { getSizeFullnessTiers } from '@boardsesh/board-constants/size-comparison';
import { gradeBandToDifficultyIds } from '@boardsesh/board-constants/grade-conversion';
import {
  buildRecommendationRefsSql,
  buildRecommendationCountSql,
  buildUserSendGradesByBoardSql,
  computeUserMaxVGrade,
  rowsOf,
  type BoardTarget,
  type RecommendationType,
  type RecommendationQueryParams,
} from '@boardsesh/db/queries';
import type { BoardName } from '@boardsesh/shared-schema';
import { db } from '../../../../db/client';
import type { ClimbRef } from './hydrate-climbs';

/** How far back published_at counts as "fresh". A year keeps the pool healthy
 * given catalog-sync gaps; recency still ranks newer climbs first. */
const FRESH_WINDOW_DAYS = 365;
const GRADES_BELOW = 3;
const GRADES_ABOVE = 1;

/** The user's [max-3, max+1] V-band as target-board difficulty ids, or null. */
async function resolveGradeBand(userId: string): Promise<{ minDifficultyId: number; maxDifficultyId: number } | null> {
  const rows = rowsOf<{ board_type: string; max_difficulty: number | null }>(
    await db.execute(buildUserSendGradesByBoardSql(userId)),
  );
  const maxV = computeUserMaxVGrade(rows);
  if (maxV === null) return null;
  return gradeBandToDifficultyIds(maxV, GRADES_BELOW, GRADES_ABOVE);
}

/**
 * Assemble the query params for a recommendation variant. Returns null only when
 * AT_LEVEL is requested but the user has no graded sends (the card is hidden).
 * `excludeUserId` drops climbs the user has already sent; pass null for the
 * public cohort playlists.
 */
async function buildParams(
  type: RecommendationType,
  target: BoardTarget,
  excludeUserId: string | null,
): Promise<RecommendationQueryParams | null> {
  const tiers = getSizeFullnessTiers(target.boardType as BoardName, target.sizeId);

  let gradeBand: { minDifficultyId: number; maxDifficultyId: number } | null = null;
  if (type === 'RECOMMENDED_AT_LEVEL') {
    if (!excludeUserId) return null; // no user => no level to target
    gradeBand = await resolveGradeBand(excludeUserId);
    if (!gradeBand) return null;
  }

  return {
    type,
    target,
    shorterSizeIds: tiers.shorterSizeIds,
    narrowerSameHeightSizeIds: tiers.narrowerSameHeightSizeIds,
    gradeBand,
    excludeUserId,
    freshWindowDays: FRESH_WINDOW_DAYS,
  };
}

export async function selectRecommendationClimbRefs(
  type: RecommendationType,
  target: BoardTarget,
  excludeUserId: string | null,
  page: number,
  pageSize: number,
): Promise<ClimbRef[]> {
  const params = await buildParams(type, target, excludeUserId);
  if (!params) return [];
  const rows = rowsOf<{ climb_uuid: string; board_type: string }>(
    await db.execute(buildRecommendationRefsSql(params, page, pageSize)),
  );
  return rows.map((row) => ({ climbUuid: row.climb_uuid, boardType: row.board_type }));
}

export async function countRecommendationClimbRefs(
  type: RecommendationType,
  target: BoardTarget,
  excludeUserId: string | null,
): Promise<number> {
  const params = await buildParams(type, target, excludeUserId);
  if (!params) return 0;
  const rows = rowsOf<{ count: number }>(await db.execute(buildRecommendationCountSql(params)));
  return Number(rows[0]?.count ?? 0);
}
