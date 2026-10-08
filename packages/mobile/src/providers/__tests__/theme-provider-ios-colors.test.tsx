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
  Appearance: { setColorScheme: () => undefined },
}));
vi.mock('expo-glass-effect', () => ({
  isLiquidGlassAvailable: () => true,
  isGlassEffectAPIAvailable: () => true,
}));

import { ThemeProvider, useTheme } from '../theme-provider';

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

  it('uses the brand violet as the accent, not the system link blue', async () => {
    const light = await renderTheme('light');
    expect(light.current.systemColors.accent).toBe('#6D28D9');
    expect(light.current.systemColors.accent).not.toBe('link');
  });

  it('lifts the accent in dark so it stays the brand tint and clears AA', async () => {
    const dark = await renderTheme('dark');
    expect(dark.current.systemColors.accent).toBe('#A78BFA');
    expect(dark.current.systemColors.accent).toBe(dark.current.brandColors.tint);
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
    expect(theme.current.systemColors.accent).toBe('#6D28D9');
  });
});
