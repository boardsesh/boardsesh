import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  contentPriorKey,
  evaluateContentPriorBacktest,
  parseContentPriorLine,
  type BacktestSampleRow,
  type ContentPriorEntry,
} from '../gates';
import type { GradeCoefficients } from '../types';

/** Minimal coefficient set — the content-prior backtest only reads echoFraction. */
function makeCoefficients(echoFraction: Record<string, number>): GradeCoefficients {
  return {
    coeffVersion: 'test',
    echoFraction,
    sigmaWithin: {},
    tauSquared: {},
    angleOffset: {},
    boardOffset: {},
    raterModel: {},
    behaviorModel: {},
    bridgeReadiness: {},
  };
}

function makeRow(partial: Partial<BacktestSampleRow>): BacktestSampleRow {
  return {
    board_type: 'kilter',
    climb_uuid: 'climb-1',
    angle: 40,
    snap_avg: 20,
    snap_display: 20,
    snap_count: 1,
    final_avg: 20,
    sibling_states: [],
    ...partial,
  };
}

/** Build a per-board content-prior map keyed exactly like the DB/file loaders. */
function priorMap(entries: Array<{ climbUuid: string; angle: number; contentPrior: number; contentSd?: number }>) {
  const map = new Map<string, ContentPriorEntry>();
  for (const { climbUuid, angle, contentPrior, contentSd } of entries) {
    map.set(contentPriorKey(climbUuid, angle), { contentPrior, contentSd: contentSd ?? null });
  }
  return map;
}

function approx(actual: number, expected: number, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} !~= ${expected}`);
}

void describe('evaluateContentPriorBacktest', () => {
  void test('a candidate that tracks truth beats the honest display baseline', () => {
    const coefficients = makeCoefficients({ kilter: 0.8 });
    const rows: BacktestSampleRow[] = [];
    const priors: Array<{ climbUuid: string; angle: number; contentPrior: number }> = [];
    for (let i = 0; i < 10; i++) {
      const climbUuid = `climb-${i}`;
      rows.push(makeRow({ climb_uuid: climbUuid, final_avg: 20, snap_display: 23, snap_avg: 22 }));
      priors.push({ climbUuid, angle: 40, contentPrior: 20.1 });
    }
    const summary = evaluateContentPriorBacktest(rows, priorMap(priors), coefficients);

    assert.equal(summary.gate.gate, 'content_prior_backtest');
    assert.equal(summary.gate.passed, true); // report-only, never blocks
    assert.equal(summary.boardType, 'kilter');
    approx(summary.coverage, 1);
    assert.equal(summary.matchedRows, 10);
    assert.equal(summary.totalRows, 10);
    approx(summary.overall.contentMae, 0.1, 1e-9);
    approx(summary.overall.earlyDisplayMae, 3, 1e-9);
    approx(summary.overall.earlyCrowdMae, 2, 1e-9);
    assert.ok(summary.overall.contentMae < summary.overall.earlyDisplayMae);
    assert.ok(summary.overall.contentMae < summary.overall.earlyCrowdMae);
  });

  void test('stays report-only (passed) even when the candidate is worse than both baselines', () => {
    const coefficients = makeCoefficients({ kilter: 0.8 });
    const rows = [makeRow({ climb_uuid: 'c1', final_avg: 20, snap_display: 20, snap_avg: 20 })];
    const summary = evaluateContentPriorBacktest(
      rows,
      priorMap([{ climbUuid: 'c1', angle: 40, contentPrior: 30 }]),
      coefficients,
    );
    approx(summary.overall.contentMae, 10, 1e-9);
    approx(summary.overall.earlyDisplayMae, 0, 1e-9);
    assert.equal(summary.gate.passed, true);
  });

  void test('coverage reflects unmatched rows (candidates absent)', () => {
    const coefficients = makeCoefficients({ kilter: 0.8 });
    const rows = [
      makeRow({ climb_uuid: 'a' }),
      makeRow({ climb_uuid: 'b' }),
      makeRow({ climb_uuid: 'c' }),
      makeRow({ climb_uuid: 'd' }),
    ];
    // Only two of the four rows have a candidate prior.
    const summary = evaluateContentPriorBacktest(
      rows,
      priorMap([
        { climbUuid: 'a', angle: 40, contentPrior: 20 },
        { climbUuid: 'c', angle: 40, contentPrior: 20 },
      ]),
      coefficients,
    );
    assert.equal(summary.totalRows, 4);
    assert.equal(summary.matchedRows, 2);
    approx(summary.coverage, 0.5);
  });

  void test('null snap_display rows drop out of both baselines but keep content coverage', () => {
    const coefficients = makeCoefficients({ kilter: 0.8 });
    const rows: BacktestSampleRow[] = [];
    const priors: Array<{ climbUuid: string; angle: number; contentPrior: number }> = [];
    // 2 display-comparable rows: crowd error 1 each.
    for (let i = 0; i < 2; i++) {
      const climbUuid = `disp-${i}`;
      rows.push(makeRow({ climb_uuid: climbUuid, final_avg: 20, snap_display: 21, snap_avg: 21 }));
      priors.push({ climbUuid, angle: 40, contentPrior: 20 });
    }
    // 3 null-display rows: a wild crowd error that must NOT leak into earlyCrowdMae.
    for (let i = 0; i < 3; i++) {
      const climbUuid = `nulldisp-${i}`;
      rows.push(makeRow({ climb_uuid: climbUuid, final_avg: 20, snap_display: null, snap_avg: 30 }));
      priors.push({ climbUuid, angle: 40, contentPrior: 20 });
    }
    const summary = evaluateContentPriorBacktest(rows, priorMap(priors), coefficients);

    assert.equal(summary.matchedRows, 5);
    assert.equal(summary.overall.displayNullRows, 3);
    assert.equal(summary.overall.displayComparableRows, 2);
    // Baselines are measured only on the 2 display-comparable rows.
    approx(summary.overall.earlyDisplayMae, 1, 1e-9);
    approx(summary.overall.earlyCrowdMae, 1, 1e-9);
    // Content is scored on all 5 matched rows (all exactly right here → 0).
    approx(summary.overall.contentMae, 0, 1e-9);
  });

  void test('stratifies by n_eff bucket at the boundaries (echo=0 ⇒ n_eff = snap_count)', () => {
    const coefficients = makeCoefficients({ kilter: 0 });
    const specs: Array<{ climbUuid: string; snapCount: number; bucket: string }> = [
      { climbUuid: 'z0', snapCount: 0, bucket: '<1' }, // effectiveN(0) = 0
      { climbUuid: 'a1', snapCount: 1, bucket: '[1,3)' }, // n_eff 1 (lower bound in-bucket)
      { climbUuid: 'a2', snapCount: 2, bucket: '[1,3)' },
      { climbUuid: 'b3', snapCount: 3, bucket: '[3,10)' }, // n_eff 3 crosses into next bucket
      { climbUuid: 'b9', snapCount: 9, bucket: '[3,10)' },
      { climbUuid: 'c10', snapCount: 10, bucket: '>=10' }, // n_eff 10 crosses again
    ];
    const rows = specs.map((spec) => makeRow({ climb_uuid: spec.climbUuid, snap_count: spec.snapCount }));
    const priors = specs.map((spec) => ({ climbUuid: spec.climbUuid, angle: 40, contentPrior: 20 }));
    const summary = evaluateContentPriorBacktest(rows, priorMap(priors), coefficients);

    const byBucket = new Map(summary.buckets.map((bucket) => [bucket.bucket, bucket.n]));
    assert.deepEqual(
      summary.buckets.map((bucket) => bucket.bucket),
      ['<1', '[1,3)', '[3,10)', '>=10'],
    );
    assert.equal(byBucket.get('<1'), 1);
    assert.equal(byBucket.get('[1,3)'), 2);
    assert.equal(byBucket.get('[3,10)'), 2);
    assert.equal(byBucket.get('>=10'), 1);
    assert.equal(summary.matchedRows, 6);
  });

  void test('empty input yields zeroed report, still report-only', () => {
    const summary = evaluateContentPriorBacktest([], new Map(), makeCoefficients({ kilter: 0.8 }));
    assert.equal(summary.totalRows, 0);
    assert.equal(summary.matchedRows, 0);
    approx(summary.coverage, 0);
    assert.equal(summary.gate.passed, true);
  });
});

void describe('parseContentPriorLine (candidate file loader)', () => {
  void test('parses a well-formed record and defaults a missing contentSd to null', () => {
    const result = parseContentPriorLine('{"climbUuid":"abc","angle":40,"contentPrior":21.5}', 'kilter');
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.key, contentPriorKey('abc', 40));
    assert.equal(result.entry.contentPrior, 21.5);
    assert.equal(result.entry.contentSd, null);
  });

  void test('keeps a provided contentSd', () => {
    const result = parseContentPriorLine(
      '{"climbUuid":"abc","angle":40,"contentPrior":21.5,"contentSd":0.7}',
      'kilter',
    );
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.entry.contentSd, 0.7);
  });

  void test('accepts a board-tagged record for the matching board', () => {
    const result = parseContentPriorLine('{"climbUuid":"x","angle":50,"contentPrior":18,"board":"kilter"}', 'kilter');
    assert.equal(result.status, 'ok');
  });

  void test('skips a record tagged for a different board', () => {
    const result = parseContentPriorLine('{"climbUuid":"x","angle":50,"contentPrior":18,"board":"tension"}', 'kilter');
    assert.equal(result.status, 'skip');
  });

  void test('flags malformed JSON and records missing required fields', () => {
    assert.equal(parseContentPriorLine('{not json', 'kilter').status, 'malformed');
    assert.equal(parseContentPriorLine('[]', 'kilter').status, 'malformed');
    assert.equal(parseContentPriorLine('{"climbUuid":"x","contentPrior":18}', 'kilter').status, 'malformed'); // no angle
    assert.equal(parseContentPriorLine('{"angle":40,"contentPrior":18}', 'kilter').status, 'malformed'); // no uuid
    assert.equal(parseContentPriorLine('{"climbUuid":"x","angle":40}', 'kilter').status, 'malformed'); // no contentPrior
    assert.equal(
      parseContentPriorLine('{"climbUuid":"x","angle":40,"contentPrior":"soft"}', 'kilter').status,
      'malformed',
    ); // non-numeric contentPrior
  });
});
