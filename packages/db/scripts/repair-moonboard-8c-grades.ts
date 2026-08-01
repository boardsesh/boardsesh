/**
 * Repair MoonBoard 8C/8C+ rows imported before those grades were mapped.
 *
 * The authoritative app catalog is mandatory input. Dry-run is the default:
 *
 *   DB_URL=<target> vp run db:repair-moonboard-8c-grades -- /path/to/app-catalog
 *   DB_URL=<target> vp run db:repair-moonboard-8c-grades -- /path/to/app-catalog --apply
 *
 * This deliberately does not re-run the catalog importer. It resolves only
 * catalog-backed 8C/8C+ UUIDs through board_climb_aliases and fills only grade
 * columns that are still NULL on existing imported, listed climbs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, exists, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import {
  boardClimbAliases,
  boardClimbs,
  boardClimbStats,
  boardDifficultyGrades,
} from '../src/schema/boards/unified.js';
import { createScriptDb, describeDatabaseHost, getScriptDatabaseUrl } from './db-connection.js';
import {
  MOONBOARD_8C_DIFFICULTY_IDS,
  executeMoonBoardGradeRepair,
  extractMoonBoard8cCandidates,
  parseMoonBoard8cRepairArgs,
  resolveMoonBoardGradeRepairTargets,
  type MoonBoardCatalogSource,
  type MoonBoardGradeRepairPlan,
  type MoonBoardGradeRepairTarget,
  type MoonBoardGradeRepairUpdate,
  type MoonBoardStoredGradeRow,
} from './moonboard-grade-repair.js';
import { HOLDSETUP_TO_LAYOUT, type MoonBoardCatalogFile } from './moonboard-catalog-helpers.js';

const EXPECTED_GRADE_NAMES = new Map<number, string>([
  [32, '8c/V15'],
  [33, '8c+/V16'],
]);
const EXPECTED_HOLDSETUPS = Object.keys(HOLDSETUP_TO_LAYOUT).map(Number);

type ScriptTransaction = Parameters<Parameters<ReturnType<typeof createScriptDb>['db']['transaction']>[0]>[0];

function isMoonBoardCatalogFile(input: unknown): input is MoonBoardCatalogFile {
  return (
    input !== null &&
    typeof input === 'object' &&
    'holdsetup' in input &&
    typeof input.holdsetup === 'number' &&
    'problems' in input &&
    Array.isArray(input.problems)
  );
}

function readCatalogSources(catalogDir: string): MoonBoardCatalogSource[] {
  if (!fs.existsSync(catalogDir) || !fs.statSync(catalogDir).isDirectory()) {
    throw new Error(`Catalog directory not found: ${catalogDir}`);
  }
  const fileNames = fs
    .readdirSync(catalogDir)
    .filter((fileName) => fileName.toLowerCase().endsWith('.json'))
    .sort();
  if (fileNames.length === 0) throw new Error(`No JSON catalog files found in ${catalogDir}`);

  return fileNames.map((fileName) => {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(catalogDir, fileName), 'utf8'));
    if (!isMoonBoardCatalogFile(parsed)) throw new Error(`${fileName} is not a MoonBoard catalog file`);
    return { fileName, dump: parsed };
  });
}

function assertCompleteCatalog(sources: readonly MoonBoardCatalogSource[]): void {
  const filesByHoldsetup = new Map<number, string[]>();
  for (const source of sources) {
    const fileNames = filesByHoldsetup.get(source.dump.holdsetup) ?? [];
    fileNames.push(source.fileName);
    filesByHoldsetup.set(source.dump.holdsetup, fileNames);
  }

  const missing = EXPECTED_HOLDSETUPS.filter((holdsetup) => !filesByHoldsetup.has(holdsetup));
  const duplicates = [...filesByHoldsetup.entries()].filter(([, fileNames]) => fileNames.length > 1);
  if (missing.length > 0 || duplicates.length > 0) {
    const duplicateSummary = duplicates
      .map(([holdsetup, fileNames]) => `${holdsetup} (${fileNames.join(', ')})`)
      .join('; ');
    throw new Error(
      `Catalog must contain exactly one file for each known holdsetup. Missing: ${missing.join(', ') || 'none'}; ` +
        `duplicates: ${duplicateSummary || 'none'}`,
    );
  }
}

async function assertGradeRowsReady(transaction: ScriptTransaction): Promise<void> {
  const gradeRows = await transaction
    .select({
      difficulty: boardDifficultyGrades.difficulty,
      boulderName: boardDifficultyGrades.boulderName,
      isListed: boardDifficultyGrades.isListed,
    })
    .from(boardDifficultyGrades)
    .where(
      and(
        eq(boardDifficultyGrades.boardType, 'moonboard'),
        inArray(boardDifficultyGrades.difficulty, [...MOONBOARD_8C_DIFFICULTY_IDS]),
      ),
    );
  const rowsByDifficulty = new Map(gradeRows.map((row) => [row.difficulty, row]));
  const problems: string[] = [];
  for (const difficultyId of MOONBOARD_8C_DIFFICULTY_IDS) {
    const row = rowsByDifficulty.get(difficultyId);
    const expectedName = EXPECTED_GRADE_NAMES.get(difficultyId);
    if (row === undefined) problems.push(`difficulty ${difficultyId} is missing`);
    else if (row.boulderName !== expectedName || row.isListed !== true) {
      problems.push(
        `difficulty ${difficultyId} expected ${expectedName}/listed, found ${row.boulderName ?? 'NULL'}/${String(row.isListed)}`,
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(`Run the MoonBoard 8C grade migration before repairing stats: ${problems.join('; ')}`);
  }
}

async function loadStoredRows(
  transaction: ScriptTransaction,
  targets: readonly MoonBoardGradeRepairTarget[],
): Promise<MoonBoardStoredGradeRow[]> {
  const canonicalUuids = [...new Set(targets.map((target) => target.canonicalUuid))];
  if (canonicalUuids.length === 0) return [];

  return transaction
    .select({
      climbUuid: boardClimbs.uuid,
      statsAngle: boardClimbStats.angle,
      climbAngle: boardClimbs.angle,
      layoutId: boardClimbs.layoutId,
      userId: boardClimbs.userId,
      isDraft: boardClimbs.isDraft,
      isListed: boardClimbs.isListed,
      displayDifficulty: boardClimbStats.displayDifficulty,
      benchmarkDifficulty: boardClimbStats.benchmarkDifficulty,
      difficultyAverage: boardClimbStats.difficultyAverage,
    })
    .from(boardClimbs)
    .innerJoin(
      boardClimbStats,
      and(eq(boardClimbStats.boardType, boardClimbs.boardType), eq(boardClimbStats.climbUuid, boardClimbs.uuid)),
    )
    .where(and(eq(boardClimbs.boardType, 'moonboard'), inArray(boardClimbs.uuid, canonicalUuids)));
}

async function applyGradeUpdate(transaction: ScriptTransaction, update: MoonBoardGradeRepairUpdate): Promise<boolean> {
  const set: {
    displayDifficulty?: number;
    benchmarkDifficulty?: number;
    difficultyAverage?: number;
  } = {};
  const guards: SQL[] = [
    eq(boardClimbStats.boardType, 'moonboard'),
    eq(boardClimbStats.climbUuid, update.target.canonicalUuid),
    eq(boardClimbStats.angle, update.target.angle),
  ];
  const safeClimb = transaction
    .select({ uuid: boardClimbs.uuid })
    .from(boardClimbs)
    .where(
      and(
        eq(boardClimbs.uuid, update.target.canonicalUuid),
        eq(boardClimbs.boardType, 'moonboard'),
        eq(boardClimbs.layoutId, update.target.layoutId),
        eq(boardClimbs.angle, update.target.angle),
        isNull(boardClimbs.userId),
        eq(boardClimbs.isDraft, false),
        eq(boardClimbs.isListed, true),
      ),
    );
  guards.push(exists(safeClimb));

  if (update.fillDisplayDifficulty) {
    set.displayDifficulty = update.target.difficultyId;
    guards.push(isNull(boardClimbStats.displayDifficulty));
  }
  if (update.fillBenchmarkDifficulty) {
    set.benchmarkDifficulty = update.target.difficultyId;
    guards.push(isNull(boardClimbStats.benchmarkDifficulty));
  }
  if (update.fillDifficultyAverage) {
    set.difficultyAverage = update.target.difficultyId;
    guards.push(isNull(boardClimbStats.difficultyAverage));
  }

  const updatedRows = await transaction
    .update(boardClimbStats)
    .set(set)
    .where(and(...guards))
    .returning({ climbUuid: boardClimbStats.climbUuid });
  return updatedRows.length === 1;
}

function filledColumns(update: MoonBoardGradeRepairUpdate): string {
  const columns: string[] = [];
  if (update.fillDisplayDifficulty) columns.push('display_difficulty');
  if (update.fillBenchmarkDifficulty) columns.push('benchmark_difficulty');
  if (update.fillDifficultyAverage) columns.push('difficulty_average');
  return columns.join(',');
}

function reportPlan(plan: MoonBoardGradeRepairPlan): void {
  console.info(
    `[moonboard-8c-repair] planned=${plan.updates.length} unchanged=${plan.unchanged.length} skipped=${plan.skipped.length}`,
  );
  for (const update of plan.updates) {
    console.info(
      `[moonboard-8c-repair] repair canonical=${update.target.canonicalUuid} angle=${update.target.angle} ` +
        `grade=${update.target.sourceGrade}/${update.target.difficultyId} benchmark=${String(update.target.isBenchmark)} ` +
        `problems=${update.target.sourceProblemIds.join(',')} sources=${update.target.sourceUuids.join(',')} ` +
        `fill=${filledColumns(update)} ` +
        `before=${String(update.before.displayDifficulty)}/${String(update.before.benchmarkDifficulty)}/${String(update.before.difficultyAverage)}`,
    );
  }
  for (const skipped of plan.skipped) {
    console.warn(
      `[moonboard-8c-repair] skip canonical=${skipped.target.canonicalUuid} angle=${skipped.target.angle} ` +
        `problems=${skipped.target.sourceProblemIds.join(',')} sources=${skipped.target.sourceUuids.join(',')} ` +
        `reason=${skipped.reason}`,
    );
  }
}

async function main(): Promise<void> {
  const { apply, catalogPath } = parseMoonBoard8cRepairArgs(process.argv.slice(2));
  const catalogDir = path.resolve(process.cwd(), catalogPath);
  const sources = readCatalogSources(catalogDir);
  assertCompleteCatalog(sources);
  const { candidates, unknownHoldsetups } = extractMoonBoard8cCandidates(sources);
  if (unknownHoldsetups.length > 0) {
    throw new Error(
      `Catalog contains unknown holdsetups: ${unknownHoldsetups
        .map(({ fileName, holdsetup }) => `${fileName}=${holdsetup}`)
        .join(', ')}`,
    );
  }
  if (apply && candidates.length === 0) throw new Error('Catalog contains no 8C/8C+ configurations; refusing --apply');

  const databaseUrl = getScriptDatabaseUrl();
  console.info(
    `[moonboard-8c-repair] target=${describeDatabaseHost(databaseUrl)} mode=${apply ? 'apply' : 'dry-run'} ` +
      `catalog=${catalogDir} candidates=${candidates.length}`,
  );
  const { db, close } = createScriptDb(databaseUrl);
  try {
    await db.transaction(async (transaction) => {
      if (apply) await transaction.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      else await transaction.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await transaction.execute(sql`SET LOCAL lock_timeout = '5s'`);
      await transaction.execute(sql`SET LOCAL statement_timeout = '2min'`);
      if (apply) {
        await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext('boardsesh:moonboard-8c-grade-repair'))`);
      }

      await assertGradeRowsReady(transaction);
      const aliasRows = await transaction
        .select({ aliasUuid: boardClimbAliases.aliasUuid, canonicalUuid: boardClimbAliases.canonicalUuid })
        .from(boardClimbAliases)
        .where(eq(boardClimbAliases.boardType, 'moonboard'));
      const canonicalByAlias = new Map(aliasRows.map((row) => [row.aliasUuid, row.canonicalUuid]));
      const { targets, aliasProblems } = resolveMoonBoardGradeRepairTargets(candidates, canonicalByAlias);
      for (const aliasProblem of aliasProblems) {
        console.warn(
          `[moonboard-8c-repair] cyclic alias source=${aliasProblem.sourceUuid} path=${aliasProblem.path.join(' -> ')}`,
        );
      }
      if (apply && aliasProblems.length > 0) {
        throw new Error(`Refusing --apply with ${aliasProblems.length} cyclic catalog alias resolution failures`);
      }

      console.info(
        `[moonboard-8c-repair] aliases=${aliasRows.length} resolved_targets=${targets.length} ` +
          `alias_problems=${aliasProblems.length}`,
      );
      const execution = await executeMoonBoardGradeRepair(
        targets,
        {
          loadRows: (requestedTargets) => loadStoredRows(transaction, requestedTargets),
          applyUpdate: (update) => applyGradeUpdate(transaction, update),
        },
        apply,
      );
      reportPlan(execution.plan);
      if (apply) {
        console.info(
          `[moonboard-8c-repair] applied=${execution.appliedRows} verified_remaining=${execution.verifiedPlan?.updates.length ?? 0}`,
        );
      } else {
        console.info('[moonboard-8c-repair] dry-run complete; no rows written');
      }
    });
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error(`[moonboard-8c-repair] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
