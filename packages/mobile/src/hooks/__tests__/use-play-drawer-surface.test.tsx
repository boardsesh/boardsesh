// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { SurfaceMode } from '../use-effective-surface-mode';
import type { UiVariant } from '../../theme/resolve-ui-variant';

const appearance = vi.hoisted(() => ({
  scheme: 'dark' as 'light' | 'dark',
  variant: 'liquidGlass' as UiVariant,
  mode: 'glass' as SurfaceMode,
  platform: 'ios',
}));
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return appearance.platform;
    },
  },
  PlatformColor: (name: string) => ({ semantic: name }),
  DynamicColorIOS: (colors: unknown) => colors,
}));
vi.mock('../use-effective-surface-mode', () => ({ useEffectiveSurfaceMode: () => appearance.mode }));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: appearance.variant,
    colorScheme: appearance.scheme,
    systemColors: {
      secondaryBackground:
        appearance.variant === 'material'
          ? materialSurfaces[appearance.scheme].secondaryBackground
          : appearance.platform === 'ios'
            ? { semantic: 'secondarySystemBackground' }
            : androidFallbackColors[appearance.scheme].secondaryBackground,
    },
    m3SurfaceContainers: materialSurfaceContainers[appearance.scheme],
  }),
}));
import {
  androidFallbackColors,
  materialSurfaces,
  materialSurfaceContainers,
  playDrawerMaterialTint,
} from '../../theme/colors';
import { usePlayDrawerSurface } from '../use-play-drawer-surface';

beforeEach(() => {
  appearance.scheme = 'dark';
  appearance.variant = 'liquidGlass';
  appearance.mode = 'glass';
  appearance.platform = 'ios';
});

describe('player surface and board veil', () => {
  it.each(['glass', 'blur'] as const)(
    'uses iOS secondary system colors without the ignored tint in %s mode',
    (mode) => {
      appearance.mode = mode;
      const { result, rerender } = renderHook(usePlayDrawerSurface);
      expect(result.current.fieldColor).toBe('#1C1C1E');
      expect(result.current.backgroundProps).toEqual({
        color: { semantic: 'secondarySystemBackground' },
        fallbackColor: { semantic: 'secondarySystemBackground' },
        role: 'low',
        tintColor: playDrawerMaterialTint.liquidGlass.dark,
      });
      appearance.scheme = 'light';
      rerender();
      expect(result.current.fieldColor).toBe('#F2F2F7');
    },
  );

  it.each(['ios', 'android'])(
    '%s tracks Material low tone, Reduce Transparency and theme changes using the route tint',
    (platform) => {
      appearance.platform = platform;
      appearance.variant = 'material';
      appearance.mode = 'material';
      const { result, rerender } = renderHook(usePlayDrawerSurface);
      // low #161616 under 55% #0e0e0e; solid uses secondary #1e1e1e.
      expect(result.current.fieldColor).toBe('#121212');
      appearance.mode = 'solid';
      rerender();
      expect(result.current.fieldColor).toBe('#151515');
      appearance.scheme = 'light';
      appearance.mode = 'material';
      rerender();
      // low #eaeaea under 60% white.
      expect(result.current.fieldColor).toBe('#f7f7f7');
      appearance.mode = 'solid';
      rerender();
      expect(result.current.fieldColor).toBe('#ffffff');
    },
  );

  it('uses the correct iOS and Android secondary bases when Reduce Transparency forces solid', () => {
    appearance.mode = 'solid';
    const { result, rerender } = renderHook(usePlayDrawerSurface);
    expect(result.current.fieldColor).toBe('#15131a');
    appearance.platform = 'android';
    rerender();
    expect(result.current.fieldColor).toBe('#130e1d');
  });
});
