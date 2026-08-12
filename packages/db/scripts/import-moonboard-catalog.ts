import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql, eq, and, isNull } from 'drizzle-orm';
import { boardClimbs, boardClimbStats, boardClimbHolds, boardClimbAliases } from '../src/schema/boards/unified.js';
import { blendedQualityAverageSql } from '../src/queries/climb-stats/quality-blend.js';
import { fingerprintFromHolds } from './moonboard-2024-helpers.js';
import {
  HOLDSETUP_TO_LAYOUT,
  buildExistingCatalogMatchIndex,
  catalogAliasConflictUpdate,
  catalogAliasRows,
  catalogProblemToClimbs,
  existingClimbUuidsForProblem,
  resolveIncumbentReplacement,
  resolveCatalogClimbUuid,
  type MoonBoardCatalogFile,
  type MappedCatalogClimb,
} from './moonboard-catalog-helpers.js';
import { describeDatabaseHost, getScriptDatabaseUrl } from './db-connection.js';

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
// The ~390 MB of catalog files are NOT committed. Point the script at a local
// copy of the app-catalog directory:
//   DB_URL=<target> vp run '@boardsesh/db#db:import-moonboard-catalog' "/path/to/app-catalog"
// (The package-scoped task name is required — plain `vp run
// db:import-moonboard-catalog` resolves no task. DB_URL must be set inline: it
// beats the dev-db .env override and is how you target prod vs local.)
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
 * Also returns every existing MoonBoard climb uuid (listed or not) so the
 * caller can spot a problem this importer already owns whose holds have since
 * drifted — see `existingClimbUuidsForProblem`.
 */
async function buildExistingIndex(
  client: postgres.Sql,
  db: ReturnType<typeof drizzle>,
): Promise<{ index: ReturnType<typeof buildExistingCatalogMatchIndex>; climbUuids: Set<string> }> {
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
  return { index, climbUuids: new Set(climbRows.map((row) => row.uuid)) };
}

function parseFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

async function importMoonBoardCatalog() {
  const positional = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  const catalogDir = positional ? path.resolve(process.cwd(), positional) : DEFAULT_DIR;
  const onlyHoldsetup = parseFlag('--holdsetup') ? Number(parseFlag('--holdsetup')) : undefined;

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
  };

  try {
    const { index: existingIndex, climbUuids: existingClimbUuids } = await buildExistingIndex(client, db);

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

      // Dedupe in memory keyed per conflict target so a single batch never
      // proposes the same target twice ("ON CONFLICT cannot affect row a second
      // time"). When two problems share the same holds (so they resolve to one
      // target UUID) we keep the STRONGER problem (resolveIncumbentReplacement /
      // isBetterCatalogClimb: more total repeats across its graded angles, then
      // benchmark) instead of last-wins — otherwise a junk duplicate can
      // clobber a real benchmark's ascent count and benchmark flag.
      const bestByUuid = new Map<string, MappedCatalogClimb>();
      const climbByUuid = new Map<string, typeof boardClimbs.$inferInsert>();
      // Keyed `${uuid}:${angle}` — one entry per graded angle of a climb.
      const statsByUuidAngle = new Map<string, typeof boardClimbStats.$inferInsert>();
      const holdsByKey = new Map<string, typeof boardClimbHolds.$inferInsert>();
      const aliasByUuid = new Map<string, typeof boardClimbAliases.$inferInsert>();
      let matched = 0;
      let inserted = 0;
      let skippedProblems = 0;
      let skippedAmbiguous = 0;
      let skippedDrifted = 0;

      for (const problem of dump.problems) {
        const mapped = catalogProblemToClimbs(problem, layoutId);
        if (!mapped) {
          skippedProblems++;
          continue;
        }
        const { uuid, matched: matchedExisting, ambiguous } = resolveCatalogClimbUuid(mapped, existingIndex);

        // Multiple DISTINCT listed rows share this problem's holds. Two causes:
        //   1. The moonboard_angle_dedup_backfill migration (#3849) hasn't run against this
        //      database yet, so both angle-rows of the problem are still
        //      separately listed. Running it fixes this one.
        //   2. The database IS migrated, but the dedup migration deliberately left this group
        //      alone: it only collapses a same-signature group whose members
        //      all sit at DISTINCT angles, so a cross-problem duplicate class
        //      (the real "birthday cake trail mix" vs the junk problem named
        //      "name", four listed rows on one signature) survives for manual
        //      follow-up. Running migrations again changes nothing here.
        // Either way, writing through would double-count ascents across two
        // listed rows and point a legacy alias at whichever row the name
        // tie-break happened to land on. Loud skip, not a silent guess.
        if (ambiguous) {
          skippedAmbiguous++;
          console.error(
            `   ⚠️  Skipping problem ${problem.id} ("${problem.name}"): multiple listed rows already share its holds ` +
              `at layout ${layoutId} — either this database predates the moonboard_angle_dedup_backfill migration (#3849), or that migration ` +
              `ran and left a cross-problem duplicate group for manual follow-up. Check migrations first; if they're ` +
              `up to date, these rows need deduping by hand.`,
          );
          continue;
        }

        // No hold match, but this problem already owns climb rows from an
        // earlier import — its holds drifted rather than it being new. See
        // existingClimbUuidsForProblem: inserting here would mint a duplicate
        // and repoint the old rows' self-aliases (and therefore their ticks)
        // at the empty new row. Loud skip.
        if (!matchedExisting) {
          const driftedUuids = existingClimbUuidsForProblem({
            problemId: problem.id,
            angles: mapped.stats.map((stat) => stat.angle),
            existingClimbUuids,
          });
          if (driftedUuids.length > 0) {
            skippedDrifted++;
            console.error(
              `   ⚠️  Skipping problem ${problem.id} ("${problem.name}"): its holds no longer match the climb rows it ` +
                `already owns (${driftedUuids.join(', ')}) at layout ${layoutId}. Inserting would duplicate the climb ` +
                `and redirect the existing rows' ticks. Reconcile those rows by hand, then re-run this import.`,
            );
            continue;
          }
        }

        // Record the aliases before the dedupe below: when two problems collapse
        // onto one climb (same holds) we drop the weaker problem's data, but we
        // still want BOTH problem ids to resolve to the survivor. The self-alias
        // lets resolveCanonicalClimbUuid hit; the id-based alias (only added when
        // the merge reused a legacy UUID) makes the climb addressable by its
        // MoonBoard problem id; the per-angle legacy aliases keep the
        // personal-logbook importer's `moonboard:{id}:{angle}` lookup resolving.
        for (const aliasRow of catalogAliasRows({
          problemId: problem.id,
          angles: mapped.stats.map((stat) => stat.angle),
          canonicalUuid: uuid,
        })) {
          aliasByUuid.set(aliasRow.aliasUuid, {
            boardType: 'moonboard',
            aliasUuid: aliasRow.aliasUuid,
            canonicalUuid: aliasRow.canonicalUuid,
            source: 'moonboard-catalog-import',
          });
        }

        const incumbent = bestByUuid.get(uuid);
        const decision = resolveIncumbentReplacement(uuid, mapped, incumbent);
        if (!decision.accept) continue;
        if (!incumbent) {
          if (matchedExisting) matched++;
          else inserted++;
        }
        bestByUuid.set(uuid, mapped);

        climbByUuid.set(uuid, {
          uuid,
          boardType: 'moonboard',
          layoutId: mapped.layoutId,
          setterId: null,
          setterUsername: mapped.setterUsername,
          name: mapped.name,
          description: mapped.description,
          hsm: null,
          edgeLeft: null,
          edgeRight: null,
          edgeBottom: null,
          edgeTop: null,
          // Angle-agnostic identity (see module header). Consumers that
          // resolve difficultyName by joining board_climb_stats at the climb's
          // own angle handle the null via climbStatsEffectiveAngleSql
          // (packages/backend/src/db/queries/util/climb-stats-join.ts): when
          // climbs.angle is null they fall back to the climb's most-ascended
          // stats row (lower angle wins ties). Formerly tracked as #4220,
          // fixed on main before this importer landed.
          angle: null,
          framesCount: 1,
          framesPace: 0,
          frames: mapped.frames,
          isDraft: false,
          isListed: true,
          createdAt: mapped.createdAt,
          synced: true,
          syncError: null,
          userId: null,
          holdFingerprint: mapped.holdFingerprint,
          characteristics: mapped.characteristics,
        });

        // Clear the beaten incumbent's stale batch-map entries (see
        // resolveIncumbentReplacement's doc comment for why this is needed).
        for (const key of decision.staleStatKeys) {
          statsByUuidAngle.delete(key);
        }
        for (const key of decision.staleHoldKeys) {
          holdsByKey.delete(key);
        }

        for (const stat of mapped.stats) {
          statsByUuidAngle.set(`${uuid}:${stat.angle}`, {
            boardType: 'moonboard',
            climbUuid: uuid,
            angle: stat.angle,
            displayDifficulty: stat.difficultyId ?? null,
            benchmarkDifficulty: stat.isBenchmark && stat.difficultyId !== undefined ? stat.difficultyId : null,
            // MoonBoard's community-repeat count is this board's upstream source.
            // Seed the total too (a fresh row has no Boardsesh ticks yet); the tick
            // recompute later adds boardsesh_ascensionist_count on top of upstream.
            upstreamAscensionistCount: stat.ascensionistCount,
            ascensionistCount: stat.ascensionistCount,
            difficultyAverage: stat.difficultyId ?? null,
            qualityAverage: stat.qualityAverage,
            // The manufacturer average also seeds upstream_quality_average (the
            // blend's upstream term). On a fresh INSERT quality_average == this
            // value because no Boardsesh votes exist yet; on conflict it re-blends.
            upstreamQualityAverage: stat.qualityAverage,
            qualityNormalized: true,
            faUsername: null,
            faAt: null,
            // MoonBoard catalog import is this board's upstream stats source.
            upstreamSyncedAt: new Date().toISOString(),
          });
        }

        for (const hold of mapped.holds) {
          holdsByKey.set(`${uuid}:${hold.holdId}`, {
            boardType: 'moonboard',
            climbUuid: uuid,
            holdId: hold.holdId,
            frameNumber: 0,
            holdState: hold.holdState,
          });
        }
      }

      const climbRecords = [...climbByUuid.values()];
      const statsRecords = [...statsByUuidAngle.values()];
      const holdsRecords = [...holdsByKey.values()];
      const aliasRecords = [...aliasByUuid.values()];

      console.info(
        `   ${matched} matched existing, ${inserted} new; ${skippedProblems} problems skipped, ` +
          `${skippedAmbiguous} skipped as ambiguous (duplicate listed rows), ` +
          `${skippedDrifted} skipped as drifted (holds changed under an imported climb)`,
      );

      // One transaction per board: a crash mid-file never leaves a climb without
      // its holds/aliases, and completed boards stay committed for an idempotent
      // re-run.
      await db.transaction(async (tx) => {
        // Climbs — for matched rows the identity columns are already correct, so
        // refresh only the method-derived fields (characteristics/description).
        for (let i = 0; i < climbRecords.length; i += BATCH_SIZE) {
          await tx
            .insert(boardClimbs)
            .values(climbRecords.slice(i, i + BATCH_SIZE))
            .onConflictDoUpdate({
              target: boardClimbs.uuid,
              set: { characteristics: sql`excluded.characteristics`, description: sql`excluded.description` },
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
      });

      console.info(`   ✓ climbs ${climbRecords.length}, stats ${statsRecords.length}, holds ${holdsRecords.length}`);
      totals.matched += matched;
      totals.inserted += inserted;
      totals.climbs += climbRecords.length;
      totals.stats += statsRecords.length;
      totals.holds += holdsRecords.length;
      totals.skippedProblems += skippedProblems;
      totals.skippedAmbiguous += skippedAmbiguous;
      totals.skippedDrifted += skippedDrifted;
    }

    console.info('\n✅ Import completed!');
    console.info(`   Matched existing: ${totals.matched}`);
    console.info(`   Newly inserted:   ${totals.inserted}`);
    console.info(`   Climbs upserted:  ${totals.climbs}`);
    console.info(`   Stats upserted:   ${totals.stats}`);
    console.info(`   Holds upserted:   ${totals.holds}`);
    console.info(`   Problems skipped: ${totals.skippedProblems}`);
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

    await client.end();
    process.exit(0);
  } catch (error) {
    console.error('❌ Import failed:', error);
    await client.end();
    process.exit(1);
  }
}

void importMoonBoardCatalog();
