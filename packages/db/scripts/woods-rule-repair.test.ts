import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWoodsRuleCatalog,
  planWoodsRuleRepair,
  parseWoodsRuleRepairArgs,
  type WoodsStoredRules,
} from './woods-rule-repair.js';
import { mapWoodsProblemToClimb, parseWoodsCatalogFile, type WoodsCatalogProblem } from './woods-catalog-helpers.js';

const problem: WoodsCatalogProblem = {
  id: 1,
  problemName: 'Rule fixture',
  author: 'Setter',
  problemGrade: 4,
  angle: 40,
  boardDimension: '12x12',
  matching: true,
  anyFeet: false,
  holdList: [
    { type: 'Start', baseHoldLocation: 10 },
    { type: 'Finish', baseHoldLocation: 20 },
  ],
};

void test('repair defaults to dry-run and accepts vp forwarded arguments', () => {
  assert.deepEqual(parseWoodsRuleRepairArgs(['--', '/catalog']), { directory: '/catalog', apply: false });
  assert.deepEqual(parseWoodsRuleRepairArgs(['--', '/catalog', '--apply']), { directory: '/catalog', apply: true });
  assert.deepEqual(parseWoodsRuleRepairArgs([], '/env-catalog'), { directory: '/env-catalog', apply: false });
  assert.throws(() => parseWoodsRuleRepairArgs(['/catalog', '--aply']), /Usage/);
  assert.throws(() => parseWoodsRuleRepairArgs([]), /Usage/);
});

function fixture(matching = true, anyFeet = false) {
  const source = { ...problem, matching, anyFeet };
  const catalog = buildWoodsRuleCatalog([{ boardDimension: '12x12', count: 1, problems: [source] }]);
  const mapped = mapWoodsProblemToClimb(source)!;
  const stored: WoodsStoredRules = {
    uuid: mapped.uuid,
    boardType: 'woods',
    userId: null,
    frames: mapped.frames,
    compatibleSizeIds: [2],
    characteristics: null,
  };
  return { catalog, stored };
}

void test('imports every rule combination without changing a climb identity', () => {
  const expectations = [
    { matching: true, anyFeet: false, expected: [] },
    { matching: false, anyFeet: false, expected: ['no_match'] },
    { matching: true, anyFeet: true, expected: ['any_feet'] },
    { matching: false, anyFeet: true, expected: ['no_match', 'any_feet'] },
  ];
  const uuid = mapWoodsProblemToClimb(problem)!.uuid;
  for (const { matching, anyFeet, expected } of expectations) {
    const mapped = mapWoodsProblemToClimb({ ...problem, matching, anyFeet })!;
    assert.equal(mapped.uuid, uuid);
    assert.deepEqual(mapped.characteristics, expected);
  }
});

void test('rejects missing/nonboolean flags before producing a repair plan', () => {
  for (const matching of [undefined, null, 0, 'false']) {
    assert.throws(
      () =>
        parseWoodsCatalogFile(
          JSON.stringify({
            boardDimension: '12x12',
            problems: [{ ...problem, matching }],
          }),
          'bad.json',
        ),
      /bad.json.*boolean matching and anyFeet/,
    );
  }
  assert.throws(
    () =>
      parseWoodsCatalogFile(
        JSON.stringify({
          boardDimension: '12x12',
          problems: [{ ...problem, anyFeet: undefined }],
        }),
        'bad.json',
      ),
    /boolean matching and anyFeet/,
  );
});

void test('repairs null defaults to known empty rules and is idempotent', () => {
  const { catalog, stored } = fixture();
  const plan = planWoodsRuleRepair(catalog, [stored]);
  assert.equal(plan.matched, 1);
  assert.deepEqual(plan.updates[0].characteristics, []);
  assert.equal(stored.characteristics, null);
  const repeated = planWoodsRuleRepair(catalog, [{ ...stored, characteristics: plan.updates[0].characteristics }]);
  assert.equal(repeated.updates.length, 0);
  assert.equal(repeated.unchanged, 1);
});

void test('refreshes catalog flags while preserving app-owned rules', () => {
  const { catalog, stored } = fixture(true, false);
  stored.characteristics = ['no_match', 'any_feet', 'no_kickboard', 'future_rule'];
  assert.deepEqual(planWoodsRuleRepair(catalog, [stored]).updates[0].characteristics, ['no_kickboard', 'future_rule']);
});

void test('does not update authored, non-Woods, or unmatched rows', () => {
  const { catalog, stored } = fixture();
  const plan = planWoodsRuleRepair(catalog, [
    { ...stored, userId: 'author' },
    { ...stored, boardType: 'kilter' },
    { ...stored, uuid: 'unmatched' },
  ]);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.unmatched, 1);
});

void test('rejects changed geometry and conflicting duplicate catalog rules', () => {
  const { catalog, stored } = fixture();
  assert.throws(() => planWoodsRuleRepair(catalog, [{ ...stored, compatibleSizeIds: [1] }]), /holds or size/);
  assert.throws(() => planWoodsRuleRepair(catalog, [{ ...stored, frames: 'p99r4' }]), /holds or size/);
  assert.throws(
    () =>
      buildWoodsRuleCatalog([
        {
          boardDimension: '12x12',
          count: 2,
          problems: [problem, { ...problem, matching: false }],
        },
      ]),
    /Conflicting Woods rules/,
  );
});
