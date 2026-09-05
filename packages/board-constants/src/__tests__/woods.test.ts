// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { describe, it, expect } from 'vite-plus/test';
import { BOULDER_GRADES } from '../boulder-grade-mapping';
import { WOODS_DIFFICULTY_IDS, WOODS_GRADE_TO_DIFFICULTY, woodsGradeToDifficulty } from '../woods';

/**
 * Drift guard for the Woods grade table (design decision D4). The table is
 * hand-written, but it is not arbitrary: a Woods problem grade is a 0-based V
 * number, and each entry must be the LOWEST `BOULDER_GRADES.difficulty_id` in that
 * V band — the same rule `MOONBOARD_GRADE_TO_DIFFICULTY` follows. Re-deriving it
 * here means a row edited by hand, or a grade inserted into `BOULDER_GRADES`, fails
 * loudly instead of silently re-grading 5,392 imported climbs.
 */
const lowestDifficultyIdForVGrade = (vGrade: string): number =>
  Math.min(...BOULDER_GRADES.filter((grade) => grade.v_grade === vGrade).map((grade) => grade.difficulty_id));

describe('WOODS_GRADE_TO_DIFFICULTY', () => {
  it.each(Object.entries(WOODS_GRADE_TO_DIFFICULTY))(
    'maps Woods grade %s to the lowest difficulty id in its V band',
    (problemGrade, difficultyId) => {
      // V17 has no band of its own — the shared table stops at 8c+/V16 — so it
      // clamps onto V16's id rather than falling off the scale.
      const vGrade = `V${Math.min(Number(problemGrade), 16)}`;
      expect(difficultyId).toBe(lowestDifficultyIdForVGrade(vGrade));
    },
  );

  it('carries 17 distinct difficulty ids (V17 folds into V16)', () => {
    expect(Object.keys(WOODS_GRADE_TO_DIFFICULTY)).toHaveLength(18);
    expect(WOODS_DIFFICULTY_IDS.size).toBe(17);
  });
});

describe('woodsGradeToDifficulty', () => {
  it('clamps V17 onto V16 rather than dropping the climb', () => {
    expect(woodsGradeToDifficulty(17)).toBe(33);
  });

  it('returns null for a grade the Woods app never emits', () => {
    expect(woodsGradeToDifficulty(18)).toBeNull();
    expect(woodsGradeToDifficulty(-1)).toBeNull();
  });
});
