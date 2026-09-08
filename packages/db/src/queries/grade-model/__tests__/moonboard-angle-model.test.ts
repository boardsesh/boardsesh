import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BOULDER_GRADES } from '@boardsesh/board-constants/boulder-grade-mapping';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  MOONBOARD_ANGLE_COEFFICIENT_KIND,
  MOONBOARD_ANGLE_MAX_LOO_DELTA,
  MOONBOARD_ANGLE_MODEL_VERSION,
  MOONBOARD_SHALLOW_ANGLE,
  MOONBOARD_STEEP_ANGLE,
  buildMoonboardAngleCoefficientRows,
  buildMoonboardDualAngleSampleSql,
  estimateMoonboardAngleDeltas,
  estimateMoonboardGradeAtOtherAngle,
  otherMoonboardAngle,
  type MoonboardAngleCoefficients,
  type MoonboardDualAngleSampleRow,
} from '../moonboard-angle-model';
import { ANGLE_CELL_MIN_CLIMBS, DEFAULT_SIGMA_WITHIN } from '../constants';

const dialect = new PgDialect();
const sqlText = (query: SQL): string => dialect.sqlToQuery(query).sql;

/** `count` dual-graded problems at 25° grade `shallow`, each `delta` harder at 40°. */
function pairs(shallow: number, delta: number, count: number, prefix = 'c'): MoonboardDualAngleSampleRow[] {
  return Array.from({ length: count }, (_unused, index) => ({
    climb_uuid: `${prefix}-${shallow}-${delta}-${index}`,
    grade_25: shallow,
    grade_40: shallow + delta,
  }));
}

function fit(samples: MoonboardDualAngleSampleRow[]) {
  return estimateMoonboardAngleDeltas(samples, 'test-coeffs');
}

void describe('buildMoonboardDualAngleSampleSql', () => {
  void test('only pairs ascent-backed grades at both of MoonBoard’s two angles', () => {
    const text = sqlText(buildMoonboardDualAngleSampleSql());
    assert.match(text, /board_type = 'moonboard'/);
    assert.match(text, /display_difficulty IS NOT NULL/);
    assert.match(text, /ascensionist_count > 0/);
    // Both angles required — a single-angle climb is an estimate TARGET, never
    // training data, or the model would learn from its own output.
    assert.match(text, /HAVING COUNT\(\*\) FILTER/);
    assert.match(text, /is_listed = true/);
  });
});

void describe('estimateMoonboardAngleDeltas', () => {
  void test('learns a per-band delta from a well-sampled band', () => {
    const samples = [
      ...pairs(12, 3, 60, 'easy'), // v0-2 band: +3
      ...pairs(22, 2, 60, 'hard'), // v6-8 band: +2
    ];
    const { coefficients, report } = fit(samples);

    assert.equal(coefficients.from25['v0-2']?.delta, 3);
    assert.equal(coefficients.from25['v6-8']?.delta, 2);
    // from40 is banded on the 40° grade: 15 → v0-2, 24 → v6-8.
    assert.equal(coefficients.from40['v0-2']?.delta, -3);
    assert.equal(coefficients.from40['v6-8']?.delta, -2);
    assert.equal(report.problems.length, 0);
    assert.equal(report.sampleClimbs, 120);
    assert.equal(report.nonMonotonicShare, 0);
  });

  void test('a band under ANGLE_CELL_MIN_CLIMBS is dropped so the lookup falls back to `all`', () => {
    const samples = [
      ...pairs(12, 3, ANGLE_CELL_MIN_CLIMBS + 10, 'easy'),
      ...pairs(26, 1, ANGLE_CELL_MIN_CLIMBS - 1, 'v9'), // one short of the bar
    ];
    const { coefficients, report } = fit(samples);

    assert.equal(coefficients.from25['v9+'], undefined);
    assert.ok(coefficients.from25.all);
    const v9 = report.bands.find((band) => band.direction === MOONBOARD_SHALLOW_ANGLE && band.band === 'v9+');
    assert.equal(v9?.rejectedBecause, 'low_n');
    assert.equal(v9?.n, ANGLE_CELL_MIN_CLIMBS - 1);
  });

  void test('regression: the real v9+ sign flip is rejected, not published', () => {
    // The live catalogue's v9+ band (n=54) does not get harder with angle —
    // sparse, non-monotonic setter labels put its median the wrong way round.
    // Publishing it would tell a climber a 40° problem eases off at 25°.
    const samples = [...pairs(12, 3, 200, 'bulk'), ...pairs(26, -1, 40, 'v9down'), ...pairs(27, -1, 14, 'v9down2')];
    const { coefficients, report } = fit(samples);

    const v9 = report.bands.find((band) => band.direction === MOONBOARD_SHALLOW_ANGLE && band.band === 'v9+');
    assert.equal(v9?.n, 54);
    assert.equal(v9?.median, -1);
    assert.equal(v9?.rejectedBecause, 'sign_flip');
    assert.equal(coefficients.from25['v9+'], undefined);
    // The pooled direction is still sound, so the band just borrows it.
    assert.ok((coefficients.from25.all?.delta ?? 0) > 0);
    assert.ok(report.nonMonotonicShare > 0);
    assert.equal(report.problems.length, 0);
  });

  void test('a band whose median hangs on one climb is rejected as LOO-unstable', () => {
    // Half the band says +2, half says +3: the median sits on the 2.5 seam, so
    // dropping any single climb moves it 0.5 — past the bridge estimator's bar.
    const wobbly = [...pairs(12, 2, 20, 'lo'), ...pairs(12, 3, 20, 'hi')];
    const { coefficients, report } = fit([...wobbly, ...pairs(22, 2, 60, 'stable')]);

    const band = report.bands.find((entry) => entry.direction === MOONBOARD_SHALLOW_ANGLE && entry.band === 'v0-2');
    assert.equal(band?.median, 2.5);
    assert.ok((band?.looMaxDelta ?? 0) > MOONBOARD_ANGLE_MAX_LOO_DELTA);
    assert.equal(band?.rejectedBecause, 'loo_unstable');
    assert.equal(coefficients.from25['v0-2'], undefined);
  });

  void test('flags an unusable pooled fit instead of publishing a wrong-signed delta', () => {
    const { report } = fit(pairs(12, -2, 60, 'backwards'));
    assert.ok(report.problems.some((problem) => problem.includes('25°→40°')));
    assert.ok(report.problems.some((problem) => problem.includes('40°→25°')));
  });

  void test('an empty sample produces no coefficients and says why', () => {
    const { coefficients, report } = fit([]);
    assert.deepEqual(coefficients.from25, {});
    assert.deepEqual(coefficients.from40, {});
    assert.equal(report.sampleClimbs, 0);
    assert.equal(report.problems.length, 1);
  });

  void test('the ± band never claims to be tighter than the within-climb spread', () => {
    // Every pair agrees exactly, so MAD is 0 — the floor keeps the published
    // band honest instead of printing a zero-width CI.
    const { coefficients } = fit(pairs(12, 3, 60, 'identical'));
    assert.equal(coefficients.from25['v0-2']?.sd, DEFAULT_SIGMA_WITHIN);
  });
});

void describe('estimateMoonboardGradeAtOtherAngle', () => {
  const coefficients: MoonboardAngleCoefficients = {
    coeffVersion: 'test',
    from25: {
      'v0-2': { delta: 3, n: 100, sd: 1.2, looMaxDelta: 0 },
      all: { delta: 2, n: 500, sd: 1.5, looMaxDelta: 0 },
    },
    from40: {
      'v6-8': { delta: -2, n: 100, sd: 1.1, looMaxDelta: 0 },
      all: { delta: -2.5, n: 500, sd: 1.4, looMaxDelta: 0 },
    },
  };

  void test('uses the band’s own delta when the band survived the guards', () => {
    const estimate = estimateMoonboardGradeAtOtherAngle(12, MOONBOARD_SHALLOW_ANGLE, coefficients);
    assert.deepEqual(estimate, { grade: 15, band: 'v0-2', cellKey: 'v0-2', sd: 1.2 });
  });

  void test('falls back to the pooled delta for a band that was dropped', () => {
    const estimate = estimateMoonboardGradeAtOtherAngle(26, MOONBOARD_SHALLOW_ANGLE, coefficients);
    assert.equal(estimate?.band, 'v9+');
    assert.equal(estimate?.cellKey, 'all');
    assert.equal(estimate?.grade, 28);
    assert.equal(estimate?.sd, 1.5);
  });

  void test('transposes the other way from 40°, and lands on the 40° grade’s band', () => {
    const estimate = estimateMoonboardGradeAtOtherAngle(23, MOONBOARD_STEEP_ANGLE, coefficients);
    assert.deepEqual(estimate, { grade: 21, band: 'v6-8', cellKey: 'v6-8', sd: 1.1 });
  });

  void test('rounds a fractional delta to the integer difficulty scale', () => {
    const estimate = estimateMoonboardGradeAtOtherAngle(24, MOONBOARD_STEEP_ANGLE, {
      ...coefficients,
      from40: { all: { delta: -2.5, n: 500, sd: 1.4, looMaxDelta: 0 } },
    });
    // 24 − 2.5 = 21.5 → 22 (Math.round's half-up), a real grade id.
    assert.equal(estimate?.grade, 22);
  });

  void test('clamps to the ends of the grade scale rather than inventing an id', () => {
    const low = estimateMoonboardGradeAtOtherAngle(10, MOONBOARD_STEEP_ANGLE, coefficients);
    assert.equal(low?.grade, 10);
    const topOfScale = BOULDER_GRADES[BOULDER_GRADES.length - 1].difficulty_id;
    const high = estimateMoonboardGradeAtOtherAngle(topOfScale, MOONBOARD_SHALLOW_ANGLE, coefficients);
    assert.equal(high?.grade, topOfScale);
  });

  void test('refuses an angle MoonBoard does not have, and a direction with no coefficients', () => {
    assert.equal(estimateMoonboardGradeAtOtherAngle(20, 30, coefficients), null);
    assert.equal(estimateMoonboardGradeAtOtherAngle(Number.NaN, 25, coefficients), null);
    assert.equal(
      estimateMoonboardGradeAtOtherAngle(20, MOONBOARD_SHALLOW_ANGLE, { coeffVersion: 'x', from25: {}, from40: {} }),
      null,
    );
  });
});

void describe('coefficient persistence shape', () => {
  void test('rows are keyed direction:band under their own kind', () => {
    const { coefficients } = fit([...pairs(12, 3, 60, 'easy'), ...pairs(22, 2, 60, 'hard')]);
    const rows = buildMoonboardAngleCoefficientRows(coefficients);
    const keys = rows.map((row) => row.key).sort();

    assert.ok(rows.every((row) => row.kind === MOONBOARD_ANGLE_COEFFICIENT_KIND));
    assert.ok(keys.includes('from25:all'));
    assert.ok(keys.includes('from25:v0-2'));
    assert.ok(keys.includes('from40:all'));
  });

  void test('the model version is its own string, never the EB blend’s', () => {
    assert.equal(MOONBOARD_ANGLE_MODEL_VERSION, 'moonboard-angle-v1');
  });

  void test('otherMoonboardAngle pairs the two angles and rejects anything else', () => {
    assert.equal(otherMoonboardAngle(MOONBOARD_SHALLOW_ANGLE), MOONBOARD_STEEP_ANGLE);
    assert.equal(otherMoonboardAngle(MOONBOARD_STEEP_ANGLE), MOONBOARD_SHALLOW_ANGLE);
    assert.equal(otherMoonboardAngle(45), null);
  });
});
