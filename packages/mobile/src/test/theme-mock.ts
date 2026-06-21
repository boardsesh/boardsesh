import type { Theme } from '../providers/theme-provider';
import {
  spacing,
  borderRadius,
  shadows,
  opacity,
  radiiByVariant,
  sheetChromeByVariant,
  materialElevationByLevel,
} from '../theme/tokens';
import { springs, timing, motionByVariant } from '../theme/animations';
import { textStylesByVariant } from '../theme/typography';
import {
  brandColors,
  brandColorsDark,
  materialSurfaces,
  androidFallbackColors,
  materialSurfaceContainers,
} from '../theme/colors';
import { buildPaperTheme } from '../theme/paper-theme';
import { resolveActionColors, resolveChartColors, sectionCaptionByVariant } from '../theme/variants/variant-tokens';
import { variantFeatures } from '../theme/variants/variant-features';

/**
 * Build a complete `Theme` for unit tests. One factory so every test gets the
 * full shape — including the variant-resolved fields (`actionColors`,
 * `chartColors`, `sectionCaption`) — and a migration that relocates a colour
 * into a new token only updates this file, not the ~25 inline `vi.mock`s that
 * otherwise each hand-roll a partial theme.
 *
 * Pass `{ variant }` / `{ colorScheme }` to resolve everything for that
 * combination the way the provider does, or override any field directly. Uses
 * plain-string colour palettes (Android fallback / Material surfaces) so colour
 * assertions read real hex, not `PlatformColor`.
 */
export function makeThemeMock(overrides: Partial<Theme> = {}): Theme {
  const variant = overrides.variant ?? 'liquidGlass';
  const colorScheme = overrides.colorScheme ?? 'light';
  const brand = colorScheme === 'dark' ? brandColorsDark : brandColors;
  const systemColors =
    overrides.systemColors ??
    (variant === 'material' ? materialSurfaces[colorScheme] : androidFallbackColors[colorScheme]);

  const base: Theme = {
    colorScheme,
    systemColors,
    brandColors: brand,
    textStyles: textStylesByVariant[variant],
    spacing,
    borderRadius,
    shadows,
    opacity,
    springs,
    timing,
    motion: motionByVariant[variant],
    themeOverride: 'system',
    setThemeOverride: () => Promise.resolve(),
    variant,
    uiVariantPreference: 'auto',
    setUiVariant: () => Promise.resolve(),
    radii: radiiByVariant[variant],
    sheet: sheetChromeByVariant[variant],
    m3: buildPaperTheme(colorScheme).colors,
    m3SurfaceContainers: materialSurfaceContainers[colorScheme],
    materialElevation: materialElevationByLevel,
    actionColors: resolveActionColors(variant, {
      label: systemColors.label,
      accent: systemColors.accent,
      brandSuccess: brand.success,
      brandPrimary: brand.primary,
    }),
    chartColors: resolveChartColors(variant, colorScheme),
    sectionCaption: sectionCaptionByVariant[variant],
    features: variantFeatures[variant],
  };

  return { ...base, ...overrides };
}
