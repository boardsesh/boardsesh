import type { FeatureFlagDefinition } from '../providers/feature-flags-provider';
import type { FeatureFlagOverrides } from '../lib/feature-flag-overrides';
import { BOOLEAN_FLAG_OPTIONS, variantFlagOptions } from './FeatureFlagsForm.logic';
import type { FeatureFlagRow } from './FeatureFlagsForm.types';

/**
 * View model for the tester-only Feature Flags screen. Extracted from
 * FeatureFlagsScreen so it can be tested without rendering the platform-split
 * native @expo/ui form.
 *
 * Two shapes, by whether the definition declares `variants`:
 *  - Boolean flags keep their original `=== true` semantics exactly —
 *    `configuredValue` is `boolean | undefined` so the caption can distinguish
 *    a live default that is not set from an explicit off value.
 *  - Multivariate flags show the resolved variant string itself (or
 *    'not set') rather than an on/off effective value — there is no universal
 *    "off" for an arbitrary variant set.
 *
 * Permanently shipped capabilities are not listed here.
 */
export function buildFeatureFlagRows(
  definitions: readonly FeatureFlagDefinition[],
  overrides: FeatureFlagOverrides,
  baseFlags: Record<string, boolean | string>,
): FeatureFlagRow[] {
  return definitions.map((definition) => {
    const override = overrides[definition.key];
    const base = baseFlags[definition.key];

    if (definition.variants) {
      const variants = definition.variants;
      const overrideVariant = typeof override === 'string' && variants.includes(override) ? override : undefined;
      const baseVariant = typeof base === 'string' && variants.includes(base) ? base : undefined;
      const configuredValue = overrideVariant ?? baseVariant;
      return {
        key: definition.key,
        label: definition.label,
        description: definition.description,
        options: variantFlagOptions(variants),
        choice: overrideVariant ?? 'default',
        // i18n-ignore-next-line — tester-only screen
        effectiveLabel: `Live default: ${baseVariant ?? 'not set'} · Effective: ${configuredValue ?? 'not set'}`,
      };
    }

    const overrideBool = typeof override === 'boolean' ? override : undefined;
    const baseBool = typeof base === 'boolean' ? base : undefined;
    const choice = overrideBool === undefined ? 'default' : overrideBool ? 'on' : 'off';
    // i18n-ignore-next-line — tester-only screen
    const baseLabel = baseBool === undefined ? 'not set' : baseBool ? 'on' : 'off';
    const configuredValue: boolean | undefined = overrideBool ?? baseBool;
    const effective = configuredValue === true;
    return {
      key: definition.key,
      label: definition.label,
      description: definition.description,
      options: BOOLEAN_FLAG_OPTIONS,
      choice,
      // i18n-ignore-next-line — tester-only screen
      effectiveLabel: `Live default: ${baseLabel} · Effective: ${effective ? 'on' : 'off'}`,
    };
  });
}
