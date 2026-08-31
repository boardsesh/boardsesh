// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

// Controllable stand-ins for the three hooks useDisplayGrade composes, so
// these tests exercise the composition (hard kill switch, resolveGrade
// wiring) rather than AsyncStorage/PostHog plumbing already covered by each
// dependency's own tests.
const ctrl = vi.hoisted(() => ({
  flagEnabled: false,
  preferenceEnabled: false,
  gradeFormat: 'v-grade' as 'v-grade' | 'font' | 'both',
}));

vi.mock('../../providers/feature-flags-provider', () => ({
  useBoardseshGradeEnabled: () => ctrl.flagEnabled,
}));

vi.mock('../../lib/boardsesh-grades-preference', () => ({
  useBoardseshGradesPreference: () => ({
    enabled: ctrl.preferenceEnabled,
    loaded: true,
    setEnabled: vi.fn(),
  }),
}));

vi.mock('../use-grade-format', () => ({
  useGradeFormat: () => ({
    gradeFormat: ctrl.gradeFormat,
    setGradeFormat: vi.fn(),
    loaded: true,
    formatGrade: vi.fn(),
    formatGradeByDifficultyId: vi.fn(),
  }),
}));

import { useBoardseshGradesActive, useDisplayGrade } from '../use-display-grade';

describe('useBoardseshGradesActive', () => {
  it('is off when the flag is off, even if the preference is on (hard kill switch)', () => {
    ctrl.flagEnabled = false;
    ctrl.preferenceEnabled = true;
    expect(renderHook(() => useBoardseshGradesActive()).result.current).toBe(false);
  });

  it('is off when the preference is off, even if the flag is on', () => {
    ctrl.flagEnabled = true;
    ctrl.preferenceEnabled = false;
    expect(renderHook(() => useBoardseshGradesActive()).result.current).toBe(false);
  });

  it('is on only when both the flag and the preference are on', () => {
    ctrl.flagEnabled = true;
    ctrl.preferenceEnabled = true;
    expect(renderHook(() => useBoardseshGradesActive()).result.current).toBe(true);
  });
});

describe('useDisplayGrade', () => {
  const climb = { difficulty: '6b/V4', boardseshDifficulty: 20, boardseshConfidence: 'confirmed' };

  it('resolveGrade renders the legacy grade when inactive', () => {
    ctrl.flagEnabled = false;
    ctrl.preferenceEnabled = false;
    ctrl.gradeFormat = 'v-grade';

    const { result } = renderHook(() => useDisplayGrade());
    expect(result.current.boardseshActive).toBe(false);
    expect(result.current.resolveGrade(climb)).toEqual({
      label: 'V4',
      color: expect.stringMatching(/^#/),
      isBoardsesh: false,
      isEstimated: false,
    });
  });

  it('resolveGrade renders the Boardsesh grade when active', () => {
    ctrl.flagEnabled = true;
    ctrl.preferenceEnabled = true;
    ctrl.gradeFormat = 'v-grade';

    const { result } = renderHook(() => useDisplayGrade());
    expect(result.current.boardseshActive).toBe(true);
    // 20 = 6c/V5, differs from the legacy 6b/V4 so the swap is observable.
    expect(result.current.resolveGrade(climb)).toEqual({
      label: 'V5',
      color: expect.stringMatching(/^#/),
      isBoardsesh: true,
      isEstimated: false,
    });
  });
});
