import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { hydrateFrozenGradeCoefficients } from '../frozen-coefficients';

void describe('hydrateFrozenGradeCoefficients', () => {
  void test('hydrates persisted rows from one immutable version', () => {
    const coefficients = hydrateFrozenGradeCoefficients([
      { coeff_version: 'v1', kind: 'echo_fraction', key: 'kilter', payload: { lambda: 0.85 } },
      {
        coeff_version: 'v1',
        kind: 'sigma_within',
        key: 'kilter',
        payload: { 'v0-2': 0.8, 'v3-5': 0.9, 'v6-8': 1, 'v9+': 1.1 },
      },
      {
        coeff_version: 'v1',
        kind: 'tau_squared',
        key: 'kilter',
        payload: { 'v0-2': 0.2, 'v3-5': 0.3, 'v6-8': 0.4, 'v9+': 0.5 },
      },
      {
        coeff_version: 'v1',
        kind: 'angle_offset',
        key: 'kilter',
        payload: { all: { 40: 0.2 }, 'v6-8': { 40: 0.3 } },
      },
      {
        coeff_version: 'v1',
        kind: 'board_offset',
        key: 'kilter',
        payload: { offset: -1.2, sd: 0.4, users: 50, looMaxDelta: 0.1 },
      },
      {
        coeff_version: 'v1',
        kind: 'rater_model',
        key: 'kilter',
        payload: {
          boardType: 'kilter',
          biases: {
            'user\u0000location': {
              bias: 0.2,
              shrinkage: 0.5,
              effectiveN: 10.5,
              rawVotes: 12,
              weightedResidual: 4.2,
            },
          },
          summary: { expressedVotes: 10.5, users: 4, locations: 1, topUserShare: 0.25 },
        },
      },
      {
        coeff_version: 'v1',
        kind: 'behavior_model',
        key: 'kilter',
        payload: {
          boardType: 'kilter',
          boardMean: 20,
          outcomeOffset: { flash: 0.5, attempt_4_plus: -0.4 },
          eligible: true,
          summary: {
            users: 100,
            outcomes: 500,
            topUserShare: 0.03,
            usedUsers: 95,
            usedOutcomes: 450,
            usedTopUserShare: 0.025,
          },
        },
      },
      {
        coeff_version: 'v1',
        kind: 'bridge_readiness',
        key: 'moonboard',
        payload: {
          boardType: 'moonboard',
          bridgeUsers: 0,
          requiredUsers: 20,
          minSendsPerBoard: 10,
          candidateOffset: null,
          looMaxDelta: null,
          publishable: false,
        },
      },
    ]);

    assert.ok(coefficients);
    assert.equal(coefficients.coeffVersion, 'v1');
    assert.equal(coefficients.echoFraction.kilter, 0.85);
    assert.equal(coefficients.boardOffset.kilter.offset, -1.2);
    assert.equal(coefficients.angleOffset.kilter.all?.[40], 0.2);
    assert.equal(coefficients.raterModel.kilter.biases['user\u0000location'].rawVotes, 12);
    assert.equal(coefficients.behaviorModel.kilter.outcomeOffset.flash, 0.5);
    assert.equal(coefficients.bridgeReadiness.moonboard.publishable, false);
  });

  void test('rejects rows from different coefficient versions', () => {
    assert.throws(
      () =>
        hydrateFrozenGradeCoefficients([
          { coeff_version: 'v1', kind: 'echo_fraction', key: 'kilter', payload: { lambda: 0.85 } },
          { coeff_version: 'v2', kind: 'echo_fraction', key: 'tension', payload: { lambda: 0.8 } },
        ]),
      /mixed coefficient-version/,
    );
  });

  void test('rejects unknown coefficient kinds instead of silently skipping them', () => {
    assert.throws(
      () =>
        hydrateFrozenGradeCoefficients([
          { coeff_version: 'v1', kind: 'future_coefficient', key: 'kilter', payload: {} },
        ]),
      /unknown coefficient kind/,
    );
  });

  void test('rejects malformed top-level and nested payloads before grade calculation', () => {
    assert.throws(
      () =>
        hydrateFrozenGradeCoefficients([
          { coeff_version: 'v1', kind: 'echo_fraction', key: 'kilter', payload: { lambad: 0.85 } },
        ]),
      /lambda must be a finite number/,
    );
    assert.throws(
      () =>
        hydrateFrozenGradeCoefficients([
          {
            coeff_version: 'v1',
            kind: 'rater_model',
            key: 'kilter',
            payload: {
              boardType: 'kilter',
              biases: {
                location: {
                  bias: 'wrong',
                  shrinkage: 0.5,
                  effectiveN: 10,
                  rawVotes: 10,
                  weightedResidual: 2,
                },
              },
              summary: { expressedVotes: 10, users: 1, locations: 1, topUserShare: 1 },
            },
          },
        ]),
      /bias must be a finite number/,
    );
  });

  void test('rejects ambiguous or unrecognized nested coefficient identities', () => {
    assert.throws(
      () =>
        hydrateFrozenGradeCoefficients([
          {
            coeff_version: 'v1',
            kind: 'behavior_model',
            key: 'kilter',
            payload: {
              boardType: 'tension',
              boardMean: 20,
              outcomeOffset: {},
              eligible: false,
              summary: {
                users: 0,
                outcomes: 0,
                topUserShare: 0,
                usedUsers: 0,
                usedOutcomes: 0,
                usedTopUserShare: 0,
              },
            },
          },
        ]),
      /payload boardType "tension" does not match its key/,
    );
    assert.throws(
      () =>
        hydrateFrozenGradeCoefficients([
          {
            coeff_version: 'v1',
            kind: 'angle_offset',
            key: 'kilter',
            payload: { typo: { 40: 0.2 } },
          },
        ]),
      /unknown angle band "typo"/,
    );
    assert.throws(
      () =>
        hydrateFrozenGradeCoefficients([
          {
            coeff_version: 'v1',
            kind: 'behavior_model',
            key: 'kilter',
            payload: {
              boardType: 'kilter',
              boardMean: 20,
              outcomeOffset: { unknown: 0.5 },
              eligible: false,
              summary: {
                users: 0,
                outcomes: 0,
                topUserShare: 0,
                usedUsers: 0,
                usedOutcomes: 0,
                usedTopUserShare: 0,
              },
            },
          },
        ]),
      /unknown behavior bucket "unknown"/,
    );
    const duplicate = { coeff_version: 'v1', kind: 'echo_fraction', key: 'kilter', payload: { lambda: 0.85 } };
    assert.throws(() => hydrateFrozenGradeCoefficients([duplicate, duplicate]), /duplicate kind\/key row/);
  });
});
