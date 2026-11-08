// @vitest-environment jsdom
//
// The one background rule every native sheet shares. iOS hands over whatever
// the iOS resolver says (tested in use-ios-sheet-background-style.test.tsx).
// Android and web always get the opaque `sheetSurface`: an unset colour lets
// @expo/ui's Compose sheet paint itself from the phone wallpaper.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const state = vi.hoisted(() => ({
  platform: 'ios',
  sheetSurface: '#191422',
  iosStyle: undefined as { backgroundColor: string } | undefined,
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return state.platform;
    },
  },
}));

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ sheetSurface: state.sheetSurface }),
}));

vi.mock('../use-ios-sheet-background-style', () => ({
  useIosSheetBackgroundStyle: () => state.iosStyle,
}));

import { useSheetBackgroundStyle } from '../use-sheet-background-style';

describe('useSheetBackgroundStyle', () => {
  beforeEach(() => {
    state.platform = 'ios';
    state.sheetSurface = '#191422';
    state.iosStyle = undefined;
  });

  it('leaves the native iOS presentation alone when the iOS resolver does', () => {
    const { result } = renderHook(() => useSheetBackgroundStyle());

    expect(result.current).toBeUndefined();
  });

  it('passes the iOS override through untouched', () => {
    const iosStyle = { backgroundColor: '#EDE7F6' };
    state.iosStyle = iosStyle;

    const { result } = renderHook(() => useSheetBackgroundStyle());

    expect(result.current).toBe(iosStyle);
  });

  it.each(['android', 'web'])('paints the opaque sheet surface on %s', (platform) => {
    state.platform = platform;

    const { result } = renderHook(() => useSheetBackgroundStyle());

    expect(result.current).toEqual({ backgroundColor: '#191422' });
    expect(typeof result.current?.backgroundColor).toBe('string');
  });

  it.each(['android', 'web'])('ignores the iOS override on %s', (platform) => {
    state.platform = platform;
    state.iosStyle = { backgroundColor: '#EDE7F6' };

    const { result } = renderHook(() => useSheetBackgroundStyle());

    expect(result.current).toEqual({ backgroundColor: '#191422' });
  });

  it('keeps the same style object across renders, so the native sheet is not re-styled', () => {
    state.platform = 'android';

    const { result, rerender } = renderHook(() => useSheetBackgroundStyle());
    const first = result.current;
    rerender();

    expect(result.current).toBe(first);
  });
});
