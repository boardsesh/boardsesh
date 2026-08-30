/**
 * Backfill `board_climb_holds` rows for legacy climbs that have a `frames`
 * text blob but no corresponding rows in the holds table.
 *
 * Aurora's sync historically wrote `frames` directly to `board_climbs` and
 * relied on the search hot path to parse it on every query. PR #2183
 * introduced the duplicate gate and the similar-climbs feature, both of
 * which read from `board_climb_holds` instead — so ~8.9k pre-existing
 * climbs are invisible to those features until their hold rows are
 * materialised.
 *
 * This script parses each affected climb's frames and inserts the rows.
 * Idempotent via `ON CONFLICT DO NOTHING` on the PK
 * (board_type, climb_uuid, hold_id).
 *
 * Usage:
 *   vp exec tsx packages/db/scripts/backfill-board-climb-holds.ts [--board kilter] [--batch-size 500] [--dry-run]
 */

import { sql } from 'drizzle-orm';
import { convertLitUpHoldsStringToMap, isSentinelHoldState } from '@boardsesh/board-constants/hold-states';
import type { BoardName } from '@boardsesh/shared-schema';
import { createScriptDb } from './db-connection.js';
import { executeRows, executeCommandCount } from '../src/client/index.js';

const args = process.argv.slice(2);
const boardFilter = args.includes('--board') ? args[args.indexOf('--board') + 1] : undefined;

// Parse --batch-size with explicit validation so `--batch-size foo` or a
// trailing `--batch-size` doesn't silently produce NaN and stall the loop
// (the SQL LIMIT clause would then ship with NaN, the runtime would
// coerce, and progress reporting would be misleading either way).
function parseBatchSize(): number {
  if (!args.includes('--batch-size')) return 500;
  const raw = args[args.indexOf('--batch-size') + 1];
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    console.error(`Invalid --batch-size value: ${raw ?? '(missing)'}. Expected a positive integer.`);
    process.exit(2);
  }
  return parsed;
}
const batchSize = parseBatchSize();
const dryRun = args.includes('--dry-run');

type ParsedHold = {
  holdId: number;
  frameNumber: number;
  holdState: string;
};

/**
 * Mirrors `parseFramesToHoldEntries` in
 * `packages/backend/src/graphql/resolvers/climbs/climb-similarity.ts` — kept
 * inline here because `@boardsesh/db` does not depend on the backend
 * package. If you tweak the parser's behaviour, update both sites.
 */
function parseFrames(boardType: BoardName, frames: string): ParsedHold[] {
  if (!frames) return [];
  const frameMap = convertLitUpHoldsStringToMap(frames, boardType);
  const rows: ParsedHold[] = [];
  for (const [frameIndexKey, holdsMap] of Object.entries(frameMap)) {
    const frameNumber = Number(frameIndexKey);
    for (const [holdIdKey, hold] of Object.entries(holdsMap)) {
      if (isSentinelHoldState(hold.state)) continue;
      const holdId = Number(holdIdKey);
      if (!Number.isFinite(holdId)) continue;
      rows.push({ frameNumber, holdId, holdState: hold.state });
    }
  }
  return rows;
}

async function main() {
  const { db, close } = createScriptDb();

  try {
    // Find climbs with frames but no board_climb_holds rows, grouped by board.
    // Restrict to single-frame climbs — multi-frame parsing is the same code
    // path but the duplicate-gate / similar-climbs features only consume
    // single-frame holds today, and backfilling multi-frame would silently
    // double the row count for legitimate dynos that already have entries.
    const boardTypes = await executeRows<{ board_type: string; eligible_count: string }>(
      db,
      sql`
        SELECT bc.board_type, COUNT(*) as eligible_count
        FROM board_climbs bc
        WHERE bc.frames IS NOT NULL
          AND bc.frames != ''
          AND bc.frames_count = 1
          AND bc.board_type != 'moonboard'
          AND NOT EXISTS (
            SELECT 1 FROM board_climb_holds h
            WHERE h.board_type = bc.board_type
              AND h.climb_uuid = bc.uuid
          )
        GROUP BY bc.board_type
        ORDER BY bc.board_type
      `,
    );

    if (boardTypes.length === 0) {
      console.info('No climbs need a holds backfill. Nothing to do.');
      return;
    }

    console.info('Climbs missing board_climb_holds rows:');
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
      let inserted = 0;
      let skippedUnparseable = 0;

      console.info(`\nBackfilling ${bt.board_type} (${totalEligible.toLocaleString()} climbs)...`);

      while (true) {
        // The NOT EXISTS predicate doubles as the termination condition —
        // once we insert holds for a batch, those climbs drop out of the
        // next query naturally. No keyset cursor needed.
        const batchRows = await executeRows<{ uuid: string; frames: string }>(
          db,
          sql`
            SELECT bc.uuid, bc.frames
            FROM board_climbs bc
            WHERE bc.board_type = ${bt.board_type}
              AND bc.frames IS NOT NULL
              AND bc.frames != ''
              AND bc.frames_count = 1
              AND NOT EXISTS (
                SELECT 1 FROM board_climb_holds h
                WHERE h.board_type = bc.board_type
                  AND h.climb_uuid = bc.uuid
              )
            LIMIT ${batchSize}
          `,
        );

        if (batchRows.length === 0) break;

        const rowsToInsert: Array<{
          board_type: string;
          climb_uuid: string;
          hold_id: number;
          frame_number: number;
          hold_state: string;
        }> = [];

        for (const climb of batchRows) {
          const parsed = parseFrames(bt.board_type as BoardName, climb.frames);
          if (parsed.length === 0) {
            // Unparseable frames text — log and skip. These rows will stay
            // out of the duplicate gate / similar-climbs index; without a
            // real frame we can't do better here.
            skippedUnparseable += 1;
            continue;
          }
          for (const hold of parsed) {
            rowsToInsert.push({
              board_type: bt.board_type,
              climb_uuid: climb.uuid,
              hold_id: hold.holdId,
              frame_number: hold.frameNumber,
              hold_state: hold.holdState,
            });
          }
        }

        if (rowsToInsert.length > 0) {
          // Build a single multi-row VALUES INSERT inside drizzle's sql
          // template. Doing this in one statement (rather than per-row) keeps
          // network round-trips proportional to batch count, not row count —
          // a 500-climb batch with ~12 holds each is 6k row inserts that
          // would otherwise be 6k separate round-trips.
          const valuesFragments = rowsToInsert.map(
            (row) =>
              sql`(${row.board_type}, ${row.climb_uuid}, ${row.hold_id}, ${row.frame_number}, ${row.hold_state})`,
          );
          const insertCount = await executeCommandCount(
            db,
            sql`
              INSERT INTO board_climb_holds
                (board_type, climb_uuid, hold_id, frame_number, hold_state)
              VALUES ${sql.join(valuesFragments, sql`, `)}
              ON CONFLICT (board_type, climb_uuid, hold_id) DO NOTHING
            `,
          );
          inserted += insertCount ?? 0;
        }

        processed += batchRows.length;
        const pct = totalEligible > 0 ? ((processed / totalEligible) * 100).toFixed(1) : '100';
        console.info(
          `  ${processed.toLocaleString()} / ${totalEligible.toLocaleString()} (${pct}%) — ${inserted.toLocaleString()} hold rows inserted`,
        );

        if (batchRows.length < batchSize) break;
      }

      console.info(
        `  Done — ${processed.toLocaleString()} climbs processed, ${inserted.toLocaleString()} hold rows inserted, ${skippedUnparseable.toLocaleString()} skipped (unparseable frames).`,
      );
    }

    console.info('\nVerification:');
    const remaining = await executeRows<{ board_type: string; remaining: string }>(
      db,
      sql`
        SELECT bc.board_type, COUNT(*) as remaining
        FROM board_climbs bc
        WHERE bc.frames IS NOT NULL
          AND bc.frames != ''
          AND bc.frames_count = 1
          AND bc.board_type != 'moonboard'
          AND NOT EXISTS (
            SELECT 1 FROM board_climb_holds h
            WHERE h.board_type = bc.board_type
              AND h.climb_uuid = bc.uuid
          )
        GROUP BY bc.board_type
        ORDER BY bc.board_type
      `,
    );

    if (remaining.length === 0) {
      console.info('  All eligible climbs have board_climb_holds rows.');
    } else {
      for (const r of remaining) {
        console.info(`  ${r.board_type}: ${Number(r.remaining).toLocaleString()} still missing (unparseable frames)`);
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
