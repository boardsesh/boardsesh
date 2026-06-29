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
