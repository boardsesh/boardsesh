import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  assignTier,
  computePosteriorGrade,
  crossAnglePrior,
  effectiveN,
  gradeBandForDifficulty,
  shouldPublish,
} from '../blend';
import {
  buildEchoRatesSql,
  buildSigmaWithinSql,
  estimateAngleSurface,
  estimateBoardOffsets,
  estimateEchoFractions,
  estimateSigmaWithin,
  estimateTauSquared,
  type AngleSurfaceRow,
  type BoardOffsetSampleRow,
  type TauSampleRow,
} from '../coefficients';
import {
  evaluateBacktest,
  evaluateFingerprintGate,
  evaluateResidualGapGate,
  evaluateZeroEvidenceProjection,
  type BacktestSampleRow,
} from '../gates';
import {
  anchorAngles,
  boardSupportsCrossAngleEstimate,
  buildProjectedAngleObservations,
  foldCoefficientRows,
} from '../cross-angle-estimate';
import { applyIsotonicAngleConstraint, type AngleGradeRow } from '../isotonic';
import {
  applyDisplayDeltaHygiene,
  createDisplayDeltaHygieneStats,
  evaluateDisplayDeltaHygiene,
  mergeDisplayDeltaHygieneStats,
  recordDisplayDeltaHygiene,
} from '../hygiene';
import { CONFIDENCE, DEFAULT_ECHO_FRACTION } from '../constants';
import type { ClimbAngleObservation, GradeCoefficients, PosteriorGrade } from '../types';

function makeCoefficients(overrides: Partial<GradeCoefficients> = {}): GradeCoefficients {
  return {
    coeffVersion: 'test',
    echoFraction: { kilter: 0.8, tension: 0.8 },
    sigmaWithin: {
      kilter: { 'v0-2': 0.8, 'v3-5': 0.8, 'v6-8': 0.8, 'v9+': 0.8 },
    },
    tauSquared: {
      kilter: { 'v0-2': 0.25, 'v3-5': 0.25, 'v6-8': 0.25, 'v9+': 0.25 },
    },
    angleOffset: {
      kilter: {
        all: { 20: -1.0, 40: 0.0, 50: 1.0 },
      },
    },
    boardOffset: {
      kilter: { offset: -1.2, sd: 0.4, users: 50, looMaxDelta: 0.1 },
      tension: { offset: 0, sd: 0, users: 0, looMaxDelta: 0 },
    },
    raterModel: {},
    behaviorModel: {},
    bridgeReadiness: {},
    ...overrides,
  };
}

function observation(partial: Partial<ClimbAngleObservation>): ClimbAngleObservation {
  return {
    boardType: 'kilter',
    climbUuid: 'climb-1',
    angle: 40,
    difficultyAverage: null,
    displayDifficulty: null,
    ascensionistCount: 0,
    ...partial,
  };
}

function posterior(partial: Partial<PosteriorGrade>): PosteriorGrade {
  return {
    localGrade: 20,
    universalGrade: 19,
    gradeLow: 18.5,
    gradeHigh: 19.5,
    confidence: CONFIDENCE.confirmed,
    postSd: 0.25,
    ...partial,
  };
}

void describe('gradeBandForDifficulty', () => {
  void test('maps band edges', () => {
    assert.equal(gradeBandForDifficulty(15), 'v0-2');
    assert.equal(gradeBandForDifficulty(16), 'v3-5');
    assert.equal(gradeBandForDifficulty(20), 'v3-5');
    assert.equal(gradeBandForDifficulty(21), 'v6-8');
    assert.equal(gradeBandForDifficulty(25), 'v9+');
    assert.equal(gradeBandForDifficulty(null), 'v3-5');
  });
});

void describe('effectiveN', () => {
  void test('discounts by echo fraction with floor of 1', () => {
    assert.ok(Math.abs(effectiveN(100, 0.8) - 20) < 1e-9);
    assert.equal(effectiveN(1, 0.8), 1);
    assert.equal(effectiveN(0, 0.8), 0);
  });
});

void describe('crossAnglePrior', () => {
  void test('transports sibling means through the angle surface', () => {
    const coefficients = makeCoefficients();
    // Sibling at 20° reads 18.0; surface says 20° sits −1 from climb mean and
    // 50° sits +1 → prediction for 50° is 18 − (−1) + 1 = 20.
    const target = observation({ angle: 50, displayDifficulty: 20 });
    const sibling = observation({ angle: 20, difficultyAverage: 18, displayDifficulty: 18, ascensionistCount: 100 });
    const prior = crossAnglePrior(target, [sibling], coefficients);
    assert.ok(prior !== null);
    assert.ok(Math.abs(prior - 20) < 1e-9);
  });

  void test('weights siblings by effective n and ignores the target angle itself', () => {
    const coefficients = makeCoefficients();
    const target = observation({ angle: 50, displayDifficulty: 20 });
    const strong = observation({ angle: 20, difficultyAverage: 18, ascensionistCount: 1000 });
    const weak = observation({ angle: 40, difficultyAverage: 25, ascensionistCount: 1 });
    const self = observation({ angle: 50, difficultyAverage: 99, ascensionistCount: 1000 });
    const prior = crossAnglePrior(target, [strong, weak, self], coefficients);
    assert.ok(prior !== null);
    // Strong sibling → reference 19; weak sibling → reference 25; heavily tilted to 19+1=20.
    assert.ok(prior > 19.9 && prior < 20.2, `prior was ${prior}`);
  });

  void test('returns null with no usable siblings', () => {
    const coefficients = makeCoefficients();
    assert.equal(crossAnglePrior(observation({ angle: 40 }), [], coefficients), null);
  });
});

void describe('computePosteriorGrade', () => {
  void test('regime 1: blends crowd mean with cross-angle prior', () => {
    const coefficients = makeCoefficients();
    const target = observation({
      angle: 50,
      difficultyAverage: 22,
      displayDifficulty: 22,
      ascensionistCount: 5,
    });
    const sibling = observation({ angle: 20, difficultyAverage: 18, displayDifficulty: 18, ascensionistCount: 1000 });
    const posterior = computePosteriorGrade(target, [sibling], coefficients);
    assert.ok(posterior.localGrade !== null);
    // Prior says 20, observation says 22 with n_eff=1 → pulled well toward 20.
    assert.ok(posterior.localGrade > 20 && posterior.localGrade < 22, `got ${posterior.localGrade}`);
    assert.ok(posterior.postSd !== null && posterior.postSd < 0.8);
    assert.equal(posterior.confidence, CONFIDENCE.provisional);
  });

  void test('regime 2: single-angle crowd mean stands with honest SE, no fake shrink to display', () => {
    const coefficients = makeCoefficients();
    const target = observation({
      angle: 40,
      difficultyAverage: 21.4,
      displayDifficulty: 21,
      ascensionistCount: 100,
    });
    const posterior = computePosteriorGrade(target, [], coefficients);
    assert.equal(posterior.localGrade, 21.4);
    // se = 0.8/sqrt(20) ≈ 0.179
    assert.ok(posterior.postSd !== null && Math.abs(posterior.postSd - 0.8 / Math.sqrt(20)) < 1e-9);
    assert.equal(posterior.confidence, CONFIDENCE.confirmed);
  });

  void test('regime 3: display-only pass-through has no CI and is setter_only', () => {
    const coefficients = makeCoefficients();
    const target = observation({ angle: 40, displayDifficulty: 18, ascensionistCount: 0 });
    const posterior = computePosteriorGrade(target, [], coefficients);
    assert.equal(posterior.localGrade, 18);
    assert.equal(posterior.postSd, null);
    assert.equal(posterior.gradeLow, null);
    assert.equal(posterior.confidence, CONFIDENCE.setterOnly);
  });

  void test('thin siblings carry their own sampling error — weak pull', () => {
    const coefficients = makeCoefficients();
    const target = observation({
      angle: 50,
      difficultyAverage: 22,
      displayDifficulty: 22,
      ascensionistCount: 10,
    });
    // Sibling with a single ascent: prior variance ≈ τ² + σ²/1 ≈ 0.89 — the
    // prior must not dominate the way a 1000-ascent sibling would.
    const thinSibling = observation({ angle: 20, difficultyAverage: 17, displayDifficulty: 17, ascensionistCount: 1 });
    const posterior = computePosteriorGrade(target, [thinSibling], coefficients);
    assert.ok(posterior.localGrade !== null && posterior.localGrade > 21, `pulled too far: ${posterior.localGrade}`);
  });

  void test('established crowd is never moved more than the no-shock bound', () => {
    const coefficients = makeCoefficients();
    const target = observation({
      angle: 50,
      difficultyAverage: 20,
      displayDifficulty: 20,
      ascensionistCount: 60,
    });
    // Pathological sibling evidence 5 grades away with massive weight.
    const sibling = observation({ angle: 20, difficultyAverage: 14, displayDifficulty: 14, ascensionistCount: 100000 });
    const posterior = computePosteriorGrade(target, [sibling], coefficients);
    assert.ok(posterior.localGrade !== null && posterior.localGrade >= 19, `moved past clamp: ${posterior.localGrade}`);
  });

  void test('nothing at all → null grade, setter_only', () => {
    const posterior = computePosteriorGrade(observation({}), [], makeCoefficients());
    assert.equal(posterior.localGrade, null);
    assert.equal(posterior.confidence, CONFIDENCE.setterOnly);
  });

  void test('universal grade only for boards with a fitted offset', () => {
    const coefficients = makeCoefficients();
    const kilter = computePosteriorGrade(
      observation({ difficultyAverage: 20, displayDifficulty: 20, ascensionistCount: 50 }),
      [],
      coefficients,
    );
    assert.ok(kilter.universalGrade !== null && Math.abs(kilter.universalGrade - 18.8) < 1e-9);

    const grasshopper = computePosteriorGrade(
      observation({ boardType: 'grasshopper', difficultyAverage: 20, displayDifficulty: 20, ascensionistCount: 50 }),
      [],
      coefficients,
    );
    assert.equal(grasshopper.universalGrade, null);
    assert.ok(grasshopper.localGrade !== null);
  });
});

void describe('assignTier', () => {
  void test('tier boundaries', () => {
    assert.equal(assignTier(2, 0.1), CONFIDENCE.setterOnly);
    assert.equal(assignTier(3, 0.1), CONFIDENCE.provisional);
    assert.equal(assignTier(19, 0.1), CONFIDENCE.provisional);
    assert.equal(assignTier(20, 0.1), CONFIDENCE.confirmed);
    assert.equal(assignTier(20, 0.5), CONFIDENCE.provisional);
    assert.equal(assignTier(20, null), CONFIDENCE.provisional);
  });
});

void describe('shouldPublish', () => {
  const next = {
    localGrade: 20,
    universalGrade: 18.8,
    gradeLow: 18,
    gradeHigh: 19.6,
    confidence: CONFIDENCE.confirmed,
    postSd: 0.2,
  };
  void test('always publishes a first row', () => {
    assert.equal(shouldPublish(undefined, next), true);
  });
  void test('suppresses sub-threshold movement', () => {
    assert.equal(
      shouldPublish({ localGrade: 20.1, universalGrade: 18.9, confidence: CONFIDENCE.confirmed }, next),
      false,
    );
  });
  void test('publishes on tier change or big move', () => {
    assert.equal(
      shouldPublish({ localGrade: 20.1, universalGrade: 18.9, confidence: CONFIDENCE.provisional }, next),
      true,
    );
    assert.equal(shouldPublish({ localGrade: 21, universalGrade: 19.5, confidence: CONFIDENCE.confirmed }, next), true);
  });
});

void describe('applyDisplayDeltaHygiene', () => {
  void test('downgrades confirmed Kilter rows outside the rounded universal-display band', () => {
    const high = applyDisplayDeltaHygiene({
      boardType: 'kilter',
      displayDifficulty: 10,
      posterior: posterior({ universalGrade: 14 }),
    });
    assert.equal(high.downgraded, true);
    assert.equal(high.checked, true);
    assert.equal(high.skippedMissingUniversal, false);
    assert.equal(high.roundedDelta, 4);
    assert.equal(high.posterior.confidence, CONFIDENCE.provisional);
    assert.equal(high.posterior.universalGrade, 14);

    const low = applyDisplayDeltaHygiene({
      boardType: 'kilter',
      displayDifficulty: 20,
      posterior: posterior({ universalGrade: 16 }),
    });
    assert.equal(low.downgraded, true);
    assert.equal(low.checked, true);
    assert.equal(low.roundedDelta, -4);
    assert.equal(low.posterior.confidence, CONFIDENCE.provisional);
  });

  void test('keeps boundary deltas confirmed', () => {
    const lowerBoundary = applyDisplayDeltaHygiene({
      boardType: 'kilter',
      displayDifficulty: 20,
      posterior: posterior({ universalGrade: 17 }),
    });
    const upperBoundary = applyDisplayDeltaHygiene({
      boardType: 'kilter',
      displayDifficulty: 20,
      posterior: posterior({ universalGrade: 21 }),
    });
    assert.equal(lowerBoundary.downgraded, false);
    assert.equal(lowerBoundary.checked, true);
    assert.equal(lowerBoundary.roundedDelta, -3);
    assert.equal(lowerBoundary.posterior.confidence, CONFIDENCE.confirmed);
    assert.equal(upperBoundary.downgraded, false);
    assert.equal(upperBoundary.checked, true);
    assert.equal(upperBoundary.roundedDelta, 1);
    assert.equal(upperBoundary.posterior.confidence, CONFIDENCE.confirmed);
  });

  void test('leaves non-Kilter, non-confirmed, and incomplete rows unchanged', () => {
    const nonKilter = applyDisplayDeltaHygiene({
      boardType: 'tension',
      displayDifficulty: 10,
      posterior: posterior({ universalGrade: 14 }),
    });
    const provisional = applyDisplayDeltaHygiene({
      boardType: 'kilter',
      displayDifficulty: 10,
      posterior: posterior({ confidence: CONFIDENCE.provisional, universalGrade: 14 }),
    });
    const noUniversal = applyDisplayDeltaHygiene({
      boardType: 'kilter',
      displayDifficulty: 10,
      posterior: posterior({ universalGrade: null }),
    });
    const noDisplay = applyDisplayDeltaHygiene({
      boardType: 'kilter',
      displayDifficulty: null,
      posterior: posterior({ universalGrade: 14 }),
    });
    assert.equal(nonKilter.downgraded, false);
    assert.equal(provisional.downgraded, false);
    assert.equal(noUniversal.downgraded, false);
    assert.equal(noUniversal.checked, false);
    assert.equal(noUniversal.skippedMissingUniversal, true);
    assert.equal(noDisplay.downgraded, false);
    assert.equal(noDisplay.skippedMissingUniversal, false);
  });

  void test('records report-only hygiene gate metrics', () => {
    const left = createDisplayDeltaHygieneStats();
    const right = createDisplayDeltaHygieneStats();
    recordDisplayDeltaHygiene(
      left,
      applyDisplayDeltaHygiene({
        boardType: 'kilter',
        displayDifficulty: 10,
        posterior: posterior({ universalGrade: 14 }),
      }),
    );
    recordDisplayDeltaHygiene(
      right,
      applyDisplayDeltaHygiene({
        boardType: 'kilter',
        displayDifficulty: 20,
        posterior: posterior({ universalGrade: 16 }),
      }),
    );
    mergeDisplayDeltaHygieneStats(left, right);
    const gate = evaluateDisplayDeltaHygiene(left);
    assert.equal(gate.passed, true);
    assert.equal(gate.metrics.checkedRows, 2);
    assert.equal(gate.metrics.skippedMissingUniversalRows, 0);
    assert.equal(gate.metrics.downgradedRows, 2);
    assert.equal(gate.metrics.minDelta, -4);
    assert.equal(gate.metrics.maxDelta, 4);
  });

  void test('reports skipped hygiene when Kilter universal grades are unavailable', () => {
    const stats = createDisplayDeltaHygieneStats();
    recordDisplayDeltaHygiene(
      stats,
      applyDisplayDeltaHygiene({
        boardType: 'kilter',
        displayDifficulty: 10,
        posterior: posterior({ universalGrade: null }),
      }),
    );
    const gate = evaluateDisplayDeltaHygiene(stats);
    assert.equal(gate.passed, true);
    assert.equal(gate.metrics.checkedRows, 0);
    assert.equal(gate.metrics.skippedMissingUniversalRows, 1);
    assert.match(gate.detail, /not checked/);
  });
});

void describe('estimateEchoFractions', () => {
  void test('deconvolves auto-copy share from provenance split', () => {
    // e = 0.848 synced echo, a = 0.771 native agreement → λ ≈ 0.336
    const result = estimateEchoFractions([
      { board_type: 'kilter', synced_graded: 10000, synced_echo: 8480, native_graded: 1000, native_echo: 771 },
    ]);
    assert.ok(Math.abs(result.kilter - (0.848 - 0.771) / (1 - 0.771)) < 1e-9);
  });
  void test('falls back on thin data', () => {
    const result = estimateEchoFractions([
      { board_type: 'soill', synced_graded: 10, synced_echo: 9, native_graded: 0, native_echo: 0 },
    ]);
    assert.equal(result.soill, DEFAULT_ECHO_FRACTION);
  });
  void test('borrows pooled native agreement when a board has few native ticks', () => {
    const result = estimateEchoFractions([
      { board_type: 'kilter', synced_graded: 10000, synced_echo: 8000, native_graded: 2000, native_echo: 1500 },
      { board_type: 'tension', synced_graded: 5000, synced_echo: 4500, native_graded: 10, native_echo: 9 },
    ]);
    // tension uses pooled a = 1509/2010
    const pooled = 1509 / 2010;
    assert.ok(Math.abs(result.tension - (0.9 - pooled) / (1 - pooled)) < 1e-9);
  });
});

void describe('tick provenance in coefficient SQL', () => {
  // A native tick pushed back upstream keeps origin='native' but gets
  // aurora_id/kilter_id stamped (tickOriginEnum in schema/app/ascents.ts), so
  // classifying by ID-nullness would silently reclassify opt-in opinions as
  // synced once push-back runs. Both builders must classify by origin.
  const renderedSql = (query: SQL): string => new PgDialect().sqlToQuery(query).sql;

  void test('buildEchoRatesSql classifies native by origin, not upstream-ID nullness', () => {
    const query = renderedSql(buildEchoRatesSql());
    assert.ok(query.includes("t.origin = 'native'"));
    assert.ok(!query.includes('aurora_id IS NULL'));
    assert.ok(!query.includes('kilter_id IS NULL'));
  });

  void test('buildSigmaWithinSql classifies native by origin, not upstream-ID nullness', () => {
    const query = renderedSql(buildSigmaWithinSql());
    assert.ok(query.includes("t.origin = 'native'"));
    assert.ok(!query.includes('aurora_id IS NULL'));
    assert.ok(!query.includes('kilter_id IS NULL'));
  });
});

void describe('estimateSigmaWithin', () => {
  void test('takes sqrt of mean squared deviation and backfills bands', () => {
    const result = estimateSigmaWithin([
      { board_type: 'kilter', grade_band: 'v3-5', mean_sq_deviation: 0.64, n_users: 100 },
      { board_type: 'kilter', grade_band: 'v9+', mean_sq_deviation: 4, n_users: 5 },
    ]);
    assert.equal(result.kilter['v3-5'], 0.8);
    // v9+ had too few users → inherits the board mean (0.8), not sqrt(4).
    assert.equal(result.kilter['v9+'], 0.8);
  });
});

void describe('estimateAngleSurface', () => {
  void test('keeps supported cells and builds weighted all-band fallback', () => {
    const rows: AngleSurfaceRow[] = [
      { board_type: 'kilter', grade_band: 'v3-5', angle: 40, offset_from_climb_mean: 0.5, n_climbs: 100 },
      { board_type: 'kilter', grade_band: 'v6-8', angle: 40, offset_from_climb_mean: 0.3, n_climbs: 100 },
      { board_type: 'kilter', grade_band: 'v9+', angle: 40, offset_from_climb_mean: 9, n_climbs: 5 },
    ];
    const surface = estimateAngleSurface(rows);
    assert.equal(surface.kilter['v3-5']?.[40], 0.5);
    assert.equal(surface.kilter['v9+']?.[40], undefined);
    // all-band: (0.5·100 + 0.3·100 + 9·5) / 205
    const expected = (0.5 * 100 + 0.3 * 100 + 9 * 5) / 205;
    assert.ok(Math.abs((surface.kilter.all?.[40] ?? 0) - expected) < 1e-9);
  });
});

void describe('estimateTauSquared', () => {
  void test('measures leave-one-angle-out residual variance', () => {
    // Two-angle climbs where 40° and 50° agree through a zero surface, plus
    // controlled residual spread.
    const rows: TauSampleRow[] = [];
    for (let i = 0; i < 40; i++) {
      const base = 18 + (i % 3) * 0.5; // some spread in true grade
      const noise = i % 2 === 0 ? 0.3 : -0.3; // symmetric residual
      rows.push({
        board_type: 'kilter',
        climb_uuid: `climb-${i}`,
        angle: 40,
        difficulty_average: base + noise,
        display_difficulty: 18,
        ascensionist_count: 100,
      });
      rows.push({
        board_type: 'kilter',
        climb_uuid: `climb-${i}`,
        angle: 50,
        difficulty_average: base,
        display_difficulty: 18,
        ascensionist_count: 100,
      });
    }
    const tau = estimateTauSquared(rows, {});
    // Residuals are ±0.3 on one side and ∓ on the other → variance ≈ 0.09;
    // clamp floor is 0.05 so the estimate must be near 0.09.
    assert.ok(tau.kilter['v3-5'] > 0.05 && tau.kilter['v3-5'] < 0.2, `tau was ${tau.kilter['v3-5']}`);
  });
});

void describe('estimateBoardOffsets', () => {
  void test('median gap with LOO stability', () => {
    const rows: BoardOffsetSampleRow[] = Array.from({ length: 30 }, (_, i) => ({
      user_id: `user-${i}`,
      kilter_median: 20,
      tension_median: 20 - 1.2 + (i % 2 === 0 ? 0.2 : -0.2),
      kilter_n: 50,
      tension_n: 50,
    }));
    const { kilter } = estimateBoardOffsets(rows);
    assert.ok(kilter);
    assert.ok(Math.abs(kilter.offset - -1.2) < 0.21);
    assert.ok(kilter.looMaxDelta < 0.5);
    assert.equal(kilter.users, 30);
  });
  void test('refuses with too few shared users', () => {
    assert.equal(estimateBoardOffsets([]).kilter, null);
  });
});

void describe('evaluateResidualGapGate', () => {
  void test('passes when mean gap matches fitted offset', () => {
    const rows: BoardOffsetSampleRow[] = Array.from({ length: 25 }, (_, i) => ({
      user_id: `user-${i}`,
      kilter_median: 20,
      tension_median: 18.8 + (i % 2 === 0 ? 0.1 : -0.1),
      kilter_n: 30,
      tension_n: 30,
    }));
    const gate = evaluateResidualGapGate(rows, -1.2);
    assert.equal(gate.passed, true);
  });
  void test('fails when the offset misrepresents the population', () => {
    const rows: BoardOffsetSampleRow[] = Array.from({ length: 25 }, (_, i) => ({
      user_id: `user-${i}`,
      kilter_median: 20,
      tension_median: 19.6,
      kilter_n: 30,
      tension_n: 30,
    }));
    const gate = evaluateResidualGapGate(rows, -1.2);
    assert.equal(gate.passed, false);
  });
});

void describe('evaluateFingerprintGate', () => {
  void test('tolerates up to 1% disagreement', () => {
    assert.equal(evaluateFingerprintGate({ violations: 1, groups: 200 }).passed, true);
    assert.equal(evaluateFingerprintGate({ violations: 10, groups: 200 }).passed, false);
    assert.equal(evaluateFingerprintGate({ violations: 0, groups: 0 }).passed, true);
  });
});

void describe('evaluateBacktest', () => {
  void test('multi-angle blending beats the raw tail mean on synthetic data', () => {
    const coefficients = makeCoefficients({
      angleOffset: { kilter: { all: { 40: 0, 50: 0 } } },
    });
    const rows: BacktestSampleRow[] = [];
    for (let i = 0; i < 150; i++) {
      const truth = 20;
      const noisySnap = truth + (i % 2 === 0 ? 1.5 : -1.5); // raw 1-ascent grade is 1.5 off
      rows.push({
        board_type: 'kilter',
        climb_uuid: `climb-${i}`,
        angle: 50,
        snap_avg: noisySnap,
        snap_display: 20,
        snap_count: 1,
        final_avg: truth,
        sibling_states: [{ angle: 40, difficulty_average: truth, display_difficulty: 20, ascensionist_count: 500 }],
      });
    }
    const summary = evaluateBacktest(rows, coefficients);
    assert.ok(summary.report.multiAngle.shrunkMae < summary.report.multiAngle.rawMae);
    assert.equal(summary.tailGate.passed, true, summary.tailGate.detail);
  });

  void test('single-angle rows assert no-regression only', () => {
    const coefficients = makeCoefficients();
    const rows: BacktestSampleRow[] = Array.from({ length: 120 }, (_, i) => ({
      board_type: 'kilter',
      climb_uuid: `climb-${i}`,
      angle: 40,
      snap_avg: 20 + (i % 2 === 0 ? 1 : -1),
      snap_display: 20,
      snap_count: 1,
      final_avg: 20,
      sibling_states: [],
    }));
    const summary = evaluateBacktest(rows, coefficients);
    // No multi-angle rows → gate cannot pass (needs n≥100 with evidence)…
    assert.equal(summary.tailGate.passed, false);
    // …but the single-angle posterior must equal the raw mean (no regression).
    assert.ok(Math.abs(summary.report.singleAngle.shrunkMae - summary.report.singleAngle.rawMae) < 1e-9);
  });
});

// Angle surface + σ/τ sized so a projection lands squarely inside the width cap
// and the transported grades are easy to reason about by hand.
function projectionCoefficients(): GradeCoefficients {
  return makeCoefficients({
    angleOffset: { kilter: { all: { 20: -1, 30: -0.5, 40: 0, 50: 1, 60: 2 } } },
  });
}

void describe('anchorAngles', () => {
  void test('keeps only angles with a crowd mean and at least 3 ascents', () => {
    const kept = anchorAngles([
      observation({ angle: 40, difficultyAverage: 20, ascensionistCount: 30 }),
      observation({ angle: 45, difficultyAverage: 20.5, ascensionistCount: 3 }),
      observation({ angle: 50, difficultyAverage: 21, ascensionistCount: 2 }),
      observation({ angle: 55, difficultyAverage: null, ascensionistCount: 40 }),
    ]);
    assert.deepEqual(
      kept.map((row) => row.angle),
      [40, 45],
    );
  });
});

void describe('boardSupportsCrossAngleEstimate', () => {
  void test('covers the crowd-mean boards and never MoonBoard', () => {
    assert.equal(boardSupportsCrossAngleEstimate('kilter'), true);
    assert.equal(boardSupportsCrossAngleEstimate('tension'), true);
    assert.equal(boardSupportsCrossAngleEstimate('moonboard'), false);
  });
});

void describe('buildProjectedAngleObservations', () => {
  const boardAngles = [20, 30, 40, 50, 60];

  void test('fills every unclimbed angle when two angles carry real evidence', () => {
    const real = [
      observation({ angle: 40, difficultyAverage: 20, displayDifficulty: 20, ascensionistCount: 40 }),
      observation({ angle: 50, difficultyAverage: 21, displayDifficulty: 21, ascensionistCount: 30 }),
    ];
    const projected = buildProjectedAngleObservations(real, boardAngles, projectionCoefficients());

    assert.deepEqual(
      projected.map((row) => row.angle),
      [20, 30, 60],
    );
    for (const row of projected) {
      assert.equal(row.projectedAngle, true);
      assert.equal(row.difficultyAverage, null, 'a projected angle carries no crowd mean');
      assert.equal(row.ascensionistCount, 0);
    }
  });

  void test('transports the grade along the angle surface, easier low and harder steep', () => {
    // Both real angles sit at reference grade 20 (40° offset 0; 50° offset +1).
    const real = [
      observation({ angle: 40, difficultyAverage: 20, displayDifficulty: 20, ascensionistCount: 40 }),
      observation({ angle: 50, difficultyAverage: 21, displayDifficulty: 20, ascensionistCount: 40 }),
    ];
    const coefficients = projectionCoefficients();
    const projected = buildProjectedAngleObservations(real, boardAngles, coefficients);
    const gradeAt = (angle: number): number => {
      const target = projected.find((row) => row.angle === angle);
      assert.ok(target, `expected a projection at ${angle}°`);
      const grade = computePosteriorGrade(target, real, coefficients).localGrade;
      assert.ok(grade !== null);
      return grade;
    };

    assert.ok(Math.abs(gradeAt(20) - 19) < 1e-9, 'reference 20 with a -1 offset at 20°');
    assert.ok(Math.abs(gradeAt(60) - 22) < 1e-9, 'reference 20 with a +2 offset at 60°');
    assert.ok(gradeAt(20) < gradeAt(30) && gradeAt(30) < gradeAt(60), 'monotone with angle');
  });

  void test('publishes projections as cross_angle_estimate with a real band, never setter_only', () => {
    const real = [
      observation({ angle: 40, difficultyAverage: 20, displayDifficulty: 20, ascensionistCount: 40 }),
      observation({ angle: 50, difficultyAverage: 21, displayDifficulty: 21, ascensionistCount: 30 }),
    ];
    const coefficients = projectionCoefficients();
    const [projected] = buildProjectedAngleObservations(real, [30], coefficients);
    const result = computePosteriorGrade(projected, real, coefficients);

    assert.equal(result.confidence, CONFIDENCE.crossAngleEstimate);
    assert.notEqual(result.confidence, CONFIDENCE.setterOnly);
    assert.ok(result.postSd !== null && result.postSd > 0);
    assert.ok(result.gradeLow !== null && result.gradeHigh !== null, 'an estimate must carry its band');
    assert.ok(result.gradeHigh > result.gradeLow);
  });

  void test('refuses a climb with only one ascent-backed angle', () => {
    const real = [
      observation({ angle: 40, difficultyAverage: 20, displayDifficulty: 20, ascensionistCount: 40 }),
      observation({ angle: 50, difficultyAverage: 21, displayDifficulty: 21, ascensionistCount: 2 }),
    ];
    assert.deepEqual(buildProjectedAngleObservations(real, boardAngles, projectionCoefficients()), []);
  });

  void test('refuses MoonBoard whatever its angle coverage', () => {
    const real = [
      observation({ boardType: 'moonboard', angle: 40, difficultyAverage: 20, ascensionistCount: 90 }),
      observation({ boardType: 'moonboard', angle: 25, difficultyAverage: 19, ascensionistCount: 80 }),
    ];
    assert.deepEqual(buildProjectedAngleObservations(real, [25, 40, 50], projectionCoefficients()), []);
  });

  void test('skips an angle whose band would be wider than the cap', () => {
    // τ² at its clamp ceiling AND siblings thin enough that their own sampling
    // error dominates — the only way past the width cap, and exactly the case
    // it exists for.
    const coefficients = makeCoefficients({
      sigmaWithin: { kilter: { 'v0-2': 3, 'v3-5': 3, 'v6-8': 3, 'v9+': 3 } },
      tauSquared: { kilter: { 'v0-2': 4, 'v3-5': 4, 'v6-8': 4, 'v9+': 4 } },
      angleOffset: { kilter: { all: { 30: -0.5, 40: 0, 50: 1 } } },
    });
    const thin = [
      observation({ angle: 40, difficultyAverage: 20, displayDifficulty: 20, ascensionistCount: 3 }),
      observation({ angle: 50, difficultyAverage: 21, displayDifficulty: 21, ascensionistCount: 3 }),
    ];
    assert.deepEqual(buildProjectedAngleObservations(thin, [30], coefficients), []);

    // The same coefficients with well-sampled siblings stay inside the cap.
    const wellSampled = [
      observation({ angle: 40, difficultyAverage: 20, displayDifficulty: 20, ascensionistCount: 400 }),
      observation({ angle: 50, difficultyAverage: 21, displayDifficulty: 21, ascensionistCount: 400 }),
    ];
    assert.equal(buildProjectedAngleObservations(wellSampled, [30], coefficients).length, 1);
  });

  void test('bands a hard climb by its own grade, not the default middle band', () => {
    // Two-pass band selection. A zero-evidence angle has no display label, so
    // `gradeBandForDifficulty(null)` inside computePosteriorGrade would price
    // EVERY projection with the middle 'v3-5' band; the probe pass feeds the
    // nominal grade back so the right band's σ/τ² are used. Here the v9+ band
    // carries a τ² at the clamp ceiling, so a hard climb's band is far too wide
    // to publish while an easy one is comfortably inside the cap.
    const coefficients = makeCoefficients({
      sigmaWithin: { kilter: { 'v0-2': 0.8, 'v3-5': 0.8, 'v6-8': 0.8, 'v9+': 3 } },
      tauSquared: { kilter: { 'v0-2': 0.25, 'v3-5': 0.25, 'v6-8': 0.25, 'v9+': 4 } },
      angleOffset: { kilter: { all: { 30: -0.5, 40: 0, 50: 1 } } },
    });
    const hard = [
      observation({ angle: 40, difficultyAverage: 28, displayDifficulty: 28, ascensionistCount: 3 }),
      observation({ angle: 50, difficultyAverage: 29, displayDifficulty: 29, ascensionistCount: 3 }),
    ];
    // Would be published if the projection had defaulted to the 'v3-5' σ/τ².
    assert.deepEqual(buildProjectedAngleObservations(hard, [30], coefficients), []);

    const easy = [
      observation({ angle: 40, difficultyAverage: 18, displayDifficulty: 18, ascensionistCount: 3 }),
      observation({ angle: 50, difficultyAverage: 19, displayDifficulty: 19, ascensionistCount: 3 }),
    ];
    assert.equal(buildProjectedAngleObservations(easy, [30], coefficients).length, 1);
  });
});

void describe('projected angles in the isotonic fit', () => {
  void test('never move a real angle, but are pulled onto the real curve', () => {
    // 40° and 50° are inverted (harder at 40 than 50) and both well sampled;
    // a projected 45° sits between them. Whatever the projection says, the two
    // real angles must settle exactly where they would have without it.
    const realRows: AngleGradeRow[] = [
      { angle: 40, posterior: posterior({ localGrade: 21, postSd: 0.3 }), observedMean: 21, ascensionistCount: 30 },
      { angle: 50, posterior: posterior({ localGrade: 20, postSd: 0.3 }), observedMean: 20, ascensionistCount: 30 },
    ];
    const withProjection: AngleGradeRow[] = [
      realRows[0],
      {
        angle: 45,
        posterior: posterior({ localGrade: 26, postSd: 0.9 }),
        observedMean: null,
        ascensionistCount: 0,
        projectedAngle: true,
      },
      realRows[1],
    ];

    const baseline = applyIsotonicAngleConstraint(realRows);
    const widened = applyIsotonicAngleConstraint(withProjection);

    const gradeAt = (result: { adjusted: PosteriorGrade[] }, rows: AngleGradeRow[], angle: number): number => {
      const grade = result.adjusted[rows.findIndex((row) => row.angle === angle)].localGrade;
      assert.ok(grade !== null);
      return grade;
    };

    assert.ok(
      Math.abs(gradeAt(baseline, realRows, 40) - gradeAt(widened, withProjection, 40)) < 1e-6,
      'the real 40° grade is unchanged by the projected neighbour',
    );
    assert.ok(
      Math.abs(gradeAt(baseline, realRows, 50) - gradeAt(widened, withProjection, 50)) < 1e-6,
      'the real 50° grade is unchanged by the projected neighbour',
    );
    // The wild projection is itself dragged back onto the merged real block.
    assert.ok(gradeAt(widened, withProjection, 45) < 26);
  });
});

void describe('evaluateZeroEvidenceProjection', () => {
  // Head climbs whose grade genuinely rises with angle: transporting through
  // the surface should beat pretending every angle grades the same.
  function angleTransportRows(): TauSampleRow[] {
    const rows: TauSampleRow[] = [];
    for (let i = 0; i < 60; i++) {
      for (const [angle, grade] of [
        [20, 19],
        [40, 20],
        [60, 22],
      ] as const) {
        rows.push({
          board_type: 'kilter',
          climb_uuid: `climb-${i}`,
          angle,
          difficulty_average: grade,
          display_difficulty: grade,
          ascensionist_count: 40,
        });
      }
    }
    return rows;
  }

  void test('passes when the angle surface beats the naive sibling mean', () => {
    const coefficients = makeCoefficients({
      angleOffset: { kilter: { all: { 20: -1, 40: 0, 60: 2 } } },
    });
    const gate = evaluateZeroEvidenceProjection(angleTransportRows(), coefficients);
    assert.equal(gate.gate, 'zero_evidence_projection');
    assert.equal(gate.passed, true, gate.detail);
    assert.ok(gate.metrics.projectedMae < gate.metrics.naiveMae, gate.detail);
  });

  void test('blocks when the surface is flat and the angle effect is real', () => {
    // A surface of all-zero offsets can only reproduce the naive mean, and the
    // tolerance is tight, so a genuinely angle-dependent population regresses.
    const flat = makeCoefficients({ angleOffset: { kilter: { all: { 20: 0, 40: 0, 60: 0 } } } });
    const gate = evaluateZeroEvidenceProjection(angleTransportRows(), flat);
    assert.ok(gate.metrics.projectedMae >= gate.metrics.naiveMae - 1e-9, gate.detail);
  });

  void test('fails on too small a sample rather than passing on nothing', () => {
    const gate = evaluateZeroEvidenceProjection(angleTransportRows().slice(0, 9), makeCoefficients());
    assert.equal(gate.passed, false);
    assert.ok(gate.metrics.scored < 100);
  });
});

void describe('foldCoefficientRows', () => {
  void test('folds each payload kind onto its board key and ignores unknowns', () => {
    const folded = foldCoefficientRows('2026-08-01T00:00:00Z', [
      { kind: 'echo_fraction', key: 'kilter', payload: { lambda: 0.83 } },
      { kind: 'board_offset', key: 'kilter', payload: { offset: -1.2, sd: 0.4, users: 60, looMaxDelta: 0.2 } },
      { kind: 'gate_results', key: 'run-1', payload: { whatever: true } },
    ]);
    assert.equal(folded.coeffVersion, '2026-08-01T00:00:00Z');
    assert.equal(folded.echoFraction.kilter, 0.83);
    assert.equal(folded.boardOffset.kilter.offset, -1.2);
    assert.deepEqual(folded.raterModel, {});
  });
});
