/**
 * Fix orphaned climbs with NULL required_set_ids.
 *
 * The root cause is that shared sync discards placement data from Aurora.
 * The board_placements table was only populated from the initial APK dump
 * (June 2024), so any placements Aurora added since then are missing.
 *
 * This script:
 * 1. Reports how many climbs have NULL required_set_ids
 * 2. With --reset-sync: resets sync timestamps for placement-related tables
 *    to force the next shared sync to pull all historical data from Aurora
 * 3. After a sync runs, use backfill-required-set-ids.ts to populate the
 *    newly-fixable climbs
 *
 * Usage:
 *   bun run packages/db/scripts/fix-orphaned-climbs.ts [--board kilter] [--dry-run] [--reset-sync]
 */

import { sql } from 'drizzle-orm';
import { createScriptDb } from './db-connection.js';

function rows<T>(result: unknown): T[] {
  const r = result as { rows?: T[] };
  return Array.isArray(r) ? r : (r.rows ?? []);
}

const args = process.argv.slice(2);
const boardFilter = args.includes('--board') ? args[args.indexOf('--board') + 1] : undefined;
const dryRun = args.includes('--dry-run');
const resetSync = args.includes('--reset-sync');

// Tables that were previously discarded by shared sync and need their
// timestamps reset so Aurora sends all historical data on next sync
const TABLES_TO_RESET = ['holes', 'sets', 'layouts', 'placement_roles', 'placements', 'product_sizes_layouts_sets'];

async function main() {
  const { db, close } = createScriptDb();

  try {
    // Report current state
    console.log('=== Orphaned Climbs Report ===\n');

    const orphanedResult = await db.execute(sql`
      SELECT board_type, COUNT(*) as null_count
      FROM board_climbs
      WHERE required_set_ids IS NULL
        AND frames IS NOT NULL AND frames != ''
        AND board_type != 'moonboard'
      GROUP BY board_type
      ORDER BY board_type
    `);

    const orphaned = rows<{ board_type: string; null_count: string }>(orphanedResult);

    if (orphaned.length === 0) {
      console.log('No climbs with NULL required_set_ids found. Nothing to do.');
      return;
    }

    let totalOrphaned = 0;
    for (const o of orphaned) {
      if (boardFilter && o.board_type !== boardFilter) continue;
      const count = Number(o.null_count);
      totalOrphaned += count;
      console.log(`  ${o.board_type}: ${count.toLocaleString()} climbs with NULL required_set_ids`);
    }
    console.log(`  Total: ${totalOrphaned.toLocaleString()}\n`);

    // Show current sync timestamps
    console.log('=== Current Sync Timestamps ===\n');

    const tableNames = TABLES_TO_RESET.concat(['climbs']);
    const tableNamesArray = sql`ARRAY[${sql.join(
      tableNames.map((t) => sql`${t}`),
      sql`, `,
    )}]::text[]`;
    const syncTimesResult = await db.execute(sql`
      SELECT board_type, table_name, last_synchronized_at
      FROM board_shared_syncs
      WHERE table_name = ANY(${tableNamesArray})
      ORDER BY board_type, table_name
    `);

    const syncTimes = rows<{ board_type: string; table_name: string; last_synchronized_at: string }>(syncTimesResult);
    for (const st of syncTimes) {
      if (boardFilter && st.board_type !== boardFilter) continue;
      const isStale = TABLES_TO_RESET.includes(st.table_name);
      console.log(`  ${st.board_type} / ${st.table_name}: ${st.last_synchronized_at}${isStale ? ' (STALE)' : ''}`);
    }
    console.log('');

    // Diagnose: check if placements exist for orphaned climbs
    console.log('=== Diagnosis (sample of up to 500 climbs) ===\n');

    // Step 1: Get a sample of orphaned climbs
    const sampleResult = await db.execute(sql`
      SELECT uuid, board_type, layout_id, frames
      FROM board_climbs
      WHERE required_set_ids IS NULL
        AND frames IS NOT NULL AND frames != ''
        AND board_type != 'moonboard'
      LIMIT 500
    `);
    const sampleClimbs = rows<{ uuid: string; board_type: string; layout_id: number; frames: string }>(sampleResult);

    // Step 2: Extract all unique placement IDs referenced by these climbs
    const placementIdsByBoard = new Map<string, Set<number>>();
    const climbPlacementIds = new Map<string, { board_type: string; ids: number[] }>();

    for (const climb of sampleClimbs) {
      const ids: number[] = [];
      const matches = climb.frames.matchAll(/p(\d+)r/g);
      for (const match of matches) {
        ids.push(Number(match[1]));
      }
      climbPlacementIds.set(climb.uuid, { board_type: climb.board_type, ids });

      if (!placementIdsByBoard.has(climb.board_type)) {
        placementIdsByBoard.set(climb.board_type, new Set());
      }
      const boardSet = placementIdsByBoard.get(climb.board_type)!;
      for (const id of ids) boardSet.add(id);
    }

    // Step 3: Look up which placement IDs exist in board_placements
    const existingPlacements = new Map<string, Set<number>>(); // "board_type" -> Set of existing IDs

    for (const [boardType, idSet] of placementIdsByBoard) {
      const idsArr = [...idSet];
      const idsLiteral = sql`ARRAY[${sql.join(
        idsArr.map((id) => sql`${id}`),
        sql`, `,
      )}]::int[]`;
      const result = await db.execute(sql`
        SELECT id FROM board_placements
        WHERE board_type = ${boardType} AND id = ANY(${idsLiteral})
      `);
      existingPlacements.set(boardType, new Set(rows<{ id: number }>(result).map((r) => r.id)));
    }

    // Step 4: Categorize climbs
    const stats: Record<string, { total: number; allExist: number; hasMissing: number }> = {};

    for (const climb of sampleClimbs) {
      const bt = climb.board_type;
      if (boardFilter && bt !== boardFilter) continue;
      if (!stats[bt]) stats[bt] = { total: 0, allExist: 0, hasMissing: 0 };
      stats[bt].total++;

      const { ids } = climbPlacementIds.get(climb.uuid)!;
      const existing = existingPlacements.get(bt) ?? new Set();
      const missing = ids.filter((id) => !existing.has(id));

      if (missing.length === 0) {
        stats[bt].allExist++;
      } else {
        stats[bt].hasMissing++;
      }
    }

    for (const [bt, s] of Object.entries(stats)) {
      console.log(`  ${bt} (${s.total} sampled):`);
      console.log(`    All placements exist (backfill will fix): ${s.allExist}`);
      console.log(`    Missing placements (need Aurora sync):    ${s.hasMissing}`);
    }
    console.log('');

    if (!resetSync) {
      console.log('Run with --reset-sync to reset timestamps for stale tables.');
      console.log('After resetting, trigger a shared sync and then run backfill-required-set-ids.ts');
      return;
    }

    // Reset sync timestamps
    console.log('=== Resetting Sync Timestamps ===\n');

    if (dryRun) {
      console.log('DRY RUN — would reset the following tables:');
      for (const table of TABLES_TO_RESET) {
        console.log(`  ${boardFilter || 'all boards'} / ${table} → 1970-01-01 00:00:00.000000`);
      }
      return;
    }

    const defaultTimestamp = '1970-01-01 00:00:00.000000';

    for (const tableName of TABLES_TO_RESET) {
      if (boardFilter) {
        await db.execute(sql`
          UPDATE board_shared_syncs
          SET last_synchronized_at = ${defaultTimestamp}
          WHERE board_type = ${boardFilter}
            AND table_name = ${tableName}
        `);
        console.log(`  Reset ${boardFilter} / ${tableName}`);
      } else {
        await db.execute(sql`
          UPDATE board_shared_syncs
          SET last_synchronized_at = ${defaultTimestamp}
          WHERE table_name = ${tableName}
        `);
        console.log(`  Reset all boards / ${tableName}`);
      }
    }

    console.log('\nSync timestamps reset. Next steps:');
    console.log('  1. Deploy the shared-sync.ts changes (adds placement processing)');
    console.log('  2. Trigger a shared sync for kilter and tension');
    console.log('  3. Run: bun run packages/db/scripts/backfill-required-set-ids.ts');
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
