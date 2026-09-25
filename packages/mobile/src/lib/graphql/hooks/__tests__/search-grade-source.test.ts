import { describe, expect, it } from 'vitest';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import { climbSearchScrollKey, withGradeSource } from '../search-grade-source';

const board: ClimbSearchInput = { boardName: 'kilter', layoutId: 1, sizeId: 2, setIds: '3', angle: 40 };

describe('withGradeSource', () => {
  it('attaches BOARDSESH when active and a grade bound or the difficulty sort can read it', () => {
    expect(withGradeSource({ ...board, minGrade: 16 }, true).gradeSource).toBe('BOARDSESH');
    expect(withGradeSource({ ...board, maxGrade: 20 }, true).gradeSource).toBe('BOARDSESH');
    expect(withGradeSource({ ...board, sortBy: 'difficulty' }, true).gradeSource).toBe('BOARDSESH');
  });

  it('leaves the field off when nothing reads it, with 0 as the unset grade bound', () => {
    expect(withGradeSource(board, true)).not.toHaveProperty('gradeSource');
    expect(withGradeSource({ ...board, minGrade: 0, maxGrade: 0 }, true)).not.toHaveProperty('gradeSource');
    expect(withGradeSource({ ...board, sortBy: 'ascents' }, true)).not.toHaveProperty('gradeSource');
  });

  it('strips a pre-existing gradeSource when Boardsesh grades are off', () => {
    const result = withGradeSource({ ...board, minGrade: 16, gradeSource: 'BOARDSESH' }, false);
    expect(result).not.toHaveProperty('gradeSource');
    expect(result).toEqual({ ...board, minGrade: 16 });
  });

  it('strips a pre-existing gradeSource when no grade bound or difficulty sort reads it', () => {
    expect(withGradeSource({ ...board, gradeSource: 'BOARDSESH' }, true)).not.toHaveProperty('gradeSource');
    expect(withGradeSource({ ...board, gradeSource: 'UPSTREAM' }, true)).not.toHaveProperty('gradeSource');
  });

  it('returns the same object when there is nothing to change', () => {
    const input = { ...board, name: 'Moonage' };
    expect(withGradeSource(input, false)).toBe(input);
  });
});

describe('climbSearchScrollKey', () => {
  const graded: ClimbSearchInput = { ...board, minGrade: 16, maxGrade: 18 };

  it('changes when Boardsesh grades flip on a graded search, so the list scrolls to the top', () => {
    expect(climbSearchScrollKey(graded, true)).not.toBe(climbSearchScrollKey(graded, false));
  });

  it('changes for the difficulty sort too', () => {
    const bySort: ClimbSearchInput = { ...board, sortBy: 'difficulty' };
    expect(climbSearchScrollKey(bySort, true)).not.toBe(climbSearchScrollKey(bySort, false));
  });

  it('stays put when the flip cannot change the results', () => {
    expect(climbSearchScrollKey(board, true)).toBe(climbSearchScrollKey(board, false));
  });

  it('ignores page and property order', () => {
    const reordered: ClimbSearchInput = {
      maxGrade: 18,
      minGrade: 16,
      angle: 40,
      setIds: '3',
      sizeId: 2,
      layoutId: 1,
      boardName: 'kilter',
    };
    expect(climbSearchScrollKey({ ...graded, page: 4 }, true)).toBe(climbSearchScrollKey(reordered, true));
  });
});
