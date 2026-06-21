// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';

// Mock the secure-store adapter, not expo-secure-store directly. The adapter
// is the seam ThemeProvider depends on; controlling its three methods is enough
// to drive every persistence + hydration path in the provider.
const getMock = vi.fn();
const setMock = vi.fn();
const removeMock = vi.fn();
vi.mock('../../lib/preferences/secure-store-adapter', () => ({
  secureStorePreferences: {
    get: (key: string) => getMock(key),
    set: (key: string, value: unknown) => setMock(key, value),
    remove: (key: string) => removeMock(key),
  },
}));

// react-native isn't satisfiable under jsdom. Replace it with a minimal
// surface: useColorScheme is what the provider reads; Platform.OS = 'android'
// skips the iOS PlatformColor branch in src/theme/colors so importing the
// module doesn't blow up. PlatformColor is still mocked as a passthrough for
// belt-and-braces in case some other module reaches for it.
const useColorSchemeMock = vi.fn();
// Platform.OS is a getter so a test can flip it to 'ios' and exercise the
// platform-driven 'auto' → liquidGlass resolution. Default 'android' keeps the
// colour assertions below on the Android fallback path; iosSystemColors is
// computed at module import (null here), so the iOS path degrades to that
// fallback rather than touching native PlatformColor.
const platform = vi.hoisted(() => ({ os: 'android' as 'ios' | 'android' }));
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platform.os;
    },
  },
  useColorScheme: () => useColorSchemeMock(),
  PlatformColor: (name: string) => name,
  // The provider drives Appearance.setColorScheme so the override flips native
  // iOS colours; mock it so the effect doesn't blow up under jsdom.
  Appearance: { setColorScheme: vi.fn() },
}));

// The provider resolves 'auto' off Platform.OS ('android' here → Material), not
// glass capability. Other modules in the import graph still pull expo-glass-effect,
// so mock it defensively; the values don't affect the provider's variant choice.
vi.mock('expo-glass-effect', () => ({
  isLiquidGlassAvailable: () => false,
  isGlassEffectAPIAvailable: () => false,
}));

import { ThemeProvider, useTheme } from '../theme-provider';
import { THEME_OVERRIDE_KEY, UI_VARIANT_KEY } from '@boardsesh/key-value-storage';

const wrapper = ({ children }: { children: ReactNode }) => <ThemeProvider>{children}</ThemeProvider>;

describe('ThemeProvider', () => {
  beforeEach(() => {
    getMock.mockReset();
    setMock.mockReset();
    removeMock.mockReset();
    useColorSchemeMock.mockReset();
    // Defaults: no stored preference, OS in light mode, Android platform.
    getMock.mockResolvedValue(null);
    setMock.mockResolvedValue(undefined);
    useColorSchemeMock.mockReturnValue('light');
    platform.os = 'android';
  });

  describe('resolved colorScheme (without persistence)', () => {
    it("'system' override follows the device scheme", async () => {
      useColorSchemeMock.mockReturnValue('dark');
      const { result } = renderHook(() => useTheme(), { wrapper });
      // Default starting override is 'system'; no stored value → stays system.
      await waitFor(() => expect(getMock).toHaveBeenCalledWith(THEME_OVERRIDE_KEY));
      expect(result.current.colorScheme).toBe('dark');
      expect(result.current.themeOverride).toBe('system');
    });

    it("'light' override beats a dark device", async () => {
      useColorSchemeMock.mockReturnValue('dark');
      getMock.mockResolvedValue('light');
      const { result } = renderHook(() => useTheme(), { wrapper });
      await waitFor(() => expect(result.current.themeOverride).toBe('light'));
      expect(result.current.colorScheme).toBe('light');
    });

    it("'dark' override beats a light device", async () => {
      useColorSchemeMock.mockReturnValue('light');
      getMock.mockResolvedValue('dark');
      const { result } = renderHook(() => useTheme(), { wrapper });
      await waitFor(() => expect(result.current.themeOverride).toBe('dark'));
      expect(result.current.colorScheme).toBe('dark');
    });

    it('a null/undefined system scheme resolves to light', async () => {
      useColorSchemeMock.mockReturnValue(null);
      const { result } = renderHook(() => useTheme(), { wrapper });
      await waitFor(() => expect(getMock).toHaveBeenCalled());
      expect(result.current.colorScheme).toBe('light');
    });
  });

  describe('hydration', () => {
    it('reads the override from SecureStore on mount and applies it', async () => {
      getMock.mockResolvedValue('dark');
      const { result } = renderHook(() => useTheme(), { wrapper });
      await waitFor(() => expect(result.current.themeOverride).toBe('dark'));
      expect(getMock).toHaveBeenCalledWith(THEME_OVERRIDE_KEY);
    });

    it('ignores a stored value that does not type-guard as a ThemeOverride', async () => {
      getMock.mockResolvedValue('lavender');
      const { result } = renderHook(() => useTheme(), { wrapper });
      await waitFor(() => expect(getMock).toHaveBeenCalled());
      expect(result.current.themeOverride).toBe('system');
    });

    it('does not crash if the SecureStore read rejects', async () => {
      getMock.mockRejectedValue(new Error('secure store unavailable'));
      const { result } = renderHook(() => useTheme(), { wrapper });
      await waitFor(() => expect(getMock).toHaveBeenCalled());
      expect(result.current.themeOverride).toBe('system');
    });
  });

  describe('setThemeOverride', () => {
    it('updates state synchronously and persists asynchronously', async () => {
      const { result } = renderHook(() => useTheme(), { wrapper });
      await waitFor(() => expect(getMock).toHaveBeenCalled());

      await act(async () => {
        await result.current.setThemeOverride('dark');
      });

      expect(result.current.themeOverride).toBe('dark');
      expect(result.current.colorScheme).toBe('dark');
      expect(setMock).toHaveBeenCalledWith(THEME_OVERRIDE_KEY, 'dark');
    });

    it("keeps the user's pick in-memory even if persistence fails", async () => {
      setMock.mockRejectedValue(new Error('disk full'));
      const { result } = renderHook(() => useTheme(), { wrapper });
      await waitFor(() => expect(getMock).toHaveBeenCalled());

      await act(async () => {
        await result.current.setThemeOverride('dark');
      });

      expect(result.current.themeOverride).toBe('dark');
    });
  });

  describe('uiVariant', () => {
    it("defaults to the Material variant on Android ('auto' → material)", async () => {
      const { result } = renderHook(() => useTheme(), { wrapper });
      await waitFor(() => expect(getMock).toHaveBeenCalledWith(UI_VARIANT_KEY));
      expect(result.current.uiVariantPreference).toBe('auto');
      expect(result.current.variant).toBe('material');
      // Material maps M3 tonal surfaces + the 20dp button radius.
      expect(result.current.radii.button).toBe(20);
      expect(result.current.systemColors.background).toBe('#F3EFFA');
    });

    it("defaults to the Liquid Glass variant on iPhone ('auto' → liquidGlass), incl. iOS < 26", async () => {
      // The provider keys 'auto' on Platform.OS, not glass capability — so every
      // iPhone (older ones degrade their surfaces downstream) lands on liquidGlass.
      platform.os = 'ios';
      const { result } = renderHook(() => useTheme(), { wrapper });
      await waitFor(() => expect(getMock).toHaveBeenCalledWith(UI_VARIANT_KEY));
      expect(result.current.uiVariantPreference).toBe('auto');
      expect(result.current.variant).toBe('liquidGlass');
      // Liquid Glass keeps the soft 10dp button radius, not the Material 20dp.
      expect(result.current.radii.button).toBe(10);
    });

    it('setUiVariant persists to SecureStore and flips the resolved variant + tokens', async () => {
      const { result } = renderHook(() => useTheme(), { wrapper });
      await waitFor(() => expect(getMock).toHaveBeenCalledWith(UI_VARIANT_KEY));

      await act(async () => {
        await result.current.setUiVariant('liquidGlass');
      });

      expect(result.current.uiVariantPreference).toBe('liquidGlass');
      expect(result.current.variant).toBe('liquidGlass');
      // Liquid Glass keeps the soft 10dp button radius and the (Android) system
      // surface — not the Material tonal map.
      expect(result.current.radii.button).toBe(10);
      expect(result.current.systemColors.background).toBe('#F4F1FB');
      expect(setMock).toHaveBeenCalledWith(UI_VARIANT_KEY, 'liquidGlass');
    });

    it('hydrates a stored variant preference on mount', async () => {
      getMock.mockImplementation((key: string) => Promise.resolve(key === UI_VARIANT_KEY ? 'liquidGlass' : null));
      const { result } = renderHook(() => useTheme(), { wrapper });
      await waitFor(() => expect(result.current.uiVariantPreference).toBe('liquidGlass'));
      expect(result.current.variant).toBe('liquidGlass');
    });

    it('ignores a stored value that is not a UiVariantPreference', async () => {
      getMock.mockImplementation((key: string) => Promise.resolve(key === UI_VARIANT_KEY ? 'frosted' : null));
      const { result } = renderHook(() => useTheme(), { wrapper });
      await waitFor(() => expect(getMock).toHaveBeenCalledWith(UI_VARIANT_KEY));
      expect(result.current.uiVariantPreference).toBe('auto');
    });
  });

  describe('scheme-aware brand + accent colours (#2583)', () => {
    it('light scheme exposes the base brand palette and the violet accent', async () => {
      useColorSchemeMock.mockReturnValue('light');
      const { result } = renderHook(() => useTheme(), { wrapper });
      await waitFor(() => expect(getMock).toHaveBeenCalled());
      expect(result.current.colorScheme).toBe('light');
      expect(result.current.brandColors.primary).toBe('#6D28D9');
      expect(result.current.brandColors.success).toBe('#047857');
      // New scheme-aware interactive accent (replaces the static systemBlue).
      expect(result.current.systemColors.accent).toBe('#6D28D9');
    });

    it('dark scheme lifts brand foregrounds + the accent so they clear AA on near-black', async () => {
      useColorSchemeMock.mockReturnValue('dark');
      const { result } = renderHook(() => useTheme(), { wrapper });
      await waitFor(() => expect(getMock).toHaveBeenCalled());
      expect(result.current.colorScheme).toBe('dark');
      // The core #2583 fix: foreground brand + semantic tones lift in dark.
      expect(result.current.brandColors.primary).toBe('#A78BFA');
      expect(result.current.brandColors.success).toBe('#34D399');
      expect(result.current.brandColors.warning).toBe('#FBBF24');
      expect(result.current.brandColors.error).toBe('#F87171');
      expect(result.current.systemColors.accent).toBe('#A78BFA');
    });
  });

  describe('hydration race guard', () => {
    it("does not stomp the user's choice if setThemeOverride lands before the SecureStore read resolves", async () => {
      // Hold the hydration read until we say go. Lets us set the override
      // first and then resolve the read with a *different* persisted value.
      let resolveGet: (value: string) => void = () => undefined;
      getMock.mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            resolveGet = resolve;
          }),
      );

      const { result } = renderHook(() => useTheme(), { wrapper });
      // Hook mounted; the hydration read is in-flight (unresolved).
      expect(result.current.themeOverride).toBe('system');

      await act(async () => {
        await result.current.setThemeOverride('dark');
      });
      expect(result.current.themeOverride).toBe('dark');

      // Now the SecureStore read resolves with the previously-persisted value.
      // Without the hasUserChosenRef guard this would stomp 'dark' back to
      // 'light'. With it, the user's choice wins.
      await act(async () => {
        resolveGet('light');
        await Promise.resolve();
      });
      expect(result.current.themeOverride).toBe('dark');
    });
  });
});
