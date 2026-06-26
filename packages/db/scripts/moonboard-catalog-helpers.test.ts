import test from 'node:test';
import assert from 'node:assert/strict';
import { uuidv5, MOONBOARD_UUID_NAMESPACE } from './moonboard-helpers.js';
import { fingerprintFromHolds } from './moonboard-2024-helpers.js';
import {
  HOLDSETUP_TO_LAYOUT,
  angleFromConfiguration,
  roleLetterToHoldState,
  parseMovesString,
  holdsToFrames,
  catalogClimbUuid,
  isImportableProblem,
  isImportableConfig,
  mapCatalogConfig,
  catalogProblemToClimbs,
  type MoonBoardCatalogProblem,
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

void test('catalogClimbUuid is deterministic, id+angle keyed, distinct per angle', () => {
  const uuid = catalogClimbUuid({ id: 541453, angle: 40 });
  assert.equal(uuid, uuidv5('moonboard:541453:40', MOONBOARD_UUID_NAMESPACE));
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(uuid, catalogClimbUuid({ id: 541453, angle: 25 }));
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

void test('mapCatalogConfig fills stats from the configuration', () => {
  const mapped = mapCatalogConfig(PORRIDGE, PORRIDGE.configurations![1], { layoutId: 3, angle: 40 });
  assert.equal(mapped.uuid, catalogClimbUuid({ id: 541453, angle: 40 }));
  assert.equal(mapped.difficultyId, 23); // 7A+
  assert.equal(mapped.isBenchmark, true);
  assert.equal(mapped.ascensionistCount, 812);
  assert.equal(mapped.qualityAverage, 4);
  assert.equal(mapped.setterUsername, 'Joe Wallace');
  assert.equal(mapped.createdAt, '2023-11-23T18:00:15.227');
  assert.equal(mapped.characteristics, null); // "Any marked holds" → no token
});

void test('userRating 0 becomes null quality (0 is off the 1-5 scale)', () => {
  const mapped = mapCatalogConfig(
    PORRIDGE,
    { ...PORRIDGE.configurations![1], userRating: 0 },
    { layoutId: 3, angle: 40 },
  );
  assert.equal(mapped.qualityAverage, null);
});

void test('catalogProblemToClimbs yields one climb per graded angle, skipping phantoms', () => {
  const climbs = catalogProblemToClimbs(PORRIDGE, 3);
  // Only the graded 40° config is imported; the empty-grade 25° phantom is dropped.
  assert.equal(climbs.length, 1);
  assert.equal(climbs[0].angle, 40);
  assert.equal(climbs[0].difficultyId, 23);

  // Both angles graded → two rows.
  const bothGraded = catalogProblemToClimbs(
    { ...PORRIDGE, configurations: [{ ...PORRIDGE.configurations![0], grade: '6C' }, PORRIDGE.configurations![1]] },
    3,
  );
  assert.deepEqual(
    bothGraded.map((climb) => climb.angle).sort((a, b) => a - b),
    [25, 40],
  );

  // A deleted / holdless problem yields nothing.
  assert.deepEqual(catalogProblemToClimbs({ ...PORRIDGE, dateDeleted: '2025-01-01' }, 3), []);
});

void test('unmappable grades map to undefined difficulty', () => {
  const mapped = mapCatalogConfig(
    PORRIDGE,
    { ...PORRIDGE.configurations![1], grade: '9Z' },
    { layoutId: 3, angle: 40 },
  );
  assert.equal(mapped.difficultyId, undefined);
});
