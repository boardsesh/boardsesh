import { createSystemServerFlag, type FlagEnvironment } from './system-server-flag';

/**
 * The `directory-setup-suggestions` server flag (docs/product/directory-reports.md,
 * "The `directory-setup-suggestions` flag"; docs/operations/feature-flags.md).
 * It sits on top of `directory-reports` and decides whether a climber's
 * suggested setup on a "Set up wrong" report may change a board at a gym nobody
 * runs. Off, a suggestion is still checked and stored, and always goes to
 * review with no reason.
 *
 * Same rules as `directory-reports`: one switch for the whole service,
 * evaluated for the fixed id `system:directory-setup-suggestions`, decided by
 * `FEATURE_FLAG_OVERRIDES` when that names it, and off when PostHog can't
 * answer (`createSystemServerFlag`). `reportBoard` awaits it before its
 * transaction opens, only when the report carries a suggestion, so nothing
 * needs it warm at boot.
 */

export const DIRECTORY_SETUP_SUGGESTIONS_FLAG = 'directory-setup-suggestions';

const setupSuggestionsFlag = createSystemServerFlag({
  flagKey: DIRECTORY_SETUP_SUGGESTIONS_FLAG,
  logLabel: 'DirectoryReports',
  outageConsequence: 'suggested setups go to review until it answers',
});

/** Whether a suggested setup may change a board. Awaits PostHog (at most 1.5 s) when the cached answer is stale. Never throws. */
export function isDirectorySetupSuggestionsEnabled(environment: FlagEnvironment = process.env): Promise<boolean> {
  return setupSuggestionsFlag.isEnabled(environment);
}

export function __resetDirectorySetupSuggestionsFlagForTests(): void {
  setupSuggestionsFlag.resetForTests();
}
