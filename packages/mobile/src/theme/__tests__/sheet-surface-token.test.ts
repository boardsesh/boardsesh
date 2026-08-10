// @vitest-environment jsdom
//
// `theme.sheetSurface` is the opaque ground a `surface="solid"` sheet paints.
// Two properties matter and neither is enforced by the type system:
//
//  1. It must be a PLAIN STRING. @expo/ui's `extractBackgroundColor`
//     (BottomSheet.ios.tsx:26) checks `typeof color === 'string'` and silently
//     falls back to the glass material for a `PlatformColor` — the sheet would
//     just go see-through again with no error. `Theme['sheetSurface']` is typed
//     `string`, but the palettes it is resolved from are `string | OpaqueColorValue`
//     elsewhere in the theme, so a one-line change of source could satisfy the
//     compiler and break the sheet.
//  2. The test factory (`src/test/theme-mock.ts`) and the real ThemeProvider must
//     resolve it identically, or every sheet colour assertion in the suite is
//     asserting on a value production never ships.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Same seams as providers/__tests__/theme-provider.test.tsx: the secure-store
// adapter drives hydration, and react-native is not satisfiable under jsdom.
const { appearanceSetColorSchemeMock, getMock, removeMock, setMock, useColorSchemeMock } = vi.hoisted(() => ({
  appearanceSetColorSchemeMock: vi.fn(),
  getMock: vi.fn(),
  removeMock: vi.fn(),
  setMock: vi.fn(),
  useColorSchemeMock: vi.fn(),
}));

vi.mock('../../lib/preferences/secure-store-adapter', () => ({
  secureStorePreferences: {
    get: (key: string) => getMock(key),
    set: (key: string, value: unknown) => setMock(key, value),
    remove: (key: string) => removeMock(key),
  },
}));

// Platform.OS = 'android' keeps `theme/colors` off the iOS PlatformColor branch
// at import time; the variant under test is chosen explicitly below, never
// inferred from the platform.
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  useColorScheme: () => useColorSchemeMock(),
  PlatformColor: (name: string) => name,
  Appearance: { setColorScheme: appearanceSetColorSchemeMock },
}));

vi.mock('expo-glass-effect', () => ({
  isLiquidGlassAvailable: () => false,
  isGlassEffectAPIAvailable: () => false,
}));

import { ThemeProvider, useTheme } from '../../providers/theme-provider';
import { THEME_OVERRIDE_KEY, UI_VARIANT_KEY } from '@boardsesh/key-value-storage';
import { makeThemeMock } from '../../test/theme-mock';
import { resolveChartColors } from '../variants/variant-tokens';
import type { UiVariant } from '../resolve-ui-variant';

const wrapper = ({ children }: { children: ReactNode }) => createElement(ThemeProvider, null, children);

const combinations: [variant: UiVariant, colorScheme: 'light' | 'dark'][] = [
  ['liquidGlass', 'light'],
  ['liquidGlass', 'dark'],
  ['material', 'light'],
  ['material', 'dark'],
];

describe('sheetSurface token', () => {
  beforeEach(() => {
    getMock.mockReset();
    setMock.mockReset();
    removeMock.mockReset();
    useColorSchemeMock.mockReset();
    appearanceSetColorSchemeMock.mockReset();
    getMock.mockResolvedValue(null);
    setMock.mockResolvedValue(undefined);
    useColorSchemeMock.mockReturnValue('light');
  });

  describe.each(combinations)('%s / %s', (variant, colorScheme) => {
    it('resolves to the chart palette secondaryBackground, as a plain string', () => {
      const { sheetSurface } = makeThemeMock({ variant, colorScheme });

      expect(typeof sheetSurface).toBe('string');
      expect(sheetSurface).toBe(resolveChartColors(variant, colorScheme).secondaryBackground);
    });

    it('matches what the real ThemeProvider resolves', async () => {
      // The mock cannot drift: a change to the provider's `sheetSurface` line
      // that theme-mock.ts does not mirror fails here.
      useColorSchemeMock.mockReturnValue(colorScheme);
      getMock.mockImplementation((key: string) => Promise.resolve(key === UI_VARIANT_KEY ? variant : null));

      const { result } = renderHook(() => useTheme(), { wrapper });

      await waitFor(() => {
        expect(getMock).toHaveBeenCalledWith(THEME_OVERRIDE_KEY);
        expect(result.current.variant).toBe(variant);
        expect(result.current.colorScheme).toBe(colorScheme);
      });

      expect(typeof result.current.sheetSurface).toBe('string');
      expect(result.current.sheetSurface).toBe(makeThemeMock({ variant, colorScheme }).sheetSurface);
    });
  });
});
