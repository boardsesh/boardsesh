import { aggregateHoldUsage, ensureHoldIndex, getLocalUserId, type OfflineDatabase } from '@boardsesh/offline-sync';
import type { ClimbSearchInput, HoldStat } from '@boardsesh/shared-schema';
import { parseHoldRows } from '../../offline/hold-index-parser';
import { followedAuthorsLocalCondition } from './followed-authors-local';
import {
  buildJoinAndWhere,
  effectiveStatsSql,
  isCrossAngleStats,
  isOfflineSearchSupported,
} from './search-climbs-local';

type HoldSetRow = { holds: unknown; ascensionist_count?: number | null; display_difficulty?: number | null };

/**
 * On-device twin of the server's `holdHeatmap` (packages/db/src/queries/climbs/
 * hold-heatmap.ts): how often each hold is used by the climbs one search matches.
 *
 * The climb set is the climbs list's own — `buildJoinAndWhere` from
 * search-climbs-local.ts, with the same owner stamp and followed-authors
 * condition the list passes, so the personal-progress filters obey the
 * auth-scoping contract in docs/offline-reads.md — joined to the packed hold sets
 * of the device-derived holds index. The rows are folded in JS by
 * `aggregateHoldUsage` instead of a GROUP BY over per-hold rows (the index has
 * none; see holds-index/query.ts in @boardsesh/offline-sync).
 *
 * The index is brought up to date first; an interrupted build throws. Only listed, published, visible climbs
 * are indexed, which is also every climb the list can show outside a by-name
 * search; a by-name search that surfaces a community-hidden climb therefore
 * counts it in the list but not here.
 *
 * Returns [] for a search the device cannot express (the same
 * `isOfflineSearchSupported` gate as the list): the registration's
 * `canServeLocal` already declines those, so this is a second line only.
 */
export type HoldHeatmapLocalOptions = {
  /**
   * Read each climb's grade and ascent count too. Only the grade mode colours
   * by them; the count modes need nothing but the packed hold sets, so they
   * skip the two effective-stats columns (and the per-row fold of them).
   */
  withStats?: boolean;
};

export type HoldHeatmapLocalResult = {
  holdStats: HoldStat[];
  /** How many climbs the search matched and the aggregate folded: the legend's scope count. */
  climbCount: number;
};

export async function getHoldHeatmapLocal(
  db: OfflineDatabase,
  input: ClimbSearchInput,
  options: HoldHeatmapLocalOptions = {},
): Promise<HoldStat[]> {
  return (await getHoldHeatmapLocalWithCount(db, input, options)).holdStats;
}

/** `getHoldHeatmapLocal` plus the number of climbs it counted. */
export async function getHoldHeatmapLocalWithCount(
  db: OfflineDatabase,
  input: ClimbSearchInput,
  { withStats = true }: HoldHeatmapLocalOptions = {},
): Promise<HoldHeatmapLocalResult> {
  if (!isOfflineSearchSupported(input)) return { holdStats: [], climbCount: 0 };

  const build = await ensureHoldIndex(
    db,
    { boardType: input.boardName, layoutId: input.layoutId, sizeId: input.sizeId },
    { parseHoldRows },
  );
  // A partial index would undercount every hold. Throw so React Query retries
  // rather than caching a heatmap built from half the board.
  if (build.status === 'aborted') throw new Error('Hold heatmap: holds index build was interrupted');

  const ownerUserId = await getLocalUserId(db);
  const followedCondition = input.onlyFollowedAuthors ? await followedAuthorsLocalCondition(db) : undefined;
  const { joinSql, whereSql, joinBinds, whereBinds } = buildJoinAndWhere(input, ownerUserId, followedCondition);
  const crossAngle = isCrossAngleStats(input);
  const statsColumns = withStats
    ? `,
       ${effectiveStatsSql('ascensionist_count', crossAngle)} AS ascensionist_count,
       ${effectiveStatsSql('display_difficulty', crossAngle)} AS display_difficulty`
    : '';

  const rows = await db.getAllAsync<HoldSetRow>(
    `SELECT hs.holds${statsColumns}
     FROM board_climbs c
     JOIN holds_index_climbs hic ON hic.uuid = c.uuid
     JOIN board_climb_hold_sets hs ON hs.climb_id = hic.id
     ${joinSql}
     WHERE ${whereSql}`,
    [...joinBinds, ...whereBinds],
  );

  let climbCount = 0;
  const holdStats = holdUsageToStats(
    aggregateHoldUsage(
      (function* decodeRows() {
        for (const row of rows) {
          if (!(row.holds instanceof Uint8Array)) continue;
          climbCount++;
          yield {
            holds: row.holds,
            ascents: row.ascensionist_count ?? null,
            difficulty: row.display_difficulty ?? null,
          };
        }
      })(),
    ),
  );
  return { holdStats, climbCount };
}

/** The aggregate in the GraphQL `HoldStat` shape, ordered by hold id. */
export function holdUsageToStats(usage: ReturnType<typeof aggregateHoldUsage>): HoldStat[] {
  const stats: HoldStat[] = [];
  for (const [holdId, entry] of usage) {
    stats.push({
      holdId,
      totalUses: entry.uses,
      startingUses: entry.byRole[0],
      handUses: entry.byRole[1],
      footUses: entry.byRole[2],
      finishUses: entry.byRole[3],
      totalAscents: entry.ascentsSum,
      averageDifficulty: entry.difficultyCount > 0 ? entry.difficultySum / entry.difficultyCount : null,
    });
  }
  return stats.sort((left, right) => left.holdId - right.holdId);
}
