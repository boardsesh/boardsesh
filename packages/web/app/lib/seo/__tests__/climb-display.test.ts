import { describe, expect, it } from 'vite-plus/test';
import { climbBoardForSearch, climbGradeForSearch } from '../climb-display';

describe('readable climb search copy', () => {
  it('puts complete V grades first without losing the Font grade', () => {
    expect(climbGradeForSearch('6a/V3')).toBe('V3 (6a)');
    expect(climbGradeForSearch('V10/7c+')).toBe('V10 (7c+)');
    expect(climbGradeForSearch('V12')).toBe('V12');
    expect(climbGradeForSearch('7a')).toBe('7a');
  });
  it('uses a human board name once', () => {
    expect(climbBoardForSearch('kilter', 'Kilter Board Original')).toBe('Kilter Board Original');
    expect(climbBoardForSearch('tension', 'Original')).toBe('Tension Original');
    expect(climbBoardForSearch('moonboard')).toBe('MoonBoard');
  });
});
