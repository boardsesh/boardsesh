import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { boardBetaLinks, boardClimbAliases, boardClimbs } from '../schema/boards/unified.js';
import { catalogClimbUuid, terminalCanonicalUuid } from './moonboard-catalog-helpers.js';
import { stageBetaLinks, type MoonBoardBetaVideoFile } from './moonboard-beta-links-helpers.js';
import type { ImportOptions } from './catalog.js';
export type { MoonBoardBetaVideoFile } from './moonboard-beta-links-helpers.js';
const BATCH_SIZE = 2000,
  LOOKUP_CHUNK = 5000;
const ROLLBACK = new Error('moonboard_beta_dry_run');
async function resolveClimbUuids(db: ReturnType<typeof drizzle>, problemIds: number[]): Promise<Map<number, string>> {
  // Pull the whole MoonBoard alias set rather than looking up the ids we need:
  // resolution has to WALK the chain (an alias can point at another alias), and
  // a per-id query cannot follow a hop it did not fetch. A few hundred thousand
  // short rows is cheap next to hanging beta off a climb nobody opens.
  const aliasRows = await db
    .select({ aliasUuid: boardClimbAliases.aliasUuid, canonicalUuid: boardClimbAliases.canonicalUuid })
    .from(boardClimbAliases)
    .where(eq(boardClimbAliases.boardType, 'moonboard'));
  const canonicalByAlias = new Map(aliasRows.map((row) => [row.aliasUuid, row.canonicalUuid]));

  const resolved = new Map<number, string>();
  for (const problemId of problemIds) {
    const aliasUuid = catalogClimbUuid({ id: problemId });
    // No alias row at all means we have never imported this problem.
    if (!canonicalByAlias.has(aliasUuid)) continue;
    // terminalCanonicalUuid returns undefined for a cyclic chain — a broken
    // redirect we refuse to reason about, same as the catalog importer.
    const canonicalUuid = terminalCanonicalUuid(aliasUuid, canonicalByAlias);
    if (canonicalUuid) resolved.set(problemId, canonicalUuid);
  }

  // Only attach beta to a climb row that exists. An alias can outlive its
  // target, and board_beta_links has no FK to catch that for us.
  const candidateUuids = [...new Set(resolved.values())];
  const liveUuids = new Set<string>();
  for (let i = 0; i < candidateUuids.length; i += LOOKUP_CHUNK) {
    const rows = await db
      .select({ uuid: boardClimbs.uuid })
      .from(boardClimbs)
      .where(
        and(
          eq(boardClimbs.boardType, 'moonboard'),
          inArray(boardClimbs.uuid, candidateUuids.slice(i, i + LOOKUP_CHUNK)),
        ),
      );
    for (const row of rows) liveUuids.add(row.uuid);
  }

  for (const [problemId, climbUuid] of resolved) {
    if (!liveUuids.has(climbUuid)) resolved.delete(problemId);
  }

  return resolved;
}

export async function applyMoonBoardBetaLinks(
  client: postgres.Sql,
  file: MoonBoardBetaVideoFile,
  options: ImportOptions & { requireResolved?: boolean } = {},
) {
  let report: Record<string, number> = {};
  try {
    await client.begin(async (connection) => {
      const tx = drizzle(Object.assign(connection, { options: client.options }) as unknown as postgres.Sql);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('moonboard-beta-import'))`);
      const canonicalUuidByProblemId = await resolveClimbUuids(tx, Object.keys(file.problems).map(Number));
      const existingRows = await tx
        .select({ videoIdentity: boardBetaLinks.videoIdentity })
        .from(boardBetaLinks)
        .where(isNotNull(boardBetaLinks.videoIdentity));
      const existingVideoIdentities = new Set(
        existingRows.flatMap((row) => (row.videoIdentity ? [row.videoIdentity] : [])),
      );
      const { rows, counters } = stageBetaLinks({ file, canonicalUuidByProblemId, existingVideoIdentities });
      if (options.requireResolved && (counters.unresolvedProblem || counters.rejectedUrl)) {
        throw new Error('Media contains unresolved problems or unsupported URLs');
      }
      const createdAt = new Date().toISOString();
      let inserted = 0;
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const insertedRows = await tx
          .insert(boardBetaLinks)
          .values(
            rows.slice(i, i + BATCH_SIZE).map((row) => ({
              boardType: 'moonboard',
              climbUuid: row.climbUuid,
              link: row.link,
              shortcode: row.shortcode,
              videoIdentity: row.videoIdentity,
              isListed: true,
              createdAt,
              // See the module header for why these stay null.
              thumbnail: null,
              foreignUsername: null,
              angle: null,
              tickUuid: null,
              boardId: null,
              createdByUserId: null,
            })),
          )
          // Backstop for the (board_type, climb_uuid, link) primary key. The
          // video_identity unique index is handled by the staging dedupe —
          // it cannot be an ON CONFLICT target here because a statement takes
          // only one, and the PK is the one a re-run actually hits.
          .onConflictDoNothing()
          .returning({ link: boardBetaLinks.link });
        inserted += insertedRows.length;
      }

      report = { ...counters, inserted };
      await options.beforeCommit?.(connection);
      if (options.dryRun) throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  return report;
}
