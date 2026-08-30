// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

// Mutable so a test can flip the platform / iOS version; reset in beforeEach.
const platformMock = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android', Version: '26.1' as string }));

vi.mock('react-native', () => ({
  Platform: platformMock,
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

import { useSheetColumnStyle } from '../use-sheet-column-style';

// window 844 − top inset 44 − 24pt card gap = 776 usable base for a % detent
// on iOS 26+; then × fraction, minus the 20pt chrome margin. A px detent skips
// the gap. Pre-26 iOS drops the card gap (776 → 800 usable).
const FILL = { flex: 1 };

beforeEach(() => {
  platformMock.OS = 'ios';
  platformMock.Version = '26.1';
});

describe('useSheetColumnStyle', () => {
  it('bounds an iOS % detent to (window − topInset − gap) × fraction − chrome', () => {
    const { result } = renderHook(() => useSheetColumnStyle(['90%']));
    // round(776 × 0.9) − 20 = 678
    expect(result.current).toEqual({ height: 678 });
  });

  it('drops the card gap on pre-26 iOS (no Liquid-Glass chrome to correct for)', () => {
    platformMock.Version = '18.4';
    const { result } = renderHook(() => useSheetColumnStyle(['90%']));
    // No 24pt gap: round((844 − 44) × 0.9) − 20 = round(720) − 20 = 700
    expect(result.current).toEqual({ height: 700 });
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

  it('caps the Android column at window − topInset − chrome on the content-fitting path (#4720)', () => {
    // A `flex: 1` column resolves to zero inside a `matchContents` RNHostView, so
    // the content-fitting path takes a `maxHeight` ceiling instead — the form
    // measures under it, a keyboard-up long note shrink-scrolls into it.
    // round(844 − 44 − 20) = 780.
    platformMock.OS = 'android';
    const { result } = renderHook(() => useSheetColumnStyle(['65%', '92%'], { contentSizedOnAndroid: true }));
    expect(result.current).toEqual({ maxHeight: 780 });
  });

  it('ignores contentSizedOnAndroid on iOS (detents still win there)', () => {
    const { result } = renderHook(() => useSheetColumnStyle(['90%'], { contentSizedOnAndroid: true }));
    // round(776 × 0.9) − 20 = 678, exactly as without the flag.
    expect(result.current).toEqual({ height: 678 });
  });
});
