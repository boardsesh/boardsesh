import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { GradeCoefficients } from '../../grade-model';
import { computeFrozenStage2Target } from '../stage2-target';

const coefficients: GradeCoefficients = {
  coeffVersion: 'frozen-test',
  echoFraction: { kilter: 0.5 },
  sigmaWithin: {},
  tauSquared: {},
  angleOffset: {},
  boardOffset: { kilter: { offset: -1.2, sd: 0.4, users: 50, looMaxDelta: 0.1 } },
  raterModel: {},
  behaviorModel: {},
  bridgeReadiness: {},
};

void describe('computeFrozenStage2Target', () => {
  void test('combines de-echoed crowd, capped rater, and capped behavior evidence', () => {
    const target = computeFrozenStage2Target(
      {
        boardType: 'kilter',
        observedMean: 20.5,
        displayGrade: 20,
        ascensionistCount: 20,
        evidence: {
          raterMean: 23,
          raterEffectiveN: 20,
          behaviorMean: 18,
          behaviorEffectiveN: 20,
        },
      },
      coefficients,
    );

    // Crowd: 21 at weight 10; rater: 21 at capped weight 5;
    // behavior: 20.15 at capped weight 2.
    const expectedLocal = (21 * 10 + 21 * 5 + 20.15 * 2) / 17;
    assert.ok(Math.abs(target.localGrade - expectedLocal) < 1e-12);
    assert.ok(target.universalGrade !== null && Math.abs(target.universalGrade - (expectedLocal - 1.2)) < 1e-12);
    assert.equal(target.signalWeight, 17);
  });

  void test('uses Tension as the universal anchor when no offset row exists', () => {
    const target = computeFrozenStage2Target(
      {
        boardType: 'tension',
        observedMean: 20,
        displayGrade: 20,
        ascensionistCount: 1,
      },
      { ...coefficients, echoFraction: { tension: 0.85 }, boardOffset: {} },
    );

    assert.equal(target.localGrade, 20);
    assert.equal(target.universalGrade, 20);
    assert.equal(target.signalWeight, 1);
  });
});
