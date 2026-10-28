// Theming bridge for @expo/ui native primitives.
//
// Native @expo/ui controls read system colours automatically — iOS via
// PlatformColor / SwiftUI semantic styles, Android via the Compose Material
// theme. On Android that theme is Material You: unseeded, every Compose control
// takes the phone wallpaper's palette for each colour we don't set (#6919). So
// every Android Host is seeded from the brand (`composeSeedColor`, applied by
// `ComposeHost.android.tsx`), and each control's colour set below names every
// state a climber sees from `useTheme().brandColors` / `useTheme().m3`. This
// module is the single place that maps those onto the plain colour values the
// native modifiers / props want, so the brand colour is sourced once and every
// primitive tints identically.
//
// WHY THIS FILE IMPORTS NOTHING FROM @expo/ui
// It is shared by both `*.ios.tsx` and `*.android.tsx` component files, and the
// platform-import lint guardrail (.oxlintrc.json) forbids importing
// `@expo/ui/swift-ui/*` or `@expo/ui/jetpack-compose/*` outside the matching
// platform file (a cross-platform native import crashes at runtime with
// "Unable to get view config"). So these helpers stay PURE: they take plain
// brand-colour values and return plain colour strings / plain config objects.
// Each platform component file imports its OWN native modifier factories
// (`tint`, `disabled`, the `SwitchColors` shape, …) and feeds them these values,
// e.g. `tint(brandControlTint(brandColors))` on iOS, or
// `colors={switchControlColors(brandColors, m3, colorScheme)}` on Android.
//
// Two brand colours, two jobs:
// - `brandAccentColor` (the theme's `primaryFill`) is for a surface that carries
//   WHITE text or a white glyph: a filled button, a selected segment, a badge.
// - `brandControlTint` (the theme's `primary`) is for a control's on-state drawn
//   straight on a card: a Toggle / Switch track, a Slider, a menu Picker's value,
//   a plain text button. In dark mode `primaryFill` #7C3AED is 2.45:1 on the iOS
//   grouped card #2C2C2E, under the 3:1 minimum for a control; `primary` #A78BFA
//   is 5.12:1 there. Light mode is the same violet (#6D28D9) either way.
// Add control-specific Android colour mappers here as more primitives land, each
// reading one of those two so they can't drift.

import { withAlpha } from '@boardsesh/velvet-tokens';

/**
 * The subset of resolved brand colours the native-control bridge reads. The
 * theme's `brandColors` (`useTheme().brandColors`) satisfies this structurally,
 * so call sites pass it straight through.
 */
export type BrandControlColors = {
  /**
   * Brand colour for FOREGROUND use: text, icons, and a control's on-state drawn
   * on a card. Scheme-aware (`#6D28D9` light, lighter `#A78BFA` dark).
   */
  primary: string;
  /**
   * Brand colour for a FILLED surface — the on-track / selected-fill accent.
   * Scheme-aware (`#6D28D9` light, brighter `#7C3AED` dark) so white thumbs and
   * labels sitting on top clear WCAG AA.
   */
  primaryFill: string;
  /** Text/icon colour sitting ON `primaryFill` (e.g. a selected segment's label). */
  onPrimary: string;
};

/**
 * The Velvet Material roles the Android colour sets read for a control's
 * neutral states. `useTheme().m3` (built by `buildPaperTheme`) satisfies this
 * structurally, so the Compose controls match their Paper / RN neighbours.
 */
export type MaterialControlRoles = {
  /** Component boundary: 4.08:1 on the dark card #221A33, 3.00:1 on white. */
  outline: string;
  /** Neutral toned container (an unchecked Switch track). */
  surfaceVariant: string;
  /** Muted foreground on a surface (an unselected chip's label). */
  onSurfaceVariant: string;
  /** Tonal button fill: translucent brand violet. */
  secondaryContainer: string;
  /** Ink on `secondaryContainer`. */
  onSecondaryContainer: string;
};

/**
 * The seed for every Android Compose `Host`. A seeded Host generates its
 * Material 3 scheme from this colour (`SchemeTonalSpot`) instead of the
 * wallpaper, so any Compose colour we don't set explicitly is still violet.
 */
export function composeSeedColor(brandColors: BrandControlColors): string {
  return brandColors.primaryFill;
}

/**
 * The brand FILL: the colour of a surface that carries white text or a white
 * glyph (a filled button, a selected segment, a badge). White on it is 7.10:1
 * light and 5.70:1 dark. Not for a control drawn straight on a card; that is
 * `brandControlTint`.
 */
export function brandAccentColor(brandColors: BrandControlColors): string {
  return brandColors.primaryFill;
}

/**
 * The tint for a native control's on-state drawn straight on a card: iOS
 * `tint(...)` on a Toggle, menu Picker, Slider or plain Button, the Android
 * Switch track and Slider. `#A78BFA` in dark is 5.12:1 on the iOS grouped card
 * (#2C2C2E) and 6.25:1 on #1C1C1E; `#6D28D9` in light is 7.10:1 on white.
 */
export function brandControlTint(brandColors: BrandControlColors): string {
  return brandColors.primary;
}

/**
 * Ink for a dark-mode Switch's CHECKED thumb. On the lighter dark-mode track
 * (#A78BFA) a white thumb blurs into it; this dark ink is 6.8:1 against it, the
 * M3 pattern of a dark `onPrimary` over a light primary. Same value as the
 * Velvet dark ink, `brandColors.onAccent`.
 */
const DARK_SCHEME_CHECKED_THUMB = '#16111F';

/**
 * Plain Compose `SwitchColors` for a native Android `Switch` drawn on a settings
 * card. Checked: the track is `brandControlTint`; in dark mode that track is the
 * light #A78BFA, so the thumb is a dark ink to stay visible, and in light mode
 * it is white on #6D28D9. Unchecked follows the M3 switch: a neutral track whose
 * `outline` border and thumb carry the boundary (3:1 or better on the card).
 */
export function switchControlColors(
  brandColors: BrandControlColors,
  m3: MaterialControlRoles,
  colorScheme: 'light' | 'dark',
): {
  checkedTrackColor: string;
  checkedThumbColor: string;
  uncheckedTrackColor: string;
  uncheckedThumbColor: string;
  uncheckedBorderColor: string;
} {
  return {
    checkedTrackColor: brandControlTint(brandColors),
    checkedThumbColor: colorScheme === 'dark' ? DARK_SCHEME_CHECKED_THUMB : brandColors.onPrimary,
    uncheckedTrackColor: m3.surfaceVariant,
    uncheckedThumbColor: m3.outline,
    uncheckedBorderColor: m3.outline,
  };
}

/**
 * Plain Compose `ButtonColors` for a native Android `FilledTonalButton`: the same
 * `secondaryContainer` / `onSecondaryContainer` pair Paper's `contained-tonal`
 * reads, so a tonal button matches its Paper neighbours.
 */
export function tonalButtonColors(m3: MaterialControlRoles): { containerColor: string; contentColor: string } {
  return { containerColor: m3.secondaryContainer, contentColor: m3.onSecondaryContainer };
}

/**
 * Plain Compose `SegmentedButtonColors` bridging the brand selected-fill for a
 * native Android `SegmentedButton`. Only the active (selected) container + content
 * are branded; every other state reads the Compose Material theme. Returned as a
 * minimal object — every `SegmentedButtonColors` field is optional — so this
 * shared file needs no `@expo/ui/jetpack-compose` import; the `.android.tsx` file
 * passes it straight to each button's `colors` prop.
 */
export function segmentedBrandColors(brandColors: BrandControlColors): {
  activeContainerColor: string;
  activeContentColor: string;
} {
  return {
    activeContainerColor: brandAccentColor(brandColors),
    activeContentColor: brandColors.onPrimary,
  };
}

/**
 * Plain Compose `SliderColors` for a native Android `Slider` on a settings card:
 * the thumb and the filled track take `brandControlTint`, like the iOS Slider's
 * `tint`, so the filled part clears 3:1 on a dark card.
 */
export function sliderControlColors(brandColors: BrandControlColors): {
  thumbColor: string;
  activeTrackColor: string;
} {
  return {
    thumbColor: brandControlTint(brandColors),
    activeTrackColor: brandControlTint(brandColors),
  };
}

/**
 * Plain Compose `TextFieldColors` bridging the brand accent onto a native Android
 * `OutlinedTextField` — the focused outline and the cursor. Every other state
 * (unfocused outline, error red, label, supporting text) reads the Compose
 * Material theme. Returned as a minimal object — every `TextFieldColors` field is
 * optional — so this shared file needs no `@expo/ui/jetpack-compose` import; the
 * `.android.tsx` file passes it straight to the field's `colors` prop. The outline
 * reads `brandAccentColor`; the cursor reads `brandControlTint` because a caret is
 * foreground drawn on a card (primaryFill is 2.45:1 on the dark card).
 */
export function textFieldBrandColors(brandColors: BrandControlColors): {
  focusedIndicatorColor: string;
  cursorColor: string;
} {
  return {
    focusedIndicatorColor: brandAccentColor(brandColors),
    cursorColor: brandControlTint(brandColors),
  };
}

/**
 * Brand cursor / selection props for a React Native `TextInput`.
 *
 * Android: RN falls back `cursorColor` and `selectionHandleColor` to
 * `selectionColor`, but `selectionColor` is also the text highlight, which RN
 * (ReactTextInputManager.kt) applies exactly as given. An opaque value would hide
 * the selected text, while a translucent value alone would give a translucent
 * caret (cursor and handles are drawn with SRC_IN, which keeps the alpha). So the
 * caret and handles get the opaque tint and the highlight gets a translucent one.
 *
 * Other platforms: on iOS `selectionColor` is the caret and highlight tint, and
 * iOS draws its own translucent highlight, so it stays opaque.
 */
export function textInputBrandColors(
  brandColors: BrandControlColors,
  platform: string,
): { cursorColor?: string; selectionColor: string; selectionHandleColor?: string } {
  const tint = brandControlTint(brandColors);
  if (platform === 'android') {
    return { cursorColor: tint, selectionHandleColor: tint, selectionColor: withAlpha(tint, 0.4) };
  }
  return { selectionColor: tint };
}

/**
 * Plain Compose `FilterChipColors` for a native Android Material 3 `FilterChip`.
 * SELECTED (active facet): the container takes the brand fill and the label +
 * leading icon take the on-fill colour, the Compose equivalent of the iOS chip's
 * `glassProminent` + `tint(brandColors.primary)` active style. UNSELECTED: the
 * leading icon is `brandControlTint` (6.11:1 on the dark card) and the label is
 * `onSurfaceVariant`, as M3 draws them. Returned as a plain object so this shared
 * file needs no `@expo/ui/jetpack-compose` import; the `.android.tsx` file passes
 * it straight to each chip's `colors` prop.
 */
export function filterChipBrandColors(
  brandColors: BrandControlColors,
  m3: MaterialControlRoles,
): {
  labelColor: string;
  iconColor: string;
  selectedContainerColor: string;
  selectedLabelColor: string;
  selectedLeadingIconColor: string;
} {
  return {
    labelColor: m3.onSurfaceVariant,
    iconColor: brandControlTint(brandColors),
    selectedContainerColor: brandAccentColor(brandColors),
    selectedLabelColor: brandColors.onPrimary,
    selectedLeadingIconColor: brandColors.onPrimary,
  };
}

/**
 * Plain Compose `ChipBorder`s for a `FilterChip`, one per selection state. Idle:
 * 1dp of `outline`, 4.08:1 on the dark card where the wallpaper-derived default
 * was 1.77:1. Selected: no visible border, M3's plain brand fill. A Compose chip
 * draws a custom border in every state, so the caller picks one per chip, and
 * the selected one is explicit rather than an omitted prop so a chip toggled on
 * clears its outline.
 */
export function filterChipBorders(m3: MaterialControlRoles): {
  idle: { width: number; color: string };
  selected: { width: number; color: string };
} {
  return { idle: { width: 1, color: m3.outline }, selected: { width: 0, color: 'transparent' } };
}

/**
 * Plain Compose `RadioButtonColors` for a native Android `RadioButton` on a
 * settings card: the selected dot takes `brandControlTint`, like the Switch track
 * beside it, and the empty ring takes `onSurfaceVariant`, as M3 draws it.
 */
export function radioControlColors(
  brandColors: BrandControlColors,
  m3: MaterialControlRoles,
): { selectedColor: string; unselectedColor: string } {
  return { selectedColor: brandControlTint(brandColors), unselectedColor: m3.onSurfaceVariant };
}
