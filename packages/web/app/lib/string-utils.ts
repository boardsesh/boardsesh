export function capitalizeFirst(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// `formatBoardDisplayName` now lives in @boardsesh/board-config so shared
// packages (e.g. @boardsesh/profile-stats) share one source of truth for
// board-name casing. Re-exported here for back-compat with web call sites.
export { formatBoardDisplayName } from '@boardsesh/board-config';

/**
 * The name a climb page shows — and, more importantly, the name that goes into
 * its URL slug. Unnamed climbs exist (draft and imported ones), and if
 * `generateMetadata` falls back while the page body doesn't, the canonical and
 * the CTA hand-off end up on two different pathnames for the same climb. One
 * function so they can't drift.
 */
export function resolveClimbDisplayName(climbName: string | null | undefined, boardName: string): string {
  return climbName || `${boardName} Climb`;
}
