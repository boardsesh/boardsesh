// @vitest-environment jsdom
// The iOS Liquid Glass palette: one brand tint for the interactive accent (HIG
// Color) and an adaptive `error` role (HIG Dark Mode / Increase Contrast).
//
// Unlike theme-provider.test.tsx, Platform.OS is 'ios' at IMPORT time here, so
// `iosSystemColors` in src/theme/colors is built and the real Liquid Glass branch
// runs. PlatformColor is a passthrough that returns the semantic name, so an
// assertion of 'systemRed' proves the value is the adaptive system colour rather
// than a static hex.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const { useColorSchemeMock } = vi.hoisted(() => ({ useColorSchemeMock: vi.fn() }));
vi.mock('../../lib/preferences/secure-store-adapter', () => ({
  secureStorePreferences: {
    get: () => Promise.resolve(null),
    set: () => Promise.resolve(undefined),
    remove: () => Promise.resolve(undefined),
  },
}));
vi.mock('../../lib/theme/document-appearance', () => ({ syncDocumentAppearance: () => undefined }));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  useColorScheme: () => useColorSchemeMock(),
  PlatformColor: (name: string) => name,
  // Returns its appearance map so the test can read every variant, incl. Increase Contrast.
  DynamicColorIOS: (appearances: Record<string, string>) => ({ dynamic: appearances }),
  Appearance: { setColorScheme: () => undefined },
}));
vi.mock('expo-glass-effect', () => ({
  isLiquidGlassAvailable: () => true,
  isGlassEffectAPIAvailable: () => true,
}));

import { ThemeProvider, useTheme } from '../theme-provider';
import { brandAccentDynamic } from '../../theme/colors';
import { contrastRatioHex, oklch, parseHex } from '../../lib/color-contrast-oracle';

const wrapper = ({ children }: { children: ReactNode }) => <ThemeProvider>{children}</ThemeProvider>;

async function renderTheme(scheme: 'light' | 'dark') {
  useColorSchemeMock.mockReturnValue(scheme);
  const { result } = renderHook(() => useTheme(), { wrapper });
  await waitFor(() => expect(result.current.colorScheme).toBe(scheme));
  return result;
}

describe('ThemeProvider on iOS Liquid Glass', () => {
  beforeEach(() => {
    useColorSchemeMock.mockReset();
  });

  it('runs the Liquid Glass branch with adaptive PlatformColor labels', async () => {
    const theme = await renderTheme('light');
    expect(theme.current.variant).toBe('liquidGlass');
    expect(theme.current.systemColors.secondaryLabel).toBe('secondaryLabel');
  });

  it('uses the brand violet as the accent, adaptive to dark mode and Increase Contrast', async () => {
    const theme = await renderTheme('light');
    expect(theme.current.systemColors.accent).toEqual({
      dynamic: {
        light: '#5B22F2',
        dark: '#9784FF',
        highContrastLight: '#5613EA',
        highContrastDark: '#B6AFFF',
      },
    });
    expect(theme.current.systemColors.accent).not.toBe('link');
  });

  it('keeps the Increase Contrast accent at 7:1 on the grouped grounds, on the brand hue', () => {
    // HIG Contrast: 7:1 under Increase Contrast. Light on #F2F2F7 (and white), dark
    // on the elevated grouped card #2C2C2E (and #1C1C1E).
    for (const ground of ['#F2F2F7', '#FFFFFF']) {
      expect(contrastRatioHex(brandAccentDynamic.highContrastLight, ground), ground).toBeGreaterThanOrEqual(7);
    }
    for (const ground of ['#2C2C2E', '#1C1C1E', '#000000']) {
      expect(contrastRatioHex(brandAccentDynamic.highContrastDark, ground), ground).toBeGreaterThanOrEqual(7);
    }
    // Same hue as the tint it stands in for (OKLCH, within a few degrees).
    const hue = (hex: string) => oklch(parseHex(hex)).h;
    expect(Math.abs(hue(brandAccentDynamic.highContrastLight) - hue(brandAccentDynamic.light))).toBeLessThan(3);
    expect(Math.abs(hue(brandAccentDynamic.highContrastDark) - hue(brandAccentDynamic.dark))).toBeLessThan(3);
  });

  it('keeps the accent appearances on the brand tint of each scheme', async () => {
    const dark = await renderTheme('dark');
    const accent = dark.current.systemColors.accent as unknown as { dynamic: Record<string, string> };
    expect(accent.dynamic.dark).toBe(dark.current.brandColors.tint);
  });

  it('gives large shapes the lighter tertiarySystemFill', async () => {
    const theme = await renderTheme('light');
    expect(theme.current.systemColors.tertiaryFill).toBe('tertiarySystemFill');
    expect(theme.current.systemColors.fill).toBe('systemFill');
  });

  it('builds the v2 page ladders from the adaptive iOS system backgrounds', async () => {
    const theme = await renderTheme('dark');
    expect(theme.current.surfaces).toEqual({
      plain: {
        page: 'systemBackground',
        card: 'secondarySystemBackground',
        tile: 'tertiarySystemBackground',
      },
      grouped: {
        page: 'systemGroupedBackground',
        card: 'secondarySystemGroupedBackground',
        tile: 'tertiarySystemGroupedBackground',
      },
    });
  });

  it('resolves selection to label, accent and the brand wash, and status to the system fills', async () => {
    const light = await renderTheme('light');
    expect(light.current.selection.text).toBe('label');
    expect(light.current.selection.checkmark).toBe(light.current.systemColors.accent);
    // The current-climb wash in the Climbs list: the #5B22F2 fill at 13% in light...
    expect(light.current.selection.fill).toBe('rgba(91, 34, 242, 0.13)');
    expect(light.current.status).toEqual({ fill: 'tertiarySystemFill', label: 'secondaryLabel' });
  });

  it('mixes the dark selection wash from the dark fill, not the tint', async () => {
    const dark = await renderTheme('dark');
    // ...and the #7855FF fill (never the #9784FF tint) at 20% in dark.
    expect(dark.current.selection.fill).toBe('rgba(120, 85, 255, 0.2)');
  });

  it('routes errors through the adaptive systemRed', async () => {
    const theme = await renderTheme('dark');
    expect(theme.current.systemColors.error).toBe('systemRed');
  });

  it('keeps the M3 error role on the Material variant', async () => {
    const theme = await renderTheme('light');
    await act(async () => {
      await theme.current.setUiVariant('material');
    });
    await waitFor(() => expect(theme.current.variant).toBe('material'));
    expect(theme.current.systemColors.error).toBe('#C81E1E');
    expect(theme.current.systemColors.accent).toBe('#5B22F2');
  });
});
