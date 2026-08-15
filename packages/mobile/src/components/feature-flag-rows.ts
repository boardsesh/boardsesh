import type { FeatureFlagDefinition } from '../providers/feature-flags-provider';
import type { FeatureFlagOverrides } from '../lib/feature-flag-overrides';
import type { FeatureFlagChoice, FeatureFlagRow } from './FeatureFlagsForm.types';

/**
 * View model for the tester-only Feature Flags screen. Extracted from
 * FeatureFlagsScreen so it can be tested without rendering the platform-split
 * native @expo/ui form.
 *
 * `configuredValue` is `boolean | undefined`, so the caption can distinguish a
 * live default that is not set from an explicit off value. Permanently shipped
 * capabilities are not listed here; every remaining flag uses `=== true`.
 */
export function buildFeatureFlagRows(
  definitions: readonly FeatureFlagDefinition[],
  overrides: FeatureFlagOverrides,
  baseFlags: Record<string, boolean>,
): FeatureFlagRow[] {
  return definitions.map((definition) => {
    const override = overrides[definition.key];
    const choice: FeatureFlagChoice = override === undefined ? 'default' : override ? 'on' : 'off';
    const base = baseFlags[definition.key];
    // i18n-ignore-next-line — tester-only screen
    const baseLabel = base === undefined ? 'not set' : base ? 'on' : 'off';
    const configuredValue: boolean | undefined = override ?? base;
    const effective = configuredValue === true;
    return {
      key: definition.key,
      label: definition.label,
      description: definition.description,
      choice,
      // i18n-ignore-next-line — tester-only screen
      effectiveLabel: `Live default: ${baseLabel} · Effective: ${effective ? 'on' : 'off'}`,
    };
  });
}
