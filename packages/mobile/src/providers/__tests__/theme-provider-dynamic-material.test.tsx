// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Material3Theme } from '@pchmn/expo-material3-theme';
import { THEME_OVERRIDE_KEY, UI_VARIANT_KEY } from '@boardsesh/key-value-storage';

const getMock = vi.fn();
const setMock = vi.fn();
const useColorSchemeMock = vi.fn();
const resetMaterial3ThemeMock = vi.hoisted(() => vi.fn());
const appStateChangeListeners = vi.hoisted(() => [] as Array<(state: string) => void>);

vi.mock('../../lib/preferences/secure-store-adapter', () => ({
  secureStorePreferences: {
    get: (key: string) => getMock(key),
    set: (key: string, storedPreference: unknown) => setMock(key, storedPreference),
    remove: vi.fn(),
  },
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'android', Version: 35 },
  useColorScheme: () => useColorSchemeMock(),
  PlatformColor: (name: string) => name,
  Appearance: { setColorScheme: vi.fn() },
  AppState: {
    addEventListener: (_eventName: string, listener: (state: string) => void) => {
      appStateChangeListeners.push(listener);
      return { remove: vi.fn() };
    },
  },
}));

vi.mock('expo-glass-effect', () => ({
  isLiquidGlassAvailable: () => false,
  isGlassEffectAPIAvailable: () => false,
}));

const dynamicMaterialTheme = vi.hoisted(
  () =>
    ({
      light: {
        primary: '#3366AA',
        onPrimary: '#FFFFFF',
        background: '#FBF8FF',
        onSurface: '#191C20',
        onSurfaceVariant: '#42474E',
        outlineVariant: '#C2C7CF',
        surfaceContainerLow: '#F5F2FA',
        surfaceContainer: '#EFECF4',
        elevation: { level2: '#ECEFF8' },
      },
      dark: {
        primary: '#A8C7FA',
        onPrimary: '#071426',
        background: '#101418',
        onSurface: '#E1E2E8',
        onSurfaceVariant: '#C2C7CF',
        outlineVariant: '#42474E',
        surfaceContainerLow: '#1A1C20',
        surfaceContainer: '#1E2024',
        elevation: { level2: '#242832' },
      },
    }) as unknown as Material3Theme,
);

const fallbackMaterialTheme = vi.hoisted(
  () =>
    ({
      light: {
        primary: '#6D28D9',
        onPrimary: '#FFFFFF',
        background: '#F3EFFA',
        onSurface: '#000000',
        onSurfaceVariant: 'rgba(60, 60, 67, 0.6)',
        outlineVariant: 'rgba(60, 60, 67, 0.18)',
        surfaceContainerLow: '#FFFFFF',
        surfaceContainer: '#FFFFFF',
        elevation: { level2: '#FFFFFF' },
      },
      dark: {
        primary: '#7C3AED',
        onPrimary: '#FFFFFF',
        background: '#15101E',
        onSurface: '#FFFFFF',
        onSurfaceVariant: 'rgba(235, 235, 245, 0.6)',
        outlineVariant: 'rgba(235, 235, 245, 0.18)',
        surfaceContainerLow: '#221A33',
        surfaceContainer: '#2A2142',
        elevation: { level2: '#2A2142' },
      },
    }) as unknown as Material3Theme,
);

vi.mock('@pchmn/expo-material3-theme', () => ({
  isDynamicThemeSupported: true,
  createMaterial3Theme: () => fallbackMaterialTheme,
  useMaterial3Theme: () => ({
    theme: dynamicMaterialTheme,
    updateTheme: () => undefined,
    resetTheme: resetMaterial3ThemeMock,
  }),
}));

import { ThemeProvider, useTheme } from '../theme-provider';

const wrapper = ({ children }: { children: ReactNode }) => <ThemeProvider>{children}</ThemeProvider>;

describe('ThemeProvider dynamic Material color', () => {
  beforeEach(() => {
    getMock.mockReset();
    setMock.mockReset();
    useColorSchemeMock.mockReset();
    resetMaterial3ThemeMock.mockReset();
    appStateChangeListeners.length = 0;
    getMock.mockResolvedValue(null);
    setMock.mockResolvedValue(undefined);
    useColorSchemeMock.mockReturnValue('light');
  });

  it('uses the Android 12+ dynamic palette for the Material variant', async () => {
    const { result } = renderHook(() => useTheme(), { wrapper });

    await waitFor(() => expect(getMock).toHaveBeenCalledWith(UI_VARIANT_KEY));

    expect(result.current.variant).toBe('material');
    expect(result.current.systemColors.background).toBe('#FBF8FF');
    expect(result.current.systemColors.secondaryBackground).toBe('#F5F2FA');
    expect(result.current.systemColors.elevatedSurface).toBe('#ECEFF8');
    expect(result.current.systemColors.fill).toBe('rgba(51, 102, 170, 0.12)');
    expect(result.current.brandColors.primary).toBe('#3366AA');
    expect(result.current.dynamicMaterialColors?.primary).toBe('#3366AA');
  });

  it('composes dynamic Material colors with the appearance override', async () => {
    getMock.mockImplementation((key: string) => Promise.resolve(key === THEME_OVERRIDE_KEY ? 'dark' : null));
    const { result } = renderHook(() => useTheme(), { wrapper });

    await waitFor(() => expect(result.current.themeOverride).toBe('dark'));

    expect(result.current.colorScheme).toBe('dark');
    expect(result.current.systemColors.background).toBe('#101418');
    expect(result.current.systemColors.fill).toBe('rgba(168, 199, 250, 0.18)');
    expect(result.current.brandColors.primary).toBe('#A8C7FA');
    expect(result.current.brandColors.onPrimary).toBe('#071426');
  });

  it('refreshes the native dynamic palette when Android returns active', async () => {
    renderHook(() => useTheme(), { wrapper });

    await waitFor(() => expect(appStateChangeListeners).toHaveLength(1));

    appStateChangeListeners[0]?.('background');
    expect(resetMaterial3ThemeMock).not.toHaveBeenCalled();

    appStateChangeListeners[0]?.('active');
    expect(resetMaterial3ThemeMock).toHaveBeenCalledTimes(1);
  });

  it('ignores dynamic Material colors when the resolved variant is Liquid Glass', async () => {
    getMock.mockImplementation((key: string) => Promise.resolve(key === UI_VARIANT_KEY ? 'liquidGlass' : null));
    const { result } = renderHook(() => useTheme(), { wrapper });

    await waitFor(() => expect(result.current.uiVariantPreference).toBe('liquidGlass'));

    expect(result.current.variant).toBe('liquidGlass');
    expect(result.current.systemColors.background).toBe('#F4F1FB');
    expect(result.current.brandColors.primary).toBe('#6D28D9');
    expect(result.current.dynamicMaterialColors).toBeUndefined();
  });
});
