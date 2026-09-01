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
export const BOOLEAN_FLAG_OPTIONS: readonly FeatureFlagOption[] = [
  // i18n-ignore-next-line — tester-only screen
  { key: 'default', label: 'Default' },
  // i18n-ignore-next-line — tester-only screen
  { key: 'on', label: 'On' },
  // i18n-ignore-next-line — tester-only screen
  { key: 'off', label: 'Off' },
];
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
