import { type OpaqueColorValue } from 'react-native';
import type { UiVariant } from '../resolve-ui-variant';
import { iosSystemColors } from '../ios-colors';
import { materialSurfaces, androidFallbackColors, type SystemColorKey } from '../colors';

/**
 * Variant-resolved design tokens. These live in ONE place so the provider and
 * the test theme mock (`src/test/theme-mock.ts`) resolve them identically and
 * can't drift. The provider exposes each as `theme.actionColors` /
 * `theme.chartColors` / `theme.sectionCaption`; components read the resolved
 * value and never branch on `variant`. See ./README.md for the decision tree.
 */

type ColorValue = string | OpaqueColorValue;

/**
 * Semantic foregrounds for action rows / action FABs. Liquid Glass renders them
 * monochrome (the row's meaning carried by the SF Symbol + copy, the HIG way);
 * Material tints each by its semantic role per M3. One decision, resolved once.
 */
export type ActionColors = {
  /** Default / non-semantic action glyph. */
  neutral: ColorValue;
  /** Add-to-queue, confirm. */
  success: ColorValue;
  /** Favourite / heart. */
  favorite: ColorValue;
  /** Edit · copy · open (interactive accent). */
  accent: ColorValue;
  /** Pin / feature. */
  pin: ColorValue;
};

/**
 * The colours `resolveActionColors` reads, passed in already resolved for the
 * current scheme so this stays decoupled from the provider's `Theme` type
 * (avoids an import cycle).
 */
export type ActionColorInputs = {
  /** `systemColors.label` — the monochrome foreground. */
  label: ColorValue;
  /** `systemColors.accent` — the interactive-accent foreground. */
  accent: ColorValue;
  /** `brandColors.success`. */
  brandSuccess: ColorValue;
  /** `brandColors.primary`. */
  brandPrimary: ColorValue;
};

export function resolveActionColors(variant: UiVariant, inputs: ActionColorInputs): ActionColors {
  if (variant === 'liquidGlass') {
    return {
      neutral: inputs.label,
      success: inputs.label,
      favorite: inputs.label,
      accent: inputs.label,
      pin: inputs.label,
    };
  }
  return {
    neutral: inputs.label,
    success: inputs.brandSuccess,
    // Static iOS red (gifted-charts / animated styles can't take PlatformColor);
    // reads fine on Android too.
    favorite: iosSystemColors.systemRed,
    accent: inputs.accent,
    pin: inputs.brandPrimary,
  };
}

/**
 * Plain-string colour palette for chart libraries (react-native-gifted-charts)
 * that reject `PlatformColor`/`OpaqueColorValue`. Mirrors `systemColors` but is
 * always hex/rgba on every platform+variant. Liquid Glass borrows the Android
 * fallback strings (iOS `systemColors` are PlatformColor and can't reach a chart);
 * Material uses its M3 tonal strings.
 */
export type ChartColors = Record<SystemColorKey, string>;

export function resolveChartColors(variant: UiVariant, colorScheme: 'light' | 'dark'): ChartColors {
  return (variant === 'material' ? materialSurfaces : androidFallbackColors)[colorScheme];
}

/**
 * The five-stop data ramp the hold heatmap draws with, few → many.
 *
 * One violet hue ordered by luminance, never a role hue: the board already
 * spends green / cyan / magenta / amber on Start / Hand / Finish / Foot, so a
 * green-to-red ramp read as "all feet" on a busy wall. Luminance alone carries
 * the order, which is what keeps it readable for every colour-vision type.
 * Brightness rises toward "many" on the dark field and falls toward "many" on
 * the light one, so the hottest hold is always the one with the most contrast
 * against the sheet. Plain strings: the renderer's hold-state map and the
 * legend both need hex. Pinned by `heat-ramp.test.ts` (strictly monotonic,
 * at least 1.3:1 between neighbours).
 */
export type HeatRamp = readonly [string, string, string, string, string];

export const heatRampByScheme = {
  // Violet end to end: a near-white top stop read as an unheated grey hold on
  // the board photo, and a near-white cold stop faded the same way in light mode.
  dark: ['#4C1D95', '#6D28D9', '#8B5CF6', '#A78BFA', '#C4B5FD'],
  light: ['#C4B5FD', '#A78BFA', '#7C3AED', '#5B21B6', '#2E1065'],
} as const satisfies Record<'light' | 'dark', HeatRamp>;

export function resolveHeatRamp(colorScheme: 'light' | 'dark'): HeatRamp {
  return heatRampByScheme[colorScheme];
}

/**
 * Section-caption treatment. Liquid Glass uses the HIG group caption (uppercased,
 * dimmed, tracked-out); Material uses sentence case (the M3 app bar / onSurfaceVariant
 * carries the hierarchy instead). Keyed on VARIANT, not `Platform.OS` — fixing the
 * `SectionHeader` / `FeedSectionLabel` bug where a Liquid-Glass user on Android lost
 * the uppercasing and a Material user on iOS wrongly gained it.
 */
export type SectionCaption = {
  uppercase: boolean;
  opacity: number;
  letterSpacing: number;
};

export const sectionCaptionByVariant = {
  liquidGlass: { uppercase: true, opacity: 0.6, letterSpacing: 0.5 },
  material: { uppercase: false, opacity: 1, letterSpacing: 0 },
} as const satisfies Record<UiVariant, SectionCaption>;

/**
 * Apply a section-caption treatment to a label: returns the (possibly uppercased)
 * text plus the style fragment, so `SectionHeader` and `FeedSectionLabel` stay
 * branch-free and identical. JS `.toUpperCase()` (not RN `textTransform`) matches
 * the existing behaviour; captions are non-user-generated UI strings, so the
 * locale-sensitivity of `.toUpperCase()` is not a concern here.
 */
export function applySectionCaption(
  text: string,
  caption: SectionCaption,
): { text: string; style: { opacity: number; letterSpacing: number } } {
  return {
    text: caption.uppercase ? text.toUpperCase() : text,
    style: { opacity: caption.opacity, letterSpacing: caption.letterSpacing },
  };
}
