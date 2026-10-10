// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const state = vi.hoisted(() => ({
  platform: 'ios',
  surfaceMode: 'glass',
  sheetSurface: '#EDE7F6',
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

vi.mock('../../hooks/use-effective-surface-mode', () => ({
  useEffectiveSurfaceMode: () => state.surfaceMode,
}));

import { useIosSheetBackgroundStyle } from '../use-ios-sheet-background-style';

describe('useIosSheetBackgroundStyle', () => {
  beforeEach(() => {
    state.platform = 'ios';
    state.surfaceMode = 'glass';
    state.sheetSurface = '#EDE7F6';
  });

  it.each(['glass', 'blur'])('keeps the native iOS presentation in %s mode', (surfaceMode) => {
    state.surfaceMode = surfaceMode;

    const { result } = renderHook(() => useIosSheetBackgroundStyle());

    expect(result.current).toBeUndefined();
  });

  it.each(['material', 'solid'])('uses an opaque plain-string iOS surface in %s mode', (surfaceMode) => {
    state.surfaceMode = surfaceMode;

    const { result } = renderHook(() => useIosSheetBackgroundStyle());

    expect(result.current).toEqual({ backgroundColor: state.sheetSurface });
    expect(typeof result.current?.backgroundColor).toBe('string');
  });

  it.each(['android', 'web'])('leaves %s background behavior to its existing sheet path', (platform) => {
    state.platform = platform;
    state.surfaceMode = 'material';

    const { result } = renderHook(() => useIosSheetBackgroundStyle());

    expect(result.current).toBeUndefined();
  });
});
