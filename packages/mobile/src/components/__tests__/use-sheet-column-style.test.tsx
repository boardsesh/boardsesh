// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

// The hook has no platform/dimension branches any more — @expo/ui 57.0.3 bounds
// the sheet content natively (RNHostView `.frame(maxHeight: .infinity)` +
// size-report), so the column is always `flex: 1` and fills the real detent. Mock
// react-native just enough for the import to resolve under jsdom.
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

import { useSheetColumnStyle } from '../use-sheet-column-style';

const FILL = { flex: 1 };

describe('useSheetColumnStyle', () => {
  it('returns a flex column for a % detent', () => {
    const { result } = renderHook(() => useSheetColumnStyle(['90%']));
    expect(result.current).toEqual(FILL);
  });

  it('returns a flex column for a px detent', () => {
    const { result } = renderHook(() => useSheetColumnStyle([500]));
    expect(result.current).toEqual(FILL);
  });

  it('returns a flex column across multiple detents regardless of active index', () => {
    const { result: first } = renderHook(() => useSheetColumnStyle(['50%', '90%'], { activeIndex: 0 }));
    const { result: second } = renderHook(() => useSheetColumnStyle(['50%', '90%'], { activeIndex: 1 }));
    expect(first.current).toEqual(FILL);
    expect(second.current).toEqual(FILL);
  });

  it('returns a flex column with dynamic sizing on', () => {
    const { result } = renderHook(() => useSheetColumnStyle(['90%'], { enableDynamicSizing: true }));
    expect(result.current).toEqual(FILL);
  });

  it('returns a flex column with no snap points', () => {
    const undefinedPoints = renderHook(() => useSheetColumnStyle(undefined));
    const emptyPoints = renderHook(() => useSheetColumnStyle([]));
    expect(undefinedPoints.result.current).toEqual(FILL);
    expect(emptyPoints.result.current).toEqual(FILL);
  });
});
