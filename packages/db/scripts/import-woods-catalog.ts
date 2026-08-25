import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import {
  boardClimbs,
  boardClimbStats,
  boardClimbHolds,
  boardClimbAliases,
  boardDifficultyGrades,
} from '../src/schema/boards/unified.js';
import {
  mapWoodsProblemToClimb,
  woodsGradeRows,
  WOODS_REQUIRED_SET_IDS,
  type WoodsCatalogFile,
} from './woods-catalog-helpers.js';
import { assertWoodsImportAllowed } from './woods-import-guard.js';
import { getScriptDatabaseUrl } from './db-connection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// =============================================================================
// Woods Board catalog import (boardsesh/woodsboard-scraper)
// =============================================================================
// Imports the full Woods catalog scraped from the Daniel Woods Board iOS app's
// REST API. One JSON file per physical size ({ boardDimension, count,
// problems[] }); we write one climb row per (name, author, hold layout) onto the
// single Woods layout, with compatibleSizeIds selecting the size.
//
// Idempotent: each climb gets a deterministic name|author|frames UUID, so a
// re-import upserts in place rather than duplicating. Stat upserts are monotonic
// for the ascent count (never shrink it). board_difficulty_grades is seeded once.
//
// The catalog files are not committed. Point the script at a local checkout of
// the woodsboard-scraper catalog directory — as a positional argument, or via
// WOODS_CATALOG_DIR, or leave both off to fall back to a sibling checkout
// (../../woodsboard-scraper/catalog relative to the repo root):
//   DB_URL=<target> tsx scripts/import-woods-catalog.ts /path/to/catalog
//   DB_URL=<target> WOODS_CATALOG_DIR=/path/to/catalog tsx scripts/import-woods-catalog.ts
//   DB_URL=<target> vp run db:import-woods-catalog -- /path/to/catalog
// Relative paths resolve against the current working directory. The positional
// argument wins over WOODS_CATALOG_DIR, which wins over the sibling default.
//
// DB_URL must be set inline — it beats the dev-db .env override and is how you
// target prod vs local. A non-local host also needs WOODS_IMPORT_ALLOW_REMOTE=1
// (see woods-import-guard.ts): the run rewrites the whole catalog, so pointing it
// at prod has to be deliberate rather than whatever DB_URL the shell carried in.
// =============================================================================

// Sibling checkout of boardsesh/woodsboard-scraper (../../../../ from scripts/:
// scripts → db → packages → repo root → the dir holding both checkouts).
const DEFAULT_DIR = path.join(__dirname, '../../../../woodsboard-scraper/catalog');
// 2000 rows/insert keeps every table well under Postgres's 65,535 bind-param
// limit (widest is board_climbs at ~22 cols) while cutting round-trips.
const BATCH_SIZE = 2000;

async function importWoodsCatalog() {
  const positional = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  const envDir = process.env.WOODS_CATALOG_DIR;
  const catalogDir = positional
    ? path.resolve(process.cwd(), positional)
    : envDir
      ? path.resolve(process.cwd(), envDir)
      : DEFAULT_DIR;

  if (!fs.existsSync(catalogDir) || !fs.statSync(catalogDir).isDirectory()) {
    console.error(`❌ Catalog directory not found: ${catalogDir}`);
    console.error('   Usage: DB_URL=<target> tsx scripts/import-woods-catalog.ts [/path/to/catalog]');
    console.error('   (or set WOODS_CATALOG_DIR instead of passing a path)');
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
  console.info(`🔄 Importing Woods catalog to: ${dbHost}`);
  assertWoodsImportAllowed(databaseUrl, 'import-woods-catalog.ts');
  console.info(`📂 Reading catalog from: ${catalogDir} (${files.length} files)`);

  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client);

  const totals = {
    climbs: 0,
    stats: 0,
    holds: 0,
    aliases: 0,
    skippedProblems: 0,
    duplicateProblems: 0,
    clampedGrades: 0,
    unmappedGrades: 0,
  };

  try {
    // Seed the grade scale once (idempotent upsert).
    const gradeRows = woodsGradeRows();
    await db
      .insert(boardDifficultyGrades)
      .values(gradeRows)
      .onConflictDoUpdate({
        target: [boardDifficultyGrades.boardType, boardDifficultyGrades.difficulty],
        set: {
          boulderName: sql`excluded.boulder_name`,
          routeName: sql`excluded.route_name`,
          isListed: sql`excluded.is_listed`,
        },
      });
    console.info(`   Seeded ${gradeRows.length} Woods difficulty grades`);

    for (const file of files) {
      const raw = fs.readFileSync(path.join(catalogDir, file), 'utf-8');
      const dump: WoodsCatalogFile = JSON.parse(raw);
      console.info(`\n📖 ${file} — ${dump.boardDimension}, ${dump.problems.length} problems`);

      // Dedupe in memory (last wins) keyed per conflict target so a single batch
      // never proposes the same target twice ("ON CONFLICT cannot affect row a
      // second time"). Stats are keyed by uuid+angle because two problems that
      // share name|author|holds at different angles share one climb UUID.
      const climbByUuid = new Map<string, typeof boardClimbs.$inferInsert>();
      const statsByKey = new Map<string, typeof boardClimbStats.$inferInsert>();
      const holdsByKey = new Map<string, typeof boardClimbHolds.$inferInsert>();
      const aliasByUuid = new Map<string, typeof boardClimbAliases.$inferInsert>();
      let mappedCount = 0;
      let skippedProblems = 0;
      let duplicateProblems = 0;
      let clampedGrades = 0;
      let unmappedGrades = 0;

      for (const problem of dump.problems) {
        const mapped = mapWoodsProblemToClimb(problem);
        if (!mapped) {
          skippedProblems++;
          continue;
        }
        mappedCount++;
        if (mapped.difficultyClamped) clampedGrades++;
        if (mapped.difficulty === null) unmappedGrades++;

        const statsKey = `${mapped.uuid}:${mapped.angle}`;
        // Two catalog problems that agree on name|author|holds AND angle are the
        // same climb listed twice — they collapse onto one row here (last wins).
        // Counted so the "problems in the files" vs "climbs in the database" gap
        // is visible in the summary instead of looking like dropped data.
        if (statsByKey.has(statsKey)) duplicateProblems++;

        climbByUuid.set(mapped.uuid, {
          uuid: mapped.uuid,
          boardType: 'woods',
          layoutId: mapped.layoutId,
          setterId: null,
          setterUsername: mapped.setterUsername,
          name: mapped.name,
          // `notes` is '' on every row of the catalog as of 2026-08, so there is
          // nothing to carry across; '' rather than NULL matches how every other
          // importer writes a description-less climb.
          description: '',
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
          // Projects are listed on purpose: a Woods "project" is a problem nobody
          // has sent yet, not a hidden or unfinished draft. The app shows them and
          // ~1,100 of them are real climbs to try, so hiding them would be wrong.
          isListed: true,
          createdAt: mapped.createdAt,
          synced: true,
          syncError: null,
          userId: null,
          requiredSetIds: WOODS_REQUIRED_SET_IDS,
          compatibleSizeIds: mapped.compatibleSizeIds,
          holdFingerprint: mapped.holdFingerprint,
          characteristics: null,
        });

        statsByKey.set(statsKey, {
          boardType: 'woods',
          climbUuid: mapped.uuid,
          angle: mapped.angle,
          displayDifficulty: mapped.difficulty,
          benchmarkDifficulty: null,
          ascensionistCount: mapped.ascensionistCount,
          difficultyAverage: mapped.difficulty,
          qualityAverage: mapped.qualityAverage,
          qualityNormalized: true,
          faUsername: mapped.faUsername,
          // The Woods API credits a first ascensionist by name but publishes no
          // date for it, so there is nothing honest to put here.
          faAt: null,
        });

        for (const hold of mapped.holds) {
          holdsByKey.set(`${mapped.uuid}:${hold.holdId}`, {
            boardType: 'woods',
            climbUuid: mapped.uuid,
            holdId: hold.holdId,
            frameNumber: 0,
            holdState: hold.holdState,
          });
        }

        // Self-alias so resolveCanonicalClimbUuid always hits for a Woods climb.
        // Nothing in the Woods path needs it today (there is no dedup pass and no
        // legacy uuid to redirect), but every other board maintains the invariant
        // "every canonical climb aliases to itself" and a future merge/repair pass
        // would otherwise start from a half-populated table.
        aliasByUuid.set(mapped.uuid, {
          boardType: 'woods',
          aliasUuid: mapped.uuid,
          canonicalUuid: mapped.uuid,
          source: 'woods-catalog-import',
        });
      }

      const climbRecords = [...climbByUuid.values()];
      const statsRecords = [...statsByKey.values()];
      const holdsRecords = [...holdsByKey.values()];
      const aliasRecords = [...aliasByUuid.values()];

      console.info(
        `   ${mappedCount} mapped, ${skippedProblems} skipped (no holds), ${duplicateProblems} duplicates folded`,
      );
      if (clampedGrades > 0) {
        console.info(`   ${clampedGrades} problems graded above the shared scale, clamped onto 8c+/V16`);
      }
      if (unmappedGrades > 0) {
        console.warn(`   ⚠️  ${unmappedGrades} problems carry a grade outside 0-17 — stored with a NULL difficulty`);
      }

      // One transaction per file: a crash mid-file never leaves a climb without
      // its holds, and completed files stay committed for an idempotent re-run.
      await db.transaction(async (tx) => {
        // Climbs — refresh the catalog-derived fields in place on re-import.
        for (let offset = 0; offset < climbRecords.length; offset += BATCH_SIZE) {
          await tx
            .insert(boardClimbs)
            .values(climbRecords.slice(offset, offset + BATCH_SIZE))
            .onConflictDoUpdate({
              target: boardClimbs.uuid,
              set: {
                name: sql`excluded.name`,
                frames: sql`excluded.frames`,
                angle: sql`excluded.angle`,
                setterUsername: sql`excluded.setter_username`,
                compatibleSizeIds: sql`excluded.compatible_size_ids`,
                requiredSetIds: sql`excluded.required_set_ids`,
                holdFingerprint: sql`excluded.hold_fingerprint`,
                createdAt: sql`excluded.created_at`,
              },
            });
        }

        // Stats — take the new grade, but never shrink the ascent count.
        for (let offset = 0; offset < statsRecords.length; offset += BATCH_SIZE) {
          await tx
            .insert(boardClimbStats)
            .values(statsRecords.slice(offset, offset + BATCH_SIZE))
            .onConflictDoUpdate({
              target: [boardClimbStats.boardType, boardClimbStats.climbUuid, boardClimbStats.angle],
              set: {
                displayDifficulty: sql`excluded.display_difficulty`,
                difficultyAverage: sql`excluded.difficulty_average`,
                ascensionistCount: sql`greatest(coalesce(excluded.ascensionist_count, 0), coalesce(${boardClimbStats.ascensionistCount}, 0))`,
                qualityAverage: sql`excluded.quality_average`,
                qualityNormalized: sql`true`,
                faUsername: sql`excluded.fa_username`,
              },
            });
        }

        for (let offset = 0; offset < holdsRecords.length; offset += BATCH_SIZE) {
          await tx
            .insert(boardClimbHolds)
            .values(holdsRecords.slice(offset, offset + BATCH_SIZE))
            .onConflictDoNothing();
        }

        for (let offset = 0; offset < aliasRecords.length; offset += BATCH_SIZE) {
          await tx
            .insert(boardClimbAliases)
            .values(aliasRecords.slice(offset, offset + BATCH_SIZE))
            .onConflictDoUpdate({
              target: [boardClimbAliases.boardType, boardClimbAliases.aliasUuid],
              set: { canonicalUuid: sql`excluded.canonical_uuid`, lastSeenAt: sql`now()` },
            });
        }
      });

      console.info(
        `   ✓ climbs ${climbRecords.length}, stats ${statsRecords.length}, holds ${holdsRecords.length}, aliases ${aliasRecords.length}`,
      );
      totals.climbs += climbRecords.length;
      totals.stats += statsRecords.length;
      totals.holds += holdsRecords.length;
      totals.aliases += aliasRecords.length;
      totals.skippedProblems += skippedProblems;
      totals.duplicateProblems += duplicateProblems;
      totals.clampedGrades += clampedGrades;
      totals.unmappedGrades += unmappedGrades;
    }

    console.info('\n✅ Import completed!');
    console.info(`   Climbs upserted:   ${totals.climbs}`);
    console.info(`   Stats upserted:    ${totals.stats}`);
    console.info(`   Holds upserted:    ${totals.holds}`);
    console.info(`   Aliases upserted:  ${totals.aliases}`);
    console.info(`   Problems skipped:  ${totals.skippedProblems} (no holds)`);
    console.info(`   Duplicates folded: ${totals.duplicateProblems} (same name, setter, holds and angle)`);
    console.info(`   Grades clamped:    ${totals.clampedGrades} (above 8c+/V16, the top of the shared scale)`);
    if (totals.unmappedGrades > 0) {
      console.warn(`   ⚠️  Grades unmapped: ${totals.unmappedGrades} — stored with a NULL difficulty`);
    }

    await client.end();
    process.exit(0);
  } catch (error) {
    console.error('❌ Import failed:', error);
    await client.end();
    process.exit(1);
  }
}

void importWoodsCatalog();
