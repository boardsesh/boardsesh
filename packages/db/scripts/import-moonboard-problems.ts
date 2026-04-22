import path from 'path';
import fs from 'fs';
import { sql } from 'drizzle-orm';
import { boardClimbs, boardClimbStats, boardClimbHolds } from '../src/schema/boards/unified.js';
import {
  uuidv5,
  coordinateToHoldId,
  movesToFrames,
  moveToHoldState,
  MOONBOARD_UUID_NAMESPACE,
  type MoonBoardMove,
} from './moonboard-helpers.js';
import { createScriptDb, getScriptDatabaseUrl } from './db-connection.js';

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

interface MoonBoardProblem {
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
}

interface DumpFile {
  total: number;
  data: MoonBoardProblem[];
}

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

// Grade string → difficulty ID (matching MOONBOARD_GRADES in moonboard-config.ts)
// Note: "5+" from MoonBoard maps to 5a (difficulty 13 / V1)
const GRADE_TO_DIFFICULTY: Record<string, number> = {
  '5+': 13,
  '6A': 16,
  '6a': 16,
  '6A+': 17,
  '6a+': 17,
  '6B': 18,
  '6b': 18,
  '6B+': 19,
  '6b+': 19,
  '6C': 20,
  '6c': 20,
  '6C+': 21,
  '6c+': 21,
  '7A': 22,
  '7a': 22,
  '7A+': 23,
  '7a+': 23,
  '7B': 24,
  '7b': 24,
  '7B+': 25,
  '7b+': 25,
  '7C': 26,
  '7c': 26,
  '7C+': 27,
  '7c+': 27,
  '8A': 28,
  '8a': 28,
  '8A+': 29,
  '8a+': 29,
  '8B': 30,
  '8b': 30,
  '8B+': 31,
  '8b+': 31,
};

// =============================================================================
// Files to import
// =============================================================================

interface FileConfig {
  filename: string;
  angle: number;
}

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

        const difficultyId = GRADE_TO_DIFFICULTY[problem.grade];
        if (difficultyId === undefined) {
          skippedGrade++;
          continue;
        }

        const uuid = uuidv5(`moonboard:${problem.apiId}`, MOONBOARD_UUID_NAMESPACE);
        const frames = movesToFrames(problem.moves);

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
        });

        statsRecords.push({
          boardType: 'moonboard',
          climbUuid: uuid,
          angle: fileConfig.angle,
          displayDifficulty: difficultyId,
          benchmarkDifficulty: problem.isBenchmark ? difficultyId : null,
          ascensionistCount: problem.repeats,
          difficultyAverage: difficultyId,
          qualityAverage: problem.userRating,
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
        await db.insert(boardClimbs).values(batch).onConflictDoNothing();
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
