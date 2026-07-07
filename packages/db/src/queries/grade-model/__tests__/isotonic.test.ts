import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyIsotonicAngleConstraint, isotonicNonDecreasing, type AngleGradeRow } from '../isotonic';
import { CONFIDENCE } from '../constants';
import type { PosteriorGrade } from '../types';

function posterior(
  localGrade: number | null,
  postSd: number | null,
  universalGrade: number | null = null,
): PosteriorGrade {
  return {
    localGrade,
    universalGrade,
    gradeLow: localGrade === null || postSd === null ? null : localGrade - 1.96 * postSd,
    gradeHigh: localGrade === null || postSd === null ? null : localGrade + 1.96 * postSd,
    confidence: CONFIDENCE.provisional,
    postSd,
  };
}

function row(
  angle: number,
  grade: number | null,
  sd: number | null,
  observed: number | null = grade,
  count = 30,
): AngleGradeRow {
  return { angle, posterior: posterior(grade, sd), observedMean: observed, ascensionistCount: count };
}

void describe('isotonicNonDecreasing', () => {
  void test('leaves monotone sequences untouched', () => {
    assert.deepEqual(isotonicNonDecreasing([1, 2, 3], [1, 1, 1]), [1, 2, 3]);
  });
  void test('merges a violating pair to its weighted mean', () => {
    const fitted = isotonicNonDecreasing([24, 22], [3, 1]);
    // (24·3 + 22·1)/4 = 23.5 for both
    assert.deepEqual(fitted, [23.5, 23.5]);
  });
  void test('cascading merge across three values', () => {
    const fitted = isotonicNonDecreasing([5, 3, 1], [1, 1, 1]);
    assert.deepEqual(fitted, [3, 3, 3]);
  });
  void test('heavier evidence wins the merge', () => {
    const fitted = isotonicNonDecreasing([20, 24, 22], [1, 1, 100]);
    assert.ok(fitted[1] < 22.1, `high-weight 22 should dominate, got ${fitted[1]}`);
    assert.ok(fitted[1] === fitted[2]);
  });
});

void describe('applyIsotonicAngleConstraint', () => {
  void test('fixes the Enchiridion inversion (30° above 35°)', () => {
    // Real-world shape: 30° graded ~1 above 35°, both with real evidence.
    const rows = [
      row(20, 20.12, 0.35),
      row(25, 19.95, 0.42),
      row(30, 23.81, 0.24, 23.83, 55),
      row(35, 22.86, 0.31, 22.83, 33),
      row(40, 24.94, 0.19, 24.96, 95),
    ];
    const { adjusted, residualInversions, movedRows } = applyIsotonicAngleConstraint(rows);
    const byAngle = new Map(rows.map((r, i) => [r.angle, adjusted[i]]));
    const at30 = byAngle.get(30)!.localGrade as number;
    const at35 = byAngle.get(35)!.localGrade as number;
    assert.ok(at30 <= at35 + 1e-9, `30° (${at30}) must not exceed 35° (${at35})`);
    // Merged toward the precision-weighted middle, and 20/25 fixed too.
    const at20 = byAngle.get(20)!.localGrade as number;
    const at25 = byAngle.get(25)!.localGrade as number;
    assert.ok(at20 <= at25 + 1e-9);
    assert.equal(residualInversions, 0);
    assert.ok(movedRows >= 4);
    // 40° was already above everything — untouched.
    assert.equal(byAngle.get(40)!.localGrade, 24.94);
  });

  void test('shifts universal grade and CI with the mean', () => {
    const rows = [
      { ...row(30, 24, 0.3), posterior: posterior(24, 0.3, 23) },
      { ...row(35, 22, 0.3), posterior: posterior(22, 0.3, 21) },
    ];
    const { adjusted } = applyIsotonicAngleConstraint(rows);
    // Equal weights → both merge to 23; universal keeps the −1 offset.
    assert.ok(Math.abs((adjusted[0].localGrade as number) - 23) < 1e-9);
    assert.ok(Math.abs((adjusted[0].universalGrade as number) - 22) < 1e-9);
    const width = (adjusted[0].gradeHigh as number) - (adjusted[0].gradeLow as number);
    assert.ok(Math.abs(width - 2 * 1.96 * 0.3) < 1e-9, 'CI width preserved');
  });

  void test('established rows never move more than the no-shock bound', () => {
    // Massive-precision low grade at 35° would drag 30° far below its crowd.
    const rows = [row(30, 24, 0.5, 24, 100), row(35, 18, 0.01, 18, 5000)];
    const { adjusted, residualInversions } = applyIsotonicAngleConstraint(rows);
    const at30 = adjusted[0].localGrade as number;
    assert.ok(at30 >= 23 - 1e-9, `30° clamped to crowd−1, got ${at30}`);
    // The cap leaves a residual inversion — counted, not hidden.
    assert.equal(residualInversions, 1);
  });

  void test('display-only rows (no postSd) do not participate and are unchanged', () => {
    const rows = [
      { angle: 30, posterior: posterior(24, null), observedMean: null, ascensionistCount: 0 },
      row(35, 22, 0.3),
    ];
    const { adjusted } = applyIsotonicAngleConstraint(rows);
    assert.equal(adjusted[0].localGrade, 24);
    assert.equal(adjusted[1].localGrade, 22);
  });

  void test('single-angle climbs pass through', () => {
    const rows = [row(40, 20, 0.4)];
    const { adjusted, movedRows } = applyIsotonicAngleConstraint(rows);
    assert.equal(adjusted[0].localGrade, 20);
    assert.equal(movedRows, 0);
  });
});
