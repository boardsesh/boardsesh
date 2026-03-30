import type { SessionGradeDistributionItem } from '@boardsesh/shared-schema';

/**
 * Compute session aggregate stats from tick rows.
 * Counts sends (flash + send), flashes, and attempts (including implicit
 * failed attempts from sends with attemptCount > 1).
 */
export function computeSessionAggregates(
  tickRows: Array<{ tick: { status: string; attemptCount: number } }>,
): { totalSends: number; totalFlashes: number; totalAttempts: number } {
  let totalSends = 0;
  let totalFlashes = 0;
  let totalAttempts = 0;
  for (const row of tickRows) {
    if (row.tick.status === 'flash') { totalFlashes++; totalSends++; }
    else if (row.tick.status === 'send') {
      totalSends++;
      totalAttempts += Math.max(row.tick.attemptCount - 1, 0);
    }
    else if (row.tick.status === 'attempt') { totalAttempts += row.tick.attemptCount; }
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
  }>,
): SessionGradeDistributionItem[] {
  const gradeMap = new Map<string, { grade: string; difficulty: number; flash: number; send: number; attempt: number }>();

  for (const row of tickRows) {
    if (row.tick.difficulty == null || !row.difficultyName) continue;
    const key = `${row.difficultyName}:${row.tick.difficulty}`;
    const existing = gradeMap.get(key) ?? { grade: row.difficultyName, difficulty: row.tick.difficulty, flash: 0, send: 0, attempt: 0 };

    if (row.tick.status === 'flash') existing.flash++;
    else if (row.tick.status === 'send') {
      existing.send++;
      existing.attempt += Math.max(row.tick.attemptCount - 1, 0);
    }
    else if (row.tick.status === 'attempt') existing.attempt += row.tick.attemptCount;

    gradeMap.set(key, existing);
  }

  return [...gradeMap.values()]
    .sort((a, b) => b.difficulty - a.difficulty)
    .map(({ grade, difficulty, flash, send, attempt }) => ({ grade, difficulty, flash, send, attempt }));
}
