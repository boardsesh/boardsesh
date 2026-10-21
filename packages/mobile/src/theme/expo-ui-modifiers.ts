// Theming bridge for @expo/ui native primitives.
//
// Native @expo/ui controls read system colours automatically — iOS via
// PlatformColor / SwiftUI semantic styles, Android via the Compose Material
// theme — so only the BRAND ACCENT needs bridging from our theme tokens. This
// module is the single place that maps `useTheme().brandColors` onto the plain
// colour values the native modifiers / props want, so the brand colour is
// sourced once and every primitive tints identically.
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
// `colors={switchControlColors(brandColors, colorScheme)}` on Android.
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
 * card: the on-track is `brandControlTint`. In dark mode that track is the light
 * #A78BFA, so the checked thumb switches to a dark ink to stay visible; light
 * mode keeps the Compose default thumb (the track is the same #6D28D9 as before).
 */
export function switchControlColors(
  brandColors: BrandControlColors,
  colorScheme: 'light' | 'dark',
): { checkedTrackColor: string; checkedThumbColor?: string } {
  return {
    checkedTrackColor: brandControlTint(brandColors),
    ...(colorScheme === 'dark' ? { checkedThumbColor: DARK_SCHEME_CHECKED_THUMB } : {}),
  };
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
 * `.android.tsx` file passes it straight to the field's `colors` prop. Both fields
 * read `brandAccentColor` so they can't drift from the other primitives.
 */
export function textFieldBrandColors(brandColors: BrandControlColors): {
  focusedIndicatorColor: string;
  cursorColor: string;
} {
  return {
    focusedIndicatorColor: brandAccentColor(brandColors),
    cursorColor: brandAccentColor(brandColors),
  };
}

/**
 * Plain Compose `FilterChipColors` bridging the brand fill for a native Android
 * Material 3 `FilterChip` — only the SELECTED (active facet) state is branded: the
 * container takes the brand fill and the label + leading icon take the on-fill
 * colour. Every unselected state reads the Compose Material theme. This is the
 * Compose equivalent of the iOS chip's `glassProminent` + `tint(brandColors.primary)`
 * active style. Returned as a minimal object — every `FilterChipColors` field is
 * optional — so this shared file needs no `@expo/ui/jetpack-compose` import; the
 * `.android.tsx` file passes it straight to each chip's `colors` prop. All branded
 * fields read `brandAccentColor` / `onPrimary` so they can't drift from the other
 * primitives.
 */
export function filterChipBrandColors(brandColors: BrandControlColors): {
  selectedContainerColor: string;
  selectedLabelColor: string;
  selectedLeadingIconColor: string;
} {
  return {
    selectedContainerColor: brandAccentColor(brandColors),
    selectedLabelColor: brandColors.onPrimary,
    selectedLeadingIconColor: brandColors.onPrimary,
  };
}
