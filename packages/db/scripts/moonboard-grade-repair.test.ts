import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertCompleteMoonBoardCatalog,
  assertMoonBoardCatalogFile,
  executeMoonBoardGradeRepair,
  extractMoonBoard8cCandidates,
  parseMoonBoard8cRepairArgs,
  planMoonBoardGradeRepairs,
  resolveMoonBoardGradeRepairTargets,
  resolveTerminalMoonBoardAlias,
  type MoonBoardCatalogSource,
  type MoonBoardGradeRepairStore,
  type MoonBoardStoredGradeRow,
} from './moonboard-grade-repair.js';
import { HOLDSETUP_TO_LAYOUT, type MoonBoardCatalogProblem } from './moonboard-catalog-helpers.js';

void test('repair CLI is dry-run unless --apply is explicitly present', () => {
  assert.deepEqual(parseMoonBoard8cRepairArgs(['/catalog']), { apply: false, catalogPath: '/catalog' });
  assert.deepEqual(parseMoonBoard8cRepairArgs(['--', '/catalog', '--apply']), {
    apply: true,
    catalogPath: '/catalog',
  });
  assert.throws(() => parseMoonBoard8cRepairArgs(['/catalog', '--write']), /Unknown argument/);
  assert.throws(() => parseMoonBoard8cRepairArgs([]), /Catalog path required/);
});

const CATALOG_PROBLEMS: MoonBoardCatalogProblem[] = [
  {
    id: 800,
    name: 'Hard benchmark',
    setter: 'Setter One',
    moves: 's~A1~|l~B2~|e~C3~',
    holdsetup: 21,
    Active: true,
    configurations: [
      {
        apiId: 80040,
        grade: '8C',
        configuration: '40°',
        repeats: 12,
        isBenchmark: true,
      },
    ],
  },
  {
    id: 801,
    name: 'Lowercase hard climb',
    setter: 'Setter Two',
    moves: 's~A2~|l~B3~|e~C4~',
    holdsetup: 21,
    Active: true,
    configurations: [
      {
        apiId: 80140,
        grade: '8c+',
        configuration: '40°',
        repeats: 4,
        isBenchmark: false,
      },
    ],
  },
  {
    id: 802,
    name: 'Real project',
    setter: 'Setter Three',
    moves: 's~A3~|l~B4~|e~C5~',
    holdsetup: 21,
    Active: true,
    configurations: [{ apiId: 80240, grade: '', configuration: '40°', repeats: 0, isBenchmark: false }],
  },
  {
    id: 803,
    name: 'Future grade',
    setter: 'Setter Four',
    moves: 's~A4~|l~B5~|e~C6~',
    holdsetup: 21,
    Active: true,
    configurations: [{ apiId: 80340, grade: '9A', configuration: '40°', repeats: 1, isBenchmark: false }],
  },
];

function completeCatalogSources(): MoonBoardCatalogSource[] {
  return Object.keys(HOLDSETUP_TO_LAYOUT).map((holdsetup) => ({
    fileName: `holdsetup-${holdsetup}.json`,
    dump: {
      count: 1,
      holdsetup: Number(holdsetup),
      problems: [{ ...CATALOG_PROBLEMS[0], id: Number(holdsetup), holdsetup: Number(holdsetup) }],
    },
  }));
}

void test('complete catalog validation rejects a truncated file even when all seven holdsetups are present', () => {
  const sources = completeCatalogSources();
  assert.doesNotThrow(() => assertCompleteMoonBoardCatalog(sources));
  const truncatedSource = sources.find((source) => source.dump.holdsetup === 19);
  assert.ok(truncatedSource);
  truncatedSource.dump.count = 2;

  assert.throws(
    () => assertCompleteMoonBoardCatalog(sources),
    /holdsetup-19\.json declares count 2 but contains 1 problems/,
  );
});

void test('catalog count validation rejects empty and malformed declarations', () => {
  for (const count of [undefined, '1', 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () =>
        assertMoonBoardCatalogFile(
          { count, holdsetup: 21, problems: count === 0 ? [] : [CATALOG_PROBLEMS[0]] },
          'moonboard-2024.json',
        ),
      /moonboard-2024\.json has invalid count/,
      String(count),
    );
  }

  assert.throws(
    () =>
      assertCompleteMoonBoardCatalog(
        completeCatalogSources().map((source) => ({ ...source, dump: { ...source.dump, count: 0, problems: [] } })),
      ),
    /has invalid count 0/,
  );
});

function safeStoredRow(input: Partial<MoonBoardStoredGradeRow> & Pick<MoonBoardStoredGradeRow, 'climbUuid'>) {
  return {
    climbUuid: input.climbUuid,
    statsAngle: input.statsAngle ?? 40,
    climbAngle: input.climbAngle ?? 40,
    layoutId: input.layoutId ?? 3,
    userId: input.userId ?? null,
    isDraft: input.isDraft ?? false,
    isListed: input.isListed ?? true,
    displayDifficulty: input.displayDifficulty ?? null,
    benchmarkDifficulty: input.benchmarkDifficulty ?? null,
    difficultyAverage: input.difficultyAverage ?? null,
  } satisfies MoonBoardStoredGradeRow;
}

void test('catalog extraction targets only authoritative 8C/8C+ configs, including lowercase', () => {
  const extraction = extractMoonBoard8cCandidates([
    {
      fileName: 'moonboard-2024.json',
      dump: { count: CATALOG_PROBLEMS.length, holdsetup: 21, problems: CATALOG_PROBLEMS },
    },
  ]);

  assert.deepEqual(
    extraction.candidates.map((candidate) => ({
      id: candidate.sourceProblemId,
      grade: candidate.sourceGrade,
      difficulty: candidate.difficultyId,
    })),
    [
      { id: 800, grade: '8C', difficulty: 32 },
      { id: 801, grade: '8C+', difficulty: 33 },
    ],
  );
  assert.deepEqual(extraction.unknownHoldsetups, []);
});

void test('alias resolution reaches the terminal canonical UUID and rejects cycles', () => {
  assert.deepEqual(
    resolveTerminalMoonBoardAlias(
      'catalog-id',
      new Map([
        ['catalog-id', 'legacy-id'],
        ['legacy-id', 'canonical-id'],
        ['canonical-id', 'canonical-id'],
      ]),
    ),
    { canonicalUuid: 'canonical-id', path: ['catalog-id', 'legacy-id', 'canonical-id'] },
  );
  assert.deepEqual(
    resolveTerminalMoonBoardAlias(
      'cycle-a',
      new Map([
        ['cycle-a', 'cycle-b'],
        ['cycle-b', 'cycle-a'],
      ]),
    ),
    { canonicalUuid: null, path: ['cycle-a', 'cycle-b', 'cycle-a'] },
  );
});

void test('repair planning preserves non-null fields and refuses user-owned projects', () => {
  const { candidates } = extractMoonBoard8cCandidates([
    {
      fileName: 'moonboard-2024.json',
      dump: { count: CATALOG_PROBLEMS.length, holdsetup: 21, problems: CATALOG_PROBLEMS },
    },
  ]);
  const canonicalByAlias = new Map([
    [candidates[0].sourceUuid, 'canonical-8c'],
    [candidates[1].sourceUuid, 'canonical-8c-plus'],
  ]);
  const { targets, aliasProblems } = resolveMoonBoardGradeRepairTargets(candidates, canonicalByAlias);
  assert.deepEqual(aliasProblems, []);

  const rows = [
    safeStoredRow({ climbUuid: 'canonical-8c' }),
    safeStoredRow({
      climbUuid: 'canonical-8c-plus',
      displayDifficulty: 31,
      benchmarkDifficulty: 29,
      difficultyAverage: null,
    }),
  ];
  const plan = planMoonBoardGradeRepairs(targets, rows);
  assert.equal(plan.updates.length, 2);
  assert.deepEqual(
    plan.updates.map((update) => ({
      uuid: update.target.canonicalUuid,
      display: update.fillDisplayDifficulty,
      benchmark: update.fillBenchmarkDifficulty,
      average: update.fillDifficultyAverage,
    })),
    [
      { uuid: 'canonical-8c', display: true, benchmark: true, average: true },
      { uuid: 'canonical-8c-plus', display: false, benchmark: false, average: true },
    ],
  );

  const projectPlan = planMoonBoardGradeRepairs(
    [{ ...targets[0], canonicalUuid: 'user-project' }],
    [safeStoredRow({ climbUuid: 'user-project', userId: 'project-owner' })],
  );
  assert.equal(projectPlan.updates.length, 0);
  assert.equal(projectPlan.skipped[0]?.reason, 'stored climb is user-owned');
});

void test('execution is dry-run by default input, guarded on apply, and idempotent', async () => {
  const { candidates } = extractMoonBoard8cCandidates([
    {
      fileName: 'moonboard-2024.json',
      dump: { count: CATALOG_PROBLEMS.length, holdsetup: 21, problems: CATALOG_PROBLEMS },
    },
  ]);
  const { targets } = resolveMoonBoardGradeRepairTargets(
    candidates,
    new Map([
      [candidates[0].sourceUuid, 'canonical-8c'],
      [candidates[1].sourceUuid, 'canonical-8c-plus'],
    ]),
  );
  const rows = [
    safeStoredRow({ climbUuid: 'canonical-8c' }),
    safeStoredRow({ climbUuid: 'canonical-8c-plus', displayDifficulty: 30 }),
  ];
  let writes = 0;
  const store: MoonBoardGradeRepairStore = {
    loadRows: async () => rows.map((row) => ({ ...row })),
    applyUpdate: async (update) => {
      const row = rows.find(
        (candidateRow) =>
          candidateRow.climbUuid === update.target.canonicalUuid && candidateRow.statsAngle === update.target.angle,
      );
      if (row === undefined) return false;
      if (update.fillDisplayDifficulty) {
        if (row.displayDifficulty !== null) return false;
        row.displayDifficulty = update.target.difficultyId;
      }
      if (update.fillBenchmarkDifficulty) {
        if (row.benchmarkDifficulty !== null) return false;
        row.benchmarkDifficulty = update.target.difficultyId;
      }
      if (update.fillDifficultyAverage) {
        if (row.difficultyAverage !== null) return false;
        row.difficultyAverage = update.target.difficultyId;
      }
      writes++;
      return true;
    },
  };

  const dryRun = await executeMoonBoardGradeRepair(targets, store, false);
  assert.equal(dryRun.plan.updates.length, 2);
  assert.equal(dryRun.appliedRows, 0);
  assert.equal(writes, 0);
  assert.equal(rows[0].displayDifficulty, null);

  const apply = await executeMoonBoardGradeRepair(targets, store, true);
  assert.equal(apply.appliedRows, 2);
  assert.equal(apply.verifiedPlan?.updates.length, 0);
  assert.equal(writes, 2);
  assert.deepEqual(
    rows.map((row) => [row.displayDifficulty, row.benchmarkDifficulty, row.difficultyAverage]),
    [
      [32, 32, 32],
      [30, null, 33],
    ],
  );

  const secondApply = await executeMoonBoardGradeRepair(targets, store, true);
  assert.equal(secondApply.appliedRows, 0);
  assert.equal(writes, 2);
});
