// Theming bridge for @expo/ui native primitives.
//
// iOS controls read system colours automatically via PlatformColor / SwiftUI
// semantic styles, so only the BRAND ACCENT needs bridging there. Android does
// NOT get that for free, and this comment used to claim it did — which is how the
// app shipped black-on-dark-purple settings and auth text. Two Android caveats:
//
//   1. The Compose theme follows the DEVICE scheme unless the host is told
//      otherwise. Mount every host through `components/ThemedHost`, never a bare
//      `@expo/ui` `Host`.
//   2. Compose's ambient `LocalContentColor` defaults to `Color.Black`, and
//      `MaterialTheme` does not provide it — only Surface-family composables
//      (Surface / Card / Button / Chip / ListItem / text-field slots) do. A
//      `<Text>` outside one of those is literally black in BOTH schemes, so it
//      needs an explicit `color`.
//
// This module is the single place that maps `useTheme()` colours onto the plain
// values the native modifiers / props want, so they are sourced once and every
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
// e.g. `tint(brandAccentColor(brandColors))` on iOS, or
// `colors={switchBrandColors(brandColors)}` on Android.
//
// The surface generalises to the other primitives this migration covers:
// `brandAccentColor` is the one source of the on-fill accent every control tints
// with (Toggle, Switch, Picker / SegmentedControl, Slider, Button). Add
// control-specific Android colour mappers (`sliderBrandColors`, …) here as more
// primitives land — each reading `brandAccentColor` so they can't drift.

/**
 * The subset of resolved brand colours the native-control bridge reads. The
 * theme's `brandColors` (`useTheme().brandColors`) satisfies this structurally,
 * so call sites pass it straight through.
 */
export type BrandControlColors = {
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
 * The brand accent every native control tints with (on-track, selected fill,
 * thumb). Sourced once here so a Toggle, Switch, Picker, Slider, and Button all
 * read the same scheme-aware brand colour. Feed it to the platform's accent
 * input: iOS `tint(...)`, Android Switch `checkedTrackColor`, Slider `color`, …
 */
export function brandAccentColor(brandColors: BrandControlColors): string {
  return brandColors.primaryFill;
}

/**
 * Plain Compose `SwitchColors` bridging the brand on-track colour for a native
 * Android `Switch`. Returned as a minimal object — every `SwitchColors` field is
 * optional — so this shared file needs no `@expo/ui/jetpack-compose` import; the
 * `.android.tsx` file passes it straight to the Switch's `colors` prop.
 */
export function switchBrandColors(brandColors: BrandControlColors): { checkedTrackColor: string } {
  return { checkedTrackColor: brandAccentColor(brandColors) };
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
 * Plain Compose `SliderColors` bridging the brand fill for a native Android
 * `Slider` — the thumb and the active (filled) portion of the track. Every other
 * slider element (inactive track, ticks) reads the Compose Material theme.
 * Returned as a minimal object — every `SliderColors` field is optional — so this
 * shared file needs no `@expo/ui/jetpack-compose` import; the `.android.tsx` file
 * passes it straight to the Slider's `colors` prop. Both fields read
 * `brandAccentColor` so they can't drift from the other primitives.
 */
export function sliderBrandColors(brandColors: BrandControlColors): {
  thumbColor: string;
  activeTrackColor: string;
} {
  return {
    thumbColor: brandAccentColor(brandColors),
    activeTrackColor: brandAccentColor(brandColors),
  };
}

/**
 * The subset of resolved system colours the native-control bridge reads for text
 * ink. `useTheme().systemColors` satisfies this structurally on the Material
 * variant, where every value is a plain string. (On the Liquid Glass iOS branch
 * these are `PlatformColor`s, which is why only Android call sites pass them.)
 */
export type SystemInkColors = {
  label: string;
  secondaryLabel: string;
};

/**
 * Plain Compose `TextFieldColors` for a native Android `OutlinedTextField`: the
 * brand accent on the focused outline + cursor, and our own label/supporting/value
 * ink for every text state.
 *
 * The ink matters. Left to the Compose theme these resolve from `onSurface` /
 * `onSurfaceVariant` of a palette that is wallpaper-derived on Android 12+
 * (`dynamicDark/LightColorScheme`), so the auth fields drifted away from the rest
 * of the screen — and read near-black outright whenever the host's scheme didn't
 * match the app's. Pinning them keeps the field legible and on-brand.
 *
 * Returned as a plain object — every `TextFieldColors` field is optional — so this
 * shared file needs no `@expo/ui/jetpack-compose` import; the `.android.tsx` file
 * passes it straight to the field's `colors` prop. The branded fields read
 * `brandAccentColor` so they can't drift from the other primitives.
 */
export function textFieldBrandColors(
  brandColors: BrandControlColors,
  systemColors: SystemInkColors,
): {
  focusedIndicatorColor: string;
  cursorColor: string;
  focusedTextColor: string;
  unfocusedTextColor: string;
  focusedLabelColor: string;
  unfocusedLabelColor: string;
  focusedPlaceholderColor: string;
  unfocusedPlaceholderColor: string;
  focusedSupportingTextColor: string;
  unfocusedSupportingTextColor: string;
  focusedTrailingIconColor: string;
  unfocusedTrailingIconColor: string;
} {
  return {
    focusedIndicatorColor: brandAccentColor(brandColors),
    cursorColor: brandAccentColor(brandColors),
    // The typed value — the one that went near-black on the dark auth screen.
    focusedTextColor: systemColors.label,
    unfocusedTextColor: systemColors.label,
    // Floating label: brand accent while focused (it sits on the outline), the
    // secondary ink at rest.
    focusedLabelColor: brandAccentColor(brandColors),
    unfocusedLabelColor: systemColors.secondaryLabel,
    focusedPlaceholderColor: systemColors.secondaryLabel,
    unfocusedPlaceholderColor: systemColors.secondaryLabel,
    focusedSupportingTextColor: systemColors.secondaryLabel,
    unfocusedSupportingTextColor: systemColors.secondaryLabel,
    // The password reveal eye — an `Icon` with no tint, so it would otherwise
    // inherit the black `LocalContentColor`.
    focusedTrailingIconColor: systemColors.secondaryLabel,
    unfocusedTrailingIconColor: systemColors.secondaryLabel,
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
