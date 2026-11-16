import { type OpaqueColorValue } from 'react-native';
import type { UiVariant } from '../resolve-ui-variant';
import { materialSurfaces, androidFallbackColors, withAlpha, type SystemColorKey } from '../colors';

/**
 * Variant-resolved design tokens. These live in ONE place so the provider and
 * the test theme mock (`src/test/theme-mock.ts`) resolve them identically and
 * can't drift. The provider exposes each as `theme.actionColors` /
 * `theme.chartColors` / `theme.sectionCaption`, and the Velvet Send v2 roles as
 * `theme.surfaces` / `theme.selection` / `theme.status`; components read the
 * resolved value and never branch on `variant`. See ./README.md for the decision
 * tree.
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
  /** Favourite / heart, as an action-row glyph (monochrome on Liquid Glass). */
  favorite: ColorValue;
  /**
   * A heart that IS favourited (the filled state). The one red for that state on
   * every surface and variant: `systemColors.error`.
   */
  favoriteSelected: ColorValue;
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
  /** `systemColors.error` — the adaptive red (iOS systemRed, M3 error). */
  error: ColorValue;
};

export function resolveActionColors(variant: UiVariant, inputs: ActionColorInputs): ActionColors {
  if (variant === 'liquidGlass') {
    return {
      neutral: inputs.label,
      success: inputs.label,
      favorite: inputs.label,
      favoriteSelected: inputs.error,
      accent: inputs.label,
      pin: inputs.label,
    };
  }
  return {
    neutral: inputs.label,
    success: inputs.brandSuccess,
    favorite: inputs.error,
    favoriteSelected: inputs.error,
    accent: inputs.accent,
    pin: inputs.brandPrimary,
  };
}

/**
 * The system colours the Velvet Send v2 roles below are built from, passed in
 * already resolved for the current variant and scheme (iOS PlatformColors on
 * Liquid Glass, the violet fallback ladder on Liquid Glass off iOS, the Graphite
 * ladder on Material). Structural, so the provider hands in its `systemColors`
 * without this file importing the provider's `Theme` type (avoids a cycle).
 */
export type RoleColorInputs = Record<
  | 'background'
  | 'secondaryBackground'
  | 'tertiaryBackground'
  | 'groupedBackground'
  | 'secondaryGroupedBackground'
  | 'tertiaryGroupedBackground'
  | 'label'
  | 'secondaryLabel'
  | 'accent'
  | 'tertiaryFill',
  ColorValue
>;

/** One page style's three grounds, bottom to top. */
export type SurfaceLadder = {
  /** The screen itself. */
  page: ColorValue;
  /** A card, shelf or grouped section on the page. */
  card: ColorValue;
  /** A block inside a card: an art tile, a summary, a warning. */
  tile: ColorValue;
};

/**
 * Page grounds, one ladder per page style (HIG Color, "Background"):
 *
 * - `plain` is a page of content: a feed, a shelf, a list of climbs. iOS
 *   `systemBackground` → `secondarySystemBackground` → `tertiarySystemBackground`.
 * - `grouped` is a page of inset-grouped rows, like Settings. iOS
 *   `systemGroupedBackground` → `secondarySystemGroupedBackground` →
 *   `tertiarySystemGroupedBackground`.
 *
 * The iOS colours resolve base vs elevated on their own, so a page drawn in a sheet
 * steps up without asking. Material and Liquid Glass off iOS take the same steps
 * from their own ladders.
 */
export type Surfaces = { plain: SurfaceLadder; grouped: SurfaceLadder };

/** Same mapping on both variants: the variant arrives through the resolved inputs. */
export function resolveSurfaces(inputs: RoleColorInputs): Surfaces {
  return {
    plain: { page: inputs.background, card: inputs.secondaryBackground, tile: inputs.tertiaryBackground },
    grouped: {
      page: inputs.groupedBackground,
      card: inputs.secondaryGroupedBackground,
      tile: inputs.tertiaryGroupedBackground,
    },
  };
}

/**
 * The selected or current item in a list: the board you're on, the picked option,
 * the active filter. Selection is a state, not a link, so the text stays the label
 * colour (set it semibold with `<Text emphasized>` at the call site), a checkmark
 * in the accent marks it, and a violet wash sits behind the row. Violet text and
 * icons are only for things you can tap (HIG Color: "if you use your brand color to
 * indicate that a borderless button is interactive, using the same or similar color
 * to stylize noninteractive text is confusing"); a wash behind the row is a
 * surface, not text, so it may carry the brand.
 */
export type SelectionColors = {
  /** The selected item's title: `label`. */
  text: ColorValue;
  /** The checkmark beside it: `accent`. */
  checkmark: ColorValue;
  /**
   * The row or cell wash: the scheme's brand primary at 18% (#6D28D9 in light,
   * the lifted #A78BFA in dark), the same wash the current climb in the Climbs
   * list draws (`selectedRowColors`). Every variant takes it: Material's climb
   * list already draws this wash rather than an M3 tonal container, so one look
   * holds everywhere.
   */
  fill: string;
};

/** The selection wash's strength. Must stay equal to `selectedRowColors`' wash. */
export const SELECTION_WASH_ALPHA = 0.18;

/**
 * Same mapping on both variants: the variant arrives through the resolved inputs.
 * `brandPrimary` is the scheme's `brandColors.primary`, a hex string.
 */
export function resolveSelectionColors(inputs: RoleColorInputs, brandPrimary: string): SelectionColors {
  return { text: inputs.label, checkmark: inputs.accent, fill: withAlpha(brandPrimary, SELECTION_WASH_ALPHA) };
}

/**
 * A status that can't be tapped: "Ready to review", "On it". A quiet
 * pill (`tertiarySystemFill`) with `secondaryLabel` text, so it never competes with
 * the tappable accent beside it.
 */
export type StatusColors = {
  /** The pill ground: `tertiaryFill`. */
  fill: ColorValue;
  /** The pill text and glyph: `secondaryLabel`. */
  label: ColorValue;
};

/** Same mapping on both variants: the variant arrives through the resolved inputs. */
export function resolveStatusColors(inputs: RoleColorInputs): StatusColors {
  return { fill: inputs.tertiaryFill, label: inputs.secondaryLabel };
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
 * Section-caption treatment. Both variants are sentence case with no tracking:
 * on iOS 26 a grouped list's section header is sentence-case footnote semibold in
 * secondaryLabel (HIG Lists and tables; it is what the native SwiftUI Forms in
 * Settings draw, so our own headers now match them), and M3 list subheaders are
 * sentence-case titleSmall in onSurfaceVariant. The hierarchy comes from the
 * secondary colour, not from dimming, so opacity stays 1. Keyed on VARIANT, not
 * `Platform.OS`, so a Liquid-Glass user on Android gets the same header as on iOS.
 */
export type SectionCaption = {
  uppercase: boolean;
  opacity: number;
  letterSpacing: number;
};

export const sectionCaptionByVariant = {
  liquidGlass: { uppercase: false, opacity: 1, letterSpacing: 0 },
  material: { uppercase: false, opacity: 1, letterSpacing: 0 },
} as const satisfies Record<UiVariant, SectionCaption>;

/**
 * Apply a section-caption treatment to a label: returns the (possibly uppercased)
 * text plus the style fragment, so `SectionHeader` and `FeedSectionLabel` stay
 * branch-free and identical. No variant uppercases today. If one ever does,
 * use `toLocaleUpperCase(locale)`: a plain `.toUpperCase()` is locale-blind (it
 * turns Turkish `i` into `I`, and German `ß` into `SS`).
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
