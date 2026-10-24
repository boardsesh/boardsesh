/**
 * Read-only measurement of workout climb candidates (#6232, SEL0).
 *
 * The workout preview searches one grade at a time with `minAscents` (default
 * 5), `minRating` (default 2) and, soon, "Benchmarks only". Whether those
 * thresholds leave enough climbs depends on the board. This script counts, per
 * board, layout, popular angle and grade, how many listed climbs pass each
 * combination of
 *
 *   minAscents {0,1,5,10,50,100} x minRating {0,2,3,3.5} x benchmarks only {no,yes}
 *
 * and how often a typical plan fills across the grades climbers actually
 * target. The plans are volume 20, grade focus 15, pyramid 5x1 and ladder 5x2,
 * each built by the real generator on the board's real grade table. The
 * predicates mirror the server search (create-climb-filters.ts): rounded display_difficulty,
 * ascensionist_count >= minAscents, quality_average >= minRating,
 * a real benchmark_difficulty above 0 (realBenchmarkCondition: NaN does not
 * count), and is_listed / not draft / not hidden.
 *
 * Run: node --import tsx packages/db/scripts/analyze-workout-candidates.ts [--format md|json] [--min-climbs 1000]
 * Writes nothing: every query runs in a READ ONLY transaction.
 */
import { and, count, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { getGradesForBoard, toBoardName } from '@boardsesh/board-config';
import { createScriptDb } from './db-connection.js';
import { boardClimbStats, boardClimbs } from '../src/schema/boards/unified.js';
import { realBenchmarkCondition } from '../src/queries/climbs/benchmark.js';
import {
  MIN_ASCENTS_THRESHOLDS,
  MIN_RATING_THRESHOLDS,
  SUMMARY_HEADER,
  countByGrade,
  evaluateCatalogue,
  summaryRow,
  tierOf,
  type CatalogueResult,
  type CatalogueTarget,
  type FilterCombo,
  type TierGroup,
} from './analyze-workout-candidates-core.js';

function parseArgs(argv: string[]): { format: 'md' | 'json'; minClimbs: number } {
  let format: 'md' | 'json' = 'md';
  let minClimbs = 1000;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--format') format = argv[index + 1] === 'json' ? 'json' : 'md';
    if (argv[index] === '--min-climbs') {
      const requested = Number(argv[index + 1]);
      // 0 is a valid threshold; only a missing or non-numeric value keeps the default.
      if (Number.isFinite(requested) && requested >= 0) minClimbs = requested;
    }
  }
  return { format, minClimbs };
}

/** A climb's stats rows: one per angle. */
const statsJoin = and(
  eq(boardClimbStats.boardType, boardClimbs.boardType),
  eq(boardClimbStats.climbUuid, boardClimbs.uuid),
);

/** Listed, published, visible climbs with a stats row: what a workout search can return. */
const searchableClimbConditions = [
  eq(boardClimbs.isListed, true),
  eq(boardClimbs.isDraft, false),
  eq(boardClimbs.isHidden, false),
  ne(boardClimbs.boardType, 'spray'),
  isNotNull(boardClimbStats.displayDifficulty),
];

/**
 * The grade the preview searches on. Its 0 is literal SQL, not a bound
 * parameter, so the copy in GROUP BY renders the same text as the SELECT.
 */
const roundedGrade = sql<number>`ROUND(${boardClimbStats.displayDifficulty}::numeric, 0)::int`;
/**
 * The server's benchmark rule. It is never NULL, so a NULL benchmark difficulty
 * is "not a benchmark", never a third group, and NaN is not a benchmark either.
 */
const isBenchmark = realBenchmarkCondition(boardClimbStats.benchmarkDifficulty);

const DEFAULT_COMBO: FilterCombo = { minAscents: 5, minRating: 2, benchmarksOnly: false };
const BENCHMARK_COMBO: FilterCombo = { minAscents: 0, minRating: 0, benchmarksOnly: true };
const UNFILTERED_COMBO: FilterCombo = { minAscents: 0, minRating: 0, benchmarksOnly: false };

async function main(): Promise<void> {
  const { format, minClimbs } = parseArgs(process.argv.slice(2));
  const { db, close } = createScriptDb();
  try {
    const catalogues: Array<CatalogueResult & { groups: TierGroup[] }> = await db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      await tx.execute(sql`SET max_parallel_workers_per_gather = 0`);

      // Popular angle per layout: the angle with the most climbs that have stats.
      const angleRows = await tx
        .select({
          boardType: boardClimbs.boardType,
          layoutId: boardClimbs.layoutId,
          angle: boardClimbStats.angle,
          climbs: count(),
        })
        .from(boardClimbs)
        .innerJoin(boardClimbStats, statsJoin)
        .where(and(...searchableClimbConditions))
        .groupBy(boardClimbs.boardType, boardClimbs.layoutId, boardClimbStats.angle);
      const popular = new Map<string, (typeof angleRows)[number]>();
      const layoutTotals = new Map<string, number>();
      for (const row of angleRows) {
        const key = `${row.boardType}|${row.layoutId}`;
        layoutTotals.set(key, (layoutTotals.get(key) ?? 0) + row.climbs);
        const current = popular.get(key);
        if (!current || row.climbs > current.climbs || (row.climbs === current.climbs && row.angle < current.angle)) {
          popular.set(key, row);
        }
      }
      const targets: CatalogueTarget[] = [...popular.entries()]
        .filter(([key, row]) => (layoutTotals.get(key) ?? 0) >= minClimbs && row.climbs > 0)
        .map(([, { boardType, layoutId, angle }]) => ({ boardType, layoutId, angle }))
        .sort((first, second) => first.boardType.localeCompare(second.boardType) || first.layoutId - second.layoutId);

      const results: Array<CatalogueResult & { groups: TierGroup[] }> = [];
      for (const target of targets) {
        const rows = await tx
          .select({
            grade: roundedGrade,
            ascents: boardClimbStats.ascensionistCount,
            rating: boardClimbStats.qualityAverage,
            isBenchmark,
            climbs: count(),
          })
          .from(boardClimbs)
          .innerJoin(boardClimbStats, statsJoin)
          .where(
            and(
              ...searchableClimbConditions,
              eq(boardClimbs.boardType, target.boardType),
              eq(boardClimbs.layoutId, target.layoutId),
              eq(boardClimbStats.angle, target.angle),
            ),
          )
          .groupBy(roundedGrade, boardClimbStats.ascensionistCount, boardClimbStats.qualityAverage, isBenchmark);
        const merged = new Map<string, TierGroup>();
        for (const row of rows) {
          const ascentsTier = tierOf(row.ascents, MIN_ASCENTS_THRESHOLDS);
          const ratingTier = tierOf(row.rating, MIN_RATING_THRESHOLDS);
          const key = `${row.grade}|${ascentsTier}|${ratingTier}|${row.isBenchmark}`;
          const existing = merged.get(key);
          if (existing) existing.climbs += row.climbs;
          else
            merged.set(key, {
              grade: row.grade,
              ascentsTier,
              ratingTier,
              isBenchmark: row.isBenchmark,
              climbs: row.climbs,
            });
        }
        const groups = [...merged.values()];
        const boardName = toBoardName(target.boardType);
        if (!boardName) throw new Error(`Unknown board type ${target.boardType}`);
        results.push({ ...evaluateCatalogue(target, groups, getGradesForBoard(boardName)), groups });
      }
      return results;
    });

    if (format === 'json') {
      console.log(
        JSON.stringify(
          catalogues.map(({ groups: _groups, ...rest }) => rest),
          null,
          2,
        ),
      );
      return;
    }
    printMarkdown(catalogues);
  } finally {
    await close();
  }
}

function printMarkdown(catalogues: Array<CatalogueResult & { groups: TierGroup[] }>): void {
  const sections: Array<[string, FilterCombo]> = [
    ['No quality filter (minAscents 0, minRating 0)', UNFILTERED_COMBO],
    ['Rating floor off (minAscents 5, minRating 0)', { minAscents: 5, minRating: 0, benchmarksOnly: false }],
    ['Current defaults (minAscents 5, minRating 2)', DEFAULT_COMBO],
    ['Benchmarks only (no other filter)', BENCHMARK_COMBO],
    ['Boardz-style (minAscents 50, minRating 3.5)', { minAscents: 50, minRating: 3.5, benchmarksOnly: false }],
    ['minAscents 10, minRating 3', { minAscents: 10, minRating: 3, benchmarksOnly: false }],
  ];
  for (const [title, combo] of sections) {
    console.log(`\n### ${title}\n`);
    console.log(SUMMARY_HEADER);
    for (const catalogue of catalogues) console.log(summaryRow(catalogue, combo));
  }
  console.log('\n### Climbs per core grade at the current defaults (grade id: climbs)\n');
  for (const catalogue of catalogues) {
    const counts = countByGrade(catalogue.groups, DEFAULT_COMBO);
    const cells = catalogue.band.map((grade) => `${grade}: ${counts.get(grade) ?? 0}`);
    const { boardType, layoutId } = catalogue.target;
    console.log(`- ${boardType} layout ${layoutId}: ${cells.join(', ')}`);
  }
  console.log('\n### Benchmark share of the unfiltered catalogue\n');
  console.log('| board | layout | angle | climbs | benchmarks |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const { target, unfilteredClimbs, benchmarkClimbs } of catalogues) {
    console.log(
      `| ${target.boardType} | ${target.layoutId} | ${target.angle} | ${unfilteredClimbs} | ${benchmarkClimbs} |`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
