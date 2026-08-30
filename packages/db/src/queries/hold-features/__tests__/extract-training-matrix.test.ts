import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrainingRow } from '../training-matrix';

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

// A Kilter-ish echo share; matches the model default so the de-herd is exercised.
const ECHO = 0.85;

void describe('buildTrainingRow', () => {
  const stat = {
    climb_uuid: 'abc',
    angle: 40,
    label: 18.5,
    n: 120,
    layout_id: 1,
    fingerprint: 'fp1',
    display: 17,
    benchmark: null,
  };

  test('joins holds to their features and maps roles', () => {
    const features = new Map([
      [10, feature(10, { hand_difficulty: 3 })],
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
      'kilter',
      ECHO,
    );
    assert.equal(row.climbUuid, 'abc');
    assert.equal(row.angle, 40);
    assert.equal(row.label, 18.5);
    assert.equal(row.holds.length, 3);
    assert.equal(row.holds[0].role, 'hand');
    assert.equal(row.holds[0].hd, 3);
    assert.equal(row.holds[1].role, 'foot');
    assert.equal(row.holds[1].footSet, true);
    // Hold with no feature row keeps its role but carries null features.
    assert.equal(row.holds[2].role, 'hand');
    assert.equal(row.holds[2].hd, null);
    assert.equal(row.holds[2].nx, null);
  });

  test('skips malformed hold states', () => {
    const row = buildTrainingRow(
      stat,
      [
        { placement_id: 10, hold_state: 'HAND' },
        { placement_id: 11, hold_state: 'NaN=undefined' }, // known bad-parse rows
      ],
      new Map([[10, feature(10)]]),
      'kilter',
      ECHO,
    );
    assert.equal(row.holds.length, 1);
  });

  test('tags every row with the board', () => {
    const row = buildTrainingRow(
      { ...stat, display: null },
      [{ placement_id: 10, hold_state: 'HAND' }],
      new Map([[10, feature(10)]]),
      'tension',
      ECHO,
    );
    assert.equal(row.board, 'tension');
  });

  test('passes the benchmark grade through, null when absent', () => {
    const holds = [{ placement_id: 10, hold_state: 'HAND' }];
    const features = new Map([[10, feature(10)]]);
    const withBenchmark = buildTrainingRow({ ...stat, benchmark: 21 }, holds, features, 'tension', ECHO);
    assert.equal(withBenchmark.benchmark, 21);
    const withoutBenchmark = buildTrainingRow({ ...stat, benchmark: null }, holds, features, 'tension', ECHO);
    assert.equal(withoutBenchmark.benchmark, null);
  });

  test('de-herds the crowd label when the evidence is eligible', () => {
    // label 18.5 sits above display 17; with λ=0.85 the display-anchored delta is
    // divided out (17 + 1.5/0.15 = 27) then capped at ±0.75 from the observed mean
    // (STAGE2_DEECHO_MAX_MOVE) → 19.25. Mirrors applyCappedStage2Evidence.
    const row = buildTrainingRow(
      { ...stat, label: 18.5, display: 17, n: 120 },
      [{ placement_id: 10, hold_state: 'HAND' }],
      new Map([[10, feature(10)]]),
      'kilter',
      ECHO,
    );
    assert.equal(row.deherdedLabel, 19.25);
    assert.equal((row.deherdedLabel as number) > row.label, true);
  });

  test('de-echo division is exact when the move stays inside the cap', () => {
    // A small display-anchored delta (0.09) de-echoes to a ~0.6 move — inside the
    // ±0.75 observed cap, so this pins the 1/(1−λ) division itself, not the cap.
    // A wrong λ would land elsewhere and fail here where the capped case can't.
    const row = buildTrainingRow(
      { ...stat, label: 17.09, display: 17, n: 120 },
      [{ placement_id: 10, hold_state: 'HAND' }],
      new Map([[10, feature(10)]]),
      'kilter',
      ECHO,
    );
    const expected = 17 + (17.09 - 17) / (1 - ECHO);
    assert.equal(row.deherdedLabel, expected);
    assert.equal(Math.abs((row.deherdedLabel as number) - 17.09) < 0.75, true);
  });

  test('deherdedLabel falls back to the raw label when the de-herd is ineligible', () => {
    const holds = [{ placement_id: 10, hold_state: 'HAND' }];
    const features = new Map([[10, feature(10)]]);
    // No display grade to anchor to → de-herd passes the observed mean straight through.
    const noDisplay = buildTrainingRow({ ...stat, display: null }, holds, features, 'kilter', ECHO);
    assert.equal(noDisplay.deherdedLabel, noDisplay.label);
    // Too few independent opinions (effectiveN < 3) → thin-evidence passthrough.
    const thin = buildTrainingRow({ ...stat, n: 5 }, holds, features, 'kilter', ECHO);
    assert.equal(thin.deherdedLabel, thin.label);
  });
});
