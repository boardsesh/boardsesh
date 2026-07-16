/**
 * Seed the relational MoonBoard hardware catalog used by geometry consumers.
 *
 * Dry-run is the default. Apply with:
 *   DB_URL=<target> vp run db:backfill-moonboard-hardware -- --apply
 */
import { and, eq, sql } from 'drizzle-orm';
import { createScriptDb, getScriptDatabaseUrl } from './db-connection.js';
import {
  boardHoles,
  boardClimbHolds,
  boardClimbs,
  boardLayouts,
  boardPlacements,
  boardProducts,
  boardSets,
} from '../src/schema/boards/unified.js';
import {
  buildMoonBoardHardware,
  countMissingMoonBoardHardware,
  findMoonBoardHardwareDefinitionProblems,
  findMoonBoardHardwareProblems,
  findUnmappedMoonBoardHardwareUses,
  type MoonBoardHardwareUse,
  type MoonBoardHardwareState,
} from './moonboard-hardware.js';

const APPLY_FLAG = '--apply';
const ARG_SEPARATOR = '--';

export function parseMoonBoardHardwareArgs(args: string[]): { apply: boolean } {
  const meaningfulArgs = args.filter((argument) => argument !== ARG_SEPARATOR);
  const unknownArgument = meaningfulArgs.find((argument) => argument !== APPLY_FLAG);
  if (unknownArgument) throw new Error(`Unknown argument: ${unknownArgument}`);
  return { apply: meaningfulArgs.includes(APPLY_FLAG) };
}

async function loadHardwareState(
  db: Parameters<Parameters<ReturnType<typeof createScriptDb>['db']['transaction']>[0]>[0],
) {
  const products = await db.select().from(boardProducts).where(eq(boardProducts.boardType, 'moonboard'));
  const layouts = await db.select().from(boardLayouts).where(eq(boardLayouts.boardType, 'moonboard'));
  const sets = await db.select().from(boardSets).where(eq(boardSets.boardType, 'moonboard'));
  const holes = await db.select().from(boardHoles).where(eq(boardHoles.boardType, 'moonboard'));
  const placements = await db.select().from(boardPlacements).where(eq(boardPlacements.boardType, 'moonboard'));
  return { products, layouts, sets, holes, placements } as MoonBoardHardwareState;
}

async function loadHardwareUses(
  db: Parameters<Parameters<ReturnType<typeof createScriptDb>['db']['transaction']>[0]>[0],
): Promise<MoonBoardHardwareUse[]> {
  const rows = await db
    .select({
      layoutId: boardClimbs.layoutId,
      holeId: boardClimbHolds.holdId,
      importedRowCount: sql<number>`count(*) FILTER (WHERE ${boardClimbs.userId} IS NULL)::int`,
      userRowCount: sql<number>`count(*) FILTER (WHERE ${boardClimbs.userId} IS NOT NULL)::int`,
    })
    .from(boardClimbHolds)
    .innerJoin(
      boardClimbs,
      and(eq(boardClimbs.boardType, boardClimbHolds.boardType), eq(boardClimbs.uuid, boardClimbHolds.climbUuid)),
    )
    .where(eq(boardClimbHolds.boardType, 'moonboard'))
    .groupBy(boardClimbs.layoutId, boardClimbHolds.holdId);

  return rows.map((row) => ({
    layoutId: row.layoutId,
    holeId: row.holeId,
    importedRowCount: Number(row.importedRowCount),
    userRowCount: Number(row.userRowCount),
  }));
}

function reportUnmappedUses(unmappedUses: MoonBoardHardwareUse[]): void {
  const importedRows = unmappedUses.reduce((total, usage) => total + usage.importedRowCount, 0);
  const userRows = unmappedUses.reduce((total, usage) => total + usage.userRowCount, 0);
  console.warn(
    `[moonboard-hardware] unmapped used cells=${unmappedUses.length} imported_rows=${importedRows} user_rows=${userRows}`,
  );
  for (const usage of unmappedUses) {
    console.warn(
      `[moonboard-hardware] unmapped layout=${usage.layoutId} cell=${usage.holeId} ` +
        `imported_rows=${usage.importedRowCount} user_rows=${usage.userRowCount}`,
    );
  }
}

function assertState(problems: string[], phase: string): void {
  if (problems.length === 0) return;
  const preview = problems
    .slice(0, 20)
    .map((problem) => `  - ${problem}`)
    .join('\n');
  const remainder = problems.length > 20 ? `\n  ... and ${problems.length - 20} more` : '';
  throw new Error(`MoonBoard hardware ${phase} validation failed:\n${preview}${remainder}`);
}

async function main(): Promise<void> {
  const { apply } = parseMoonBoardHardwareArgs(process.argv.slice(2));
  const databaseUrl = getScriptDatabaseUrl();
  console.info(`[moonboard-hardware] target=${new URL(databaseUrl).host} mode=${apply ? 'apply' : 'dry-run'}`);

  const expected = buildMoonBoardHardware();
  assertState(findMoonBoardHardwareDefinitionProblems(expected), 'definition');
  const { db, close } = createScriptDb(databaseUrl);
  try {
    await db.transaction(async (transaction) => {
      if (!apply) {
        await transaction.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      }
      await transaction.execute(sql`SET LOCAL lock_timeout = '5s'`);
      await transaction.execute(sql`SET LOCAL statement_timeout = '2min'`);
      if (apply) {
        await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext('boardsesh:moonboard-hardware-backfill'))`);
      }

      const before = await loadHardwareState(transaction);
      assertState(findMoonBoardHardwareProblems(expected, before, false), 'pre-write');
      const unmappedUses = findUnmappedMoonBoardHardwareUses(expected, await loadHardwareUses(transaction));
      reportUnmappedUses(unmappedUses);
      const missing = countMissingMoonBoardHardware(expected, before);
      console.info(
        `[moonboard-hardware] missing products=${missing.products} layouts=${missing.layouts} sets=${missing.sets} ` +
          `holes=${missing.holes} placements=${missing.placements}`,
      );

      if (!apply) {
        console.info('[moonboard-hardware] dry-run complete; no rows written');
        return;
      }

      await transaction.insert(boardProducts).values(expected.products).onConflictDoNothing();
      await transaction.insert(boardLayouts).values(expected.layouts).onConflictDoNothing();
      await transaction.insert(boardSets).values(expected.sets).onConflictDoNothing();
      await transaction.insert(boardHoles).values(expected.holes).onConflictDoNothing();
      await transaction.insert(boardPlacements).values(expected.placements).onConflictDoNothing();

      const after = await loadHardwareState(transaction);
      assertState(findMoonBoardHardwareProblems(expected, after, true), 'post-write');
      console.info(
        `[moonboard-hardware] validated products=${after.products.length} layouts=${after.layouts.length} ` +
          `sets=${after.sets.length} holes=${after.holes.length} placements=${after.placements.length}`,
      );
    });
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error(`[moonboard-hardware] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
