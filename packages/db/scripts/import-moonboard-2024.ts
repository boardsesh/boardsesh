import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { sql } from 'drizzle-orm';
import { boardClimbs, boardClimbStats, boardClimbHolds, boardClimbAliases } from '../src/schema/boards/unified.js';
import {
  MOONBOARD_2024_LAYOUT_ID,
  angleFromFilename,
  mapMoonBoard2024Problem,
  type MoonBoard2024DumpFile,
} from './moonboard-2024-helpers.js';
import { createScriptDb, getScriptDatabaseUrl } from './db-connection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// =============================================================================
// MoonBoard 2024 authoritative import
// =============================================================================
// Imports the full MoonBoard 2024 catalog (~35k problems) at angle 40 from the
// boardsesh/moonboard-scraper "Problems Moonboard 2024 40.json" file. The format
// has no apiId/repeats/userRating and usually no date fields, so we derive a
// deterministic UUID from name+setter+holds, compute the hold fingerprint, and
// leave ascensionist_count/quality_average empty. Ungraded "PROJECT" problems
// are imported with a null difficulty (not skipped).
//
// Climbs are marked synced=true / user_id=null so they're distinct from the
// OCR-created climbs (synced=false) the cleanup migration removes.
//
// The export is NOT committed to the repo (it's ~60MB raw data; see .gitignore).
// Download it from
//   https://raw.githubusercontent.com/boardsesh/moonboard-scraper/master/Problems%20Moonboard%202024%2040.json
// and run against your local copy:
//   vp run db:import-moonboard-2024 "/path/to/Problems Moonboard 2024 40.json"
// With no argument it falls back to packages/db/data/moonboard/ (a gitignored
// local drop spot). The dev DB image does not auto-load 2024 problems.
// =============================================================================

const DEFAULT_EXPORT = path.join(__dirname, '../data/moonboard/Problems Moonboard 2024 40.json');
// 2000 rows/insert keeps every table under Postgres's 65,535 bind-param limit
// (widest is board_climbs at 23 cols → 46,000 params) while cutting round-trips
// ~4× vs 500 — meaningful for the ~311k-hold insert over a network.
const BATCH_SIZE = 2000;

function parseFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

async function importMoonBoard2024() {
  const positional = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  const exportPath = positional ? path.resolve(process.cwd(), positional) : DEFAULT_EXPORT;

  if (!fs.existsSync(exportPath)) {
    console.error(`❌ Export file not found: ${exportPath}`);
    console.error('   Usage: vp run db:import-moonboard-2024 [/path/to/export.json]');
    process.exit(1);
  }

  const layoutId = Number(parseFlag('--layout') ?? MOONBOARD_2024_LAYOUT_ID);
  const angle = Number(parseFlag('--angle') ?? angleFromFilename(path.basename(exportPath)) ?? 40);
  if (!Number.isInteger(layoutId) || !Number.isInteger(angle)) {
    console.error(`❌ Invalid --layout (${layoutId}) or --angle (${angle}); both must be integers.`);
    process.exit(2);
  }

  const databaseUrl = getScriptDatabaseUrl();
  const dbHost = databaseUrl.split('@')[1]?.split('/')[0] || 'unknown';
  console.info(`🔄 Importing MoonBoard 2024 problems to: ${dbHost}`);
  console.info(`📂 Reading export from: ${exportPath}`);
  console.info(`   Layout ${layoutId}, angle ${angle}`);

  const { db, close } = createScriptDb(databaseUrl);

  try {
    const dump: MoonBoard2024DumpFile = JSON.parse(fs.readFileSync(exportPath, 'utf-8'));
    console.info(`   Total problems in file: ${dump.data.length}`);

    // Keep problems that aren't deleted. The full catalog file usually omits the
    // date fields entirely, so test for truthiness (absent/null = not deleted)
    // rather than `=== null` (which would reject every record lacking the field).
    const problems = dump.data.filter((problem) => !problem.dateDeleted);
    const deleted = dump.data.length - problems.length;
    if (deleted > 0) console.info(`   Skipping ${deleted} deleted problems`);

    // Identity is name+setter+holds, so a re-scrape of the same problem maps to
    // the SAME uuid. Dedupe in memory (last wins) keyed by the conflict target of
    // each table — otherwise a single insert batch could propose the same target
    // twice, which Postgres rejects with "ON CONFLICT ... cannot affect row a
    // second time" (fails the whole import).
    const climbByUuid = new Map<string, typeof boardClimbs.$inferInsert>();
    const statsByUuid = new Map<string, typeof boardClimbStats.$inferInsert>();
    const holdsByKey = new Map<string, typeof boardClimbHolds.$inferInsert>();
    const aliasByUuid = new Map<string, typeof boardClimbAliases.$inferInsert>();
    let ungraded = 0;
    let mappedCount = 0;

    for (const problem of problems) {
      const mapped = mapMoonBoard2024Problem(problem, { layoutId, angle });
      // Ungraded "PROJECT"/empty-grade problems are imported with a null
      // difficulty rather than skipped, so the catalog is complete.
      if (mapped.difficultyId === undefined) ungraded++;
      mappedCount++;

      climbByUuid.set(mapped.uuid, {
        uuid: mapped.uuid,
        boardType: 'moonboard',
        layoutId,
        setterId: null,
        setterUsername: mapped.setterUsername,
        name: mapped.name,
        description: mapped.description,
        hsm: null,
        edgeLeft: null,
        edgeRight: null,
        edgeBottom: null,
        edgeTop: null,
        angle,
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

      statsByUuid.set(mapped.uuid, {
        boardType: 'moonboard',
        climbUuid: mapped.uuid,
        angle,
        // null for ungraded problems.
        displayDifficulty: mapped.difficultyId ?? null,
        benchmarkDifficulty: mapped.isBenchmark && mapped.difficultyId !== undefined ? mapped.difficultyId : null,
        ascensionistCount: 0,
        difficultyAverage: mapped.difficultyId ?? null,
        // No quality data in the export. Mark normalized so the 1-3→1-5 quality
        // backfill never touches these rows.
        qualityAverage: null,
        qualityNormalized: true,
        faUsername: null,
        faAt: null,
      });

      for (const hold of mapped.holds) {
        holdsByKey.set(`${mapped.uuid}:${hold.holdId}`, {
          boardType: 'moonboard',
          climbUuid: mapped.uuid,
          holdId: hold.holdId,
          frameNumber: 0,
          holdState: hold.holdState,
        });
      }

      aliasByUuid.set(mapped.uuid, {
        boardType: 'moonboard',
        aliasUuid: mapped.uuid,
        canonicalUuid: mapped.uuid,
        source: 'moonboard-2024-import',
      });
    }

    const climbRecords = [...climbByUuid.values()];
    const statsRecords = [...statsByUuid.values()];
    const holdsRecords = [...holdsByKey.values()];
    const aliasRecords = [...aliasByUuid.values()];

    if (ungraded > 0) console.info(`   ${ungraded} problems are ungraded (imported with null difficulty)`);
    const collapsed = mappedCount - climbRecords.length;
    if (collapsed > 0) console.info(`   Collapsed ${collapsed} problem(s) with identical name+setter+holds`);

    // One transaction for all four tables: a mid-import crash must not leave a
    // climb without its holds/aliases.
    await db.transaction(async (tx) => {
      // Climbs — UUID derived from name+setter+holds, so a conflict means the
      // same problem is already imported and the identity columns are identical by
      // construction. Refresh `characteristics` and `description`, which both
      // derive from `method` (NOT part of the identity) — so a re-scrape
      // backfills/updates the method tag and the preserved joke label. Re-grades
      // land via the stats upsert.
      console.info(`   Inserting ${climbRecords.length} climbs...`);
      for (let i = 0; i < climbRecords.length; i += BATCH_SIZE) {
        await tx
          .insert(boardClimbs)
          .values(climbRecords.slice(i, i + BATCH_SIZE))
          .onConflictDoUpdate({
            target: boardClimbs.uuid,
            set: { characteristics: sql`excluded.characteristics`, description: sql`excluded.description` },
          });
      }

      console.info(`   Inserting ${statsRecords.length} stats...`);
      for (let i = 0; i < statsRecords.length; i += BATCH_SIZE) {
        await tx
          .insert(boardClimbStats)
          .values(statsRecords.slice(i, i + BATCH_SIZE))
          .onConflictDoUpdate({
            target: [boardClimbStats.boardType, boardClimbStats.climbUuid, boardClimbStats.angle],
            set: {
              displayDifficulty: sql`excluded.display_difficulty`,
              benchmarkDifficulty: sql`excluded.benchmark_difficulty`,
              difficultyAverage: sql`excluded.difficulty_average`,
              qualityNormalized: sql`true`,
            },
          });
      }

      console.info(`   Inserting ${holdsRecords.length} holds...`);
      for (let i = 0; i < holdsRecords.length; i += BATCH_SIZE) {
        await tx
          .insert(boardClimbHolds)
          .values(holdsRecords.slice(i, i + BATCH_SIZE))
          .onConflictDoNothing();
      }

      // Self-aliases so resolveCanonicalClimbUuid always hits.
      console.info(`   Inserting ${aliasRecords.length} self-aliases...`);
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

    console.info('\n✅ Import completed!');
    console.info(`   Climbs: ${climbRecords.length}`);
    console.info(`   Stats:  ${statsRecords.length}`);
    console.info(`   Holds:  ${holdsRecords.length}`);

    await close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Import failed:', error);
    process.exit(1);
  }
}

void importMoonBoard2024();
