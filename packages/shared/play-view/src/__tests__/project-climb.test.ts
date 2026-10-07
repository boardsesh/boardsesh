import { describe, it, expect } from 'vitest';
import { climbStatsKnown, isProjectClimb } from '../grade-display';

describe('isProjectClimb (#5971)', () => {
  it('is a published climb with no grade to show', () => {
    expect(isProjectClimb({ gradeLabel: '' })).toBe(true);
    expect(isProjectClimb({ gradeLabel: null })).toBe(true);
    expect(isProjectClimb({ gradeLabel: undefined, isDraft: false })).toBe(true);
    expect(isProjectClimb({ gradeLabel: '   ' })).toBe(true);
  });

  it('is not a climb with a grade to show', () => {
    expect(isProjectClimb({ gradeLabel: 'V4' })).toBe(false);
    expect(isProjectClimb({ gradeLabel: '6b/V4' })).toBe(false);
    // A Boardsesh estimate still counts as a grade.
    expect(isProjectClimb({ gradeLabel: '≈V3' })).toBe(false);
  });

  it('is never a draft, which has its own chip', () => {
    expect(isProjectClimb({ gradeLabel: '', isDraft: true })).toBe(false);
  });

  it('is not a climb whose stats the surface does not have yet', () => {
    expect(isProjectClimb({ gradeLabel: '', statsKnown: false })).toBe(false);
  });
});

describe('climbStatsKnown', () => {
  it('knows a spray climb always, and any other climb by its stats angle', () => {
    expect(climbStatsKnown('spray', null)).toBe(true);
    expect(climbStatsKnown('kilter', 40)).toBe(true);
    expect(climbStatsKnown('kilter', null)).toBe(false);
    expect(climbStatsKnown('tension', undefined)).toBe(false);
  });
});
