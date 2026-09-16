import { describe, expect, it } from 'vitest';
import { BOULDER_GRADES } from '@boardsesh/board-config';
import { getDifficultyIdForGradeName, getGradeLabel } from '../grade-label';

// `getDifficultyIdForGradeName` is the inverse of `getGradeLabel`, and what a
// spray-wall remix resolves its parent's grade through (#5443). The string it is
// handed is `Climb.difficulty`, which the server built with its own copy of this
// table — so the contract that matters is "accepts exactly what the server sends,
// and refuses anything it would have to guess at".

describe('getDifficultyIdForGradeName', () => {
  const accepted: Array<[string, number]> = [
    // The canonical names, as the server writes them.
    ['4a/V0', 10],
    ['6b/V4', 18],
    ['6c/V5', 20],
    ['7a/V6', 22],
    ['8c+/V16', 33],
    // Case-insensitive: the V is upper in the table, but a hand-built deep link
    // or an older payload may not be.
    ['6B/V4', 18],
    ['6b/v4', 18],
    ['7A/V6', 22],
    // Trimmed, because a route param can arrive with padding.
    ['  6b/V4', 18],
    ['6b/V4  ', 18],
    ['\t6b/V4\n', 18],
  ];

  it.each(accepted)('resolves %j to %i', (gradeName, difficultyId) => {
    expect(getDifficultyIdForGradeName(gradeName)).toBe(difficultyId);
  });

  const refused: Array<[string, string | null | undefined]> = [
    // A DISPLAY label, not a name. "V4" is both 6b and 6b+, so resolving it would
    // silently re-grade the climb — the whole reason this matches the full name.
    ['a bare V grade', 'V4'],
    ['a bare Font grade', '6b'],
    ['a Font grade with a plus', '6b+'],
    // Not on the scale at all.
    ['an invented grade', 'V99'],
    ['prose', 'hard'],
    // Absent, which is what an ungraded climb carries.
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['null', null],
    ['undefined', undefined],
  ];

  it.each(refused)('refuses %s', (_label, gradeName) => {
    expect(getDifficultyIdForGradeName(gradeName)).toBeNull();
  });

  it('round-trips every grade on the shared scale', () => {
    // The strongest form of the contract: whatever `getGradeLabel` can produce,
    // this has to take back. A divergence between the two tables would open the
    // remix ungraded for exactly the grades that fell out of step.
    for (const grade of BOULDER_GRADES) {
      const label = getGradeLabel(grade.difficulty_id);
      expect(label).not.toBe('');
      expect(getDifficultyIdForGradeName(label)).toBe(grade.difficulty_id);
    }
  });
});
