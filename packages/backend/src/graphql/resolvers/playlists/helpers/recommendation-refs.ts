import { getSizeFullnessTiers } from '@boardsesh/board-constants/size-comparison';
import { gradeBandToDifficultyIds } from '@boardsesh/board-constants/grade-conversion';
import {
  buildRecommendationRefsSql,
  buildRecommendationCountSql,
  buildRecommendationSentOverlapSql,
  buildUserSendGradesByBoardSql,
  computeUserMaxVGrade,
  rowsOf,
  withSerialPlan,
  type BoardTarget,
  type RecommendationType,
  type RecommendationQueryParams,
  type SerialPlanDb,
} from '@boardsesh/db/queries';
import type { BoardName } from '@boardsesh/shared-schema';
import { db } from '../../../../db/client';
import { readThroughRedis } from '../../../../utils/redis-read-through';
import type { ClimbRef } from './hydrate-climbs';

/** How far back published_at counts as "fresh". A year keeps the pool healthy
 * given catalog-sync gaps; recency still ranks newer climbs first. */
const FRESH_WINDOW_DAYS = 365;
const GRADES_BELOW = 3;
const GRADES_ABOVE = 1;

/** The user's [max-3, max+1] V-band as target-board difficulty ids, or null. */
async function resolveGradeBand(
  userId: string,
  executor: SerialPlanDb,
): Promise<{ minDifficultyId: number; maxDifficultyId: number } | null> {
  const rows = rowsOf<{ board_type: string; max_difficulty: number | null }>(
    await executor.execute(buildUserSendGradesByBoardSql(userId)),
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
  executor: SerialPlanDb,
): Promise<RecommendationQueryParams | null> {
  const tiers = getSizeFullnessTiers(target.boardType as BoardName, target.sizeId);

  let gradeBand: { minDifficultyId: number; maxDifficultyId: number } | null = null;
  if (type === 'RECOMMENDED_AT_LEVEL') {
    if (!excludeUserId) return null; // no user => no level to target
    gradeBand = await resolveGradeBand(excludeUserId, executor);
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

/**
 * Run `body` with per-gather parallelism disabled (#4235).
 *
 * The recommendation SQL hash-joins `board_climbs` against `board_climb_stats`,
 * `board_setter_stats` and `board_climb_send_stats` — the plan shape that
 * exhausts Postgres's dynamic shared memory on our small /dev/shm (pgCode 53100,
 * Sentry BOARDSESH-AK). When the caller already owns a guarded transaction it
 * passes its handle in and we run on that; re-wrapping it would open a savepoint
 * and re-issue the GUC for nothing.
 */
function onGuardedExecutor<T>(executor: SerialPlanDb | undefined, body: (tx: SerialPlanDb) => Promise<T>): Promise<T> {
  return executor ? body(executor) : withSerialPlan(db, body);
}

export async function selectRecommendationClimbRefs(
  type: RecommendationType,
  target: BoardTarget,
  excludeUserId: string | null,
  page: number,
  pageSize: number,
  executor?: SerialPlanDb,
): Promise<ClimbRef[]> {
  return onGuardedExecutor(executor, async (tx) => {
    const params = await buildParams(type, target, excludeUserId, tx);
    if (!params) return [];
    const rows = rowsOf<{ climb_uuid: string; board_type: string }>(
      await tx.execute(buildRecommendationRefsSql(params, page, pageSize)),
    );
    return rows.map((row) => ({ climbUuid: row.climb_uuid, boardType: row.board_type }));
  });
}

export async function countRecommendationClimbRefs(
  type: RecommendationType,
  target: BoardTarget,
  excludeUserId: string | null,
  executor?: SerialPlanDb,
): Promise<number> {
  return onGuardedExecutor(executor, async (tx) => {
    const params = await buildParams(type, target, excludeUserId, tx);
    if (!params) return 0;
    const rows = rowsOf<{ count: number }>(await tx.execute(buildRecommendationCountSql(params)));
    return Number(rows[0]?.count ?? 0);
  });
}

/**
 * Six hours: the owner-approved staleness for a card label. The rows behind it
 * move with the nightly stats refresh and catalog sync, and a card saying "283
 * climbs" when the list holds 285 costs nobody anything.
 */
export const RECOMMENDATION_COUNT_CACHE_TTL_SECONDS = 6 * 60 * 60;

/**
 * `rec-count:v1:{type}:{board}:{layout}:{size}:{sets}:{angle}[:{band}]`. Sets
 * are sorted because `<@` ignores their order; `all` covers both "no set filter"
 * shapes (null and empty). The AT_LEVEL band is part of the answer, so it is
 * part of the key. Bump `v1` when the candidate rules change.
 */
export function recommendationCountCacheKey(params: RecommendationQueryParams): string {
  const { boardType, layoutId, sizeId, angle, setIds } = params.target;
  const sets = setIds && setIds.length > 0 ? [...setIds].sort((left, right) => left - right).join(',') : 'all';
  const parts: Array<string | number> = ['rec-count', 'v1', params.type, boardType, layoutId, sizeId, sets, angle];
  if (params.gradeBand) parts.push(`${params.gradeBand.minDifficultyId}-${params.gradeBand.maxDifficultyId}`);
  return parts.join(':');
}

/**
 * The Discover card's "N climbs" label: candidates the viewer has not sent yet.
 *
 * The catalog half (every candidate, whoever asks) is the expensive part and is
 * the same for everyone on a board config, so it is cached in Redis for six
 * hours. The viewer half is how many of those candidates they have already
 * sent, read live from their own ticks. Catalog minus sent equals the NOT EXISTS
 * count exactly (checked on the replica across 16 config x type cases), so the
 * label stays exact per user; only the catalog half can be up to six hours old,
 * and a just-logged send lowers the label straight away.
 *
 * The playlist page keeps `countRecommendationClimbRefs`, uncached: its hero
 * count sits above the list it pages through and must match it.
 *
 * A miss runs on the caller's guarded transaction. `singleFlight` lets a
 * concurrent caller join that promise, which is safe because the leader awaits
 * it before its own transaction ends.
 */
export async function countRecommendationCardClimbs(
  type: RecommendationType,
  target: BoardTarget,
  userId: string,
  executor?: SerialPlanDb,
): Promise<number> {
  return onGuardedExecutor(executor, async (tx) => {
    const params = await buildParams(type, target, userId, tx);
    if (!params) return 0;

    const catalogCount = await readThroughRedis({
      key: recommendationCountCacheKey(params),
      ttlSeconds: RECOMMENDATION_COUNT_CACHE_TTL_SECONDS,
      label: 'RecommendationCount',
      load: async () => {
        const rows = rowsOf<{ count: number }>(
          await tx.execute(buildRecommendationCountSql({ ...params, excludeUserId: null })),
        );
        return Number(rows[0]?.count ?? 0);
      },
    });
    if (catalogCount === 0) return 0;

    const sentRows = rowsOf<{ count: number }>(await tx.execute(buildRecommendationSentOverlapSql(params, userId)));
    // Clamped: the catalog half can be hours old, so a climb that joined the
    // candidates since could count as sent without being in the total.
    return Math.max(0, catalogCount - Number(sentRows[0]?.count ?? 0));
  });
}
