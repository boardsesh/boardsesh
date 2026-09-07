import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { boardBetaLinks, boardClimbAliases, boardClimbs } from '../src/schema/boards/unified.js';
import { createScriptDb, describeDatabaseHost, getScriptDatabaseUrl } from './db-connection.js';
import { catalogClimbUuid, terminalCanonicalUuid } from './moonboard-catalog-helpers.js';
import { stageBetaLinks, type MoonBoardBetaVideoFile } from './moonboard-beta-links-helpers.js';

// =============================================================================
// MoonBoard beta-video import
// =============================================================================
// The MoonBoard app lists the Instagram clips people have filmed on a problem.
// This imports them into board_beta_links so they show on the climb page next
// to Boardsesh's own beta.
//
// Run AFTER import-moonboard-catalog.ts: a problem the catalog import just
// inserted has no alias row until that run commits, and an unresolved problem
// is skipped rather than guessed at.
//
//   DB_URL=<target> vp run '@boardsesh/db#db:import-moonboard-beta-links' \
//     /path/to/beta-video-links.json [--dry-run]
//
// WHAT WE DELIBERATELY DO NOT IMPORT:
//   thumbnail       — the capture carries MoonBoard CDN URLs. The beta-video
//                     resolver ignores any thumbnail that is not ours and
//                     caches its own copy to R2 on first render, so a foreign
//                     URL would be dead weight that also makes the column lie.
//   foreignUsername — not in the capture; the same resolver fills it from live
//                     metadata the first time someone opens the climb.
//   angle           — MoonBoard beta is per-problem, and the betaLinks query
//                     never filters on it.
// =============================================================================

// board_beta_links is narrow (13 columns), so a larger batch than the catalog
// importer's 2000 still sits far under Postgres's 65,535 bind-param limit.
const BATCH_SIZE = 2000;
// Alias lookups are an IN list; keep each one comfortably parameterised.
const LOOKUP_CHUNK = 5000;

const VALUE_FLAGS = new Set<string>();
const BOOLEAN_FLAGS = new Set(['--dry-run']);

// Thrown to abort a --dry-run transaction after the writes have been attempted.
const DRY_RUN_ROLLBACK = new Error('__dry_run_rollback__');

export type BetaLinksCliArgs = { positional: string[]; dryRun: boolean };

/**
 * Parse argv, rejecting anything unrecognised — a silently-ignored `-dry-run`
 * would commit a rehearsal to production. Mirrors the catalog importer.
 */
export function parseBetaLinksCliArgs(argv: string[]): BetaLinksCliArgs {
  const positional: string[] = [];
  let dryRun = false;

  for (const arg of argv) {
    // `vp run ... -- --dry-run` forwards the separator verbatim.
    if (arg === '--') continue;
    if (BOOLEAN_FLAGS.has(arg)) {
      dryRun = true;
      continue;
    }
    if (VALUE_FLAGS.has(arg)) throw new Error(`${arg} needs a value`);
    if (arg.startsWith('-')) throw new Error(`Unknown flag: ${arg}`);
    positional.push(arg);
  }

  return { positional, dryRun };
}

/**
 * MoonBoard problem id → the canonical climb uuid it resolves to today.
 *
 * Goes through `board_climb_aliases` rather than assuming the id-based uuid IS
 * the climb: the catalog import's non-destructive merge routinely parks a
 * problem on a pre-existing uuid and records that as an alias. Following the
 * chain to its terminal canonical means beta lands on the climb people actually
 * open, not on a redirect.
 */
async function resolveClimbUuids(
  db: ReturnType<typeof createScriptDb>['db'],
  problemIds: number[],
): Promise<Map<number, string>> {
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

async function importMoonBoardBetaLinks() {
  let cli: BetaLinksCliArgs;
  try {
    cli = parseBetaLinksCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`❌ ${(error as Error).message}`);
    console.error(
      "   Usage: vp run '@boardsesh/db#db:import-moonboard-beta-links' /path/to/beta-video-links.json [--dry-run]",
    );
    process.exit(1);
  }

  const sourcePath = cli.positional[0];
  if (!sourcePath) {
    console.error('❌ Path to the beta-video-links JSON is required.');
    process.exit(1);
  }
  const resolvedPath = path.resolve(process.cwd(), sourcePath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`❌ File not found: ${resolvedPath}`);
    process.exit(1);
  }

  const databaseUrl = getScriptDatabaseUrl();
  console.info(`🔄 Importing MoonBoard beta links to: ${describeDatabaseHost(databaseUrl)}`);
  console.info(`📂 Reading: ${resolvedPath}`);
  if (cli.dryRun) {
    console.info('🧪 DRY RUN — every write is attempted and then rolled back. Nothing is committed.');
  }

  const file: MoonBoardBetaVideoFile = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
  const problemIds = Object.keys(file.problems).map(Number).filter(Number.isInteger);
  console.info(`   ${problemIds.length} problems declare beta in the capture`);

  const { db, close } = createScriptDb();
  try {
    console.info('   Resolving problem ids to climbs...');
    const canonicalUuidByProblemId = await resolveClimbUuids(db, problemIds);
    console.info(`   ${canonicalUuidByProblemId.size} resolved to a live climb`);

    console.info('   Loading existing video identities...');
    const existingRows = await db
      .select({ videoIdentity: boardBetaLinks.videoIdentity })
      .from(boardBetaLinks)
      .where(isNotNull(boardBetaLinks.videoIdentity));
    const existingVideoIdentities = new Set(
      existingRows.map((row) => row.videoIdentity).filter((identity): identity is string => identity !== null),
    );
    console.info(`   ${existingVideoIdentities.size} videos already attached somewhere`);

    const { rows, counters, unresolvedProblemIds, contestedVideoIds } = stageBetaLinks({
      file,
      canonicalUuidByProblemId,
      existingVideoIdentities,
    });

    console.info(
      `\n   ${counters.sourceLinks} links in capture → ${counters.staged} to insert; ` +
        `${counters.alreadyPresent} already attached, ${counters.duplicateInFile} duplicate videos, ` +
        `${counters.unresolvedProblem} on unresolved problems, ${counters.rejectedUrl} rejected URLs`,
    );
    if (unresolvedProblemIds.length > 0) {
      console.warn(`   ⚠️  Unresolved problem ids (first few): ${unresolvedProblemIds.join(', ')}`);
      console.warn('      Run the catalog import first — a problem gets its alias row there.');
    }
    for (const contested of contestedVideoIds) {
      console.info(
        `   Video ${contested.videoIdentity} claimed by problems ${contested.keptProblemId} and ` +
          `${contested.droppedProblemId}; awarded to ${contested.keptProblemId} (lower id).`,
      );
    }

    // One transaction for the whole file: it is a single logical import and
    // small enough (tens of thousands of narrow rows) that an all-or-nothing
    // run beats a partially-attached catalog.
    const createdAt = new Date().toISOString();
    let inserted = 0;
    try {
      await db.transaction(async (tx) => {
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
        if (cli.dryRun) throw DRY_RUN_ROLLBACK;
      });
    } catch (error) {
      if (error !== DRY_RUN_ROLLBACK) throw error;
    }

    const [{ total }] = await db
      .select({ total: sql<string>`count(*)::text` })
      .from(boardBetaLinks)
      .where(eq(boardBetaLinks.boardType, 'moonboard'));

    console.info(cli.dryRun ? '\n🧪 Dry run completed — nothing was committed.' : '\n✅ Import completed!');
    console.info(`   Rows inserted:  ${inserted}`);
    console.info(`   MoonBoard beta links now in the database: ${total}`);
    console.info(
      `   Climbs with beta: ${new Set(rows.map((row) => row.climbUuid)).size} touched by this run` +
        (cli.dryRun ? ' (had it committed)' : ''),
    );
  } finally {
    await close();
  }
}

const isDirectRun = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isDirectRun) {
  void importMoonBoardBetaLinks().catch((error: unknown) => {
    console.error('❌ Import failed:', error);
    process.exit(1);
  });
}
