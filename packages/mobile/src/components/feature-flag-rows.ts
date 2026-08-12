import type { FeatureFlagDefinition } from '../providers/feature-flags-provider';
import type { FeatureFlagOverrides } from '../lib/feature-flag-overrides';
import { isOfflineDownloadsEnabled } from '../providers/offline-downloads-enabled';
import type { FeatureFlagChoice, FeatureFlagRow } from './FeatureFlagsForm.types';

/**
 * View model for the tester-only Feature Flags screen. Extracted from
 * FeatureFlagsScreen so it can be tested without rendering the platform-split
 * native @expo/ui form.
 *
 * The subtle part is `configuredValue`, which is `boolean | undefined`, NOT
 * `?? false`. "Unset" and "explicitly off" are different inputs to the gate
 * functions: since #4312 `offline-board-downloads` reads an unset value as ON,
 * so collapsing unset into `false` made the screen report "Effective: off" for
 * a flag that was actually on — the exact question a tester opens this screen
 * to answer. Every other flag is plain `=== true`, so nothing else moves.
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
    const effective =
      definition.key === 'offline-board-downloads'
        ? isOfflineDownloadsEnabled(configuredValue)
        : configuredValue === true;
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
