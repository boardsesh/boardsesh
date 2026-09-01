/**
 * Backfill required_set_ids and compatible_size_ids on board_climbs.
 *
 * Default mode finds climbs where either denormalized column is NULL and
 * populates them in batches. With --all, recomputes both columns for every
 * climb of the targeted board(s) regardless of NULL state — useful after
 * Aurora introduces a new layout / product size, since existing climbs'
 * compatible_size_ids arrays won't include the new IDs until recomputed.
 *
 * Both modes call populateDenormalizedColumns() in batches and are safe to
 * re-run (idempotent).
 *
 * Usage:
 *   vp exec tsx packages/db/scripts/backfill-required-set-ids.ts [--board kilter] [--batch-size 500] [--all] [--dry-run]
 */

import { sql } from 'drizzle-orm';
import { createScriptDb } from './db-connection.js';
import { executeRows } from '../src/client/index.js';
import { populateDenormalizedColumns } from '../src/queries/climbs/populate-denormalized-columns.js';

const args = process.argv.slice(2);
const boardFilter = args.includes('--board') ? args[args.indexOf('--board') + 1] : undefined;
const batchSize = args.includes('--batch-size') ? Number(args[args.indexOf('--batch-size') + 1]) : 500;
const dryRun = args.includes('--dry-run');
const all = args.includes('--all');

async function main() {
  const { db, close } = createScriptDb();

  try {
    // Discover boards eligible for backfill. In --all mode this counts every
    // climb (sans NULL filter) so progress reporting reflects the full pass.
    const heading = all ? 'Eligible climbs (full recompute):' : 'Climbs with NULL denormalized columns:';
    const emptyMessage = all
      ? 'No eligible climbs found. Nothing to do.'
      : 'No climbs with NULL denormalized columns found. Nothing to do.';

    const boardTypes = await executeRows<{ board_type: string; eligible_count: string }>(
      db,
      all
        ? sql`
        SELECT board_type, COUNT(*) as eligible_count
        FROM board_climbs
        WHERE frames IS NOT NULL
          AND frames != ''
          AND board_type != 'moonboard'
        GROUP BY board_type
        ORDER BY board_type
      `
        : sql`
        SELECT board_type, COUNT(*) as eligible_count
        FROM board_climbs
        WHERE (required_set_ids IS NULL OR compatible_size_ids IS NULL)
          AND frames IS NOT NULL
          AND frames != ''
          AND board_type != 'moonboard'
        GROUP BY board_type
        ORDER BY board_type
      `,
    );

    if (boardTypes.length === 0) {
      console.info(emptyMessage);
      return;
    }

    console.info(heading);
    for (const bt of boardTypes) {
      console.info(`  ${bt.board_type}: ${Number(bt.eligible_count).toLocaleString()}`);
    }
    console.info('');

    if (dryRun) {
      console.info('Dry run — no changes will be made.');
      return;
    }

    for (const bt of boardTypes) {
      if (boardFilter && bt.board_type !== boardFilter) continue;

      const totalEligible = Number(bt.eligible_count);
      let processed = 0;

      console.info(`\nBackfilling ${bt.board_type} (${totalEligible.toLocaleString()} climbs)...`);

      if (all) {
        // Keyset pagination by uuid — there's no shrinking predicate to
        // exclude already-processed rows, so iterate through the whole table
        // in stable order and advance the cursor each batch.
        let cursor = '';
        while (true) {
          const batchRows = await executeRows<{ uuid: string }>(
            db,
            sql`
            SELECT uuid
            FROM board_climbs
            WHERE board_type = ${bt.board_type}
              AND uuid > ${cursor}
              AND frames IS NOT NULL
              AND frames != ''
            ORDER BY uuid
            LIMIT ${batchSize}
          `,
          );

          const uuids = batchRows.map((r) => r.uuid);
          if (uuids.length === 0) break;

          await populateDenormalizedColumns(db, bt.board_type, uuids);
          processed += uuids.length;
          cursor = uuids[uuids.length - 1];

          const pct = totalEligible > 0 ? ((processed / totalEligible) * 100).toFixed(1) : '100';
          console.info(`  ${processed.toLocaleString()} / ${totalEligible.toLocaleString()} (${pct}%)`);

          if (uuids.length < batchSize) break;
        }
      } else {
        while (true) {
          // Fetch a batch of UUIDs with NULL denormalized columns. The NULL
          // predicate doubles as the termination condition — once
          // populateDenormalizedColumns flips the columns NOT NULL, those
          // rows drop out of the result set.
          const batchRows = await executeRows<{ uuid: string }>(
            db,
            sql`
            SELECT uuid
            FROM board_climbs
            WHERE board_type = ${bt.board_type}
              AND (required_set_ids IS NULL OR compatible_size_ids IS NULL)
              AND frames IS NOT NULL
              AND frames != ''
            LIMIT ${batchSize}
          `,
          );

          const uuids = batchRows.map((r) => r.uuid);
          if (uuids.length === 0) break;

          await populateDenormalizedColumns(db, bt.board_type, uuids);
          processed += uuids.length;

          const pct = totalEligible > 0 ? ((processed / totalEligible) * 100).toFixed(1) : '100';
          console.info(`  ${processed.toLocaleString()} / ${totalEligible.toLocaleString()} (${pct}%)`);
        }
      }

      console.info(`  Done — ${processed.toLocaleString()} climbs updated.`);
    }

    if (all) {
      // The NULL-count verification is meaningless after --all: by definition
      // every eligible climb just had its columns recomputed from current
      // dependency state, so any remaining NULLs are the rows
      // populateDenormalizedColumns chose not to update (e.g. climbs with
      // unparseable frames). The per-board "Done" lines above are the summary.
      return;
    }

    console.info('\nVerification:');
    const remaining = await executeRows<{ board_type: string; remaining: string }>(
      db,
      sql`
      SELECT board_type, COUNT(*) as remaining
      FROM board_climbs
      WHERE (required_set_ids IS NULL OR compatible_size_ids IS NULL)
        AND frames IS NOT NULL
        AND frames != ''
        AND board_type != 'moonboard'
      GROUP BY board_type
      ORDER BY board_type
    `,
    );

    if (remaining.length === 0) {
      console.info('  All denormalized columns populated.');
    } else {
      for (const r of remaining) {
        console.info(`  ${r.board_type}: ${Number(r.remaining).toLocaleString()} still NULL`);
      }
    }
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
