// Decides which grade the grade rail should center on when it opens. The
// search analytics show grade is the #1 lever and the active band peaks at
// V5–V7, but a climber's own level is the real center of gravity — so prefer
// the climber's modal recent send grade, falling back to the upper-middle of
// the board's grade band (a board-agnostic proxy for that V5–V7 peak; no
// hardcoded Kilter difficulty ids).
//
// Pure functions only, so they're trivially testable and could be promoted to
// a shared package if web wants the same personalization.

import type { Grade } from '@boardsesh/shared-schema';

export type GradeSelection = { minGradeId: number | undefined; maxGradeId: number | undefined };

/** Most-frequent difficulty id across the climber's recent sends, or undefined. */
export function selectModalSendGrade(sendDifficultyIds: readonly number[]): number | undefined {
  if (sendDifficultyIds.length === 0) return undefined;
  const counts = new Map<number, number>();
  for (const id of sendDifficultyIds) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let best: number | undefined;
  let bestCount = -1;
  for (const [id, count] of counts) {
    // Ties resolve to the harder grade (higher id) — climbers aim up, not down.
    if (count > bestCount || (count === bestCount && best !== undefined && id > best)) {
      best = id;
      bestCount = count;
    }
  }
  return best;
}

/** Default rail center when the climber has no usable send history. */
export function defaultGradeCenter(grades: readonly Grade[]): number | undefined {
  if (grades.length === 0) return undefined;
  const index = Math.min(grades.length - 1, Math.max(0, Math.round((grades.length - 1) * 0.6)));
  return grades[index]?.difficultyId;
}

/**
 * The difficulty id the grade rail should scroll to / highlight: the current
 * selection if any, else the climber's last-used grade, else their modal send
 * grade, else the default band center.
 *
 * `lastUsedGradeId` is only honoured when it actually exists on the current
 * board — difficulty scales differ across board families, so a value remembered
 * on one board falls through to the send/default heuristics on another.
 */
export function gradeRailCenter(
  selected: GradeSelection,
  grades: readonly Grade[],
  sendDifficultyIds: readonly number[] = [],
  lastUsedGradeId?: number,
): number | undefined {
  if (selected.minGradeId != null) return selected.minGradeId;
  if (selected.maxGradeId != null) return selected.maxGradeId;
  if (lastUsedGradeId != null && grades.some((grade) => grade.difficultyId === lastUsedGradeId)) {
    return lastUsedGradeId;
  }
  return selectModalSendGrade(sendDifficultyIds) ?? defaultGradeCenter(grades);
}
