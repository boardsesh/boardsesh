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

/** What the screen should do with one segment selection. */
export type FeatureFlagOverrideAction = { action: 'clear' } | { action: 'set'; value: boolean | string };

/**
 * Turn a row's segment selection into a set/clear on the override store.
 *
 * Extracted from `FeatureFlagsScreen.handleSelect` for the same reason
 * `buildFeatureFlagRows` was: it is the only branching logic on that screen,
 * and testing it should not require mounting the platform-split native
 * @expo/ui form.
 *
 * The definition — not the shape of `choice` — decides which kind of override
 * gets written, so a row can only ever set the kind of value its own flag
 * declares. A boolean flag whose segments are `on`/`off` stores a boolean; a
 * multivariate flag stores the variant string verbatim. Widened to
 * `FeatureFlagDefinition` up front because the catalog's `as const` type only
 * gives `.variants` to the union members that declare it, which `.find()`
 * cannot narrow across.
 */
export function resolveFeatureFlagOverrideAction(
  definitions: readonly FeatureFlagDefinition[],
  key: string,
  choice: string,
): FeatureFlagOverrideAction {
  if (choice === 'default') return { action: 'clear' };
  const definition = definitions.find((candidate) => candidate.key === key);
  return { action: 'set', value: definition?.variants ? choice : choice === 'on' };
}

/**
 * Override keys whose stored value no longer fits the flag's declared shape.
 *
 * The case this exists for: a flag that shipped as a plain boolean and later
 * gained `variants` (the retired `board-render-mode-default` did exactly that). A tester
 * who had forced it On still has `true` sitting in the override store. Every
 * reader already ignores it — `useFeatureFlagVariant` narrows a non-variant
 * value away, and `buildFeatureFlagRows` renders the row at 'Default' — but
 * the row being ALREADY at 'Default' is precisely why the tester cannot clear
 * it: selecting the segment it is already on fires no change. So the screen
 * migrates it on read instead.
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
      return definition.variants
        ? !(typeof override === 'string' && definition.variants.includes(override))
        : typeof override !== 'boolean';
    })
    .map((definition) => definition.key);
}
