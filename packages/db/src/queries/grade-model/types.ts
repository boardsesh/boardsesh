import type { ConfidenceTier, GradeBandKey } from './constants';

export interface RaterBiasCoefficient {
  bias: number;
  shrinkage: number;
  effectiveN: number;
  rawVotes: number;
  weightedResidual: number;
}

export interface RaterModelCoefficient {
  boardType: string;
  biases: Record<string, RaterBiasCoefficient>;
  summary: {
    expressedVotes: number;
    users: number;
    locations: number;
    topUserShare: number;
  };
}

export type BehaviorOutcomeBucket = 'flash' | 'send_2_3' | 'send_4_plus' | 'attempt_1_3' | 'attempt_4_plus';

export interface BehaviorModelCoefficient {
  boardType: string;
  boardMean: number;
  outcomeOffset: Partial<Record<BehaviorOutcomeBucket, number>>;
  eligible: boolean;
  summary: {
    users: number;
    outcomes: number;
    topUserShare: number;
    usedUsers: number;
    usedOutcomes: number;
    usedTopUserShare: number;
  };
}

export interface Stage2Evidence {
  raterMean: number | null;
  raterEffectiveN: number;
  behaviorMean: number | null;
  behaviorEffectiveN: number;
}

export interface MoonBridgeReadiness {
  boardType: 'moonboard';
  bridgeUsers: number;
  requiredUsers: number;
  minSendsPerBoard: number;
  candidateOffset: number | null;
  looMaxDelta: number | null;
  publishable: boolean;
}

/** Frozen coefficient set the nightly re-blend runs against. */
export interface GradeCoefficients {
  coeffVersion: string;
  /** Per-board echo fraction λ (quick-log auto-copy share of graded ascents). */
  echoFraction: Record<string, number>;
  /** Within-climb SD of genuinely expressed grades, per board:band. */
  sigmaWithin: Record<string, Record<GradeBandKey, number>>;
  /** Between-climb prior variance τ², per board:band. */
  tauSquared: Record<string, Record<GradeBandKey, number>>;
  /**
   * Angle surface: per board → band → angle → offset from the climb's own
   * cross-angle mean (grade points). Only cells with enough support exist;
   * lookups fall back to the band-agnostic 'all' band, then 0.
   */
  angleOffset: Record<string, Partial<Record<GradeBandKey | 'all', Record<number, number>>>>;
  /**
   * Additive cross-board offset onto the universal (Tension-anchored) scale.
   * Kilter ≈ −1.2 (reads soft); Tension 0 by definition. Boards without an
   * entry never publish a universal grade.
   */
  boardOffset: Record<string, { offset: number; sd: number; users: number; looMaxDelta: number }>;
  /** Stage 2 shrunk per-user/location rater bias models, per board. */
  raterModel: Record<string, RaterModelCoefficient>;
  /** Stage 2 anchoring-resistant behavior outcome models, per board. */
  behaviorModel: Record<string, BehaviorModelCoefficient>;
  /** Report-only bridge readiness for boards that are not yet publishable. */
  bridgeReadiness: Record<string, MoonBridgeReadiness>;
}

/** One climb+angle observation from board_climb_stats, ready to blend. */
export interface ClimbAngleObservation {
  boardType: string;
  climbUuid: string;
  angle: number;
  difficultyAverage: number | null;
  displayDifficulty: number | null;
  ascensionistCount: number;
  /**
   * Optional Climb2Vec geometry content-model grade estimate (from
   * board_climb_embeddings). Used only in the cold tail — when there is no crowd
   * mean AND no cross-angle prior — so it never overrules crowd evidence.
   */
  contentPrior?: number | null;
  /** The content model's held-out RMSE → the CI on a content-driven grade. */
  contentSd?: number | null;
  /**
   * True for a manufactured angle — one the board supports but nobody has
   * climbed, so there is no `board_climb_stats` row and never any own-angle
   * evidence. Built by `buildProjectedAngleObservations`; makes the posterior
   * publish as `cross_angle_estimate` and near-zero-weights the row in the
   * isotonic fit (it is derived FROM the real angles, so it must not vote on
   * them).
   */
  projectedAngle?: boolean;
}

/** Result of the closed-form empirical-Bayes blend for one climb+angle. */
export interface PosteriorGrade {
  localGrade: number | null;
  universalGrade: number | null;
  gradeLow: number | null;
  gradeHigh: number | null;
  confidence: ConfidenceTier;
  postSd: number | null;
}

/** Per-gate outcome persisted with each run. */
export interface GateResult {
  gate: string;
  passed: boolean;
  /** Human-readable metric summary, e.g. "MAE 0.31 vs raw 0.44 (−30%)". */
  detail: string;
  metrics: Record<string, number>;
}
