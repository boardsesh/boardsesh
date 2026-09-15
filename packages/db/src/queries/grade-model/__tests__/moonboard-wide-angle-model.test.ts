import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  estimateMoonboardGradeAtWideAngle,
  pickWideAngleAnchor,
  type MoonboardWideAngleAnchor,
} from '../moonboard-wide-angle-model';
import type { GradeCoefficients } from '../types';

function coefficients(angleOffset: GradeCoefficients['angleOffset']): GradeCoefficients {
  return {
    coeffVersion: 'test',
    echoFraction: {},
    sigmaWithin: {},
    tauSquared: {},
    angleOffset,
    boardOffset: {},
    raterModel: {},
    behaviorModel: {},
    bridgeReadiness: {},
  };
}

void describe('pickWideAngleAnchor', () => {
  void test('prefers a real anchor over a transposed one, even when the transposed one is closer', () => {
    const anchors: MoonboardWideAngleAnchor[] = [
      { angle: 25, grade: 19, isReal: false },
      { angle: 40, grade: 22, isReal: true },
    ];
    // Target 30 is closer to 25, but 25 is only a same-board transposed estimate.
    assert.deepEqual(pickWideAngleAnchor(anchors, 30), { angle: 40, grade: 22, isReal: true });
  });

  void test('picks the closer of two real anchors', () => {
    const anchors: MoonboardWideAngleAnchor[] = [
      { angle: 25, grade: 19, isReal: true },
      { angle: 40, grade: 22, isReal: true },
    ];
    assert.equal(pickWideAngleAnchor(anchors, 30)?.angle, 25);
    assert.equal(pickWideAngleAnchor(anchors, 35)?.angle, 40);
  });

  void test('falls back to a transposed anchor when nothing real exists', () => {
    const anchors: MoonboardWideAngleAnchor[] = [{ angle: 25, grade: 19, isReal: false }];
    assert.equal(pickWideAngleAnchor(anchors, 60)?.angle, 25);
  });

  void test('returns null with no anchors at all', () => {
    assert.equal(pickWideAngleAnchor([], 40), null);
  });
});

void describe('estimateMoonboardGradeAtWideAngle', () => {
  void test('shifts the anchor grade by the borrowed shape delta and rounds to an integer', () => {
    const coeffs = coefficients({
      kilter: { 'v6-8': { 40: -0.09, 0: -1.62 } },
    });
    const estimate = estimateMoonboardGradeAtWideAngle({ angle: 40, grade: 22, isReal: true }, 0, coeffs);
    // 22 + (-1.62 - -0.09) = 20.47 -> rounds to 20
    assert.equal(estimate?.grade, 20);
    assert.equal(estimate?.anchorAngle, 40);
    assert.equal(estimate?.shapeBoard, 'kilter');
  });

  void test('falls back to the next shape board when the first has no coverage for this pair', () => {
    const coeffs = coefficients({
      kilter: { 'v6-8': { 40: -0.09 } }, // no angle 0 entry, no 'all' fallback either
      tension: { 'v6-8': { 40: 0.36, 0: -2.5 } },
    });
    const estimate = estimateMoonboardGradeAtWideAngle({ angle: 40, grade: 22, isReal: true }, 0, coeffs);
    assert.equal(estimate?.shapeBoard, 'tension');
  });

  void test('returns null when no shape board covers this band/angle pair', () => {
    const coeffs = coefficients({ kilter: { 'v6-8': { 40: -0.09 } } });
    assert.equal(estimateMoonboardGradeAtWideAngle({ angle: 40, grade: 22, isReal: true }, 0, coeffs), null);
  });
});
