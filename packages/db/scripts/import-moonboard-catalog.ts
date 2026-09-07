import { mergeCatalogCharacteristicsSql } from '../src/queries/climbs/catalog-characteristics.js';
import { CLIMB_CHARACTERISTICS, isMethodCharacteristic } from '@boardsesh/shared-schema/characteristics';
import path from 'path';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql, eq, and, isNull, inArray } from 'drizzle-orm';
import { boardClimbs, boardClimbStats, boardClimbHolds, boardClimbAliases } from '../src/schema/boards/unified.js';
import { blendedQualityAverageSql } from '../src/queries/climb-stats/quality-blend.js';
import { fingerprintFromHolds } from './moonboard-2024-helpers.js';
import {
  HOLDSETUP_TO_LAYOUT,
  buildExistingCatalogMatchIndex,
  catalogAliasConflictUpdate,
  type MoonBoardCatalogFile,
} from './moonboard-catalog-helpers.js';
import { stageCatalogBatch } from './moonboard-catalog-batch.js';
import { describeDatabaseHost, getScriptDatabaseUrl } from './db-connection.js';
import { formatUnmappedMoonBoardGrades } from './moonboard-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// =============================================================================
// MoonBoard catalog import (all 7 boards)
// =============================================================================
// Imports the full MoonBoard catalog dataset. One file per board, each
// { count, holdsetup, problems[] }. We write ONE climb row per problem —
// angle-agnostic, matching Kilter/Tension — and one board_climb_stats row per
// graded angle (typically 25° and 40°) under that same climb UUID.
//
// MERGE IN PLACE (non-destructive): the dataset re-keys identities (stable
// problem id) vs the rows already in prod (keyed on apiId / name+setter). To
// avoid duplicating ~163k existing MoonBoard climbs — and to keep their UUIDs,
// URLs, ticks and favourites intact — we match each incoming climb to an
// existing one by (layout_id, hold_fingerprint), tie-breaking on
// case-insensitive name. A match reuses the existing UUID (so the upsert updates
// it in place, backfilling the 2024 quality/ascensionist gap); a miss mints a
// stable id-based UUID and inserts — unless the problem already owns climb rows
// from an earlier import, which means its holds drifted rather than that it's
// new, and it's skipped loudly instead. Stat upserts are monotonic — they never
// overwrite an existing grade/quality with null or drop an ascent count.
//
// WITHDRAWN PROBLEMS: MoonBoard soft-deletes a withdrawn problem (sets
// dateDeleted, rewrites the setter to "MoonBoardSystem") and keeps returning it
// from the API. We skip importing it AND stop listing the climb it already owns
// — rows, holds, aliases, ticks and beta links all stay, so a logbook entry
// still resolves; the climb just leaves search, matching the MoonBoard app. A
// problem that vanishes from the API entirely is NOT handled here: absence from
// a paginated capture is much weaker evidence than a dateDeleted flag (the app
// API filters rows out of its own pagination window). Use
// report-moonboard-withdrawn.ts to see those.
//
// The ~390 MB of catalog files are NOT committed. Point the script at a local
// copy of the app-catalog directory:
//   DB_URL=<target> vp run '@boardsesh/db#db:import-moonboard-catalog' "/path/to/app-catalog"
// (The package-scoped task name is required — plain `vp run
// db:import-moonboard-catalog` resolves no task. DB_URL must be set inline: it
// beats the dev-db .env override and is how you target prod vs local.)
//
// Rehearse against the real target first with --dry-run: it does every write,
// then rolls each file's transaction back, so constraints are exercised for
// real and the counters are the ones a live run would print.
// =============================================================================

const DEFAULT_DIR = path.join(__dirname, '../data/moonboard/app-catalog');
// 2000 rows/insert keeps every table under Postgres's 65,535 bind-param limit
// (widest is board_climbs at ~24 cols) while cutting round-trips ~4× vs 500.
const BATCH_SIZE = 2000;

/**
 * Build the in-memory match index for the non-destructive merge:
 * `${layoutId}|${fingerprint}` → existing climbs with those holds.
 * Existing MoonBoard climbs predate the fingerprint column (only layout 3 has
 * it populated in prod), so we recompute every fingerprint from board_climb_holds.
 * Holds are streamed with a cursor and folded per-climb so memory stays bounded.
 *
 * Also returns every existing MoonBoard climb uuid (listed or not) and the raw
 * alias → canonical map, so the caller can spot a problem whose owned rows have
 * drifted out from under it (`existingClimbUuidsForProblem`) or would be
 * repointed by a merge (`hijackedClimbUuidsForProblem`).
 */
async function buildExistingIndex(
  client: postgres.Sql,
  db: ReturnType<typeof drizzle>,
): Promise<{
  index: ReturnType<typeof buildExistingCatalogMatchIndex>;
  climbUuids: Set<string>;
  canonicalByAlias: Map<string, string>;
}> {
  console.info('   Building match index from existing MoonBoard climbs...');
  const fingerprintByUuid = new Map<string, string>();
  let currentUuid: string | null = null;
  let currentHolds: { holdId: number; holdState: string }[] = [];
  const flush = () => {
    if (currentUuid !== null) fingerprintByUuid.set(currentUuid, fingerprintFromHolds(currentHolds));
  };
  const holdCursor = client<{ climb_uuid: string; hold_id: number; hold_state: string }[]>`
    SELECT climb_uuid, hold_id, hold_state
    FROM board_climb_holds
    WHERE board_type = 'moonboard'
    ORDER BY climb_uuid
  `.cursor(50000);
  for await (const rows of holdCursor) {
    for (const row of rows) {
      if (row.climb_uuid !== currentUuid) {
        flush();
        currentUuid = row.climb_uuid;
        currentHolds = [];
      }
      currentHolds.push({ holdId: row.hold_id, holdState: row.hold_state });
    }
  }
  flush();

  // user_id IS NULL fences out Boardsesh-native user climbs, matching the
  // same fence the moonboard_angle_dedup_backfill migration (#3849) applies. Without it, a user climb that
  // happens to share holds with an incoming catalog problem could be adopted
  // as the merge target, after which the catalog import would upsert its
  // stats onto the user's climb and point the problem's aliases at it.
  const climbRows = await db
    .select({
      uuid: boardClimbs.uuid,
      layoutId: boardClimbs.layoutId,
      name: boardClimbs.name,
      isListed: boardClimbs.isListed,
    })
    .from(boardClimbs)
    .where(and(eq(boardClimbs.boardType, 'moonboard'), isNull(boardClimbs.userId)));

  const aliasRows = await db
    .select({ aliasUuid: boardClimbAliases.aliasUuid, canonicalUuid: boardClimbAliases.canonicalUuid })
    .from(boardClimbAliases)
    .where(eq(boardClimbAliases.boardType, 'moonboard'));
  const canonicalByAlias = new Map(aliasRows.map((row) => [row.aliasUuid, row.canonicalUuid]));
  const index = buildExistingCatalogMatchIndex(climbRows, fingerprintByUuid, canonicalByAlias);
  fingerprintByUuid.clear();
  console.info(`   Indexed ${climbRows.length} existing climbs (${index.size} hold groups)`);
  return { index, climbUuids: new Set(climbRows.map((row) => row.uuid)), canonicalByAlias };
}

// Thrown to abort a --dry-run transaction after the writes have been attempted.
// Same trick as import-aurora-board-unified.ts: the rehearsal exercises every
// constraint, index and trigger for real, then rolls the whole file back.
const DRY_RUN_ROLLBACK = new Error('__dry_run_rollback__');

// Flags that consume the following argv entry. Needed so the positional catalog
// directory can be told apart from a flag's value — otherwise
// `--holdsetup 21` with no directory reads "21" as the path.
const VALUE_FLAGS = new Set(['--holdsetup']);
const BOOLEAN_FLAGS = new Set(['--dry-run']);

export type CatalogCliArgs = { positional: string[]; holdsetup?: number; dryRun: boolean };

/**
 * Parse argv, rejecting anything unrecognised.
 *
 * Failing closed on an unknown flag is the whole point: a typo'd `-dry-run`
 * (one dash) or `--dryrun` would otherwise be silently ignored and the
 * rehearsal would commit to production instead.
 */
export function parseCatalogCliArgs(argv: string[]): CatalogCliArgs {
  const positional: string[] = [];
  let holdsetup: number | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      // `vp run '@boardsesh/db#db:import-moonboard-catalog' -- --dry-run`
      // forwards the separator verbatim, so skip it rather than rejecting it as
      // an unknown flag. Both invocation styles then work.
      continue;
    }
    if (BOOLEAN_FLAGS.has(arg)) {
      dryRun = true;
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      const parsed = Number(value);
      if (!Number.isInteger(parsed)) throw new Error(`${arg} needs an integer, got "${value}"`);
      holdsetup = parsed;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown flag: ${arg}`);
    positional.push(arg);
  }

  return { positional, holdsetup, dryRun };
}

async function importMoonBoardCatalog() {
  let cli: CatalogCliArgs;
  try {
    cli = parseCatalogCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`❌ ${(error as Error).message}`);
    console.error(
      "   Usage: vp run '@boardsesh/db#db:import-moonboard-catalog' [/path/to/app-catalog] [--holdsetup N] [--dry-run]",
    );
    process.exit(1);
  }

  const catalogDir = cli.positional[0] ? path.resolve(process.cwd(), cli.positional[0]) : DEFAULT_DIR;
  const onlyHoldsetup = cli.holdsetup;
  const dryRun = cli.dryRun;

  if (!fs.existsSync(catalogDir) || !fs.statSync(catalogDir).isDirectory()) {
    console.error(`❌ Catalog directory not found: ${catalogDir}`);
    console.error("   Usage: vp run '@boardsesh/db#db:import-moonboard-catalog' [/path/to/app-catalog]");
    process.exit(1);
  }

  const files = fs
    .readdirSync(catalogDir)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .sort();
  if (files.length === 0) {
    console.error(`❌ No .json catalog files in ${catalogDir}`);
    process.exit(1);
  }

  const databaseUrl = getScriptDatabaseUrl();
  console.info(`🔄 Importing MoonBoard catalog to: ${describeDatabaseHost(databaseUrl)}`);
  console.info(`📂 Reading catalog from: ${catalogDir} (${files.length} files)`);
  if (dryRun) {
    console.info('🧪 DRY RUN — every write is attempted and then rolled back. Nothing is committed.');
  }

  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client);

  const totals = {
    matched: 0,
    inserted: 0,
    climbs: 0,
    stats: 0,
    holds: 0,
    skippedProblems: 0,
    skippedAmbiguous: 0,
    skippedDrifted: 0,
    skippedHijacked: 0,
    foldedInBatch: 0,
    withdrawn: 0,
    withdrawnWithClimbs: 0,
    unlisted: 0,
  };

  try {
    const {
      index: existingIndex,
      climbUuids: existingClimbUuids,
      canonicalByAlias,
    } = await buildExistingIndex(client, db);

    for (const file of files) {
      const raw = fs.readFileSync(path.join(catalogDir, file), 'utf-8');
      const dump: MoonBoardCatalogFile = JSON.parse(raw);
      const layoutId = HOLDSETUP_TO_LAYOUT[dump.holdsetup];
      if (!layoutId) {
        console.warn(`⚠️  ${file}: unknown holdsetup ${dump.holdsetup}, skipping`);
        continue;
      }
      if (onlyHoldsetup !== undefined && dump.holdsetup !== onlyHoldsetup) continue;

      console.info(`\n📖 ${file} — holdsetup ${dump.holdsetup} → layout ${layoutId}, ${dump.problems.length} problems`);

      const {
        climbs: climbRecords,
        stats: statsRecords,
        holds: holdsRecords,
        aliases: aliasRecords,
        withdrawnClimbUuids,
        withdrawnSamples,
        counters,
        unmappedGrades,
      } = stageCatalogBatch({
        problems: dump.problems,
        layoutId,
        existingIndex,
        existingClimbUuids,
        canonicalByAlias,
      });

      console.info(
        `   ${counters.matched} matched existing, ${counters.inserted} new; ` +
          `${counters.foldedInBatch} folded onto an earlier same-holds problem; ` +
          `${counters.skippedProblems} problems skipped, ` +
          `${counters.skippedAmbiguous} skipped as ambiguous (duplicate listed rows), ` +
          `${counters.skippedDrifted} skipped as drifted (holds changed under an imported climb), ` +
          `${counters.skippedHijacked} skipped to protect climb rows a merge would repoint; ` +
          `${counters.withdrawn} withdrawn upstream (${withdrawnClimbUuids.length} climbs to unlist)`,
      );
      if (withdrawnSamples.length > 0) {
        console.info('   Withdrawn upstream (first few):');
        for (const sample of withdrawnSamples) {
          console.info(`     ${sample.problemId} "${sample.name}" → ${sample.climbUuids.join(', ')}`);
        }
      }
      if (unmappedGrades.size > 0) {
        console.warn(
          `   ⚠️  Unmapped MoonBoard grades, imported with a NULL grade — add them to MOONBOARD_GRADE_TO_DIFFICULTY: ${formatUnmappedMoonBoardGrades(unmappedGrades)}`,
        );
      }

      // Counted inside the transaction, read after it. On a dry run the
      // transaction is rolled back but this keeps its value, which is the
      // point: the rehearsal reports what a real run would change.
      let unlistedThisFile = 0;

      // One transaction per board: a crash mid-file never leaves a climb without
      // its holds/aliases, and completed boards stay committed for an idempotent
      // re-run. On a dry run it always ends in DRY_RUN_ROLLBACK.
      try {
        await db.transaction(async (tx) => {
          // Climbs — for matched rows the identity columns are already correct, so
          // refresh only the method-derived fields (characteristics/description).
          for (let i = 0; i < climbRecords.length; i += BATCH_SIZE) {
            await tx
              .insert(boardClimbs)
              .values(climbRecords.slice(i, i + BATCH_SIZE))
              .onConflictDoUpdate({
                target: boardClimbs.uuid,
                setWhere: isNull(boardClimbs.userId),
                set: {
                  characteristics: mergeCatalogCharacteristicsSql(
                    boardClimbs.characteristics,
                    sql`excluded.characteristics`,
                    Object.values(CLIMB_CHARACTERISTICS).filter(isMethodCharacteristic),
                  ),
                  description: sql`excluded.description`,
                },
              });
          }

          // Stats — monotonic merge: take the new grade/benchmark, but never null
          // out an existing grade/quality or shrink the upstream count. The total is
          // rebuilt as upstream + existing Boardsesh, so re-running the import repairs
          // any climb whose count was previously clobbered by a tick recompute without
          // dropping the ticks it has since accrued.
          //
          // The NEW upstream count this upsert resolves to: monotonic GREATEST of the
          // stored and incoming snapshot. Defined ONCE and reused for the count SET,
          // the total, AND the blend weight — a SET expression reads the OLD value of
          // a bare column, so the blend must weight by this NEW resolved count. Single
          // source keeps the three in lockstep if the count policy ever changes.
          const resolvedUpstreamAscensionistCount = sql`greatest(coalesce(excluded.upstream_ascensionist_count, 0), coalesce(${boardClimbStats.upstreamAscensionistCount}, 0))`;
          const blendedQuality = blendedQualityAverageSql({
            upstreamQualityAverage: sql`coalesce(excluded.upstream_quality_average, ${boardClimbStats.upstreamQualityAverage})`,
            upstreamAscensionistCount: resolvedUpstreamAscensionistCount,
            boardseshQualitySum: sql`${boardClimbStats.boardseshQualitySum}`,
            boardseshQualityCount: sql`${boardClimbStats.boardseshQualityCount}`,
          });
          for (let i = 0; i < statsRecords.length; i += BATCH_SIZE) {
            await tx
              .insert(boardClimbStats)
              .values(statsRecords.slice(i, i + BATCH_SIZE))
              .onConflictDoUpdate({
                target: [boardClimbStats.boardType, boardClimbStats.climbUuid, boardClimbStats.angle],
                // Existing-side refs must be table-qualified — a bare column name is
                // ambiguous between the target row and `excluded` in ON CONFLICT.
                set: {
                  displayDifficulty: sql`coalesce(excluded.display_difficulty, ${boardClimbStats.displayDifficulty})`,
                  benchmarkDifficulty: sql`excluded.benchmark_difficulty`,
                  difficultyAverage: sql`coalesce(excluded.difficulty_average, ${boardClimbStats.difficultyAverage})`,
                  upstreamAscensionistCount: resolvedUpstreamAscensionistCount,
                  ascensionistCount: sql`${resolvedUpstreamAscensionistCount} + coalesce(${boardClimbStats.boardseshAscensionistCount}, 0)`,
                  // Manufacturer average lands in upstream_quality_average; quality_average
                  // is the blend of it and Boardsesh's own votes.
                  upstreamQualityAverage: sql`coalesce(excluded.upstream_quality_average, ${boardClimbStats.upstreamQualityAverage})`,
                  qualityAverage: blendedQuality,
                  qualityNormalized: sql`true`,
                  upstreamSyncedAt: sql`excluded.upstream_synced_at`,
                },
              });
          }

          for (let i = 0; i < holdsRecords.length; i += BATCH_SIZE) {
            await tx
              .insert(boardClimbHolds)
              .values(holdsRecords.slice(i, i + BATCH_SIZE))
              .onConflictDoNothing();
          }

          // Self-aliases so resolveCanonicalClimbUuid always hits, plus id-based
          // aliases (moonboard:{id}:{angle} → canonical) so problem-id lookups from
          // the logbook importer resolve merged/legacy climbs.
          for (let i = 0; i < aliasRecords.length; i += BATCH_SIZE) {
            await tx
              .insert(boardClimbAliases)
              .values(aliasRecords.slice(i, i + BATCH_SIZE))
              .onConflictDoUpdate({
                target: [boardClimbAliases.boardType, boardClimbAliases.aliasUuid],
                set: catalogAliasConflictUpdate(),
              });
          }

          // Stop listing climbs whose problem upstream has withdrawn. Rows,
          // holds, aliases, ticks and beta links all stay — the climb just leaves
          // search, matching what the MoonBoard app itself shows.
          //
          // `user_id IS NULL` is the same fence buildExistingIndex applies: a
          // Boardsesh-native climb is never collateral, even if a withdrawn
          // problem's alias chain somehow pointed at one. The IS DISTINCT FROM
          // predicate makes a re-run a no-op instead of rewriting rows that are
          // already unlisted, so the returned count is "what actually changed".
          for (let i = 0; i < withdrawnClimbUuids.length; i += BATCH_SIZE) {
            const unlistedRows = await tx
              .update(boardClimbs)
              .set({ isListed: false })
              .where(
                and(
                  eq(boardClimbs.boardType, 'moonboard'),
                  isNull(boardClimbs.userId),
                  inArray(boardClimbs.uuid, withdrawnClimbUuids.slice(i, i + BATCH_SIZE)),
                  sql`${boardClimbs.isListed} IS DISTINCT FROM false`,
                ),
              )
              .returning({ uuid: boardClimbs.uuid });
            unlistedThisFile += unlistedRows.length;
          }

          if (dryRun) throw DRY_RUN_ROLLBACK;
        });
      } catch (error) {
        // A dry run always lands here. Anything else is a real failure.
        if (error !== DRY_RUN_ROLLBACK) throw error;
      }

      console.info(
        `   ✓ climbs ${climbRecords.length}, stats ${statsRecords.length}, holds ${holdsRecords.length}` +
          `, unlisted ${unlistedThisFile}`,
      );
      totals.matched += counters.matched;
      totals.inserted += counters.inserted;
      totals.climbs += climbRecords.length;
      totals.stats += statsRecords.length;
      totals.holds += holdsRecords.length;
      totals.skippedProblems += counters.skippedProblems;
      totals.skippedAmbiguous += counters.skippedAmbiguous;
      totals.skippedDrifted += counters.skippedDrifted;
      totals.skippedHijacked += counters.skippedHijacked;
      totals.foldedInBatch += counters.foldedInBatch;
      totals.withdrawn += counters.withdrawn;
      totals.withdrawnWithClimbs += counters.withdrawnWithClimbs;
      totals.unlisted += unlistedThisFile;
    }

    console.info(dryRun ? '\n🧪 Dry run completed — nothing was committed.' : '\n✅ Import completed!');
    console.info(`   Matched existing: ${totals.matched}`);
    console.info(`   Newly inserted:   ${totals.inserted}`);
    console.info(`   Climbs upserted:  ${totals.climbs}`);
    console.info(`   Stats upserted:   ${totals.stats}`);
    console.info(`   Holds upserted:   ${totals.holds}`);
    console.info(`   Problems skipped: ${totals.skippedProblems}`);
    console.info(
      `   Withdrawn:        ${totals.withdrawn} upstream, ${totals.withdrawnWithClimbs} of them own climb rows, ` +
        `${totals.unlisted} climbs unlisted`,
    );
    if (totals.foldedInBatch > 0) {
      console.info(
        `   Folded in batch:  ${totals.foldedInBatch} — problems that share their holds with an earlier problem in ` +
          `the same file and were collapsed onto it; both problem ids still resolve to the surviving climb.`,
      );
    }
    if (totals.skippedAmbiguous > 0) {
      console.error(
        `   ⚠️  Problems skipped as ambiguous: ${totals.skippedAmbiguous} — several listed rows share their holds. ` +
          `If this database predates the moonboard_angle_dedup_backfill migration (#3849), run it and re-run this import to pick ` +
          `these up. If it's already migrated, these are cross-problem duplicate groups the dedup migration left alone on purpose ` +
          `and they need deduping by hand.`,
      );
    }
    if (totals.skippedDrifted > 0) {
      console.error(
        `   ⚠️  Problems skipped as drifted: ${totals.skippedDrifted} — their holds no longer match the climb rows ` +
          `they already own, so inserting would duplicate the climb and redirect the old rows' ticks. Reconcile ` +
          `those rows by hand, then re-run this import.`,
      );
    }
    if (totals.skippedHijacked > 0) {
      console.error(
        `   ⚠️  Problems skipped to protect existing rows: ${totals.skippedHijacked} — their holds matched one climb ` +
          `while the problem also owns other live climb rows, so merging would repoint those rows (and their ticks) ` +
          `at the matched climb while they stay listed. Reconcile them by hand, then re-run this import.`,
      );
    }

    await client.end();
    process.exit(0);
  } catch (error) {
    console.error('❌ Import failed:', error);
    await client.end();
    process.exit(1);
  }
}

// Only run when invoked as a script — the arg parser above is imported by
// import-moonboard-catalog-args.test.ts, which must not kick off an import.
const isDirectRun = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isDirectRun) void importMoonBoardCatalog();
