import type { FeatureFlagDefinition } from '../providers/feature-flags-provider';
import type { FeatureFlagOverrides } from '../lib/feature-flag-overrides';
import { isDevBuild } from '../lib/is-dev-build';
import {
  BOOLEAN_FLAG_OPTIONS,
  MAX_SEGMENTS,
  variantChoiceKey,
  variantFlagOptions,
  variantFromChoiceKey,
} from './FeatureFlagsForm.logic';
import type { FeatureFlagRow } from './FeatureFlagsForm.types';

/**
 * View model for the tester-only Feature Flags screen. Extracted from
 * FeatureFlagsScreen so it can be tested without rendering the platform-split
 * native @expo/ui form.
 *
 * A plain flag renders Default / On / Off and an override writes a boolean.
 * A flag that declares `variants` renders Default plus one choice per variant,
 * and an override writes the variant string: `first-connect-cta-arm` is read
 * from the on-device override alone, so this is the only way to pick it, and
 * `observe-sample-rate` can be forced to a rate.
 * The select went with the 2.4 retirement of the last multivariate flags and
 * came back with these.
 *
 * Up to three choices draw as a segmented control; more draw as a menu
 * (`control`), which keeps the five sample rates readable on a phone.
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

    // A policy-controlled flag's override is dropped by the provider outside a
    // dev build, so on a store binary this row must not claim to have forced
    // anything: it reports the live value and says why it cannot be changed.
    // Rendering the tester's stored choice here would be a toggle that lies.
    const overrideIgnored = definition.policyControlled === true && !isDevBuild();
    const honouredOverride = overrideIgnored ? undefined : override;
    // i18n-ignore-next-line — tester-only screen
    const policyNote = overrideIgnored ? ' · override ignored on this build (region-gated)' : '';

    const variants = definition.variants ?? [];
    if (variants.length > 0) {
      const overrideVariant =
        typeof honouredOverride === 'string' && variants.includes(honouredOverride) ? honouredOverride : undefined;
      const baseVariant = typeof base === 'string' && variants.includes(base) ? base : undefined;
      const options = variantFlagOptions(variants);
      return {
        key: definition.key,
        label: definition.label,
        description: definition.description,
        options,
        control: options.length > MAX_SEGMENTS ? 'menu' : 'segmented',
        choice: overrideVariant === undefined ? 'default' : variantChoiceKey(overrideVariant),
        // i18n-ignore-next-line — tester-only screen
        effectiveLabel: `Live default: ${baseVariant ?? 'not set'} · Effective: ${overrideVariant ?? baseVariant ?? 'default'}${policyNote}`,
      };
    }

    const overrideBool = typeof honouredOverride === 'boolean' ? honouredOverride : undefined;
    const baseBool = typeof base === 'boolean' ? base : undefined;
    const choice = overrideBool === undefined ? 'default' : overrideBool ? 'on' : 'off';
    // i18n-ignore-next-line — tester-only screen
    const baseLabel = baseBool === undefined ? 'not set' : baseBool ? 'on' : 'off';
    const configuredValue: boolean | undefined = overrideBool ?? baseBool;
    const effective = (configuredValue ?? definition.defaultEnabled) === true;
    return {
      key: definition.key,
      label: definition.label,
      description: definition.description,
      options: BOOLEAN_FLAG_OPTIONS,
      control: 'segmented',
      choice,
      // i18n-ignore-next-line — tester-only screen
      effectiveLabel: `Live default: ${baseLabel} · Effective: ${effective ? 'on' : 'off'}${policyNote}`,
    };
  });
}

/** What the screen should do with one selection. */
export type FeatureFlagOverrideAction = { action: 'clear' } | { action: 'set'; value: boolean | string };

/**
 * Turn a row's selection into a set/clear on the override store.
 *
 * Extracted from `FeatureFlagsScreen.handleSelect` for the same reason
 * `buildFeatureFlagRows` was: it is the only branching logic on that screen,
 * and testing it should not require mounting the platform-split native
 * @expo/ui form.
 *
 * Default clears. A variant choice writes its variant string; `on` / `off`
 * write a boolean. Anything else (a key no row offers) clears rather than
 * guessing.
 */
export function resolveFeatureFlagOverrideAction(choice: string): FeatureFlagOverrideAction {
  const variant = variantFromChoiceKey(choice);
  if (variant !== null) return { action: 'set', value: variant };
  if (choice === 'on') return { action: 'set', value: true };
  if (choice === 'off') return { action: 'set', value: false };
  return { action: 'clear' };
}

/**
 * Override keys whose stored value no longer fits the flag's declared shape:
 * a string on a plain flag, or on a multivariate flag a boolean (the screen
 * wrote On/Off there while the select was gone) or a variant it no longer
 * declares. Readers already ignore these and the row renders at 'Default' —
 * which is precisely why the tester cannot clear one: selecting the segment it
 * is already on fires no change. So the screen migrates them on read.
 *
 * Deliberately does NOT include keys missing from the catalog. A flag can be
 * removed and restored across branches, and silently dropping a tester's
 * choice for one they still care about is worse than leaving an inert entry
 * that "Reset all overrides" already clears.
 */
export function findStaleFeatureFlagOverrideKeys(
  definitions: readonly FeatureFlagDefinition[],
  overrides: FeatureFlagOverrides,
): string[] {
  return definitions
    .filter((definition) => {
      const override = overrides[definition.key];
      if (override === undefined) return false;
      const variants = definition.variants ?? [];
      if (variants.length > 0) return typeof override !== 'string' || !variants.includes(override);
      return typeof override !== 'boolean';
    })
    .map((definition) => definition.key);
}
