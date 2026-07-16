import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTrainingRow,
  deduplicateTrainingRowsByPhysicalAngle,
  deduplicateTrainingRowsWithReport,
  type TrainingRow,
} from '../training-matrix';

// Minimal FeatureRow shape the assembler reads from.
const feature = (placementId: number, overrides: Record<string, unknown> = {}) => ({
  placement_id: placementId,
  norm_x: 0.5,
  norm_y: 0.5,
  edge_dist: 0.5,
  neighbor_dist: 0.1,
  hand_difficulty: 2,
  foot_difficulty: -1,
  pull_direction: 90,
  is_kickboard: false,
  coarse_type: null,
  ...overrides,
});

void describe('buildTrainingRow', () => {
  const stat = { climb_uuid: 'abc', angle: 40, label: 18.5, n: 120, layout_id: 1, fingerprint: 'fp1' };

  void test('joins holds to their features and maps roles', () => {
    const features = new Map([
      [10, feature(10, { hand_difficulty: 3, hole_id: 100, mirrored_hole_id: 0 })],
      [20, feature(20, { coarse_type: 'foot' })],
    ]);
    const row = buildTrainingRow(
      stat,
      [
        { placement_id: 10, hold_state: 'HAND' },
        { placement_id: 20, hold_state: 'FOOT' },
        { placement_id: 30, hold_state: 'STARTING' }, // no feature row → nulls, still a hand hold
      ],
      features,
    );
    assert.equal(row.climbUuid, 'abc');
    assert.equal(row.angle, 40);
    assert.equal(row.label, 18.5);
    assert.equal(row.holds.length, 3);
    assert.equal(row.holds[0].role, 'hand');
    assert.equal(row.holds[0].state, 'HAND');
    assert.equal(row.holds[0].hd, 3);
    assert.equal(row.holds[0].holeId, 100);
    assert.equal(row.holds[0].mirroredHoleId, undefined);
    assert.equal(row.holds[1].role, 'foot');
    assert.equal(row.holds[1].footSet, true);
    // Hold with no feature row keeps its role but carries null features.
    assert.equal(row.holds[2].role, 'hand');
    assert.equal(row.holds[2].hd, null);
    assert.equal(row.holds[2].nx, null);
  });

  void test('skips malformed hold states', () => {
    const row = buildTrainingRow(
      stat,
      [
        { placement_id: 10, hold_state: 'HAND' },
        { placement_id: 11, hold_state: 'NaN=undefined' }, // known bad-parse rows
      ],
      new Map([[10, feature(10)]]),
    );
    assert.equal(row.holds.length, 1);
  });
});

void describe('deduplicateTrainingRowsByPhysicalAngle', () => {
  const trainingRow = (climbUuid: string, benchmarkDifficulty: number | null): TrainingRow => ({
    climbUuid,
    boardType: 'tension',
    angle: 40,
    label: 20,
    ascents: 0,
    layoutId: 1,
    fingerprint: null,
    physicalKey: 'tension\u0000layout\u0000route',
    benchmarkDifficulty,
    holds: [],
  });

  void test('retains a single benchmark answer and all aliases', () => {
    const rows = deduplicateTrainingRowsByPhysicalAngle([trainingRow('b', null), trainingRow('a', 21)]);

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.benchmarkDifficulty, 21);
    assert.deepEqual(rows[0]?.aliases, ['a', 'b']);
  });

  void test('rejects conflicting benchmark answers within one physical angle', () => {
    assert.throws(
      () => deduplicateTrainingRowsByPhysicalAngle([trainingRow('a', 21), trainingRow('b', 22)]),
      /Conflicting benchmark grades/,
    );
  });

  void test('report mode excludes the entire conflicted physical problem', () => {
    const otherAngle = { ...trainingRow('c', null), angle: 50 };
    const result = deduplicateTrainingRowsWithReport([
      trainingRow('a', 21),
      trainingRow('b', 22),
      otherAngle,
      {
        ...trainingRow('safe', 20),
        physicalKey: 'tension\u0000layout\u0000safe-route',
      },
    ]);

    assert.deepEqual(result.rejectedPhysicalKeys, ['tension\u0000layout\u0000route']);
    assert.equal(result.rejectedRows, 3);
    assert.equal(result.rejectedBenchmarkGroups.length, 1);
    assert.deepEqual(
      result.rows.map((row) => row.climbUuid),
      ['safe'],
    );
  });
});
