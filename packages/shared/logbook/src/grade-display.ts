// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

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
} as const;

/** True when a grade came from a projection rather than ascents at this angle. */
export function isCrossAngleEstimate(confidence: string | null | undefined): boolean {
  return confidence === BOARDSESH_TIER.crossAngleEstimate;
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
 *  - Boardsesh grade null, or confidence `setter_only` / `cross_angle_estimate`
 *    → the legacy consensus.
 *  - No consensus either → null (the row shows no crowd grade).
 *
 * `cross_angle_estimate` is excluded because this value is presented as the
 * CROWD's grade for an ascent, and a projected angle has no crowd — nobody has
 * climbed it. A logbook row has nowhere to put an "estimated" marker, so the
 * honest fallback is the legacy consensus. (The detail view, which does have
 * room to mark it, shows the projection.)
 */
export function resolveCrowdDifficulty(
  fields: {
    boardseshDifficulty?: number | null;
    boardseshConfidence?: string | null;
    consensusDifficulty?: number | null;
  },
  useBoardseshGrades: boolean,
): number | null {
  // Keep these two untrusted tiers as a blocklist, not an allowlist of known
  // tiers. Intentional: the DB only ever
  // writes a `board_climb_grades` row with confidence set, so a present
  // `boardseshDifficulty` with an undefined/unknown confidence can't happen from
  // real data — but if it did, this still surfaces the grade rather than
  // silently dropping it. That mirrors mobile's buildBoardseshGradeView
  // (boardsesh-grade-utils.ts), which reads any unrecognized tier as
  // provisional-like rather than hiding the grade. Keep both in sync — do not
  // tighten this to an allowlist of specific tier strings.
  const blocked =
    fields.boardseshConfidence === BOARDSESH_TIER.setterOnly || isCrossAngleEstimate(fields.boardseshConfidence);
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
