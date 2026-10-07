import type { SessionGradeDistributionItem } from '@boardsesh/shared-schema';
import { getGradeLabel } from '@boardsesh/db/queries';

/**
 * Compute session aggregate stats from tick rows.
 * Counts sends (flash + send), flashes, and attempts (including implicit
 * failed attempts from sends with attemptCount > 1).
 */
export function computeSessionAggregates(tickRows: Array<{ tick: { status: string; attemptCount: number } }>): {
  totalSends: number;
  totalFlashes: number;
  totalAttempts: number;
} {
  let totalSends = 0;
  let totalFlashes = 0;
  let totalAttempts = 0;
  for (const row of tickRows) {
    if (row.tick.status === 'flash') {
      totalFlashes++;
      totalSends++;
    } else if (row.tick.status === 'send') {
      totalSends++;
      totalAttempts += Math.max(row.tick.attemptCount - 1, 0);
    } else if (row.tick.status === 'attempt') {
      totalAttempts += row.tick.attemptCount;
    }
  }
  return { totalSends, totalFlashes, totalAttempts };
}

/**
 * Build grade distribution from pre-fetched tick rows (for session detail).
 * Includes implicit failed attempts from sends (attemptCount - 1) and
 * uses attemptCount for explicit attempt-status ticks.
 */
export function buildGradeDistributionFromTicks(
  tickRows: Array<{
    tick: { status: string; difficulty: number | null; boardType: string; attemptCount: number };
    difficultyName: string | null;
    consensusDifficulty?: number | null;
  }>,
): SessionGradeDistributionItem[] {
  const gradeMap = new Map<
    string,
    { grade: string; difficulty: number; flash: number; send: number; attempt: number }
  >();

  for (const row of tickRows) {
    const effectiveDifficulty =
      row.tick.difficulty ?? (row.consensusDifficulty != null ? Math.round(row.consensusDifficulty) : null);
    if (effectiveDifficulty == null) continue;
    const effectiveGradeName = row.difficultyName || getGradeLabel(effectiveDifficulty, row.tick.boardType) || null;
    if (!effectiveGradeName) continue;
    const key = `${effectiveGradeName}:${effectiveDifficulty}`;
    const existing = gradeMap.get(key) ?? {
      grade: effectiveGradeName,
      difficulty: effectiveDifficulty,
      flash: 0,
      send: 0,
      attempt: 0,
    };

    if (row.tick.status === 'flash') existing.flash++;
    else if (row.tick.status === 'send') {
      existing.send++;
      existing.attempt += Math.max(row.tick.attemptCount - 1, 0);
    } else if (row.tick.status === 'attempt') existing.attempt += row.tick.attemptCount;

    gradeMap.set(key, existing);
  }

  return [...gradeMap.values()]
    .sort((a, b) => b.difficulty - a.difficulty)
    .map(({ grade, flash, send, attempt }) => ({ grade, flash, send, attempt }));
}
