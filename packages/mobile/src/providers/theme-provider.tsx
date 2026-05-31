import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { Platform, useColorScheme, type ColorValue } from 'react-native';
import { iosSystemColors, brandColors, androidFallbackColors } from '../theme/colors';
import { textStyles, type TextVariant } from '../theme/typography';
import { spacing, borderRadius, shadows, opacity } from '../theme/tokens';
import { springs, timing } from '../theme/animations';
import { useSetting } from '../settings';

type ColorScheme = 'light' | 'dark';

/**
 * Resolved system colors for the current color scheme.
 * On iOS these are PlatformColor values; on Android they are hex/rgba strings.
 */
type ResolvedSystemColors = {
  background: ColorValue;
  secondaryBackground: ColorValue;
  tertiaryBackground: ColorValue;
  groupedBackground: ColorValue;
  label: ColorValue;
  secondaryLabel: ColorValue;
  tertiaryLabel: ColorValue;
  separator: ColorValue;
  fill: ColorValue;
};

type Theme = {
  colorScheme: ColorScheme;
  systemColors: ResolvedSystemColors;
  brandColors: typeof brandColors;
  textStyles: typeof textStyles;
  spacing: typeof spacing;
  borderRadius: typeof borderRadius;
  shadows: typeof shadows;
  opacity: typeof opacity;
  springs: typeof springs;
  timing: typeof timing;
};

const ThemeContext = createContext<Theme | null>(null);

/**
 * Resolve system colors for the current platform and color scheme.
 *
 * On iOS, PlatformColor handles dark mode automatically, so we just
 * pass through the PlatformColor values unchanged.
 *
 * On Android, PlatformColor is not used — we pick from the
 * androidFallbackColors light/dark map.
 */
function resolveSystemColors(colorScheme: ColorScheme): ResolvedSystemColors {
  if (Platform.OS === 'ios' && iosSystemColors) {
    // PlatformColor values adapt automatically on iOS — return as-is.
    return iosSystemColors as ResolvedSystemColors;
  }

  // Android: resolve from the single source of truth for fallback colors.
  const fallback = colorScheme === 'dark' ? androidFallbackColors.dark : androidFallbackColors.light;

  return {
    background: fallback.background,
    secondaryBackground: fallback.secondaryBackground,
    tertiaryBackground: fallback.tertiaryBackground,
    groupedBackground: fallback.groupedBackground,
    label: fallback.label,
    secondaryLabel: fallback.secondaryLabel,
    tertiaryLabel: fallback.tertiaryLabel,
    separator: fallback.separator,
    fill: fallback.fill,
  };
}

type ThemeProviderProps = {
  children: ReactNode;
};

export function ThemeProvider({ children }: ThemeProviderProps) {
  const deviceColorScheme = useColorScheme();
  const [themePreference] = useSetting('theme');

  // 'system' follows the OS; 'light'/'dark' override it.
  const colorScheme: ColorScheme =
    themePreference === 'system' ? (deviceColorScheme === 'dark' ? 'dark' : 'light') : themePreference;

  const theme = useMemo<Theme>(() => {
    const resolvedSystemColors = resolveSystemColors(colorScheme);

    return {
      colorScheme,
      systemColors: resolvedSystemColors,
      brandColors,
      textStyles,
      spacing,
      borderRadius,
      shadows,
      opacity,
      springs,
      timing,
    };
  }, [colorScheme]);

  // React 19 context provider syntax (Expo SDK 53+ / React 19)
  return <ThemeContext value={theme}>{children}</ThemeContext>;
}

/**
 * Access the current theme. Must be called inside a ThemeProvider.
 */
export function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  if (theme === null) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return theme;
}

export type { Theme, ColorScheme, ResolvedSystemColors, TextVariant };
