/**
 * Backfill script: assign inferred sessions to all historical unassigned ticks.
 *
 * Usage: bunx tsx src/scripts/backfill-inferred-sessions.ts
 *
 * Also migrates orphaned votes/comments that reference ungrouped session IDs
 * (like "ug:userId:groupNumber") to the corresponding inferred session IDs.
 */
import 'dotenv/config';
import { db } from '../db/client';
import { sql } from 'drizzle-orm';
import { executeFirstRow } from '@boardsesh/db/client';
import { runInferredSessionBuilderBatched } from '../jobs/inferred-session-builder';

async function main() {
  console.info('=== Backfill Inferred Sessions ===');

  // Check how many unassigned ticks exist
  const { count: unassignedCount = 0 } =
    (await executeFirstRow<{ count: number }>(
      db,
      sql`
    SELECT COUNT(*) AS count
    FROM boardsesh_ticks
    WHERE session_id IS NULL AND inferred_session_id IS NULL
  `,
    )) ?? {};

  console.info(`Found ${unassignedCount} unassigned ticks`);

  if (Number(unassignedCount) === 0) {
    console.info('No unassigned ticks to process');
  } else {
    // Process in batches until all ticks are assigned
    let totalAssigned = 0;
    let iteration = 0;

    while (true) {
      iteration++;
      console.info(`\nIteration ${iteration}...`);

      const result = await runInferredSessionBuilderBatched({ batchSize: 10000 });
      totalAssigned += result.ticksAssigned;

      console.info(`  Processed ${result.usersProcessed} users, assigned ${result.ticksAssigned} ticks`);

      if (result.ticksAssigned === 0) break;
    }

    console.info(`\nTotal ticks assigned: ${totalAssigned}`);
  }

  // Migrate orphaned votes/comments with "ug:" entity IDs
  console.info('\n=== Migrating orphaned ug: entity references ===');

  const voteResult = (await executeFirstRow<{ count: number }>(
    db,
    sql`
    SELECT COUNT(*) AS count FROM vote_counts
    WHERE entity_type = 'session' AND entity_id LIKE 'ug:%'
  `,
  )) ?? { count: 0 };

  const commentResult = (await executeFirstRow<{ count: number }>(
    db,
    sql`
    SELECT COUNT(*) AS count FROM comments
    WHERE entity_type = 'session' AND entity_id LIKE 'ug:%'
  `,
  )) ?? { count: 0 };

  console.info(`Found ${voteResult.count} orphaned vote_counts, ${commentResult.count} orphaned comments`);

  if (Number(voteResult.count) > 0 || Number(commentResult.count) > 0) {
    console.info('Note: These ug: references cannot be automatically migrated to inferred session IDs');
    console.info('because the mapping depends on the original ungrouped session computation.');
    console.info('Consider manually reviewing and either deleting or migrating these entries.');
  }

  // Verify final state
  const { count: remaining = 0 } =
    (await executeFirstRow<{ count: number }>(
      db,
      sql`
    SELECT COUNT(*) AS count
    FROM boardsesh_ticks
    WHERE session_id IS NULL AND inferred_session_id IS NULL
  `,
    )) ?? {};

  console.info(`\n=== Final state: ${remaining} unassigned ticks remaining ===`);

  process.exit(0);
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
