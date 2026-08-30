/**
 * Backfill `board_climbs.hold_fingerprint` from existing `board_climb_holds`
 * rows, and insert a self-alias row into `board_climb_aliases` for every
 * climb so downstream `resolveCanonicalClimbUuid` lookups never miss.
 *
 * The fingerprint is sha256 of sorted (hold_id:hold_state:frame_number)
 * tuples joined with '|'. Kilter-sync uses it to detect duplicate climbs
 * (same physical layout, different UUIDs) and route them through aliases.
 *
 * Idempotent: re-running over the same data writes the same fingerprint;
 * alias inserts use `ON CONFLICT … DO UPDATE` to refresh `last_seen_at` so
 * a re-run still records the touch.
 *
 * Usage:
 *   vp exec tsx packages/db/scripts/backfill-hold-fingerprints.ts [--board kilter] [--batch-size 500] [--dry-run]
 */

import { createHash } from 'crypto';
import { sql } from 'drizzle-orm';
import { createScriptDb } from './db-connection.js';
import { executeRows, executeCommandCount } from '../src/client/index.js';

const args = process.argv.slice(2);
const boardFilter = args.includes('--board') ? args[args.indexOf('--board') + 1] : undefined;

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

type JoinedRow = {
  board_type: string;
  uuid: string;
  hold_id: number;
  frame_number: number;
  hold_state: string;
};

type HoldTuple = Pick<JoinedRow, 'hold_id' | 'frame_number' | 'hold_state'>;

function fingerprintFromHolds(holds: HoldTuple[]): string {
  const tuples = holds
    .map((r) => `${r.hold_id}:${r.hold_state}:${r.frame_number}`)
    .sort()
    .join('|');
  return createHash('sha256').update(tuples).digest('hex');
}

async function main() {
  const { db, close } = createScriptDb();

  const boardClause = boardFilter ? sql`AND bc.board_type = ${boardFilter}` : sql``;

  let totalProcessed = 0;
  let totalFingerprinted = 0;
  let totalAliasesTouched = 0;

  // Single JOIN per batch — fetches every hold row for every candidate climb
  // in one round trip. Previously we did N+1: one query for candidates, then
  // one SELECT per climb for its holds. At ~10k climbs that's 10k round
  // trips through pgbouncer; this loops with O(batch_size) trips total.
  // Trade-off: each batch can return up to batch_size × max_holds_per_climb
  // rows. With batch_size=500 and ≤30 holds per climb, ≤15k rows per batch
  // — comfortably small.
  for (;;) {
    const rows = await executeRows<JoinedRow>(
      db,
      sql`
        WITH candidates AS (
          SELECT bc.board_type, bc.uuid
            FROM board_climbs bc
           WHERE bc.hold_fingerprint IS NULL
             ${boardClause}
             AND EXISTS (
               SELECT 1 FROM board_climb_holds h
                WHERE h.board_type = bc.board_type
                  AND h.climb_uuid = bc.uuid
             )
           ORDER BY bc.board_type, bc.uuid
           LIMIT ${batchSize}
        )
        SELECT c.board_type,
               c.uuid,
               h.hold_id,
               h.frame_number,
               h.hold_state
          FROM candidates c
          JOIN board_climb_holds h
            ON h.board_type = c.board_type
           AND h.climb_uuid = c.uuid
         ORDER BY c.board_type, c.uuid
      `,
    );

    if (rows.length === 0) break;

    // Group by (board_type, climb_uuid) — rows are already sorted by the
    // ORDER BY above, so we can do a single linear pass.
    type ClimbGroup = { boardType: string; uuid: string; holds: HoldTuple[] };
    const groups: ClimbGroup[] = [];
    for (const row of rows) {
      const last = groups[groups.length - 1];
      if (last && last.boardType === row.board_type && last.uuid === row.uuid) {
        last.holds.push({ hold_id: row.hold_id, frame_number: row.frame_number, hold_state: row.hold_state });
      } else {
        groups.push({
          boardType: row.board_type,
          uuid: row.uuid,
          holds: [{ hold_id: row.hold_id, frame_number: row.frame_number, hold_state: row.hold_state }],
        });
      }
    }

    for (const { boardType, uuid, holds } of groups) {
      const fingerprint = fingerprintFromHolds(holds);

      if (!dryRun) {
        const updated = await executeCommandCount(
          db,
          sql`
            UPDATE board_climbs
               SET hold_fingerprint = ${fingerprint}
             WHERE board_type = ${boardType}
               AND uuid       = ${uuid}
               AND hold_fingerprint IS NULL
          `,
        );
        if ((updated ?? 0) > 0) totalFingerprinted++;

        // Self-alias for every climb so resolveCanonicalClimbUuid always
        // hits. Refresh last_seen_at on re-runs so the column reflects
        // the most recent touch instead of always equalling first_seen_at.
        const touched = await executeCommandCount(
          db,
          sql`
            INSERT INTO board_climb_aliases (board_type, alias_uuid, canonical_uuid, source)
            VALUES (${boardType}, ${uuid}, ${uuid}, 'backfill')
            ON CONFLICT (board_type, alias_uuid)
              DO UPDATE SET last_seen_at = NOW()
          `,
        );
        if ((touched ?? 0) > 0) totalAliasesTouched++;
      }

      totalProcessed++;
    }

    process.stdout.write(
      `Processed ${totalProcessed} climbs (fingerprinted ${totalFingerprinted}, aliases touched ${totalAliasesTouched})\r`,
    );
  }

  process.stdout.write('\n');
  console.log(
    `Done. ${totalProcessed} climbs scanned, ${totalFingerprinted} fingerprints written, ${totalAliasesTouched} self-aliases touched.`,
  );
  if (dryRun) console.log('(dry run — no writes)');

  await close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
