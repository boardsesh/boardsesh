// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Material3Theme } from '@pchmn/expo-material3-theme';
import { UI_VARIANT_KEY } from '@boardsesh/key-value-storage';

const getMock = vi.fn();
const useColorSchemeMock = vi.fn();

vi.mock('../../lib/preferences/secure-store-adapter', () => ({
  secureStorePreferences: {
    get: (key: string) => getMock(key),
    set: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'android', Version: 35 },
  useColorScheme: () => useColorSchemeMock(),
  PlatformColor: (name: string) => name,
  Appearance: { setColorScheme: vi.fn() },
}));

vi.mock('expo-glass-effect', () => ({
  isLiquidGlassAvailable: () => false,
  isGlassEffectAPIAvailable: () => false,
}));

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
    theme: fallbackMaterialTheme,
    updateTheme: () => undefined,
    resetTheme: () => undefined,
  }),
}));

import { ThemeProvider, useTheme } from '../theme-provider';

const wrapper = ({ children }: { children: ReactNode }) => <ThemeProvider>{children}</ThemeProvider>;

describe('ThemeProvider supported Material fallback', () => {
  beforeEach(() => {
    getMock.mockReset();
    useColorSchemeMock.mockReset();
    getMock.mockResolvedValue(null);
    useColorSchemeMock.mockReturnValue('light');
  });

  it('keeps static Material colours when the native module returns only its fallback palette', async () => {
    const { result } = renderHook(() => useTheme(), { wrapper });

    await waitFor(() => expect(getMock).toHaveBeenCalledWith(UI_VARIANT_KEY));

    expect(result.current.variant).toBe('material');
    expect(result.current.systemColors.background).toBe('#F3EFFA');
    expect(result.current.systemColors.fill).toBe('rgba(109, 40, 217, 0.14)');
    expect(result.current.brandColors.primary).toBe('#6D28D9');
    expect(result.current.dynamicMaterialColors).toBeUndefined();
  });
});
