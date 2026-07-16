import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMoonBoardHardware,
  countMissingMoonBoardHardware,
  findMoonBoardHardwareDefinitionProblems,
  findMoonBoardHardwareProblems,
  findUnmappedMoonBoardHardwareUses,
  moonBoardPlacementId,
  type MoonBoardHardwareState,
} from './moonboard-hardware.js';

const expected = buildMoonBoardHardware();

function asState(): MoonBoardHardwareState {
  return structuredClone(expected);
}

void test('builds the complete deterministic MoonBoard hardware catalog', () => {
  assert.deepEqual(findMoonBoardHardwareDefinitionProblems(expected), []);
  assert.equal(expected.products.length, 1);
  assert.equal(expected.layouts.length, 7);
  assert.equal(expected.sets.length, 31);
  assert.equal(expected.holes.length, 198);
  assert.equal(expected.placements.length, 1022);
  assert.equal(new Set(expected.placements.map((placement) => placement.id)).size, 1022);
  assert.equal(new Set(expected.placements.map((placement) => `${placement.layoutId}:${placement.holeId}`)).size, 1022);
  assert.deepEqual(
    Object.fromEntries(
      expected.layouts.map((layout) => [
        layout.id,
        expected.placements.filter((placement) => placement.layoutId === layout.id).length,
      ]),
    ),
    { 1: 40, 2: 140, 3: 198, 4: 198, 5: 198, 6: 120, 7: 128 },
  );
});

void test('maps cell ids to human coordinates and one-based grid positions', () => {
  assert.deepEqual(expected.holes[0], {
    boardType: 'moonboard',
    id: 1,
    productId: 1,
    name: 'A1',
    x: 1,
    y: 1,
    mirroredHoleId: null,
    mirrorGroup: 0,
  });
  assert.deepEqual(expected.holes[197], {
    boardType: 'moonboard',
    id: 198,
    productId: 1,
    name: 'K18',
    x: 11,
    y: 18,
    mirroredHoleId: null,
    mirrorGroup: 0,
  });
});

void test('builds layout-specific placements from the authoritative cell-set map', () => {
  const placement = expected.placements.find((candidate) => candidate.id === moonBoardPlacementId(2, 26));
  assert.deepEqual(placement, {
    boardType: 'moonboard',
    id: 2026,
    layoutId: 2,
    holeId: 26,
    setId: 4,
    defaultPlacementRoleId: null,
  });
});

void test('definition validation catches generated-map count drift', () => {
  const drifted = structuredClone(expected);
  drifted.placements.pop();
  const problems = findMoonBoardHardwareDefinitionProblems(drifted);
  assert.ok(problems.some((problem) => problem.includes('expected 1022 rows')));
  assert.ok(problems.some((problem) => problem.includes('layout 7 expected 128 rows')));
});

void test('accepts exact partial state and reports only missing rows', () => {
  const partial: MoonBoardHardwareState = {
    products: expected.products,
    layouts: expected.layouts.slice(0, 2),
    sets: [],
    holes: expected.holes.slice(0, 10),
    placements: [],
  };
  assert.deepEqual(findMoonBoardHardwareProblems(expected, partial, false), []);
  assert.deepEqual(countMissingMoonBoardHardware(expected, partial), {
    products: 0,
    layouts: 5,
    sets: 31,
    holes: 188,
    placements: 1022,
  });
});

void test('rejects mismatched and unexpected existing rows before writes', () => {
  const actual = asState();
  actual.holes = [{ ...actual.holes[0], name: 'wrong' }, ...actual.holes.slice(1), { id: 999 }];
  const problems = findMoonBoardHardwareProblems(expected, actual, false);
  assert.ok(problems.some((problem) => problem.includes('holes: row 1 field name')));
  assert.ok(problems.some((problem) => problem.includes('holes: unexpected row id 999')));
});

void test('complete validation rejects missing rows', () => {
  const actual = asState();
  actual.placements = actual.placements.slice(1);
  assert.ok(findMoonBoardHardwareProblems(expected, actual, true).includes('placements: missing row id 1026'));
});

void test('reports used layout cells absent from the authoritative map without adding placements', () => {
  const unmapped = findUnmappedMoonBoardHardwareUses(expected, [
    { layoutId: 2, holeId: 26, importedRowCount: 100, userRowCount: 0 },
    { layoutId: 2, holeId: 56, importedRowCount: 1, userRowCount: 0 },
    { layoutId: 2, holeId: 181, importedRowCount: 0, userRowCount: 1 },
  ]);
  assert.deepEqual(unmapped, [
    { layoutId: 2, holeId: 56, importedRowCount: 1, userRowCount: 0 },
    { layoutId: 2, holeId: 181, importedRowCount: 0, userRowCount: 1 },
  ]);
  assert.equal(
    expected.placements.some((placement) => placement.layoutId === 2 && placement.holeId === 56),
    false,
  );
  assert.equal(
    expected.placements.some((placement) => placement.layoutId === 2 && placement.holeId === 181),
    false,
  );
});
