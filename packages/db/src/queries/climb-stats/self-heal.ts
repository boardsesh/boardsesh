import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { recomputeClimbStatsBulk, type ClimbStatsKey } from './recompute';
import { rowsOf } from '../util/rows';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

// How far back to look for flash/send ticks that outran their stats row. The
// in-process debounced recompute (setTimeout) is the thing that can be dropped
// by a deploy, and its debounce is seconds — so a dropped recompute leaves a
// tick at most a few minutes ahead of its stats row. The daemon runs this
// self-heal hourly AND immediately after a restart (its in-memory gate resets),
// so a short lookback comfortably covers the drop-to-heal latency; a wider
// window would just re-touch no-op keys (a tick that changed nothing bumps the
// tick's updated_at but, via the WHEN-guarded trigger, not the stats row's, so
// it reads as "stale" until it ages out of this window). Bounded either way by
// the LIMIT.
const SELF_HEAL_LOOKBACK_HOURS = 3;
const SELF_HEAL_BATCH = 5000;

export type SelfHealResult = { keysHealed: number };

/**
 * The keys one self-heal pass would re-derive: flash/send ticks updated within
 * the lookback window more recently than the board_climb_stats row they feed
 * (the signature of a debounced recompute that a deploy dropped, or of a
 * deferred sync recompute a crash lost). Bounded by the recent-tick window
 * (served by boardsesh_ticks_flash_send_updated_at_idx) and a hard LIMIT.
 */
export async function findStaleClimbStatsKeys(
  db: DrizzleDb,
  opts: { limit?: number; lookbackHours?: number } = {},
): Promise<ClimbStatsKey[]> {
  const limit = opts.limit ?? SELF_HEAL_BATCH;
  const lookbackHours = opts.lookbackHours ?? SELF_HEAL_LOOKBACK_HOURS;

  const rows = rowsOf<{ board_type: string; climb_uuid: string; angle: number }>(
    await db.execute(sql`
      SELECT DISTINCT bt.board_type, bt.climb_uuid, bt.angle
        FROM boardsesh_ticks bt
        JOIN board_climb_stats s
          ON s.board_type = bt.board_type
         AND s.climb_uuid = bt.climb_uuid
         AND s.angle      = bt.angle
       WHERE bt.status IN ('flash','send')
         AND bt.updated_at > now() - (${lookbackHours} * interval '1 hour')
         AND bt.updated_at > s.updated_at
       LIMIT ${limit}
    `),
  );

  return rows.map((row) => ({
    boardType: row.board_type,
    climbUuid: row.climb_uuid,
    angle: row.angle,
  }));
}

/**
 * One bounded pass of the recompute self-heal: find the stale keys
 * ({@link findStaleClimbStatsKeys}) and re-derive them with
 * recomputeClimbStatsBulk. One pass is cheap and never runs away.
 */
export async function selfHealStaleClimbStats(
  db: DrizzleDb,
  opts: { limit?: number; lookbackHours?: number } = {},
): Promise<SelfHealResult> {
  const keys = await findStaleClimbStatsKeys(db, opts);
  if (keys.length === 0) return { keysHealed: 0 };
  await recomputeClimbStatsBulk(db, keys);
  return { keysHealed: keys.length };
}
