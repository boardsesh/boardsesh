/**
 * Client-side mirror of the Boardsesh grade's confidence tiers (the server-side
 * source of truth is `CONFIDENCE` in
 * packages/db/src/queries/grade-model/constants.ts, which the client can't
 * import — it pulls in drizzle/postgres). Only the two tiers the display rules
 * branch on are named here; anything else reads as a normal, ascent-backed
 * grade.
 */
export const BOARDSESH_TIER = {
  /** Fewer than 3 ascents: the setter's own number, no independent evidence. */
  setterOnly: 'setter_only',
  /**
   * Nobody has climbed this angle. The grade was projected from the same
   * climb's other angles during the nightly refresh — a real number with a real
   * band, but not something anyone has actually pulled on. Every surface that
   * shows it has to say so.
   */
  crossAngleEstimate: 'cross_angle_estimate',
  /**
   * MoonBoard only. The problem is graded at one of the board's two fixed
   * angles (25° / 40°) and nobody has climbed the other, so the setter's grade
   * was transposed across by a per-grade-band delta. Same "nobody has climbed
   * this angle" caveat as `crossAngleEstimate`, but a different provenance —
   * a same-board label transform, not a community projection — so it gets its
   * own predicate and its own copy rather than being folded in.
   */
  moonboardAngleEstimate: 'moonboard_angle_estimate',
} as const;

/** True when a grade came from a projection rather than ascents at this angle. */
export function isCrossAngleEstimate(confidence: string | null | undefined): boolean {
  return confidence === BOARDSESH_TIER.crossAngleEstimate;
}

/** True when a MoonBoard grade was transposed from the board's other fixed angle. */
export function isMoonboardAngleEstimate(confidence: string | null | undefined): boolean {
  return confidence === BOARDSESH_TIER.moonboardAngleEstimate;
}

/** True for either tier that stands in for an angle nobody has climbed. */
export function isEstimatedGrade(confidence: string | null | undefined): boolean {
  return isCrossAngleEstimate(confidence) || isMoonboardAngleEstimate(confidence);
}

/**
 * Decides how a logbook row shows its grade. The big grade is the climber's
 * effective grade (their logged grade, or the consensus when they didn't grade
 * it). The community consensus is surfaced as a small secondary only when it
 * disagrees with the logged grade, and an ungraded row's grade is marked as
 * consensus-sourced so it's clear it's the crowd's, not the climber's.
 *
 * Pure difficulty-id comparison so the row's display branches stay unit-testable
 * and web can reuse it when it gets the same dual-grade display; the grade-label
 * formatting (which needs the platform's grade-format hook) lives in the row.
 */
export function deriveLogbookGradeDisplay(
  loggedDifficulty: number | null | undefined,
  consensusDifficulty: number | null | undefined,
): { showConsensusSecondary: boolean; gradeIsConsensus: boolean } {
  const hasLogged = loggedDifficulty != null;
  return {
    showConsensusSecondary: hasLogged && consensusDifficulty != null && consensusDifficulty !== loggedDifficulty,
    gradeIsConsensus: !hasLogged && consensusDifficulty != null,
  };
}

/**
 * Which crowd-sourced grade a logbook row should display for an ungraded ascent:
 * the data-science-backed Boardsesh grade when it's available and trusted,
 * otherwise the legacy community consensus. Pure difficulty-id resolution so both
 * web and mobile branch the same way behind the app-wide "use Boardsesh grades"
 * toggle.
 *
 * The Boardsesh grade only fills the gap — a climber's own logged grade always
 * wins upstream of this and is never passed here. Rules:
 *  - toggle off → always the legacy consensus.
 *  - Boardsesh grade present AND trusted → the rounded Boardsesh grade (the
 *    shared scale aligns with integer difficulty ids, so rounding lands on a
 *    real grade bucket).
 *  - Boardsesh grade null, or confidence `setter_only` /
 *    `cross_angle_estimate` / `moonboard_angle_estimate` → the legacy consensus.
 *  - No consensus either → null (the row shows no crowd grade).
 *
 * Both estimate tiers are excluded because this value is presented as the
 * CROWD's grade for an ascent, and an angle nobody has climbed has no crowd.
 * A logbook row has nowhere to put an "estimated" marker, so the honest
 * fallback is the legacy consensus. (The detail view, which does have room to
 * mark it, shows the estimate.)
 */
export function resolveCrowdDifficulty(
  fields: {
    boardseshDifficulty?: number | null;
    boardseshConfidence?: string | null;
    consensusDifficulty?: number | null;
  },
  useBoardseshGrades: boolean,
): number | null {
  // Keep these untrusted tiers as a blocklist, not an allowlist of known
  // tiers. Intentional: the DB only ever
  // writes a `board_climb_grades` row with confidence set, so a present
  // `boardseshDifficulty` with an undefined/unknown confidence can't happen from
  // real data — but if it did, this still surfaces the grade rather than
  // silently dropping it. That mirrors mobile's buildBoardseshGradeView
  // (boardsesh-grade-utils.ts), which reads any unrecognized tier as
  // provisional-like rather than hiding the grade. Keep both in sync — do not
  // tighten this to an allowlist of specific tier strings.
  const blocked =
    fields.boardseshConfidence === BOARDSESH_TIER.setterOnly || isEstimatedGrade(fields.boardseshConfidence);
  if (useBoardseshGrades && fields.boardseshDifficulty != null && !blocked) {
    return Math.round(fields.boardseshDifficulty);
  }
  return fields.consensusDifficulty ?? null;
}

/**
 * Direction of the climber's grade relative to the consensus, for the arrow on
 * the row's consensus sub-line: 'up' = you graded it harder than the crowd,
 * 'down' = softer. Only meaningful when `showConsensusSecondary` is true —
 * returns null when either grade is missing or they agree. Difficulty ids are
 * ordinal (higher id = harder), the same assumption the grade range filters make.
 */
export function consensusDeltaDirection(
  loggedDifficulty: number | null | undefined,
  consensusDifficulty: number | null | undefined,
): 'up' | 'down' | null {
  if (loggedDifficulty == null || consensusDifficulty == null) return null;
  if (loggedDifficulty === consensusDifficulty) return null;
  return loggedDifficulty > consensusDifficulty ? 'up' : 'down';
}

/**
 * Minimum ascents before a climb's crowd-average grade is trusted enough to
 * carry a "stiff/soft" badge — a couple of outlier votes on a fresh climb
 * shouldn't flicker a grade-discrepancy badge on.
 */
export const MIN_ASCENTS_FOR_GRADE_ERROR_BADGE = 5;

/**
 * Minimum |difficulty_error| (difficulty-id units, the same ordinal scale
 * minGrade/maxGrade use) before the gap reads as a real discrepancy rather
 * than noise.
 */
export const GRADE_ERROR_BADGE_THRESHOLD = 0.5;

export type GradeErrorBadge = { direction: 'stiff' | 'soft'; amount: number };

/**
 * Whether a climb's card should show a "stiff/soft" badge, and which way,
 * from `difficulty_error` — `board_climb_stats.difficulty_average −
 * display_difficulty`, computed server-side and already carried on every
 * climb row (search results, GraphQL `Climb`, the offline SQLite mapping).
 * Positive means the crowd's actual grade opinions run harder than the
 * displayed grade ("stiff"); negative means they run easier ("soft") — the
 * same higher-id-is-harder convention as `consensusDeltaDirection` above,
 * just at the climb level (crowd average vs. display) instead of the ascent
 * level (one climber's log vs. consensus).
 *
 * Pure and platform-agnostic on purpose: works for any board, including
 * MoonBoard, where `difficulty_error` is populated the same way but the
 * Boardsesh grade model (`board_climb_grades`) is deliberately unavailable.
 *
 * Accepts `difficulty_error` as the string the wire format carries it as, or
 * a number for callers that already parsed it.
 */
export function resolveGradeErrorBadge(
  difficultyError: string | number | null | undefined,
  ascensionistCount: number | null | undefined,
): GradeErrorBadge | null {
  const parsed = typeof difficultyError === 'string' ? Number(difficultyError) : difficultyError;
  if (parsed == null || !Number.isFinite(parsed)) return null;
  if ((ascensionistCount ?? 0) < MIN_ASCENTS_FOR_GRADE_ERROR_BADGE) return null;
  if (Math.abs(parsed) < GRADE_ERROR_BADGE_THRESHOLD) return null;
  return { direction: parsed > 0 ? 'stiff' : 'soft', amount: Math.abs(parsed) };
}
