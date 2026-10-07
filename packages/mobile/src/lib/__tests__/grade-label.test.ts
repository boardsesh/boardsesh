import { describe, expect, it } from 'vitest';
import { BOULDER_GRADES } from '@boardsesh/board-config';
import { getDifficultyIdForGradeName, getGradeLabel, getSoleBoardType } from '../grade-label';

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

describe('getGradeLabel on a board scale', () => {
  it("labels 16 the way MoonBoard does, so local search matches the server's boulder_name", () => {
    expect(getGradeLabel(16, 'moonboard')).toBe('6a/V2');
    expect(getGradeLabel(16, 'kilter')).toBe('6a/V3');
    expect(getGradeLabel(16)).toBe('6a/V3');
  });

  it('keeps every other id the same on MoonBoard', () => {
    expect(getGradeLabel(17, 'moonboard')).toBe(getGradeLabel(17));
    expect(getGradeLabel(22, 'moonboard')).toBe('7a/V6');
  });

  it('takes the MoonBoard name back to the same id', () => {
    expect(getDifficultyIdForGradeName(getGradeLabel(16, 'moonboard'))).toBe(16);
  });
});

describe('getSoleBoardType', () => {
  it('names the board only when the session has exactly one', () => {
    expect(getSoleBoardType(['moonboard'])).toBe('moonboard');
    expect(getSoleBoardType(['moonboard', 'kilter'])).toBeNull();
    expect(getSoleBoardType([])).toBeNull();
    expect(getSoleBoardType(undefined)).toBeNull();
  });
});
