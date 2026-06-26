import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql, eq } from 'drizzle-orm';
import { boardClimbs, boardClimbStats, boardClimbHolds, boardClimbAliases } from '../src/schema/boards/unified.js';
import { fingerprintFromHolds } from './moonboard-2024-helpers.js';
import {
  HOLDSETUP_TO_LAYOUT,
  catalogProblemToClimbs,
  type MoonBoardCatalogFile,
  type MappedCatalogClimb,
} from './moonboard-catalog-helpers.js';
import { getScriptDatabaseUrl } from './db-connection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// =============================================================================
// MoonBoard app-API catalog import (all 7 boards)
// =============================================================================
// Imports the full MoonBoard catalog scraped from the app's REST API
// (boardsesh/moonboard-scraper app-catalog/). One file per board, each
// { count, holdsetup, problems[] }. We write one climb row per (problem, graded
// angle) across all 7 boards and both 25°/40° angles.
//
// MERGE IN PLACE (non-destructive): the new scrape re-keys identities (stable
// problem id) vs the rows already in prod (keyed on apiId / name+setter). To
// avoid duplicating ~163k existing MoonBoard climbs — and to keep their UUIDs,
// URLs, ticks and favourites intact — we match each incoming climb to an
// existing one by (layout_id, angle, hold_fingerprint), tie-breaking on
// case-insensitive name. A match reuses the existing UUID (so the upsert updates
// it in place, backfilling the 2024 quality/ascensionist gap); a miss mints a
// stable id-based UUID and inserts. Stat upserts are monotonic — they never
// overwrite an existing grade/quality with null or drop an ascent count.
//
// The ~390 MB of catalog files are NOT committed. Point the script at a local
// copy of the app-catalog directory:
//   DB_URL=<target> vp run db:import-moonboard-catalog "/path/to/app-catalog"
// (DB_URL must be set inline — it beats the dev-db .env override and is how you
// target prod vs local.)
// =============================================================================

const DEFAULT_DIR = path.join(__dirname, '../data/moonboard/app-catalog');
// 2000 rows/insert keeps every table under Postgres's 65,535 bind-param limit
// (widest is board_climbs at ~24 cols) while cutting round-trips ~4× vs 500.
const BATCH_SIZE = 2000;

type ExistingClimb = { uuid: string; name: string | null };

/**
 * Build the in-memory match index for the non-destructive merge:
 * `${layoutId}|${angle}|${fingerprint}` → existing climbs with those holds.
 * Existing MoonBoard climbs predate the fingerprint column (only layout 3 has
 * it populated in prod), so we recompute every fingerprint from board_climb_holds.
 * Holds are streamed with a cursor and folded per-climb so memory stays bounded.
 */
async function buildExistingIndex(
  client: postgres.Sql,
  db: ReturnType<typeof drizzle>,
): Promise<Map<string, ExistingClimb[]>> {
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

  const climbRows = await db
    .select({
      uuid: boardClimbs.uuid,
      layoutId: boardClimbs.layoutId,
      angle: boardClimbs.angle,
      name: boardClimbs.name,
    })
    .from(boardClimbs)
    .where(eq(boardClimbs.boardType, 'moonboard'));

  const index = new Map<string, ExistingClimb[]>();
  for (const row of climbRows) {
    const fingerprint = fingerprintByUuid.get(row.uuid);
    if (!fingerprint) continue;
    const key = `${row.layoutId}|${row.angle}|${fingerprint}`;
    const bucket = index.get(key);
    if (bucket) bucket.push({ uuid: row.uuid, name: row.name });
    else index.set(key, [{ uuid: row.uuid, name: row.name }]);
  }
  fingerprintByUuid.clear();
  console.info(`   Indexed ${climbRows.length} existing climbs (${index.size} hold groups)`);
  return index;
}

/**
 * Resolve the UUID an incoming climb should use: an existing match (update in
 * place) or its own minted id-based UUID (insert). Tie-break a fingerprint that
 * maps to several climbs by case-insensitive name; if none matches, mint new
 * rather than risk overwriting the wrong climb. `matched` reports whether an
 * existing row was found — note a re-import matches its own id-based rows, whose
 * UUID equals the minted one, so we can't infer `matched` from UUID equality.
 */
function resolveUuid(
  mapped: MappedCatalogClimb,
  index: Map<string, ExistingClimb[]>,
): { uuid: string; matched: boolean } {
  const candidates = index.get(`${mapped.layoutId}|${mapped.angle}|${mapped.holdFingerprint}`);
  if (!candidates || candidates.length === 0) return { uuid: mapped.uuid, matched: false };
  if (candidates.length === 1) return { uuid: candidates[0].uuid, matched: true };
  const target = mapped.name.trim().toLowerCase();
  const named = candidates.find((candidate) => (candidate.name ?? '').trim().toLowerCase() === target);
  return named ? { uuid: named.uuid, matched: true } : { uuid: mapped.uuid, matched: false };
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
    console.error('   Usage: vp run db:import-moonboard-catalog [/path/to/app-catalog]');
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
  const dbHost = databaseUrl.split('@')[1]?.split('/')[0] || 'unknown';
  console.info(`🔄 Importing MoonBoard catalog to: ${dbHost}`);
  console.info(`📂 Reading catalog from: ${catalogDir} (${files.length} files)`);

  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client);

  const totals = { matched: 0, inserted: 0, climbs: 0, stats: 0, holds: 0, skippedProblems: 0 };

  try {
    const existingIndex = await buildExistingIndex(client, db);

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

      // Dedupe in memory (last wins) keyed per conflict target so a single batch
      // never proposes the same target twice ("ON CONFLICT cannot affect row a
      // second time").
      const climbByUuid = new Map<string, typeof boardClimbs.$inferInsert>();
      const statsByUuid = new Map<string, typeof boardClimbStats.$inferInsert>();
      const holdsByKey = new Map<string, typeof boardClimbHolds.$inferInsert>();
      const aliasByUuid = new Map<string, typeof boardClimbAliases.$inferInsert>();
      let matched = 0;
      let inserted = 0;
      let skippedProblems = 0;

      for (const problem of dump.problems) {
        const climbs = catalogProblemToClimbs(problem, layoutId);
        if (climbs.length === 0) {
          skippedProblems++;
          continue;
        }
        for (const mapped of climbs) {
          const { uuid, matched: matchedExisting } = resolveUuid(mapped, existingIndex);
          if (matchedExisting) matched++;
          else inserted++;

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
            angle: mapped.angle,
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

          statsByUuid.set(uuid, {
            boardType: 'moonboard',
            climbUuid: uuid,
            angle: mapped.angle,
            displayDifficulty: mapped.difficultyId ?? null,
            benchmarkDifficulty: mapped.isBenchmark && mapped.difficultyId !== undefined ? mapped.difficultyId : null,
            ascensionistCount: mapped.ascensionistCount,
            difficultyAverage: mapped.difficultyId ?? null,
            qualityAverage: mapped.qualityAverage,
            qualityNormalized: true,
            faUsername: null,
            faAt: null,
          });

          for (const hold of mapped.holds) {
            holdsByKey.set(`${uuid}:${hold.holdId}`, {
              boardType: 'moonboard',
              climbUuid: uuid,
              holdId: hold.holdId,
              frameNumber: 0,
              holdState: hold.holdState,
            });
          }

          aliasByUuid.set(uuid, {
            boardType: 'moonboard',
            aliasUuid: uuid,
            canonicalUuid: uuid,
            source: 'moonboard-catalog-import',
          });
        }
      }

      const climbRecords = [...climbByUuid.values()];
      const statsRecords = [...statsByUuid.values()];
      const holdsRecords = [...holdsByKey.values()];
      const aliasRecords = [...aliasByUuid.values()];

      console.info(`   ${matched} matched existing, ${inserted} new; ${skippedProblems} problems skipped`);

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
        // out an existing grade/quality or shrink an ascent count.
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
                ascensionistCount: sql`greatest(coalesce(excluded.ascensionist_count, 0), coalesce(${boardClimbStats.ascensionistCount}, 0))`,
                qualityAverage: sql`coalesce(excluded.quality_average, ${boardClimbStats.qualityAverage})`,
                qualityNormalized: sql`true`,
              },
            });
        }

        for (let i = 0; i < holdsRecords.length; i += BATCH_SIZE) {
          await tx
            .insert(boardClimbHolds)
            .values(holdsRecords.slice(i, i + BATCH_SIZE))
            .onConflictDoNothing();
        }

        // Self-aliases so resolveCanonicalClimbUuid always hits.
        for (let i = 0; i < aliasRecords.length; i += BATCH_SIZE) {
          await tx
            .insert(boardClimbAliases)
            .values(aliasRecords.slice(i, i + BATCH_SIZE))
            .onConflictDoUpdate({
              target: [boardClimbAliases.boardType, boardClimbAliases.aliasUuid],
              set: { lastSeenAt: sql`now()` },
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
    }

    console.info('\n✅ Import completed!');
    console.info(`   Matched existing: ${totals.matched}`);
    console.info(`   Newly inserted:   ${totals.inserted}`);
    console.info(`   Climbs upserted:  ${totals.climbs}`);
    console.info(`   Stats upserted:   ${totals.stats}`);
    console.info(`   Holds upserted:   ${totals.holds}`);
    console.info(`   Problems skipped: ${totals.skippedProblems}`);

    await client.end();
    process.exit(0);
  } catch (error) {
    console.error('❌ Import failed:', error);
    await client.end();
    process.exit(1);
  }
}

void importMoonBoardCatalog();
