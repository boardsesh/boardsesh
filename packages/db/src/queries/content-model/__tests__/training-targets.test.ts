import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { GradeCoefficients, Stage2EvidenceMap } from '../../grade-model';
import { computeFrozenStage2Target } from '../stage2-target';
import {
  buildFrozenTrainingTargets,
  contentTrainingStatKey,
  resolveTrainingTarget,
  type ContentTrainingStat,
} from '../training-targets';

const coefficients: GradeCoefficients = {
  coeffVersion: 'target-test',
  echoFraction: { kilter: 0 },
  sigmaWithin: {},
  tauSquared: {},
  angleOffset: {},
  boardOffset: { kilter: { offset: -1, sd: 0.4, users: 50, looMaxDelta: 0.1 } },
  raterModel: {},
  behaviorModel: {},
  bridgeReadiness: {},
};

void describe('buildFrozenTrainingTargets', () => {
  void test('pools duplicate fingerprints before creating labels', () => {
    const stats: ContentTrainingStat[] = [
      {
        boardType: 'kilter',
        climbUuid: 'duplicate-a',
        layoutId: 1,
        fingerprint: 'same-holds',
        physicalKey: 'kilter\u00001\u0000same-holds',
        angle: 40,
        difficultyAverage: 20,
        displayDifficulty: 20,
        ascensionistCount: 20,
      },
      {
        boardType: 'kilter',
        climbUuid: 'duplicate-b',
        layoutId: 1,
        fingerprint: 'same-holds',
        physicalKey: 'kilter\u00001\u0000same-holds',
        angle: 40,
        difficultyAverage: 24,
        displayDifficulty: 24,
        ascensionistCount: 60,
      },
    ];

    const targets = buildFrozenTrainingTargets(stats, coefficients, new Map() as Stage2EvidenceMap);
    const first = targets.get(contentTrainingStatKey('kilter', 'duplicate-a', 40));
    const second = targets.get(contentTrainingStatKey('kilter', 'duplicate-b', 40));

    assert.ok(first);
    assert.deepEqual(first, second);
    assert.equal(first.localGrade, 23);
    assert.equal(first.universalGrade, 22);
    assert.equal(first.pooledAscensionistCount, 80);
    assert.equal(first.targetVersion, 'climb2vec-frozen-stage2-v1');
  });

  void test('pools a mirror-canonical physical key even when no fingerprint exists', () => {
    const stats: ContentTrainingStat[] = [
      {
        boardType: 'kilter',
        climbUuid: 'a',
        layoutId: 1,
        fingerprint: null,
        physicalKey: 'tension\u00002\u00007:STARTING,9:FOOT',
        angle: 40,
        difficultyAverage: 20,
        displayDifficulty: 20,
        ascensionistCount: 20,
      },
      {
        boardType: 'kilter',
        climbUuid: 'b',
        layoutId: 1,
        fingerprint: null,
        physicalKey: 'tension\u00002\u00007:STARTING,9:FOOT',
        angle: 40,
        difficultyAverage: 24,
        displayDifficulty: 24,
        ascensionistCount: 20,
      },
    ];

    const targets = buildFrozenTrainingTargets(stats, coefficients, new Map() as Stage2EvidenceMap);
    assert.equal(targets.get(contentTrainingStatKey('kilter', 'a', 40))?.localGrade, 22);
    assert.equal(targets.get(contentTrainingStatKey('kilter', 'b', 40))?.localGrade, 22);
  });

  void test('applies the minimum-ascent gate after pooling physical aliases', () => {
    const stats: ContentTrainingStat[] = [
      {
        boardType: 'kilter',
        climbUuid: 'sparse-duplicate-a',
        layoutId: 1,
        fingerprint: 'same-sparse-holds',
        physicalKey: 'kilter\u00001\u0000same-sparse-holds',
        angle: 40,
        difficultyAverage: 20,
        displayDifficulty: 20,
        ascensionistCount: 10,
      },
      {
        boardType: 'kilter',
        climbUuid: 'sparse-duplicate-b',
        layoutId: 1,
        fingerprint: 'same-sparse-holds',
        physicalKey: 'kilter\u00001\u0000same-sparse-holds',
        angle: 40,
        difficultyAverage: 22,
        displayDifficulty: 22,
        ascensionistCount: 10,
      },
    ];

    const target = buildFrozenTrainingTargets(stats, coefficients, new Map() as Stage2EvidenceMap).get(
      contentTrainingStatKey('kilter', 'sparse-duplicate-a', 40),
    );
    const resolved = resolveTrainingTarget({
      boardType: 'kilter',
      ascensionistCount: 10,
      benchmarkDifficulty: null,
      minimumAscents: 20,
      coefficients,
      target,
    });

    assert.ok(resolved);
    assert.equal(resolved.pooledAscensionistCount, 20);
  });

  void test('uses Tension local grades as the universal anchor without a stored offset', () => {
    const target = computeFrozenStage2Target(
      {
        boardType: 'tension',
        observedMean: 21,
        displayGrade: 21,
        ascensionistCount: 20,
      },
      coefficients,
    );

    assert.equal(target.localGrade, 21);
    assert.equal(target.universalGrade, 21);
  });

  void test('retains a cold Tension benchmark without making it a training signal', () => {
    const resolved = resolveTrainingTarget({
      boardType: 'tension',
      ascensionistCount: 0,
      benchmarkDifficulty: 22,
      minimumAscents: 20,
      coefficients,
      target: undefined,
    });

    assert.deepEqual(resolved, {
      label: 22,
      localLabel: 22,
      labelWeight: 0,
      coeffVersion: 'target-test',
      targetVersion: 'climb2vec-frozen-stage2-v1',
      pooledAscensionistCount: 0,
    });
  });
});
