// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

// Mutable so a test can flip the platform; reset to ios in beforeEach.
const platformMock = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android' }));

vi.mock('react-native', () => ({
  Platform: platformMock,
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

import { useSheetColumnStyle } from '../use-sheet-column-style';

// window 844 − top inset 44 − 24pt card gap = 776 usable base for a % detent;
// then × fraction, minus the 20pt chrome margin. A px detent skips the gap.
const FILL = { flex: 1 };

beforeEach(() => {
  platformMock.OS = 'ios';
});

describe('useSheetColumnStyle', () => {
  it('bounds an iOS % detent to (window − topInset − gap) × fraction − chrome', () => {
    const { result } = renderHook(() => useSheetColumnStyle(['90%']));
    // round(776 × 0.9) − 20 = 678
    expect(result.current).toEqual({ height: 678 });
  });

  it('bounds an iOS px detent to the literal height − chrome', () => {
    const { result } = renderHook(() => useSheetColumnStyle([500]));
    expect(result.current).toEqual({ height: 480 });
  });

  it('selects the active detent among multiple % snap points', () => {
    const { result: shorter } = renderHook(() => useSheetColumnStyle(['50%', '90%'], { activeIndex: 0 }));
    const { result: taller } = renderHook(() => useSheetColumnStyle(['50%', '90%'], { activeIndex: 1 }));
    // round(776 × 0.5) − 20 = 368 ; round(776 × 0.9) − 20 = 678
    expect(shorter.current).toEqual({ height: 368 });
    expect(taller.current).toEqual({ height: 678 });
  });

  it('clamps activeIndex into range (over and under)', () => {
    const { result: over } = renderHook(() => useSheetColumnStyle(['50%', '90%'], { activeIndex: 9 }));
    const { result: under } = renderHook(() => useSheetColumnStyle(['50%', '90%'], { activeIndex: -3 }));
    expect(over.current).toEqual({ height: 678 }); // clamped to last (90%)
    expect(under.current).toEqual({ height: 368 }); // clamped to first (50%)
  });

  it('falls through to flex for a non-% string detent', () => {
    const { result } = renderHook(() => useSheetColumnStyle(['auto']));
    expect(result.current).toEqual(FILL);
  });

  it('stays flex when dynamic sizing is on', () => {
    const { result } = renderHook(() => useSheetColumnStyle(['90%'], { enableDynamicSizing: true }));
    expect(result.current).toEqual(FILL);
  });

  it('stays flex with no snap points', () => {
    const undefinedPoints = renderHook(() => useSheetColumnStyle(undefined));
    const emptyPoints = renderHook(() => useSheetColumnStyle([]));
    expect(undefinedPoints.result.current).toEqual(FILL);
    expect(emptyPoints.result.current).toEqual(FILL);
  });

  it('stays flex on Android (the native Material sheet bounds the column itself)', () => {
    platformMock.OS = 'android';
    const { result } = renderHook(() => useSheetColumnStyle(['90%']));
    expect(result.current).toEqual(FILL);
  });
});
