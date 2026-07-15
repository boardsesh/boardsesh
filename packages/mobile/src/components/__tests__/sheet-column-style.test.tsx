// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

// Mutable so a test can flip the platform; reset in beforeEach.
const platformMock = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android', Version: '26.1' as string }));

vi.mock('react-native', () => ({
  Platform: platformMock,
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));

import { useSheetColumnStyle } from '../sheet-column-style';

// SwiftUI's `.fraction(f)` detent measures against the FULL window height, so the
// column is round(844 × f) − 16pt grabber chrome. A px detent is the literal
// height − chrome. Everything non-iOS / dynamic / snap-less stays flex:1.
const FILL = { flex: 1 };

beforeEach(() => {
  platformMock.OS = 'ios';
  platformMock.Version = '26.1';
});

describe('useSheetColumnStyle', () => {
  it('bounds an iOS % detent to round(window × fraction) − chrome', () => {
    const { result } = renderHook(() => useSheetColumnStyle(['90%']));
    // round(844 × 0.9) − 16 = 760 − 16 = 744
    expect(result.current).toEqual({ height: 744 });
  });

  it('bounds an iOS px detent to the literal height − chrome', () => {
    const { result } = renderHook(() => useSheetColumnStyle([500]));
    expect(result.current).toEqual({ height: 484 });
  });

  it('selects the active detent among multiple % snap points', () => {
    const { result: shorter } = renderHook(() => useSheetColumnStyle(['50%', '90%'], { activeIndex: 0 }));
    const { result: taller } = renderHook(() => useSheetColumnStyle(['50%', '90%'], { activeIndex: 1 }));
    // round(844 × 0.5) − 16 = 406 ; round(844 × 0.9) − 16 = 744
    expect(shorter.current).toEqual({ height: 406 });
    expect(taller.current).toEqual({ height: 744 });
  });

  it('clamps activeIndex into range (over and under)', () => {
    const { result: over } = renderHook(() => useSheetColumnStyle(['50%', '90%'], { activeIndex: 9 }));
    const { result: under } = renderHook(() => useSheetColumnStyle(['50%', '90%'], { activeIndex: -3 }));
    expect(over.current).toEqual({ height: 744 }); // clamped to last (90%)
    expect(under.current).toEqual({ height: 406 }); // clamped to first (50%)
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
