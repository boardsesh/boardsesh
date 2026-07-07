import { recomputeClimbStats as recomputeClimbStatsCore } from '@boardsesh/db/queries';
import { db } from '../../../db/client';
import { logger } from '../../../utils/logger';

/**
 * Thin backend wrapper around the shared recompute in @boardsesh/db/queries.
 *
 * The SQL core (defensive seed, the ascensionist double-count guard, the
 * ownership-aware FA / difficulty rules, transaction semantics) lives in
 * packages/db/src/queries/climb-stats/recompute.ts so the sync daemons and the
 * backfill share exactly the same counting logic. This wrapper only adds the
 * single-key diff logging the debounced publisher has always emitted.
 *
 * Driven by the debounced publisher in debounced-climb-stats-publisher.ts.
 */

function shortUuid(uuid: string): string {
  return uuid.length > 8 ? uuid.slice(0, 8) : uuid;
}

function faStatusFor(prev: string | null, next: string | null): string {
  if (prev === next) return 'unchanged';
  if (prev === null && next !== null) return `set:${next}`;
  if (prev !== null && next === null) return 'cleared';
  return `changed:${prev}→${next}`;
}

export async function recomputeClimbStats(boardType: string, climbUuid: string, angle: number): Promise<void> {
  const diff = await recomputeClimbStatsCore(db, boardType, climbUuid, angle);

  if (diff) {
    const prevTotal = Number(diff.prev_total ?? 0);
    const newTotal = Number(diff.new_total ?? 0);
    const delta = newTotal - prevTotal;
    const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;
    const faStatus = faStatusFor(diff.prev_fa, diff.new_fa);
    logger.info(
      `[recomputeClimbStats] ${boardType}/${shortUuid(climbUuid)}/${angle} ` +
        `boardsesh=${Number(diff.new_bs ?? 0)} total=${newTotal} delta=${deltaStr} ` +
        `fa=${faStatus}`,
    );
  }
}
