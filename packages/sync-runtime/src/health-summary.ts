/**
 * Fleet health summary shared by the aurora and kilter sync daemons.
 *
 * Pure string formatting, no drizzle — the snapshot itself is produced by
 * `getCredentialFleetSnapshot` in `@boardsesh/db/queries`. Keeping the format
 * here means both daemons emit the same line shape, so one log-based alert rule
 * covers both.
 */

/** The shape the formatter needs. Mirrors `CredentialFleetSnapshot`. */
export type SyncHealthSnapshot = {
  total: number;
  active: number;
  pending: number;
  error: number;
  expired: number;
  inBackoff: number;
  oldestAttemptAt: Date | string | null;
};

/**
 * Read a `timestamp` value that may arrive as a Date or as raw Postgres text.
 *
 * The bare `new Date(value)` this looks like would be WRONG: a zone-less wall
 * clock ("2026-05-06 07:08:09.123") is parsed in the host process's timezone, so
 * the reported instant would shift by the container's UTC offset. The column is
 * `timestamp without time zone` and this codebase reads those as UTC — which is
 * what drizzle's own decoder does (it appends "+0000"), so matching it here
 * keeps the mapped and the defensive path in agreement.
 */
function readTimestamp(value: Date | string): Date {
  if (value instanceof Date) return value;
  const trimmed = value.trim();
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed);
  return new Date(hasZone ? trimmed : `${trimmed.replace(' ', 'T')}Z`);
}

/**
 * Format a {@link SyncHealthSnapshot} as a single greppable log line.
 *
 * `tag` is the runner prefix (e.g. `[SyncRunner]`) and `label` names the fleet
 * (e.g. `aurora credentials`). Pure, so it's unit-testable without a database —
 * which matters: this function is the one that threw
 * `oldestAttemptAt.toISOString is not a function` on every cycle for a month,
 * and a health REPORTER that can throw is worse than no reporter at all.
 */
export function formatSyncHealthSummary(snapshot: SyncHealthSnapshot, tag: string, label: string): string {
  const oldest = snapshot.oldestAttemptAt ? readTimestamp(snapshot.oldestAttemptAt).toISOString() : 'never';
  return (
    `${tag} Sync health: ${snapshot.total} ${label} — ` +
    `active=${snapshot.active} pending=${snapshot.pending} error=${snapshot.error} expired=${snapshot.expired}; ` +
    `inBackoff=${snapshot.inBackoff}; oldestAttempt=${oldest}`
  );
}
