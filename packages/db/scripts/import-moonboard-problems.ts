import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { sql } from 'drizzle-orm';
import { boardClimbs, boardClimbStats, boardClimbHolds } from '../src/schema/boards/unified.js';
import {
  uuidv5,
  coordinateToHoldId,
  movesToFrames,
  moveToHoldState,
  MOONBOARD_UUID_NAMESPACE,
  moonBoardGradeToDifficultyId,
  type MoonBoardMove,
} from './moonboard-helpers.js';
import { createScriptDb, getScriptDatabaseUrl } from './db-connection.js';
// Import the dependency-free `./characteristics` subpath (not the package root,
// which pulls in graphql) so this resolves in the isolated dev-db image build,
// where shared-schema is dropped into node_modules without its deps installed.
import { moonBoardMethodToCharacteristic } from '@boardsesh/shared-schema/characteristics';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// =============================================================================
// Data Source
// =============================================================================
// MoonBoard problem data comes from a community-provided dump:
//   GitHub issue: https://github.com/spookykat/MoonBoard/issues/6#issuecomment-1783515787
//   Direct download: https://github.com/spookykat/MoonBoard/files/13193317/problems_2023_01_30.zip
//   Date: 2023-01-30
//
// The ZIP contains these JSON files:
//   - problems MoonBoard 2016 .json
//   - problems MoonBoard Masters 2017 25.json
//   - problems MoonBoard Masters 2017 40.json
//   - problems MoonBoard Masters 2019 25.json
//   - problems MoonBoard Masters 2019 40.json
//   - problems Mini MoonBoard 2020 40.json
//
// The import is baked into the dev-db Docker image during build, and can also
// be run manually with `vp run db:import-moonboard [/path/to/dump]`.
// =============================================================================

// =============================================================================
// Types for the MoonBoard JSON dump
// =============================================================================

type MoonBoardProblem = {
  name: string;
  grade: string; // e.g., "7C", "6B+"
  userGrade: string | null;
  setbyId: string;
  setby: string;
  method: string;
  userRating: number;
  repeats: number;
  holdsetup: {
    description: string;
    holdsets: unknown;
    apiId: number;
  };
  isBenchmark: boolean;
  isMaster: boolean;
  upgraded: boolean;
  downgraded: boolean;
  moves: MoonBoardMove[];
  holdsets: unknown[];
  hasBetaVideo: boolean;
  moonBoardConfigurationId: number;
  apiId: number;
  dateInserted: string;
  dateUpdated: string;
  dateDeleted: string | null;
};

type DumpFile = {
  total: number;
  data: MoonBoardProblem[];
};

// =============================================================================
// Mapping constants
// =============================================================================

// holdsetup.apiId → layout ID in our database
const HOLDSETUP_TO_LAYOUT: Record<number, number> = {
  1: 2, // MoonBoard 2016
  15: 4, // MoonBoard Masters 2017
  17: 5, // MoonBoard Masters 2019
  19: 6, // Mini MoonBoard 2020
};

// =============================================================================
// Files to import
// =============================================================================

type FileConfig = {
  filename: string;
  angle: number;
};

const FILES_TO_IMPORT: FileConfig[] = [
  { filename: 'problems MoonBoard 2016 .json', angle: 40 },
  { filename: 'problems MoonBoard Masters 2017 25.json', angle: 25 },
  { filename: 'problems MoonBoard Masters 2017 40.json', angle: 40 },
  { filename: 'problems MoonBoard Masters 2019 25.json', angle: 25 },
  { filename: 'problems MoonBoard Masters 2019 40.json', angle: 40 },
  { filename: 'problems Mini MoonBoard 2020 40.json', angle: 40 },
];

const BATCH_SIZE = 500;

// =============================================================================
// Main import function
// =============================================================================

async function importMoonBoardProblems() {
  const dumpPath = process.argv[2]
    ? path.resolve(process.cwd(), process.argv[2])
    : path.join(process.env.HOME || '~', 'Downloads', 'problems_2023_01_30');

  // Verify dump directory exists
  if (!fs.existsSync(dumpPath)) {
    console.error(`❌ Dump directory not found: ${dumpPath}`);
    console.error('   Usage: vp run db:import-moonboard [/path/to/dump]');
    process.exit(1);
  }

  const databaseUrl = getScriptDatabaseUrl();
  const dbHost = databaseUrl.split('@')[1]?.split('/')[0] || 'unknown';
  console.info(`🔄 Importing MoonBoard problems to: ${dbHost}`);
  console.info(`📂 Reading dump from: ${dumpPath}`);

  const { db, close } = createScriptDb(databaseUrl);

  try {
    let totalClimbs = 0;
    let totalStats = 0;
    let totalHolds = 0;
    let totalSkipped = 0;

    for (const fileConfig of FILES_TO_IMPORT) {
      const filePath = path.join(dumpPath, fileConfig.filename);
      if (!fs.existsSync(filePath)) {
        console.warn(`⚠️  File not found, skipping: ${fileConfig.filename}`);
        continue;
      }

      console.info(`\n📖 Processing: ${fileConfig.filename}`);
      const raw = fs.readFileSync(filePath, 'utf-8');
      const dump: DumpFile = JSON.parse(raw);
      console.info(`   Total problems in file: ${dump.data.length}`);

      // Filter out deleted problems
      const problems = dump.data.filter((p) => p.dateDeleted === null);
      const deleted = dump.data.length - problems.length;
      if (deleted > 0) {
        console.info(`   Skipping ${deleted} deleted problems`);
        totalSkipped += deleted;
      }

      // Prepare records
      const climbRecords: (typeof boardClimbs.$inferInsert)[] = [];
      const statsRecords: (typeof boardClimbStats.$inferInsert)[] = [];
      const holdsRecords: (typeof boardClimbHolds.$inferInsert)[] = [];
      let skippedGrade = 0;
      let skippedLayout = 0;

      for (const problem of problems) {
        const layoutId = HOLDSETUP_TO_LAYOUT[problem.holdsetup.apiId];
        if (!layoutId) {
          skippedLayout++;
          continue;
        }

        const difficultyId = moonBoardGradeToDifficultyId(problem.grade);
        if (difficultyId === undefined) {
          skippedGrade++;
          continue;
        }

        const uuid = uuidv5(`moonboard:${problem.apiId}`, MOONBOARD_UUID_NAMESPACE);
        const frames = movesToFrames(problem.moves);
        // MoonBoard problem "method" (footless / footless+kickboard / no-kickboard)
        // becomes a structured characteristic; the default "feet follow hands"
        // maps to null (no token).
        const methodCharacteristic = moonBoardMethodToCharacteristic(problem.method);

        climbRecords.push({
          uuid,
          boardType: 'moonboard',
          layoutId,
          setterId: null,
          setterUsername: problem.setby,
          name: problem.name,
          description: '',
          hsm: null,
          edgeLeft: null,
          edgeRight: null,
          edgeBottom: null,
          edgeTop: null,
          angle: fileConfig.angle,
          framesCount: 1,
          framesPace: 0,
          frames,
          isDraft: false,
          isListed: true,
          createdAt: problem.dateInserted,
          synced: true,
          syncError: null,
          userId: null,
          characteristics: methodCharacteristic ? [methodCharacteristic] : null,
        });

        statsRecords.push({
          boardType: 'moonboard',
          climbUuid: uuid,
          angle: fileConfig.angle,
          displayDifficulty: difficultyId,
          benchmarkDifficulty: problem.isBenchmark ? difficultyId : null,
          ascensionistCount: problem.repeats,
          difficultyAverage: difficultyId,
          // MoonBoard userRating is already on the 1-5 scale — mark normalized
          // so the 1-3→1-5 backfill (0116) and future runs leave it untouched.
          qualityAverage: problem.userRating,
          qualityNormalized: true,
          faUsername: null,
          faAt: null,
        });

        for (const move of problem.moves) {
          const holdId = coordinateToHoldId(move.description);
          holdsRecords.push({
            boardType: 'moonboard',
            climbUuid: uuid,
            holdId,
            frameNumber: 0,
            holdState: moveToHoldState(move),
          });
        }
      }

      if (skippedGrade > 0) console.info(`   Skipped ${skippedGrade} problems with unknown grade`);
      if (skippedLayout > 0) console.info(`   Skipped ${skippedLayout} problems with unknown holdsetup`);

      // Batch insert climbs
      console.info(`   Inserting ${climbRecords.length} climbs...`);
      for (let i = 0; i < climbRecords.length; i += BATCH_SIZE) {
        const batch = climbRecords.slice(i, i + BATCH_SIZE);
        // Upsert only the characteristics column so a re-run backfills method
        // tags onto climbs imported before characteristics existed, without
        // disturbing any other field (name, frames, setter, etc.).
        await db
          .insert(boardClimbs)
          .values(batch)
          .onConflictDoUpdate({
            target: boardClimbs.uuid,
            set: { characteristics: sql`excluded.characteristics` },
          });
        if ((i + BATCH_SIZE) % 5000 === 0 || i + BATCH_SIZE >= climbRecords.length) {
          process.stdout.write(`\r   Climbs: ${Math.min(i + BATCH_SIZE, climbRecords.length)}/${climbRecords.length}`);
        }
      }
      console.info('');
      totalClimbs += climbRecords.length;

      // Batch insert stats (upsert to refresh on re-run)
      console.info(`   Inserting ${statsRecords.length} stats...`);
      for (let i = 0; i < statsRecords.length; i += BATCH_SIZE) {
        const batch = statsRecords.slice(i, i + BATCH_SIZE);
        await db
          .insert(boardClimbStats)
          .values(batch)
          .onConflictDoUpdate({
            target: [boardClimbStats.boardType, boardClimbStats.climbUuid, boardClimbStats.angle],
            set: {
              displayDifficulty: sql`excluded.display_difficulty`,
              benchmarkDifficulty: sql`excluded.benchmark_difficulty`,
              ascensionistCount: sql`excluded.ascensionist_count`,
              difficultyAverage: sql`excluded.difficulty_average`,
              qualityAverage: sql`excluded.quality_average`,
              qualityNormalized: sql`true`,
            },
          });
        if ((i + BATCH_SIZE) % 5000 === 0 || i + BATCH_SIZE >= statsRecords.length) {
          process.stdout.write(`\r   Stats: ${Math.min(i + BATCH_SIZE, statsRecords.length)}/${statsRecords.length}`);
        }
      }
      console.info('');
      totalStats += statsRecords.length;

      // Batch insert holds
      console.info(`   Inserting ${holdsRecords.length} holds...`);
      for (let i = 0; i < holdsRecords.length; i += BATCH_SIZE) {
        const batch = holdsRecords.slice(i, i + BATCH_SIZE);
        await db.insert(boardClimbHolds).values(batch).onConflictDoNothing();
        if ((i + BATCH_SIZE) % 5000 === 0 || i + BATCH_SIZE >= holdsRecords.length) {
          process.stdout.write(`\r   Holds: ${Math.min(i + BATCH_SIZE, holdsRecords.length)}/${holdsRecords.length}`);
        }
      }
      console.info('');
      totalHolds += holdsRecords.length;
    }

    console.info('\n✅ Import completed!');
    console.info(`   Total climbs: ${totalClimbs}`);
    console.info(`   Total stats: ${totalStats}`);
    console.info(`   Total holds: ${totalHolds}`);
    console.info(`   Total skipped (deleted): ${totalSkipped}`);

    await close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Import failed:', error);
    process.exit(1);
  }
}

void importMoonBoardProblems();
