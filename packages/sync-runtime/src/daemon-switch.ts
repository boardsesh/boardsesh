/**
 * The off switch for the Aurora and Kilter sync daemons.
 *
 * Once the background worker families own routine syncs (docs/background-workers.md,
 * "Routine provider sync"), the sync host sets `SYNC_DAEMON_DISABLED=true`: the
 * daemon command logs one line and exits 0 instead of starting its loop, so the
 * service goes idle without deleting its unit. Only the literal `true` disables;
 * anything else (unset, `false`, a typo) keeps the daemon running, because a
 * daemon that silently stops is worse than one that keeps its old job.
 */
export function isSyncDaemonDisabled(environment: Readonly<Record<string, string | undefined>>): boolean {
  return environment.SYNC_DAEMON_DISABLED?.trim() === 'true';
}

export const SYNC_DAEMON_DISABLED_MESSAGE =
  'SYNC_DAEMON_DISABLED=true: the background worker families own routine syncs; not starting the daemon';
