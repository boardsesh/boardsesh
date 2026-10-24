import {
  aggregateHoldUsage,
  decodeSqliteBlobHex,
  ensureHoldIndex,
  getLocalUserId,
  isScopeDownloadComplete,
  offlineBoardKey,
  readHoldIndexGeneration,
  type OfflineDatabase,
} from '@boardsesh/offline-sync';
import type { ClimbSearchInput, HoldStat } from '@boardsesh/shared-schema';
import { parseHoldRows } from '../../offline/hold-index-parser';
import { followedAuthorsLocalCondition } from './followed-authors-local';
import {
  buildJoinAndWhere,
  effectiveStatsSql,
  isCrossAngleStats,
  isOfflineSearchSupported,
} from './search-climbs-local';

const HOLD_HEATMAP_PAGE_CLIMBS = 1000;
type HoldSetRow = {
  climb_id: number;
  holds_hex: string | null;
  ascensionist_count?: number | null;
  display_difficulty?: number | null;
};

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

  const scope = { boardType: input.boardName, layoutId: input.layoutId, sizeId: input.sizeId };
  const scopeKey = offlineBoardKey(scope);
  const ownerUserId = await getLocalUserId(db);
  const generation = await readHoldIndexGeneration(db, input.boardName, input.layoutId);
  const build = await ensureHoldIndex(db, scope, { parseHoldRows });
  // A partial index would undercount every hold. Throw so React Query retries
  // rather than caching a heatmap built from half the board.
  if (build.status === 'aborted') throw new Error('Hold heatmap: holds index build was interrupted');

  if (build.status === 'not-downloaded') throw new Error('Hold heatmap: scope is no longer downloaded');

  const assertReadCurrent = async () => {
    if (
      (await getLocalUserId(db)) !== ownerUserId ||
      (await readHoldIndexGeneration(db, input.boardName, input.layoutId)) !== generation ||
      !(await isScopeDownloadComplete(db, scopeKey))
    ) {
      throw new Error('Hold heatmap: account or downloaded scope changed during read');
    }
  };
  const followedCondition = input.onlyFollowedAuthors ? await followedAuthorsLocalCondition(db) : undefined;
  const { joinSql, whereSql, joinBinds, whereBinds } = buildJoinAndWhere(input, ownerUserId, followedCondition);
  const crossAngle = isCrossAngleStats(input);
  const statsColumns = withStats
    ? `,
       ${effectiveStatsSql('ascensionist_count', crossAngle)} AS ascensionist_count,
       ${effectiveStatsSql('display_difficulty', crossAngle)} AS display_difficulty`
    : '';

  // Let SQLite choose the board/filter index once, rather than scanning every
  // downloaded board for each page. Only numeric IDs survive this query; fixing
  // the candidate set also prevents concurrent imports from extending the read.
  const readCandidateIds = async (): Promise<number[]> => {
    const candidates = await db.getAllAsync<{ climb_id: number }>(
      `SELECT hs.climb_id
       FROM board_climbs c
       JOIN holds_index_climbs hic ON hic.uuid = c.uuid
       JOIN board_climb_hold_sets hs ON hs.climb_id = hic.id
       ${joinSql}
       WHERE ${whereSql}`,
      [...joinBinds, ...whereBinds],
    );
    return candidates.map((candidate) => candidate.climb_id);
  };
  await assertReadCurrent();
  const candidateIds = await readCandidateIds();
  const usage = aggregateHoldUsage([]);
  let climbCount = 0;

  const foldPage = async (pageIds: number[]): Promise<void> => {
    // CROSS JOIN keeps these bounded primary-key lookups first, including when
    // filters stop matching during sync. Stats joins are 0/1 rows.
    // Text crosses Expo's bridge without one JNI global reference per BLOB.
    const rows = await db.getAllAsync<HoldSetRow>(
      `SELECT hs.climb_id, CASE WHEN typeof(hs.holds) = 'blob' THEN hex(hs.holds) ELSE NULL END AS holds_hex${statsColumns}
       FROM board_climb_hold_sets hs
       CROSS JOIN holds_index_climbs hic ON hic.id = hs.climb_id
       CROSS JOIN board_climbs c ON c.uuid = hic.uuid
       ${joinSql}
       WHERE (${whereSql}) AND hs.climb_id IN (${pageIds.map(() => '?').join(',')})`,
      [...joinBinds, ...whereBinds, ...pageIds],
    );
    aggregateHoldUsage(
      (function* decodeRows() {
        for (const row of rows) {
          const holds = decodeSqliteBlobHex(row.holds_hex);
          if (!holds) throw new Error('Hold heatmap: invalid encoded hold set');
          climbCount++;
          yield {
            holds,
            ascents: row.ascensionist_count ?? null,
            difficulty: row.display_difficulty ?? null,
          };
        }
      })(),
      usage,
    );
  };

  await assertReadCurrent();
  for (let offset = 0; offset < candidateIds.length; offset += HOLD_HEATMAP_PAGE_CLIMBS) {
    await foldPage(candidateIds.slice(offset, offset + HOLD_HEATMAP_PAGE_CLIMBS));
    await assertReadCurrent();
    if (offset + HOLD_HEATMAP_PAGE_CLIMBS >= candidateIds.length) break;
    // Only numeric candidate IDs and aggregates survive this yield.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    // Other async database work can run during the yield, including teardown.
    await assertReadCurrent();
  }
  return { holdStats: holdUsageToStats(usage), climbCount };
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
