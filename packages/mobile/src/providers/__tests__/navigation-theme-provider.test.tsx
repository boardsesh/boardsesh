// @vitest-environment jsdom
// The React Navigation theme's dark `background` is the ground every stack paints
// under its transparent content. On iOS Liquid Glass it must be the adaptive
// `systemBackground` PlatformColor, so a scene in a sheet resolves to the
// elevated colour instead of a static #000 under elevated cards.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';

type NavigationTheme = { dark: boolean; colors: Record<string, unknown> };

const ctrl = vi.hoisted(() => ({
  os: 'ios' as 'ios' | 'android',
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
  colorScheme: 'dark' as 'light' | 'dark',
  navTheme: null as NavigationTheme | null,
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return ctrl.os;
    },
  },
  // `iosDarkColors` sits beside the PlatformColor palette, which builds at import.
  PlatformColor: (name: string) => name,
  DynamicColorIOS: (appearances: { dark: string }) => appearances.dark,
}));
vi.mock('react-native-edge-to-edge', () => ({ SystemBars: () => null }));
vi.mock('expo-router', () => ({
  DarkTheme: { dark: true, colors: { background: 'rgb(1, 1, 1)', card: 'rgb(18, 18, 18)', text: 'white' } },
  DefaultTheme: { dark: false, colors: { background: 'rgb(242, 242, 242)', card: 'white', text: 'black' } },
  ThemeProvider: ({ value, children }: { value: NavigationTheme; children: ReactNode }) => {
    ctrl.navTheme = value;
    return children;
  },
}));
vi.mock('../theme-provider', () => ({
  useTheme: () => ({
    colorScheme: ctrl.colorScheme,
    variant: ctrl.variant,
    // PlatformColor stand-ins on iOS Liquid Glass; hex on the other branches.
    systemColors: { label: ctrl.os === 'ios' && ctrl.variant === 'liquidGlass' ? 'label' : '#EDEDED' },
    surfaces: {
      plain: {
        page: ctrl.os === 'ios' && ctrl.variant === 'liquidGlass' ? 'systemBackground' : '#0E0E0E',
      },
    },
  }),
}));

import { ThemedNavigation } from '../navigation-theme-provider';

function renderedTheme(): NavigationTheme {
  render(
    <ThemedNavigation>
      <span />
    </ThemedNavigation>,
  );
  if (!ctrl.navTheme) throw new Error('ThemedNavigation rendered no navigation theme');
  return ctrl.navTheme;
}

describe('ThemedNavigation page ground', () => {
  beforeEach(() => {
    ctrl.os = 'ios';
    ctrl.variant = 'liquidGlass';
    ctrl.colorScheme = 'dark';
    ctrl.navTheme = null;
  });

  it('paints dark iOS Liquid Glass scenes with the adaptive systemBackground', () => {
    const theme = renderedTheme();
    expect(theme.colors.background).toBe('systemBackground');
    expect(theme.colors.card).toBe('#1C1C1E');
  });

  it('keeps the static #000 page on Android', () => {
    ctrl.os = 'android';
    expect(renderedTheme().colors.background).toBe('#000000');
  });

  it('keeps the static #000 page for Material on iOS', () => {
    ctrl.variant = 'material';
    expect(renderedTheme().colors.background).toBe('#000000');
  });

  it("leaves the light theme on React Navigation's default ground", () => {
    ctrl.colorScheme = 'light';
    expect(renderedTheme().colors.background).toBe('rgb(242, 242, 242)');
  });
});
