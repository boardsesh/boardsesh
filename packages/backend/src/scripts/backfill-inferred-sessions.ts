/**
 * Backfill script: assign inferred sessions to all historical unassigned ticks.
 *
 * Usage: bunx tsx src/scripts/backfill-inferred-sessions.ts
 *
 * Also migrates orphaned votes/comments that reference ungrouped session IDs
 * (like "ug:userId:groupNumber") to the corresponding inferred session IDs.
 */
import 'dotenv/config';
import { createRequestDb } from '../db/client';
import { sql } from 'drizzle-orm';
import { runInferredSessionBuilderBatched } from '../jobs/inferred-session-builder';

async function main() {
  const db = createRequestDb();
  console.log('=== Backfill Inferred Sessions ===');

  // Check how many unassigned ticks exist
  const [{ count: unassignedCount }] = await db.execute(sql`
    SELECT COUNT(*) AS count
    FROM boardsesh_ticks
    WHERE session_id IS NULL AND inferred_session_id IS NULL
  `).then((r) => (r as unknown as { rows: Array<{ count: number }> }).rows);

  console.log(`Found ${unassignedCount} unassigned ticks`);

  if (Number(unassignedCount) === 0) {
    console.log('No unassigned ticks to process');
  } else {
    // Process in batches until all ticks are assigned
    let totalAssigned = 0;
    let iteration = 0;

    while (true) {
      iteration++;
      console.log(`\nIteration ${iteration}...`);

      const result = await runInferredSessionBuilderBatched({ batchSize: 10000 });
      totalAssigned += result.ticksAssigned;

      console.log(`  Processed ${result.usersProcessed} users, assigned ${result.ticksAssigned} ticks`);

      if (result.ticksAssigned === 0) break;
    }

    console.log(`\nTotal ticks assigned: ${totalAssigned}`);
  }

  // Migrate orphaned votes/comments with "ug:" entity IDs
  console.log('\n=== Migrating orphaned ug: entity references ===');

  const [voteResult] = await db.execute(sql`
    SELECT COUNT(*) AS count FROM vote_counts
    WHERE entity_type = 'session' AND entity_id LIKE 'ug:%'
  `).then((r) => (r as unknown as { rows: Array<{ count: number }> }).rows);

  const [commentResult] = await db.execute(sql`
    SELECT COUNT(*) AS count FROM comments
    WHERE entity_type = 'session' AND entity_id LIKE 'ug:%'
  `).then((r) => (r as unknown as { rows: Array<{ count: number }> }).rows);

  console.log(`Found ${voteResult.count} orphaned vote_counts, ${commentResult.count} orphaned comments`);

  if (Number(voteResult.count) > 0 || Number(commentResult.count) > 0) {
    console.log('Note: These ug: references cannot be automatically migrated to inferred session IDs');
    console.log('because the mapping depends on the original ungrouped session computation.');
    console.log('Consider manually reviewing and either deleting or migrating these entries.');
  }

  // Verify final state
  const [{ count: remaining }] = await db.execute(sql`
    SELECT COUNT(*) AS count
    FROM boardsesh_ticks
    WHERE session_id IS NULL AND inferred_session_id IS NULL
  `).then((r) => (r as unknown as { rows: Array<{ count: number }> }).rows);

  console.log(`\n=== Final state: ${remaining} unassigned ticks remaining ===`);

  process.exit(0);
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
