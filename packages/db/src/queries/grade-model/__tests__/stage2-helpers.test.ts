import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  buildBehaviorEvidence,
  buildBehaviorSampleSql,
  estimateBehaviorModels,
  behaviorOutcomeProbability,
  estimateBehaviorAbilities,
  estimateBehaviorDifficulty,
  type BehaviorSampleRow,
  type BehaviorObservation,
} from '../behavior';
import { estimateAnchorBridgeOffsets, estimatePairwiseBridgeEdges, type BoardBridgeSample } from '../bridges';
import {
  combineDeherdedSignals,
  deherdCrowdMean,
  evaluateDeherdedBenchmark,
  evaluateTensionBenchmarkHoldout,
  type TensionBenchmarkPrediction,
} from '../deherded';
import {
  buildRaterEvidence,
  buildRaterSampleSql,
  computeBiasAdjustedGrade,
  estimateRaterBiases,
  estimateRaterModels,
  raterOpinionWeight,
  stage2LeaveoutKey,
  type RaterBiasEstimate,
  type RaterOpinion,
  type RaterSampleRow,
} from '../raters';

const renderedSql = (query: SQL): string => new PgDialect().sqlToQuery(query).sql;

void describe('Stage 2 rater helpers', () => {
  void test('splits benchmark holdout rows for rater training versus prediction evidence', () => {
    const trainingQuery = renderedSql(buildRaterSampleSql({ excludeTensionBenchmarkHoldout: true }));
    const predictionQuery = renderedSql(buildRaterSampleSql({ excludeTensionBenchmarkHoldout: false }));

    assert.ok(trainingQuery.includes('md5(s.climb_uuid'));
    assert.ok(trainingQuery.includes('NOT'));
    assert.ok(!predictionQuery.includes('md5(s.climb_uuid'));
  });

  void test('uses physical fingerprint keys for Stage 2 leave-out where available', () => {
    const firstKey = stage2LeaveoutKey({
      board_type: 'kilter',
      climb_uuid: 'uuid-a',
      layout_id: 1,
      hold_fingerprint: 'same-problem',
      angle: 40,
    });
    const siblingKey = stage2LeaveoutKey({
      board_type: 'kilter',
      climb_uuid: 'uuid-b',
      layout_id: 1,
      hold_fingerprint: 'same-problem',
      angle: 40,
    });
    const otherAngleKey = stage2LeaveoutKey({
      board_type: 'kilter',
      climb_uuid: 'uuid-b',
      layout_id: 1,
      hold_fingerprint: 'same-problem',
      angle: 50,
    });

    assert.equal(firstKey, siblingKey);
    assert.notEqual(firstKey, otherAngleKey);
  });

  void test('does not subtract held-out benchmark rows from fitted rater bias', () => {
    const trainingRows: RaterSampleRow[] = Array.from({ length: 3 }, (_, rowIndex) => ({
      board_type: 'tension',
      user_id: 'hard-rater',
      climb_uuid: `train-${rowIndex}`,
      angle: 40,
      origin: 'native',
      difficulty: 30,
      display_difficulty: 20,
      difficulty_average: 20,
      gym_id: null,
      board_id: null,
    }));
    const models = estimateRaterModels(trainingRows);
    const evidence = buildRaterEvidence(
      [
        {
          board_type: 'tension',
          user_id: 'hard-rater',
          climb_uuid: 'held-out',
          angle: 40,
          origin: 'native',
          difficulty: 30,
          display_difficulty: 20,
          difficulty_average: 20,
          gym_id: null,
          board_id: null,
        },
      ],
      models,
      trainingRows,
    );

    const heldOutEvidence = evidence.get('tension\u0000held-out\u000040');
    assert.ok(heldOutEvidence);
    assert.equal(heldOutEvidence.raterMean, 29);
  });

  void test('down-weights synced display echoes but keeps native echoes as opt-in agreement', () => {
    const syncedEcho: RaterOpinion = {
      raterId: 'u1',
      difficulty: 20,
      referenceGrade: 21,
      displayDifficulty: 20,
      origin: 'aurora_pull',
    };
    const nativeEcho: RaterOpinion = { ...syncedEcho, origin: 'native' };

    assert.equal(raterOpinionWeight(syncedEcho), 0);
    assert.equal(raterOpinionWeight(nativeEcho), 1);
  });

  void test('estimates rater bias with zero-centered shrinkage and a conservative cap', () => {
    const opinions: RaterOpinion[] = Array.from({ length: 5 }, (_, opinionIndex) => ({
      raterId: 'hard-grader',
      difficulty: 24 + (opinionIndex % 2),
      referenceGrade: 20 + (opinionIndex % 2),
      displayDifficulty: 20,
      origin: 'native',
    }));

    const biases = estimateRaterBiases(opinions);
    const estimate = biases.get('hard-grader');
    assert.ok(estimate);
    assert.ok(estimate.bias > 0 && estimate.bias <= 1, `bias was ${estimate.bias}`);
    assert.equal(estimate.effectiveWeight, 5);
  });

  void test('computes a bias-adjusted climb grade from explicit opinions', () => {
    const biases = new Map<string, RaterBiasEstimate>([
      ['hard-grader', { raterId: 'hard-grader', bias: 2, effectiveWeight: 10, opinionCount: 10 }],
    ]);
    const estimate = computeBiasAdjustedGrade(
      [
        {
          raterId: 'hard-grader',
          difficulty: 22,
          referenceGrade: 20,
          displayDifficulty: 20,
          origin: 'native',
        },
        {
          raterId: 'neutral-grader',
          difficulty: 20,
          referenceGrade: 20,
          displayDifficulty: 20,
          origin: 'native',
        },
      ],
      biases,
    );

    assert.ok(estimate);
    assert.equal(estimate.grade, 20);
    assert.equal(estimate.meanBiasApplied, 1);
  });
});

void describe('Stage 2 behavior helpers', () => {
  void test('splits benchmark holdout rows for behavior training versus prediction evidence', () => {
    const trainingQuery = renderedSql(buildBehaviorSampleSql({ excludeTensionBenchmarkHoldout: true }));
    const predictionQuery = renderedSql(buildBehaviorSampleSql({ excludeTensionBenchmarkHoldout: false }));

    assert.ok(trainingQuery.includes('md5(s.climb_uuid'));
    assert.ok(trainingQuery.includes('NOT'));
    assert.ok(!predictionQuery.includes('md5(s.climb_uuid'));
  });

  void test('measures behavior eligibility on rows usable for offsets, not raw native coverage', () => {
    const samples: BehaviorSampleRow[] = [];
    for (let userIndex = 0; userIndex < 120; userIndex++) {
      for (let outcomeIndex = 0; outcomeIndex < 5; outcomeIndex++) {
        samples.push({
          board_type: 'kilter',
          user_id: `user-${userIndex}`,
          climb_uuid: `climb-${userIndex}-${outcomeIndex}`,
          angle: 40,
          status: 'send',
          attempt_count: 2,
          difficulty_average: 20,
          ascensionist_count: userIndex < 5 ? 20 : 1,
        });
      }
    }

    const model = estimateBehaviorModels(samples).kilter;
    assert.ok(model);
    assert.equal(model.summary.users, 120);
    assert.equal(model.summary.outcomes, 600);
    assert.equal(model.summary.usedUsers, 5);
    assert.equal(model.eligible, false);
  });

  void test('uses frozen behavior offsets and leaves target rows out of behavior user ability', () => {
    const trainingRows: BehaviorSampleRow[] = [];
    for (let userIndex = 0; userIndex < 11; userIndex++) {
      for (let outcomeIndex = 0; outcomeIndex < 3; outcomeIndex++) {
        trainingRows.push({
          board_type: 'kilter',
          user_id: `user-${userIndex}`,
          climb_uuid: `steady-${userIndex}-${outcomeIndex}`,
          angle: 40,
          status: 'send',
          attempt_count: 2,
          difficulty_average: 20,
          ascensionist_count: 20,
        });
      }
    }
    trainingRows.push({
      board_type: 'kilter',
      user_id: 'user-0',
      climb_uuid: 'target',
      angle: 40,
      status: 'send',
      attempt_count: 2,
      difficulty_average: 30,
      ascensionist_count: 20,
    });

    const evidence = buildBehaviorEvidence(
      [trainingRows[trainingRows.length - 1]],
      {
        kilter: {
          boardType: 'kilter',
          boardMean: 20,
          outcomeOffset: { send_2_3: 7 },
          eligible: true,
          summary: {
            users: 11,
            outcomes: 34,
            topUserShare: 4 / 34,
            usedUsers: 11,
            usedOutcomes: 34,
            usedTopUserShare: 4 / 34,
          },
        },
      },
      new Map(),
      trainingRows,
    );

    const targetEvidence = evidence.get('kilter\u0000target\u000040');
    assert.ok(targetEvidence);
    assert.ok(targetEvidence.behaviorMean !== null);
    assert.ok(Math.abs(targetEvidence.behaviorMean - 27) < 1e-9, `behavior mean was ${targetEvidence.behaviorMean}`);
  });

  void test('orders outcome probabilities from flash to repeated-send to attempt', () => {
    const flashProbability = behaviorOutcomeProbability('flash', 1);
    const secondGoSendProbability = behaviorOutcomeProbability('send', 2);
    const fifthGoSendProbability = behaviorOutcomeProbability('send', 5);
    const attemptProbability = behaviorOutcomeProbability('attempt', 1);

    assert.ok(flashProbability > secondGoSendProbability);
    assert.ok(secondGoSendProbability > fifthGoSendProbability);
    assert.ok(fifthGoSendProbability > attemptProbability);
  });

  void test('fits higher ability for flashes than repeated failed attempts on the same references', () => {
    const flashRows: BehaviorObservation[] = Array.from({ length: 3 }, () => ({
      raterId: 'flash-user',
      status: 'flash',
      attemptCount: 1,
      referenceGrade: 20,
    }));
    const attemptRows: BehaviorObservation[] = Array.from({ length: 6 }, () => ({
      raterId: 'attempt-user',
      status: 'attempt',
      attemptCount: 1,
      referenceGrade: 20,
    }));

    const abilities = estimateBehaviorAbilities([...flashRows, ...attemptRows]);
    const flashAbility = abilities.get('flash-user');
    const attemptAbility = abilities.get('attempt-user');
    assert.ok(flashAbility);
    assert.ok(attemptAbility);
    assert.ok(flashAbility.ability > attemptAbility.ability);
  });

  void test('infers a harder climb from failed attempts than from flashes by equal-ability users', () => {
    const abilities = new Map([
      ['flash-user', { raterId: 'flash-user', ability: 22, effectiveWeight: 10, observationCount: 10 }],
      ['attempt-user', { raterId: 'attempt-user', ability: 22, effectiveWeight: 10, observationCount: 10 }],
    ]);

    const flashed = estimateBehaviorDifficulty(
      [{ raterId: 'flash-user', status: 'flash', attemptCount: 1, referenceGrade: null }],
      abilities,
    );
    const attempted = estimateBehaviorDifficulty(
      [{ raterId: 'attempt-user', status: 'attempt', attemptCount: 1, referenceGrade: null }],
      abilities,
    );

    assert.ok(flashed);
    assert.ok(attempted);
    assert.ok(attempted.grade > flashed.grade);
  });
});

void describe('Stage 2 bridge helpers', () => {
  void test('estimates pairwise board offsets with the expected sign', () => {
    const samples: BoardBridgeSample[] = Array.from({ length: 5 }, (_, userIndex) => ({
      userId: `user-${userIndex}`,
      boardType: 'kilter',
      grade: 20,
    })).concat(
      Array.from({ length: 5 }, (_, userIndex) => ({
        userId: `user-${userIndex}`,
        boardType: 'tension',
        grade: 18.8,
      })),
    );

    const edges = estimatePairwiseBridgeEdges(samples, { minSharedUsers: 5 });
    assert.equal(edges.length, 1);
    assert.equal(edges[0].fromBoard, 'kilter');
    assert.equal(edges[0].toBoard, 'tension');
    assert.ok(Math.abs(edges[0].offset - -1.2) < 1e-9);
  });

  void test('returns anchor-scale offsets and withholds unstable bridges', () => {
    const stableSamples: BoardBridgeSample[] = Array.from({ length: 5 }, (_, userIndex) => ({
      userId: `stable-${userIndex}`,
      boardType: 'kilter',
      grade: 20,
    })).concat(
      Array.from({ length: 5 }, (_, userIndex) => ({
        userId: `stable-${userIndex}`,
        boardType: 'tension',
        grade: 18.8,
      })),
    );
    const stable = estimateAnchorBridgeOffsets(stableSamples, 'tension', { minSharedUsers: 5 });
    assert.ok(stable.offsets.kilter);
    assert.ok(Math.abs(stable.offsets.kilter.offset - -1.2) < 1e-9);
    assert.deepEqual(stable.withheldBoards, []);

    const unstableSamples: BoardBridgeSample[] = [
      { userId: 'u1', boardType: 'kilter', grade: 20 },
      { userId: 'u1', boardType: 'tension', grade: 20 },
      { userId: 'u2', boardType: 'kilter', grade: 20 },
      { userId: 'u2', boardType: 'tension', grade: 30 },
      { userId: 'u3', boardType: 'kilter', grade: 20 },
      { userId: 'u3', boardType: 'tension', grade: 30 },
    ];
    const unstable = estimateAnchorBridgeOffsets(unstableSamples, 'tension', {
      minSharedUsers: 3,
      maxLooDelta: 0.5,
    });
    assert.equal(unstable.offsets.kilter, undefined);
    assert.deepEqual(unstable.withheldBoards, ['kilter']);
  });
});

void describe('Stage 2 de-herded helpers', () => {
  void test('de-attenuates an echoed crowd mean and records the moved delta', () => {
    const result = deherdCrowdMean({
      observedMean: 20.5,
      displayGrade: 20,
      echoFraction: 0.5,
      independentWeight: 10,
    });

    assert.equal(result.eligible, true);
    assert.equal(result.capped, false);
    assert.ok(result.grade !== null && Math.abs(result.grade - 21) < 1e-9);
    assert.equal(result.rawDeltaFromDisplay, 0.5);
    assert.equal(result.deherdedDeltaFromDisplay, 1);
  });

  void test('caps aggressive de-herding and leaves thin rows unchanged', () => {
    const capped = deherdCrowdMean({
      observedMean: 21,
      displayGrade: 20,
      echoFraction: 0.9,
      independentWeight: 10,
    });
    assert.equal(capped.capped, true);
    assert.equal(capped.grade, 21.75);

    const thin = deherdCrowdMean({
      observedMean: 21,
      displayGrade: 20,
      echoFraction: 0.9,
      independentWeight: 1,
    });
    assert.equal(thin.eligible, false);
    assert.equal(thin.reason, 'thin_evidence');
    assert.equal(thin.grade, 21);
  });

  void test('keeps the observed-mean cap authoritative when display and observed caps do not overlap', () => {
    const capped = deherdCrowdMean({
      observedMean: 25,
      displayGrade: 20,
      echoFraction: 0.5,
      independentWeight: 10,
    });

    assert.equal(capped.capped, true);
    assert.equal(capped.grade, 25.75);
    assert.ok(capped.grade !== null && Math.abs(capped.grade - 25) <= 0.75);
  });

  void test('combines grade signals by precision or explicit weight', () => {
    const blend = combineDeherdedSignals([
      { name: 'crowd', grade: 20, standardError: 1 },
      { name: 'behavior', grade: 22, standardError: 0.5 },
    ]);

    assert.ok(blend);
    assert.ok(Math.abs(blend.grade - 21.6) < 1e-9);
    assert.equal(blend.signalCount, 2);
  });

  void test('scores de-herded benchmark evaluation as no-regression', () => {
    const summary = evaluateDeherdedBenchmark([
      { benchmarkGrade: 20, rawGrade: 21, deherdedGrade: 20.5 },
      { benchmarkGrade: 22, rawGrade: 21, deherdedGrade: 21.5 },
    ]);

    assert.equal(summary.rows, 2);
    assert.equal(summary.rawMae, 1);
    assert.equal(summary.deherdedMae, 0.5);
    assert.equal(summary.improvement, 0.5);
    assert.equal(summary.passedNoRegression, true);
  });

  void test('counts missing benchmark intervals as calibration failures', () => {
    const predictions: TensionBenchmarkPrediction[] = Array.from({ length: 120 }, (_, rowIndex) => ({
      climbUuid: `benchmark-${rowIndex}`,
      angle: 40,
      displayDifficulty: 20,
      benchmarkDifficulty: 20,
      ascensionistCount: 100,
      stage1Grade: 20,
      stage1Low: 19,
      stage1High: 21,
      stage2Grade: 20,
      stage2Low: rowIndex === 0 ? null : 19,
      stage2High: rowIndex === 0 ? null : 21,
    }));

    const calibrationGate = evaluateTensionBenchmarkHoldout(predictions).find(
      (gate) => gate.gate === 'deherded_tension_calibration',
    );
    assert.ok(calibrationGate);
    assert.equal(calibrationGate.passed, false);
    assert.equal(calibrationGate.metrics.missingIntervalRows, 1);
  });
});
