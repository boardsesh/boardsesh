import type { FeatureFlagDefinition } from '../providers/feature-flags-provider';
import type { FeatureFlagOverrides } from '../lib/feature-flag-overrides';
import { BOOLEAN_FLAG_OPTIONS } from './FeatureFlagsForm.logic';
import type { FeatureFlagRow } from './FeatureFlagsForm.types';

/**
 * View model for the tester-only Feature Flags screen. Extracted from
 * FeatureFlagsScreen so it can be tested without rendering the platform-split
 * native @expo/ui form.
 *
 * Every flag is a boolean: `configuredValue` is `boolean | undefined` so the
 * caption can distinguish a live default that is not set from an explicit off.
 *
 * Multivariate flags used to render a select of their declared variants. That
 * went with the last two of them (`board-render-mode-default`,
 * `board-glow-falloff`), retired for 2.4 when the board drawing and its glow
 * falloff became plain user settings instead of rollout controls.
 *
 * `observe-sample-rate` is multivariate again, but this screen was NOT rebuilt
 * for it: it renders as On/Off and an override here writes a boolean. That is
 * harmless — the consumer parses a boolean back to the shipped rate — but the
 * rate itself can only be changed from PostHog. Rebuild the select if a flag
 * ever needs on-device variant selection. See docs/feature-flags.md.
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
export type FeatureFlagOverrideAction = { action: 'clear' } | { action: 'set'; value: boolean };

/**
 * Turn a row's segment selection into a set/clear on the override store.
 *
 * Extracted from `FeatureFlagsScreen.handleSelect` for the same reason
 * `buildFeatureFlagRows` was: it is the only branching logic on that screen,
 * and testing it should not require mounting the platform-split native
 * @expo/ui form.
 *
 * Every flag is a boolean, so the only two segments that write are `on` and
 * `off`; anything else clears.
 */
export function resolveFeatureFlagOverrideAction(choice: string): FeatureFlagOverrideAction {
  if (choice === 'default') return { action: 'clear' };
  return { action: 'set', value: choice === 'on' };
}

/**
 * Override keys whose stored value no longer fits the flag's declared shape.
 *
 * The case this exists for: a tester who forced a flag to a variant string
 * while it was multivariate still has that string sitting in the override
 * store now that every flag is a boolean again. Readers already ignore it and
 * `buildFeatureFlagRows` renders the row at 'Default' — but the row being
 * ALREADY at 'Default' is precisely why the tester cannot clear it: selecting
 * the segment it is already on fires no change. So the screen migrates it on
 * read instead.
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
      return typeof override !== 'boolean';
    })
    .map((definition) => definition.key);
}
