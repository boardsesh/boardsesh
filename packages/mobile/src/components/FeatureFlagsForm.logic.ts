// Pure, node-testable helpers shared by both platform FeatureFlagsForm files
// (and the test stub). Keeping the segment catalog + the selection guard here
// means iOS and Android render the same three options in the same order and can't
// drift, and it's testable without mounting a native @expo/ui tree. No native
// imports, no rendering.

import type { FeatureFlagChoice } from './FeatureFlagsForm.types';

/**
 * The three segments every flag row renders, in display order. Labels are
 * tester-facing English only (this screen never reaches a non-tester surface).
 * Shared by the iOS segmented `Picker`, the Android `SegmentedButton` row, and
 * the test stub so the options can't diverge across platforms.
 */
export const FEATURE_FLAG_CHOICES: readonly { key: FeatureFlagChoice; label: string }[] = [
  // i18n-ignore-next-line — tester-only screen
  { key: 'default', label: 'Default' },
  // i18n-ignore-next-line — tester-only screen
  { key: 'on', label: 'On' },
  // i18n-ignore-next-line — tester-only screen
  { key: 'off', label: 'Off' },
];

/**
 * Narrows the iOS segmented `Picker`'s untyped selection (`string | number |
 * null`) to a `FeatureFlagChoice` before it's handed to `onSelect`. The Picker's
 * tags are always our three choice keys, so a non-matching value is dropped
 * rather than blind-cast — mirrors SegmentedControl.ios's string guard.
 */
export function isFeatureFlagChoice(value: unknown): value is FeatureFlagChoice {
  return value === 'default' || value === 'on' || value === 'off';
}
