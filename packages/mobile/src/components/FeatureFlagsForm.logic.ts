// Pure, node-testable helpers shared by both platform FeatureFlagsForm files
// (and the test stub). Keeping the segment catalog + the selection guard here
// means iOS and Android render the same options in the same order and can't
// drift, and it's testable without mounting a native @expo/ui tree. No native
// imports, no rendering.

import type { FeatureFlagOption } from './FeatureFlagsForm.types';

/**
 * The three segments a plain boolean flag renders, in display order. Labels
 * are tester-facing English only (this screen never reaches a non-tester
 * surface). Shared by the iOS segmented `Picker`, the Android
 * `SegmentedButton` row, and the test stub so the options can't diverge across
 * platforms.
 */
// i18n-ignore-next-line — tester-only screen
const DEFAULT_OPTION: FeatureFlagOption = { key: 'default', label: 'Default' };

export const BOOLEAN_FLAG_OPTIONS: readonly FeatureFlagOption[] = [
  DEFAULT_OPTION,
  // i18n-ignore-next-line — tester-only screen
  { key: 'on', label: 'On' },
  // i18n-ignore-next-line — tester-only screen
  { key: 'off', label: 'Off' },
];
/** A row with more choices than this draws a menu instead of a segmented control. */
export const MAX_SEGMENTS = 3;

/**
 * A variant's choice key. Prefixed so a variant can never collide with the
 * `default` / `on` / `off` keys (a variant named `default` would otherwise
 * read as "clear the override").
 */
const VARIANT_PREFIX = 'variant:';

export function variantChoiceKey(variant: string): string {
  return `${VARIANT_PREFIX}${variant}`;
}

/** The variant a choice key names, or null for `default` / `on` / `off`. */
export function variantFromChoiceKey(choice: string): string | null {
  return choice.startsWith(VARIANT_PREFIX) ? choice.slice(VARIANT_PREFIX.length) : null;
}

/** Default, then one choice per declared variant, in the catalog's order. */
export function variantFlagOptions(variants: readonly string[]): readonly FeatureFlagOption[] {
  return [
    DEFAULT_OPTION,
    // Variant strings are the label: they are what PostHog and the code read.
    ...variants.map((variant) => ({ key: variantChoiceKey(variant), label: variant })),
  ];
}

/** The selected option's label, for a menu's collapsed row. */
export function selectedFeatureFlagLabel(options: readonly FeatureFlagOption[], choice: string): string {
  return options.find((option) => option.key === choice)?.label ?? DEFAULT_OPTION.label;
}

/**
 * Narrows a native picker's untyped selection (`string | number | null` on
 * iOS) to one of a row's own option keys before it's handed to `onSelect`.
 * Options differ per row now (boolean vs multivariate), so this checks
 * against the SPECIFIC row's options rather than a single fixed catalog —
 * mirrors SegmentedControl.ios's string guard.
 */
export function isKnownFeatureFlagChoice(value: unknown, options: readonly FeatureFlagOption[]): value is string {
  return typeof value === 'string' && options.some((option) => option.key === value);
}
