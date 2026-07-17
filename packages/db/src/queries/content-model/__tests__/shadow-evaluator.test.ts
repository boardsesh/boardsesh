import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { BacktestSampleRow, GradeCoefficients } from '../../grade-model';
import {
  CONTENT_SIGNAL_MAX_EFFECTIVE_N,
  CONTENT_SIGNAL_MAX_MOVE,
  SHADOW_MIN_ELIGIBLE_COVERAGE,
  applyContentSignalToObservation,
  contentCandidateKey,
  contentSignalEffectiveWeight,
  evaluateContentPriorShadow,
  evaluateShadowCoverage,
  evaluateShadowFingerprintConsistency,
  evaluateShadowNoShock,
  parseContentPriorArtifactRecord,
  type ContentPriorCandidate,
} from '../shadow-evaluator';

const coefficients: GradeCoefficients = {
  coeffVersion: 'shadow-test',
  echoFraction: { kilter: 0.5, tension: 0.5 },
  sigmaWithin: {},
  tauSquared: {},
  angleOffset: {},
  boardOffset: {},
  raterModel: {},
  behaviorModel: {},
  bridgeReadiness: {},
};

function backtestRow(index: number, hasSibling: boolean, boardType = 'kilter'): BacktestSampleRow {
  return {
    board_type: boardType,
    climb_uuid: `climb-${index}`,
    angle: 40,
    snap_avg: 20,
    snap_display: 20,
    snap_count: 2,
    final_avg: 20,
    sibling_states: hasSibling
      ? [
          {
            angle: 50,
            difficulty_average: 20,
            display_difficulty: 20,
            ascensionist_count: 2,
          },
        ]
      : [],
  };
}

void describe('content-prior shadow blend', () => {
  void test('caps both the content movement and effective weight', () => {
    assert.equal(contentSignalEffectiveWeight(0.1), CONTENT_SIGNAL_MAX_EFFECTIVE_N);
    const blended = applyContentSignalToObservation(
      {
        boardType: 'kilter',
        climbUuid: 'climb',
        angle: 40,
        difficultyAverage: 20,
        displayDifficulty: 20,
        ascensionistCount: 2,
      },
      {
        boardType: 'kilter',
        climbUuid: 'climb',
        angle: 40,
        contentPrior: 30,
        contentSd: 0.1,
      },
      coefficients,
    );

    // n_eff=1 and content weight=2, with content clamped to 20.5.
    assert.ok(blended.difficultyAverage !== null);
    assert.ok(Math.abs(blended.difficultyAverage - (20 + (2 * CONTENT_SIGNAL_MAX_MOVE) / 3)) < 1e-12);
  });

  void test('does not manufacture crowd evidence for a no-crowd sibling', () => {
    const sibling = {
      boardType: 'kilter',
      climbUuid: 'climb',
      angle: 50,
      difficultyAverage: null,
      displayDifficulty: 20,
      ascensionistCount: 0,
    };
    const result = applyContentSignalToObservation(
      sibling,
      {
        boardType: 'kilter',
        climbUuid: 'climb',
        angle: 50,
        contentPrior: 21,
        contentSd: 2,
      },
      coefficients,
      true,
    );
    assert.deepEqual(result, sibling);
  });

  void test('ignores a candidate with non-positive uncertainty', () => {
    const observation = {
      boardType: 'kilter',
      climbUuid: 'climb',
      angle: 40,
      difficultyAverage: 20,
      displayDifficulty: 20,
      ascensionistCount: 2,
    };
    for (const contentSd of [0, -1]) {
      assert.deepEqual(
        applyContentSignalToObservation(
          observation,
          {
            boardType: 'kilter',
            climbUuid: 'climb',
            angle: 40,
            contentPrior: 30,
            contentSd,
          },
          coefficients,
        ),
        observation,
      );
    }
  });

  void test('requires 100 matched rows in each overall gate and applies segment tolerances', () => {
    const rows = [
      ...Array.from({ length: 100 }, (_, index) => backtestRow(index, true, index < 50 ? 'kilter' : 'tension')),
      ...Array.from({ length: 100 }, (_, index) => backtestRow(index + 100, false, index < 50 ? 'kilter' : 'tension')),
    ];
    const candidates: ContentPriorCandidate[] = rows.map((row, index) => ({
      boardType: row.board_type,
      climbUuid: row.climb_uuid,
      angle: row.angle,
      contentPrior: 20,
      contentSd: 1,
      ascents: 50,
      difficultyAverage: 20,
      displayDifficulty: 20,
      physicalKey: `${row.board_type}-physical-${Math.floor(index / 2)}`,
    }));
    const baseline = {
      tailGate: { gate: 'tail_backtest', passed: true, detail: 'test', metrics: {} },
      headGate: { gate: 'head_holdout', passed: true, detail: 'test', metrics: {} },
      report: {
        multiAngle: { n: 100, rawMae: 0, shrunkMae: 0 },
        singleAngle: { n: 100, rawMae: 0, shrunkMae: 0 },
      },
    };

    const report = evaluateContentPriorShadow(rows, candidates, coefficients, baseline);
    assert.equal(report.passed, true);
    assert.equal(report.matchedBacktestRows, 200);
    assert.equal(report.coverage.ratio, 1);
    assert.equal(report.tail.n, 100);
    assert.equal(report.head.n, 100);
    assert.ok(report.segments.every((segment) => segment.passed));
    assert.deepEqual(new Set(report.segments.map((segment) => segment.dimension)), new Set(['angle', 'grade_band']));
  });

  void test('blocks when supported-row prediction coverage falls below 95 percent', () => {
    const rows = [
      ...Array.from({ length: 110 }, (_, index) => backtestRow(index, true)),
      ...Array.from({ length: 110 }, (_, index) => backtestRow(index + 110, false)),
    ];
    const candidates: ContentPriorCandidate[] = rows
      .filter((_, index) => !((index >= 104 && index < 110) || index >= 214))
      .map((row) => ({
        boardType: row.board_type,
        climbUuid: row.climb_uuid,
        angle: row.angle,
        contentPrior: 20,
        contentSd: 1,
      }));
    const baseline = {
      tailGate: { gate: 'tail_backtest', passed: true, detail: 'test', metrics: {} },
      headGate: { gate: 'head_holdout', passed: true, detail: 'test', metrics: {} },
      report: {
        multiAngle: { n: 110, rawMae: 0, shrunkMae: 0 },
        singleAngle: { n: 110, rawMae: 0, shrunkMae: 0 },
      },
    };

    const report = evaluateContentPriorShadow(rows, candidates, coefficients, baseline);
    assert.ok(report.coverage.ratio < SHADOW_MIN_ELIGIBLE_COVERAGE);
    assert.equal(report.coverage.eligible, 220);
    assert.equal(report.coverage.matched, 208);
    assert.equal(report.tail.n, 104);
    assert.equal(report.head.n, 104);
    assert.equal(report.coverage.passed, false);
    assert.equal(report.passed, false);
  });

  void test('requires coverage on each supported board, not only in aggregate', () => {
    const kilterRows = Array.from({ length: 200 }, (_, index) => backtestRow(index, index < 100));
    const tensionRows = Array.from({ length: 100 }, (_, index) => ({
      ...backtestRow(index + 200, index < 50),
      board_type: 'tension',
    }));
    const rows = [...kilterRows, ...tensionRows];
    const candidates = new Map(
      rows
        .filter((row, index) => row.board_type === 'kilter' || index < 294)
        .map(
          (row) =>
            [
              contentCandidateKey(row.board_type, row.climb_uuid, row.angle),
              {
                boardType: row.board_type,
                climbUuid: row.climb_uuid,
                angle: row.angle,
                contentPrior: 20,
                contentSd: 1,
              },
            ] as const,
        ),
    );

    const coverage = evaluateShadowCoverage(rows, candidates);
    assert.ok(coverage.ratio > SHADOW_MIN_ELIGIBLE_COVERAGE);
    assert.equal(coverage.byBoard.kilter?.ratio, 1);
    assert.equal(coverage.byBoard.kilter?.passed, true);
    assert.equal(coverage.byBoard.tension?.ratio, 0.94);
    assert.equal(coverage.byBoard.tension?.passed, false);
    assert.equal(coverage.passed, false);
  });

  void test('fails coverage when either required board has no eligible rows', () => {
    const row = backtestRow(1, false);
    const coverage = evaluateShadowCoverage(
      [row],
      new Map([
        [
          contentCandidateKey(row.board_type, row.climb_uuid, row.angle),
          {
            boardType: row.board_type,
            climbUuid: row.climb_uuid,
            angle: row.angle,
            contentPrior: 20,
            contentSd: 1,
          },
        ],
      ]),
    );

    assert.equal(coverage.byBoard.kilter?.passed, true);
    assert.equal(coverage.byBoard.tension?.eligible, 0);
    assert.equal(coverage.byBoard.tension?.passed, false);
    assert.equal(coverage.passed, false);
  });
});

void describe('content-prior direct invariants', () => {
  void test('parses explicit unsupported tombstones without creating a signal', () => {
    const parsed = parseContentPriorArtifactRecord(
      {
        boardType: 'kilter',
        climbUuid: 'unsupported',
        angle: 40,
        contentPrior: null,
        contentSd: null,
        embedding: null,
        modelVersion: 'climb2vec-relational-morphology-v1',
        supported: false,
      },
      1,
    );

    assert.equal(parsed.key, contentCandidateKey('kilter', 'unsupported', 40));
    assert.equal(parsed.candidate, null);
  });

  void test('rejects a shadow artifact from a different model version', () => {
    assert.throws(
      () =>
        parseContentPriorArtifactRecord(
          {
            boardType: 'kilter',
            climbUuid: 'wrong-model',
            angle: 40,
            contentPrior: null,
            contentSd: null,
            embedding: null,
            modelVersion: 'climb2vec-v1',
            supported: false,
          },
          2,
        ),
      /modelVersion=climb2vec-v1; expected climb2vec-relational-morphology-v1/,
    );
  });

  void test('checks no-shock on established candidate rows', () => {
    const result = evaluateShadowNoShock(
      [
        {
          boardType: 'kilter',
          climbUuid: 'established',
          angle: 40,
          contentPrior: 30,
          contentSd: 0.1,
          ascents: 50,
          difficultyAverage: 20,
          displayDifficulty: 20,
        },
      ],
      coefficients,
    );
    assert.equal(result.checked, 1);
    assert.equal(result.violations, 0);
    assert.equal(result.passed, true);
  });

  void test('does not pass no-shock vacuously', () => {
    const result = evaluateShadowNoShock([], coefficients);
    assert.equal(result.checked, 0);
    assert.equal(result.passed, false);
  });

  void test('does not pass no-shock when candidates exist but none meet the ascent threshold', () => {
    const result = evaluateShadowNoShock(
      [
        {
          boardType: 'kilter',
          climbUuid: 'too-cold',
          angle: 40,
          contentPrior: 20,
          contentSd: 1,
          ascents: 0,
          difficultyAverage: 20,
          displayDifficulty: 20,
        },
      ],
      coefficients,
    );
    assert.equal(result.checked, 0);
    assert.equal(result.passed, false);
  });

  void test('blocks when more than one percent of duplicate groups spread over one step', () => {
    const result = evaluateShadowFingerprintConsistency([
      {
        boardType: 'kilter',
        climbUuid: 'a',
        angle: 40,
        contentPrior: 20,
        contentSd: 1,
        layoutId: 1,
        fingerprint: 'same',
      },
      {
        boardType: 'kilter',
        climbUuid: 'b',
        angle: 40,
        contentPrior: 22,
        contentSd: 1,
        layoutId: 1,
        fingerprint: 'same',
      },
    ]);
    assert.equal(result.groups, 1);
    assert.equal(result.violations, 1);
    assert.equal(result.passed, false);
  });

  void test('groups mirror-canonical aliases by physical key when fingerprints are absent', () => {
    const result = evaluateShadowFingerprintConsistency([
      {
        boardType: 'tension',
        climbUuid: 'original',
        angle: 40,
        contentPrior: 20,
        contentSd: 1,
        physicalKey: 'tension-physical-problem',
      },
      {
        boardType: 'tension',
        climbUuid: 'mirror',
        angle: 40,
        contentPrior: 20.5,
        contentSd: 1,
        physicalKey: 'tension-physical-problem',
      },
    ]);
    assert.equal(result.groups, 1);
    assert.equal(result.violations, 0);
    assert.equal(result.passed, true);
  });

  void test('does not pass fingerprint consistency without an alias group', () => {
    const result = evaluateShadowFingerprintConsistency([]);
    assert.equal(result.groups, 0);
    assert.equal(result.passed, false);
  });
});
