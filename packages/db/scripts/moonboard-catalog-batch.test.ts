import test from 'node:test';
import assert from 'node:assert/strict';
import { stageCatalogBatch, type StageCatalogBatchArgs } from './moonboard-catalog-batch.js';
import {
  catalogClimbUuid,
  catalogFingerprintKey,
  catalogProblemToClimbs,
  legacyCatalogClimbUuid,
  statsBatchKey,
  type ExistingCatalogClimb,
  type MoonBoardCatalogConfiguration,
  type MoonBoardCatalogProblem,
} from './moonboard-catalog-helpers.js';

const LAYOUT_ID = 3;

// Two distinct hold sets, so problems either share a fingerprint or don't.
const MOVES_SHARED = 's~K1~|r~E10~|e~I18~';
const MOVES_OTHER = 's~J2~|r~D9~|e~H17~';

function config(overrides: Partial<MoonBoardCatalogConfiguration> = {}): MoonBoardCatalogConfiguration {
  return {
    apiId: 1,
    grade: '7A+',
    userGrade: '7A',
    userRating: 4,
    isBenchmark: false,
    configuration: '40°',
    repeats: 10,
    dateDeleted: null,
    ...overrides,
  };
}

function problem(overrides: Partial<MoonBoardCatalogProblem> & { id: number }): MoonBoardCatalogProblem {
  return {
    name: `Problem ${overrides.id}`,
    setter: 'A Setter',
    setbyId: 'setter-id',
    climbMethod: 'Any marked holds',
    moves: MOVES_SHARED,
    holdsetup: 21,
    dateInserted: '2023-11-23T18:00:15.227',
    dateDeleted: null,
    Active: true,
    configurations: [config()],
    ...overrides,
  };
}

function fingerprintOf(source: MoonBoardCatalogProblem, layoutId = LAYOUT_ID): string {
  const mapped = catalogProblemToClimbs(source, layoutId);
  if (!mapped) throw new Error('fixture problem must map to a climb');
  return mapped.holdFingerprint;
}

function stage(overrides: Partial<StageCatalogBatchArgs> & { problems: MoonBoardCatalogProblem[] }) {
  const warnings: string[] = [];
  const result = stageCatalogBatch({
    layoutId: LAYOUT_ID,
    existingIndex: new Map<string, ExistingCatalogClimb[]>(),
    existingClimbUuids: new Set<string>(),
    canonicalByAlias: new Map<string, string>(),
    upstreamSyncedAt: '2026-01-01T00:00:00.000Z',
    onWarning: (message) => warnings.push(message),
    ...overrides,
  });
  return { ...result, warnings };
}

function canonicalFor(aliases: { aliasUuid: string; canonicalUuid: string }[], aliasUuid: string) {
  return aliases.find((alias) => alias.aliasUuid === aliasUuid)?.canonicalUuid;
}

void test('a brand new problem stages one climb with its stats, holds and aliases', () => {
  const fresh = problem({ id: 700001 });
  const { climbs, stats, holds, aliases, counters } = stage({ problems: [fresh] });

  assert.equal(counters.inserted, 1);
  assert.equal(counters.matched, 0);
  assert.equal(counters.foldedInBatch, 0);
  assert.equal(climbs.length, 1);
  assert.equal(climbs[0].uuid, catalogClimbUuid({ id: 700001 }));
  // Angle-agnostic identity: the angles live on the stats rows, not the climb.
  assert.equal(climbs[0].angle, null);
  assert.equal(stats.length, 1);
  assert.equal(stats[0].angle, 40);
  assert.equal(holds.length, 3);
  assert.equal(canonicalFor(aliases, legacyCatalogClimbUuid({ id: 700001, angle: 40 })), climbs[0].uuid);
});

// ---------------------------------------------------------------------------
// In-batch collapse of two problems that share holds and match nothing yet
// ---------------------------------------------------------------------------

void test('two new same-holds problems stage ONE climb, and both problem ids resolve to it', () => {
  const first = problem({ id: 700010, name: 'First In File' });
  const second = problem({ id: 700011, name: 'Second In File' });

  const { climbs, stats, aliases, counters } = stage({ problems: [first, second] });

  // Without the fold both would insert, and every later run would then see two
  // listed rows on one fingerprint and skip the pair as ambiguous forever.
  assert.equal(climbs.length, 1, 'both problems must collapse onto one climb row');
  assert.equal(counters.inserted, 1);
  assert.equal(counters.foldedInBatch, 1);

  const survivor = climbs[0].uuid;
  assert.equal(survivor, catalogClimbUuid({ id: 700010 }));
  assert.equal(stats.length, 1);
  assert.equal(stats[0].climbUuid, survivor);

  // The loser keeps resolving: id-based alias and legacy per-angle alias both
  // point at the survivor, exactly as they would on the matched path.
  assert.equal(canonicalFor(aliases, catalogClimbUuid({ id: 700011 })), survivor);
  assert.equal(canonicalFor(aliases, legacyCatalogClimbUuid({ id: 700011, angle: 40 })), survivor);
  assert.equal(canonicalFor(aliases, legacyCatalogClimbUuid({ id: 700010, angle: 40 })), survivor);
  assert.equal(canonicalFor(aliases, survivor), survivor, 'self-alias survives');
});

void test('the folded climb keeps the STRONGER problem, whichever order the file lists them in', () => {
  const weak = problem({
    id: 700020,
    name: 'Junk Duplicate',
    configurations: [config({ repeats: 19, isBenchmark: false })],
  });
  const strong = problem({
    id: 700021,
    name: 'Real Problem',
    configurations: [config({ repeats: 38683, isBenchmark: true })],
  });

  const weakFirst = stage({ problems: [weak, strong] });
  assert.equal(weakFirst.climbs.length, 1);
  assert.equal(weakFirst.climbs[0].name, 'Real Problem');
  assert.equal(weakFirst.stats[0].upstreamAscensionistCount, 38683);
  assert.equal(weakFirst.counters.foldedInBatch, 1);

  const strongFirst = stage({ problems: [strong, weak] });
  assert.equal(strongFirst.climbs.length, 1);
  assert.equal(strongFirst.climbs[0].name, 'Real Problem');
  assert.equal(strongFirst.stats[0].upstreamAscensionistCount, 38683);
  assert.equal(strongFirst.counters.foldedInBatch, 1);

  // Whoever wins, both ids resolve to the one surviving climb.
  for (const result of [weakFirst, strongFirst]) {
    const survivor = result.climbs[0].uuid;
    for (const id of [700020, 700021]) {
      assert.equal(canonicalFor(result.aliases, catalogClimbUuid({ id })) ?? survivor, survivor);
    }
  }
});

void test("a folded loser leaves no stats row behind at an angle the winner isn't graded at", () => {
  // The loser is graded at 25° AND 40°; the stronger winner only at 40°. The
  // 25° entry the loser staged has to go, or it would be written under the
  // winner's uuid as a grade nobody set.
  const twoAngleLoser = problem({
    id: 700030,
    name: 'Two Angles, Weak',
    configurations: [config({ configuration: '25°', repeats: 5 }), config({ configuration: '40°', repeats: 5 })],
  });
  const oneAngleWinner = problem({
    id: 700031,
    name: 'One Angle, Strong',
    configurations: [config({ configuration: '40°', repeats: 900 })],
  });

  const { climbs, stats } = stage({ problems: [twoAngleLoser, oneAngleWinner] });

  assert.equal(climbs.length, 1);
  assert.deepEqual(
    stats.map((row) => row.angle),
    [40],
  );
  assert.equal(stats[0].upstreamAscensionistCount, 900);
  // Pins the format agreement: the stale keys resolveIncumbentReplacement
  // reports must be the keys this batch actually stored its stats under.
  assert.equal(statsBatchKey(climbs[0].uuid, 25), `${climbs[0].uuid}:25`);
});

void test('same holds on a DIFFERENT layout are a different climb — no fold across boards', () => {
  const shared = problem({ id: 700040 });
  assert.notEqual(
    catalogFingerprintKey(2, fingerprintOf(shared)),
    catalogFingerprintKey(4, fingerprintOf(shared)),
    'the fold key must keep layouts apart',
  );

  // One file per board, so the cross-layout case is two batches: each stages
  // its own climb and neither folds.
  const layout2 = stage({ problems: [shared], layoutId: 2 });
  const layout4 = stage({ problems: [problem({ id: 700041 })], layoutId: 4 });

  assert.equal(layout2.counters.foldedInBatch, 0);
  assert.equal(layout4.counters.foldedInBatch, 0);
  assert.equal(layout2.climbs[0].layoutId, 2);
  assert.equal(layout4.climbs[0].layoutId, 4);
  assert.notEqual(layout2.climbs[0].uuid, layout4.climbs[0].uuid);
});

void test('different holds never fold, even in the same file', () => {
  const { climbs, counters } = stage({
    problems: [problem({ id: 700050 }), problem({ id: 700051, moves: MOVES_OTHER })],
  });
  assert.equal(climbs.length, 2);
  assert.equal(counters.inserted, 2);
  assert.equal(counters.foldedInBatch, 0);
});

// ---------------------------------------------------------------------------
// Drift guards
// ---------------------------------------------------------------------------

void test('a matched merge is skipped when the problem owns a DIFFERENT live climb row', () => {
  // The problem's holds match climb X, but a `moonboard:{id}:40` row R also
  // exists and does not redirect to X. Merging would emit R as an alias of X
  // and repoint R's ticks at a climb it isn't, while R stays listed.
  const drifted = problem({ id: 700060 });
  const matchedUuid = 'moonboard-existing-canonical-x';
  const ownedRowUuid = legacyCatalogClimbUuid({ id: 700060, angle: 40 });

  const { climbs, aliases, counters, warnings } = stage({
    problems: [drifted],
    existingIndex: new Map([
      [catalogFingerprintKey(LAYOUT_ID, fingerprintOf(drifted)), [{ uuid: matchedUuid, name: 'Problem 700060' }]],
    ]),
    existingClimbUuids: new Set([matchedUuid, ownedRowUuid]),
  });

  assert.equal(counters.skippedHijacked, 1);
  assert.equal(counters.matched, 0);
  assert.equal(climbs.length, 0, 'nothing may be written for a problem we skip');
  assert.equal(aliases.length, 0, 'above all, no alias may repoint the owned row');
  assert.match(warnings[0], /700060/);
  assert.ok(warnings[0].includes(ownedRowUuid));
});

void test('the ordinary legacy merge — the owned row IS the matched climb — is not a hijack', () => {
  // Every MoonBoard 2024 climb looks like this: the problem owns exactly the
  // per-angle row its holds now match. That must merge in place, not skip.
  const legacy = problem({ id: 700070 });
  const legacyRowUuid = legacyCatalogClimbUuid({ id: 700070, angle: 40 });

  const { climbs, counters } = stage({
    problems: [legacy],
    existingIndex: new Map([
      [catalogFingerprintKey(LAYOUT_ID, fingerprintOf(legacy)), [{ uuid: legacyRowUuid, name: 'Problem 700070' }]],
    ]),
    existingClimbUuids: new Set([legacyRowUuid]),
  });

  assert.equal(counters.skippedHijacked, 0);
  assert.equal(counters.matched, 1);
  assert.equal(climbs.length, 1);
  assert.equal(climbs[0].uuid, legacyRowUuid);
});

void test('an owned row that already redirects to the matched climb does not block the merge', () => {
  // The dedup migration delisted the 25° row and aliased it at the survivor:
  // re-writing that alias is a no-op, so the merge is safe.
  const merged = problem({ id: 700080 });
  const matchedUuid = legacyCatalogClimbUuid({ id: 700080, angle: 40 });
  const redirectedUuid = legacyCatalogClimbUuid({ id: 700080, angle: 25 });

  const { climbs, counters } = stage({
    problems: [merged],
    existingIndex: new Map([
      [catalogFingerprintKey(LAYOUT_ID, fingerprintOf(merged)), [{ uuid: matchedUuid, name: 'Problem 700080' }]],
    ]),
    existingClimbUuids: new Set([matchedUuid, redirectedUuid]),
    canonicalByAlias: new Map([[redirectedUuid, matchedUuid]]),
  });

  assert.equal(counters.skippedHijacked, 0);
  assert.equal(counters.matched, 1);
  assert.equal(climbs[0].uuid, matchedUuid);
});

void test('a hold-match miss with rows the problem already owns is still skipped as drifted', () => {
  const drifted = problem({ id: 700090 });

  const { climbs, counters } = stage({
    problems: [drifted],
    existingClimbUuids: new Set([catalogClimbUuid({ id: 700090 })]),
  });

  assert.equal(counters.skippedDrifted, 1);
  assert.equal(counters.inserted, 0);
  assert.equal(climbs.length, 0);
});

void test('the drift guard covers angles the catalog no longer grades', () => {
  // Graded at 40° only today; the 25° configuration lost its grade since the
  // earlier import that minted `moonboard:{id}:25`. Checking only today's
  // graded angles would miss that row and insert a duplicate beside it.
  const regraded = problem({
    id: 700100,
    configurations: [config({ configuration: '25°', grade: '' }), config({ configuration: '40°' })],
  });

  const { climbs, counters, warnings } = stage({
    problems: [regraded],
    existingClimbUuids: new Set([legacyCatalogClimbUuid({ id: 700100, angle: 25 })]),
  });

  assert.equal(counters.skippedDrifted, 1);
  assert.equal(climbs.length, 0);
  assert.ok(warnings[0].includes(legacyCatalogClimbUuid({ id: 700100, angle: 25 })));
});

void test('ambiguous problems are skipped and stage nothing', () => {
  const ambiguous = problem({ id: 700110 });
  const { climbs, aliases, counters } = stage({
    problems: [ambiguous],
    existingIndex: new Map([
      [
        catalogFingerprintKey(LAYOUT_ID, fingerprintOf(ambiguous)),
        [
          { uuid: 'moonboard-dupe-a', name: 'Problem 700110' },
          { uuid: 'moonboard-dupe-b', name: 'Problem 700110' },
        ],
      ],
    ]),
  });

  assert.equal(counters.skippedAmbiguous, 1);
  assert.equal(climbs.length, 0);
  assert.equal(aliases.length, 0);
});

void test('unimportable problems are counted, not staged', () => {
  const { climbs, counters } = stage({
    problems: [problem({ id: 700120, dateDeleted: '2025-01-01T00:00:00' }), problem({ id: 700121, moves: null })],
  });
  assert.equal(counters.skippedProblems, 2);
  assert.equal(climbs.length, 0);
});

// #3531 / #4025: a grade MOONBOARD_GRADE_TO_DIFFICULTY cannot resolve still
// imports, but with a NULL difficulty — indistinguishable from an ungraded
// project once it is in the table. Staging names those grade strings so the run
// log can tell an operator which map entry is missing, instead of the next grade
// MoonBoard invents disappearing silently the way 8C/8C+ did.
void test('unmappable grades are named and counted per graded configuration', () => {
  const { unmappedGrades, climbs } = stage({
    problems: [
      problem({ id: 700130, configurations: [config({ grade: '9A' })] }),
      problem({
        id: 700131,
        moves: MOVES_OTHER,
        configurations: [config({ grade: '9A' }), config({ grade: '9B', configuration: '25°' })],
      }),
    ],
  });

  // Counted per configuration, not per problem: 9A appears at one angle on each
  // of the two problems.
  assert.deepEqual(
    [...unmappedGrades.entries()].sort(([leftGrade], [rightGrade]) => leftGrade.localeCompare(rightGrade)),
    [
      ['9A', 2],
      ['9B', 1],
    ],
  );
  // The point of the warning: they were imported anyway, with a null grade.
  assert.equal(climbs.length, 2);
});

void test('grades the map resolves are never reported as unmapped', () => {
  // 8C/8C+ are the grades #4025 added to the map. If that extension regresses,
  // they land here instead of in a stats row's difficulty.
  const { unmappedGrades, stats } = stage({
    problems: [
      problem({ id: 700140, configurations: [config({ grade: '8C' })] }),
      problem({ id: 700141, moves: MOVES_OTHER, configurations: [config({ grade: '8C+' })] }),
    ],
  });

  assert.equal(unmappedGrades.size, 0);
  assert.deepEqual(
    stats.map((row) => row.displayDifficulty).sort((left, right) => Number(left) - Number(right)),
    [32, 33],
  );
});

// ---------------------------------------------------------------------------
// Withdrawn problems (dateDeleted upstream) → unlist the climb they own
// ---------------------------------------------------------------------------

void test('a withdrawn problem we never imported leaves nothing to unlist', () => {
  const gone = problem({ id: 700200, dateDeleted: '2026-03-01T10:00:00' });
  const { climbs, withdrawnClimbUuids, counters } = stage({ problems: [gone] });

  assert.equal(counters.withdrawn, 1);
  assert.equal(counters.withdrawnWithClimbs, 0);
  assert.equal(counters.skippedProblems, 1);
  assert.deepEqual(withdrawnClimbUuids, []);
  assert.equal(climbs.length, 0);
});

void test('a withdrawn problem that owns a climb reports it for unlisting', () => {
  const gone = problem({ id: 700210, dateDeleted: '2026-03-01T10:00:00' });
  const ownedUuid = catalogClimbUuid({ id: 700210 });

  const { withdrawnClimbUuids, withdrawnSamples, counters } = stage({
    problems: [gone],
    existingClimbUuids: new Set([ownedUuid]),
  });

  assert.equal(counters.withdrawn, 1);
  assert.equal(counters.withdrawnWithClimbs, 1);
  assert.deepEqual(withdrawnClimbUuids, [ownedUuid]);
  assert.deepEqual(withdrawnSamples, [{ problemId: 700210, name: 'Problem 700210', climbUuids: [ownedUuid] }]);
});

void test('a withdrawn problem merged onto another uuid unlists the merge target, not its own id-based uuid', () => {
  // The non-destructive merge routinely parks a problem on a pre-existing uuid
  // and records that with an alias. Unlisting the id-based uuid would miss the
  // row that actually holds the climb.
  const gone = problem({ id: 700220, dateDeleted: '2026-03-01T10:00:00' });
  const ownIdUuid = catalogClimbUuid({ id: 700220 });
  const mergeTarget = 'merge-target-uuid';

  const { withdrawnClimbUuids } = stage({
    problems: [gone],
    existingClimbUuids: new Set([ownIdUuid, mergeTarget]),
    canonicalByAlias: new Map([[ownIdUuid, mergeTarget]]),
  });

  assert.deepEqual(withdrawnClimbUuids, [mergeTarget]);
});

void test('a withdrawn problem is found through its LEGACY per-angle uuid too', () => {
  // Pre-rewrite imports minted one row per graded angle. A problem withdrawn
  // today may only own `moonboard:{id}:{angle}` rows, and its configurations
  // are usually soft-deleted with it — so today's graded angles cannot be the
  // lookup key. ownedClimbAngles covers every angle we have ever imported at.
  const gone = problem({
    id: 700230,
    dateDeleted: '2026-03-01T10:00:00',
    configurations: [config({ dateDeleted: '2026-03-01T10:00:00' })],
  });
  const legacyUuid = legacyCatalogClimbUuid({ id: 700230, angle: 25 });

  const { withdrawnClimbUuids, counters } = stage({
    problems: [gone],
    existingClimbUuids: new Set([legacyUuid]),
  });

  assert.equal(counters.withdrawnWithClimbs, 1);
  assert.deepEqual(withdrawnClimbUuids, [legacyUuid]);
});

void test('a climb a LIVE problem also writes is never unlisted', () => {
  // The correctness crux. Two problems can share holds and collapse onto one
  // climb. If the withdrawn one resolved to that same uuid and we unlisted it,
  // we would hide a climb upstream still publishes.
  const withdrawnUuid = catalogClimbUuid({ id: 700240 });
  const gone = problem({ id: 700240, dateDeleted: '2026-03-01T10:00:00' });
  const live = problem({ id: 700241, name: 'Still Published' });

  const existing: ExistingCatalogClimb[] = [{ uuid: withdrawnUuid, name: 'Shared Holds' }];
  const { climbs, withdrawnClimbUuids, counters } = stage({
    problems: [gone, live],
    existingClimbUuids: new Set([withdrawnUuid]),
    // The live problem's holds match the very climb the withdrawn one owns.
    existingIndex: new Map([[catalogFingerprintKey(LAYOUT_ID, fingerprintOf(live)), existing]]),
  });

  assert.equal(counters.withdrawn, 1);
  assert.equal(counters.withdrawnWithClimbs, 1);
  assert.equal(counters.matched, 1);
  assert.equal(climbs.length, 1);
  assert.equal(climbs[0].uuid, withdrawnUuid);
  // Staged as withdrawn, then subtracted because the batch wrote it.
  assert.deepEqual(withdrawnClimbUuids, []);
});

void test('an Active=false problem is treated as withdrawn', () => {
  const gone = problem({ id: 700250, Active: false });
  const { counters, withdrawnClimbUuids } = stage({
    problems: [gone],
    existingClimbUuids: new Set([catalogClimbUuid({ id: 700250 })]),
  });

  assert.equal(counters.withdrawn, 1);
  assert.deepEqual(withdrawnClimbUuids, [catalogClimbUuid({ id: 700250 })]);
});

void test('a holdless or ungraded problem is skipped WITHOUT being treated as withdrawn', () => {
  // Only "upstream deleted this" licenses unlisting. "We cannot map this" says
  // nothing about rows we already have, so it must never reach the unlist pass.
  const ownedHoldless = catalogClimbUuid({ id: 700260 });
  const ownedUngraded = catalogClimbUuid({ id: 700261 });

  const { counters, withdrawnClimbUuids } = stage({
    problems: [
      problem({ id: 700260, moves: '' }),
      problem({ id: 700261, moves: MOVES_OTHER, configurations: [config({ grade: '' })] }),
    ],
    existingClimbUuids: new Set([ownedHoldless, ownedUngraded]),
  });

  assert.equal(counters.skippedProblems, 2);
  assert.equal(counters.withdrawn, 0);
  assert.deepEqual(withdrawnClimbUuids, []);
});

void test('a withdrawn problem whose alias chain is cyclic is left alone', () => {
  // Same stance as the hijack guard: never act on a redirect we cannot follow.
  const gone = problem({ id: 700270, dateDeleted: '2026-03-01T10:00:00' });
  const ownIdUuid = catalogClimbUuid({ id: 700270 });
  const other = 'other-uuid';

  const { withdrawnClimbUuids, counters } = stage({
    problems: [gone],
    existingClimbUuids: new Set([ownIdUuid, other]),
    canonicalByAlias: new Map([
      [ownIdUuid, other],
      [other, ownIdUuid],
    ]),
  });

  assert.equal(counters.withdrawnWithClimbs, 0);
  assert.deepEqual(withdrawnClimbUuids, []);
});

void test('withdrawn samples are capped so a big capture cannot drown the log', () => {
  const problems = Array.from({ length: 15 }, (_unused, index) =>
    problem({ id: 700300 + index, dateDeleted: '2026-03-01T10:00:00' }),
  );
  const { withdrawnSamples, counters } = stage({
    problems,
    existingClimbUuids: new Set(problems.map((each) => catalogClimbUuid({ id: each.id }))),
  });

  assert.equal(counters.withdrawn, 15);
  assert.equal(counters.withdrawnWithClimbs, 15);
  assert.equal(withdrawnSamples.length, 10);
});
