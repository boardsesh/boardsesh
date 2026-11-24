import { createSystemServerFlag, SYSTEM_SERVER_FLAG_CACHE_MS, type FlagEnvironment } from './system-server-flag';

/**
 * The `directory-reports` server flag (docs/product/directory-reports.md,
 * docs/operations/feature-flags.md). It gates the report mutations and every
 * notification the reports feature sends, so no report notice reaches an app
 * build that cannot word it. It is one switch for the whole service, not a
 * per-account rollout: a report reaches people other than the reporter, and
 * the old app builds it must stay away from belong to them.
 *
 * How it resolves (override, then PostHog for the fixed id
 * `system:directory-reports`, failing closed) is `createSystemServerFlag` in
 * system-server-flag.ts.
 *
 * The answer is read in two ways: `isDirectoryReportsEnabled()` awaits a fresh
 * answer when the cached one is stale (the report mutations, the sweep, the
 * push worker), and `directoryReportsEnabledNow()` reads the cached answer
 * without waiting (inside a transaction that holds row locks, where a PostHog
 * round trip must not run). Boot awaits the first answer before the server and
 * the workers start, and a background refresh keeps it warm.
 */

export const DIRECTORY_REPORTS_FLAG = 'directory-reports';
export const DIRECTORY_REPORTS_FLAG_CACHE_MS = SYSTEM_SERVER_FLAG_CACHE_MS;

const directoryReportsFlag = createSystemServerFlag({
  flagKey: DIRECTORY_REPORTS_FLAG,
  logLabel: 'DirectoryReports',
  outageConsequence: 'reports stay off until it answers',
});

/**
 * True or false when PostHog answered for the flag, false when its answer
 * leaves the flag out, and null when it gave no usable answer: an unreadable
 * body, or one that says evaluating the flags went wrong.
 */
export function readDirectoryReportsFlagAnswer(payload: unknown): boolean | null {
  return directoryReportsFlag.readAnswer(payload);
}

/** Whether reports are on. Awaits PostHog (at most 1.5 s) when the cached answer is stale. Never throws. */
export function isDirectoryReportsEnabled(environment: FlagEnvironment = process.env): Promise<boolean> {
  return directoryReportsFlag.isEnabled(environment);
}

/**
 * Whether reports are on, from the override or the cached answer, without
 * waiting. Safe inside a transaction. A stale cache starts a refresh in the
 * background and answers with what it has (off when it has nothing).
 */
export function directoryReportsEnabledNow(environment: FlagEnvironment = process.env): boolean {
  return directoryReportsFlag.enabledNow(environment);
}

/**
 * Read the first answer (at most 1.5 s) and keep it fresh, so
 * `directoryReportsEnabledNow()` rarely reads a stale one. Boot awaits it before
 * the server and the push worker start: a cold cache reads as off, which would
 * drop the notices and pushes of the first minute.
 */
export function startDirectoryReportsFlagRefresh(): Promise<() => void> {
  return directoryReportsFlag.startRefresh();
}

export function __resetDirectoryReportsFlagForTests(): void {
  directoryReportsFlag.resetForTests();
}
