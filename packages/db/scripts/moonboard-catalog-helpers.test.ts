import test from 'node:test';
import assert from 'node:assert/strict';
import { uuidv5, MOONBOARD_UUID_NAMESPACE } from './moonboard-helpers.js';
import { fingerprintFromHolds } from './moonboard-2024-helpers.js';
import { sqlText } from '../src/test-utils/sql-text.js';
import {
  HOLDSETUP_TO_LAYOUT,
  angleFromConfiguration,
  buildExistingCatalogMatchIndex,
  catalogAliasConflictUpdate,
  roleLetterToHoldState,
  parseMovesString,
  resolveCatalogClimbUuid,
  holdsToFrames,
  catalogClimbUuid,
  legacyCatalogClimbUuid,
  catalogAliasRows,
  isImportableProblem,
  isImportableConfig,
  mapCatalogProblemStructural,
  mapCatalogConfigStats,
  catalogProblemToClimbs,
  isBetterCatalogClimb,
  type MoonBoardCatalogProblem,
  type MappedCatalogClimb,
} from './moonboard-catalog-helpers.js';

// "Porridge & Salt" (Joe Wallace) — id 541453, MoonBoard 2024 (holdsetup 21).
// Its 40° configuration matches the row already in prod, which lets us pin the
// fingerprint and prove the merge updates that row in place.
const PORRIDGE: MoonBoardCatalogProblem = {
  id: 541453,
  name: 'Porridge & Salt',
  setter: 'Joe Wallace',
  setbyId: 'abc',
  climbMethod: 'Any marked holds',
  moves: 'r~E10~|r~E13~|e~I18~|r~J8~|r~J12~|s~K1~|s~K6~',
  holdsetup: 21,
  dateInserted: '2023-11-23T18:00:15.227',
  dateDeleted: null,
  Active: true,
  configurations: [
    {
      apiId: 2,
      grade: '', // never graded at 25° — a phantom config we skip
      userGrade: '',
      userRating: 0,
      isBenchmark: false,
      configuration: '25°',
      repeats: 0,
      dateDeleted: null,
    },
    {
      apiId: 3,
      grade: '7A+',
      userGrade: '7A',
      userRating: 4,
      isBenchmark: true,
      configuration: '40°',
      repeats: 812,
      dateDeleted: null,
    },
  ],
};

function makeMappedClimb(overrides: Partial<MappedCatalogClimb> = {}): MappedCatalogClimb {
  const climb = catalogProblemToClimbs(PORRIDGE, 3);
  if (!climb) throw new Error('PORRIDGE must map to a climb');
  return { ...climb, ...overrides };
}

void test('HOLDSETUP_TO_LAYOUT covers all 7 boards', () => {
  assert.deepEqual(HOLDSETUP_TO_LAYOUT, { 1: 2, 15: 4, 17: 5, 19: 6, 21: 3, 22: 7, 23: 1 });
});

void test('angleFromConfiguration parses the degree string', () => {
  assert.equal(angleFromConfiguration('40°'), 40);
  assert.equal(angleFromConfiguration('25°'), 25);
  assert.equal(angleFromConfiguration(''), undefined);
  assert.equal(angleFromConfiguration(null), undefined);
});

void test('roleLetterToHoldState maps start/end and folds the rest to HAND', () => {
  assert.equal(roleLetterToHoldState('s'), 'STARTING');
  assert.equal(roleLetterToHoldState('e'), 'FINISH');
  for (const hand of ['l', 'r', 'm', 'p', 'f']) {
    assert.equal(roleLetterToHoldState(hand), 'HAND');
  }
});

void test('parseMovesString recomputes hold ids and states from the cell', () => {
  const holds = parseMovesString(PORRIDGE.moves ?? '');
  assert.deepEqual(holds, [
    { holdId: 104, holdState: 'HAND' }, // E10
    { holdId: 137, holdState: 'HAND' }, // E13
    { holdId: 196, holdState: 'FINISH' }, // I18
    { holdId: 87, holdState: 'HAND' }, // J8
    { holdId: 131, holdState: 'HAND' }, // J12
    { holdId: 11, holdState: 'STARTING' }, // K1
    { holdId: 66, holdState: 'STARTING' }, // K6
  ]);
});

// The whole non-destructive merge hinges on this: parsing the new `moves` string
// must reproduce the exact fingerprint already stored for this climb in prod, so
// the importer matches and updates the existing row instead of duplicating it.
void test('fingerprint reproduces the value stored in prod (merge will match)', () => {
  const holds = parseMovesString(PORRIDGE.moves ?? '');
  assert.equal(fingerprintFromHolds(holds), 'e3d1a03797dc0aafc89034dc42e500a4c030700c5b1323f2b5afba5f97f50b10');
});

void test('holdsToFrames encodes p{holdId}r{roleCode} in move order', () => {
  const holds = parseMovesString(PORRIDGE.moves ?? '');
  assert.equal(holdsToFrames(holds), 'p104r43p137r43p196r44p87r43p131r43p11r42p66r42');
});

void test('catalogClimbUuid is deterministic and angle-agnostic — id-keyed only', () => {
  const uuid = catalogClimbUuid({ id: 541453 });
  assert.equal(uuid, uuidv5('moonboard:541453', MOONBOARD_UUID_NAMESPACE));
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // Same id → same uuid regardless of which angle is being considered.
  assert.equal(uuid, catalogClimbUuid({ id: 541453 }));
});

void test('legacyCatalogClimbUuid reproduces the old per-angle scheme, distinct per angle', () => {
  const uuid40 = legacyCatalogClimbUuid({ id: 541453, angle: 40 });
  assert.equal(uuid40, uuidv5('moonboard:541453:40', MOONBOARD_UUID_NAMESPACE));
  assert.notEqual(uuid40, legacyCatalogClimbUuid({ id: 541453, angle: 25 }));
  assert.notEqual(uuid40, catalogClimbUuid({ id: 541453 }));
});

void test('catalogAliasRows: brand new climb (no merge) — self-alias plus one legacy alias per graded angle', () => {
  const canonicalUuid = catalogClimbUuid({ id: 509834 });
  const rows = catalogAliasRows({ problemId: 509834, angles: [25, 40], canonicalUuid });
  assert.deepEqual(rows, [
    { aliasUuid: canonicalUuid, canonicalUuid },
    // No separate id-based row: canonicalUuid IS the id-based uuid already.
    { aliasUuid: legacyCatalogClimbUuid({ id: 509834, angle: 25 }), canonicalUuid },
    { aliasUuid: legacyCatalogClimbUuid({ id: 509834, angle: 40 }), canonicalUuid },
  ]);
});

void test('catalogAliasRows: merged onto a legacy (name-based) UUID — as every MoonBoard 2024 climb was', () => {
  const legacy = 'moonboard-legacy-name-based-uuid';
  const rows = catalogAliasRows({ problemId: 509834, angles: [40], canonicalUuid: legacy });
  assert.deepEqual(rows, [
    { aliasUuid: legacy, canonicalUuid: legacy },
    { aliasUuid: catalogClimbUuid({ id: 509834 }), canonicalUuid: legacy },
    { aliasUuid: legacyCatalogClimbUuid({ id: 509834, angle: 40 }), canonicalUuid: legacy },
  ]);
});

void test('catalog matching excludes delisted rows even when they have stale self-aliases', () => {
  const mapped = makeMappedClimb();
  const delistedUuid = 'moonboard-delisted-duplicate';
  const canonicalUuid = 'moonboard-listed-canonical';
  const index = buildExistingCatalogMatchIndex(
    [
      { uuid: delistedUuid, layoutId: mapped.layoutId, name: mapped.name, isListed: false },
      { uuid: canonicalUuid, layoutId: mapped.layoutId, name: mapped.name, isListed: true },
    ],
    new Map([
      [delistedUuid, mapped.holdFingerprint],
      [canonicalUuid, mapped.holdFingerprint],
    ]),
    new Map([
      [delistedUuid, delistedUuid],
      [canonicalUuid, canonicalUuid],
    ]),
  );

  assert.deepEqual(resolveCatalogClimbUuid(mapped, index), { uuid: canonicalUuid, matched: true });
});

void test('catalog matching follows alias chains and collapses candidates at the same canonical UUID', () => {
  const mapped = makeMappedClimb();
  const firstUuid = 'moonboard-first-listed-alias';
  const secondUuid = 'moonboard-intermediate-alias';
  const canonicalUuid = 'moonboard-terminal-canonical';
  const index = buildExistingCatalogMatchIndex(
    [
      { uuid: firstUuid, layoutId: 3, name: 'old name', isListed: true },
      { uuid: canonicalUuid, layoutId: 3, name: 'canonical name', isListed: true },
    ],
    new Map([
      [firstUuid, mapped.holdFingerprint],
      [canonicalUuid, mapped.holdFingerprint],
    ]),
    new Map([
      [firstUuid, secondUuid],
      [secondUuid, canonicalUuid],
      [canonicalUuid, canonicalUuid],
    ]),
  );

  assert.deepEqual(resolveCatalogClimbUuid(mapped, index), { uuid: canonicalUuid, matched: true });
});

void test('catalog matching ignores cyclic aliases instead of writing another broken redirect', () => {
  const mapped = makeMappedClimb();
  const firstUuid = 'moonboard-cycle-a';
  const secondUuid = 'moonboard-cycle-b';
  const index = buildExistingCatalogMatchIndex(
    [{ uuid: firstUuid, layoutId: 3, name: mapped.name, isListed: true }],
    new Map([[firstUuid, mapped.holdFingerprint]]),
    new Map([
      [firstUuid, secondUuid],
      [secondUuid, firstUuid],
    ]),
  );

  assert.deepEqual(resolveCatalogClimbUuid(mapped, index), { uuid: mapped.uuid, matched: false });
});

void test('catalog matching ignores a listed alias chain whose terminal climb is delisted', () => {
  const mapped = makeMappedClimb();
  const listedUuid = 'moonboard-listed-alias';
  const delistedUuid = 'moonboard-delisted-terminal';
  const index = buildExistingCatalogMatchIndex(
    [
      { uuid: listedUuid, layoutId: 3, name: mapped.name, isListed: true },
      { uuid: delistedUuid, layoutId: 3, name: mapped.name, isListed: false },
    ],
    new Map([[listedUuid, mapped.holdFingerprint]]),
    new Map([
      [listedUuid, delistedUuid],
      [delistedUuid, delistedUuid],
    ]),
  );

  assert.deepEqual(resolveCatalogClimbUuid(mapped, index), { uuid: mapped.uuid, matched: false });
});

void test('catalog alias conflicts repair the canonical target and refresh last seen', () => {
  const update = catalogAliasConflictUpdate();
  assert.equal(sqlText(update.canonicalUuid), 'excluded.canonical_uuid');
  assert.equal(sqlText(update.lastSeenAt), 'now()');
});

void test('isImportableProblem rejects deleted / inactive / holdless / config-less problems', () => {
  assert.equal(isImportableProblem(PORRIDGE), true);
  assert.equal(isImportableProblem({ ...PORRIDGE, dateDeleted: '2025-01-01T00:00:00' }), false);
  assert.equal(isImportableProblem({ ...PORRIDGE, Active: false }), false);
  assert.equal(isImportableProblem({ ...PORRIDGE, moves: null }), false);
  assert.equal(isImportableProblem({ ...PORRIDGE, moves: '' }), false);
  assert.equal(isImportableProblem({ ...PORRIDGE, configurations: null }), false);
  assert.equal(isImportableProblem({ ...PORRIDGE, configurations: [] }), false);
});

void test('isImportableConfig skips empty-grade and deleted configs', () => {
  assert.equal(isImportableConfig(PORRIDGE.configurations![0]), false); // 25° empty grade
  assert.equal(isImportableConfig(PORRIDGE.configurations![1]), true); // 40° 7A+
  assert.equal(isImportableConfig({ ...PORRIDGE.configurations![1], dateDeleted: '2025-01-01' }), false);
});

void test('mapCatalogProblemStructural is angle-agnostic — holds/name/setter computed once', () => {
  const structural = mapCatalogProblemStructural(PORRIDGE, 3);
  assert.equal(structural.uuid, catalogClimbUuid({ id: 541453 }));
  assert.equal(structural.setterUsername, 'Joe Wallace');
  assert.equal(structural.createdAt, '2023-11-23T18:00:15.227');
  assert.equal(structural.characteristics, null); // "Any marked holds" → no token
  assert.equal(structural.layoutId, 3);
});

void test('mapCatalogConfigStats fills per-angle stats from the configuration', () => {
  const stats = mapCatalogConfigStats(PORRIDGE.configurations![1], 40);
  assert.equal(stats.angle, 40);
  assert.equal(stats.difficultyId, 23); // 7A+
  assert.equal(stats.isBenchmark, true);
  assert.equal(stats.ascensionistCount, 812);
  assert.equal(stats.qualityAverage, 4);
});

void test('userRating 0 becomes null quality (0 is off the 1-5 scale)', () => {
  const stats = mapCatalogConfigStats({ ...PORRIDGE.configurations![1], userRating: 0 }, 40);
  assert.equal(stats.qualityAverage, null);
});

void test('catalogProblemToClimbs yields one climb with one stats entry per graded angle, skipping phantoms', () => {
  const climb = catalogProblemToClimbs(PORRIDGE, 3);
  // Only the graded 40° config is imported; the empty-grade 25° phantom is dropped.
  assert.ok(climb);
  assert.equal(climb.stats.length, 1);
  assert.equal(climb.stats[0].angle, 40);
  assert.equal(climb.stats[0].difficultyId, 23);

  // Both angles graded → one climb, two stats rows.
  const bothGraded = catalogProblemToClimbs(
    { ...PORRIDGE, configurations: [{ ...PORRIDGE.configurations![0], grade: '6C' }, PORRIDGE.configurations![1]] },
    3,
  );
  assert.ok(bothGraded);
  assert.deepEqual(
    bothGraded.stats.map((stat) => stat.angle).sort((a, b) => a - b),
    [25, 40],
  );
  // Structural identity is a single UUID shared by both angles.
  assert.equal(bothGraded.uuid, catalogClimbUuid({ id: PORRIDGE.id }));

  // A deleted / holdless problem yields nothing.
  assert.equal(catalogProblemToClimbs({ ...PORRIDGE, dateDeleted: '2025-01-01' }, 3), null);

  // A problem with configurations but none graded also yields nothing.
  assert.equal(catalogProblemToClimbs({ ...PORRIDGE, configurations: [PORRIDGE.configurations![0]] }, 3), null);
});

void test('unmappable grades map to undefined difficulty', () => {
  const stats = mapCatalogConfigStats({ ...PORRIDGE.configurations![1], grade: '9Z' }, 40);
  assert.equal(stats.difficultyId, undefined);
});

void test('isBetterCatalogClimb keeps the stronger of two same-holds problems (summed across angles)', () => {
  const cfg = PORRIDGE.configurations![1];
  // Mirrors the real "birthday cake trail mix" (38,683 repeats, benchmark) vs the
  // junk duplicate "name" (19 repeats, not a benchmark) — identical holds.
  const real = makeMappedClimb({
    name: 'birthday cake trail mix',
    stats: [mapCatalogConfigStats({ ...cfg, repeats: 38683, isBenchmark: true }, 40)],
  });
  const junk = makeMappedClimb({
    name: 'name',
    stats: [mapCatalogConfigStats({ ...cfg, repeats: 19, isBenchmark: false }, 40)],
  });

  // More total repeats wins, regardless of processing order.
  assert.equal(isBetterCatalogClimb(real, junk), true);
  assert.equal(isBetterCatalogClimb(junk, real), false);

  // Sums across BOTH graded angles, not just one.
  const twoAngles = makeMappedClimb({
    stats: [
      mapCatalogConfigStats({ ...cfg, repeats: 50, isBenchmark: false }, 25),
      mapCatalogConfigStats({ ...cfg, repeats: 50, isBenchmark: false }, 40),
    ],
  }); // total 100
  const oneAngle = makeMappedClimb({
    stats: [mapCatalogConfigStats({ ...cfg, repeats: 90, isBenchmark: false }, 40)],
  }); // total 90
  assert.equal(isBetterCatalogClimb(twoAngles, oneAngle), true);

  // Tie on total repeats → any benchmark angle wins.
  const benchTie = makeMappedClimb({ stats: [mapCatalogConfigStats({ ...cfg, repeats: 100, isBenchmark: true }, 40)] });
  const plainTie = makeMappedClimb({
    stats: [mapCatalogConfigStats({ ...cfg, repeats: 100, isBenchmark: false }, 40)],
  });
  assert.equal(isBetterCatalogClimb(benchTie, plainTie), true);
  assert.equal(isBetterCatalogClimb(plainTie, benchTie), false);

  // Fully equal → keep incumbent (stable, deterministic re-runs).
  assert.equal(isBetterCatalogClimb(plainTie, plainTie), false);
});
