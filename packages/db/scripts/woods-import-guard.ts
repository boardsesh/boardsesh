import { isLocalDatabaseUrl } from './db-connection.js';

// The env var a human sets to deliberately run the Woods catalog import against
// a non-local database (prod, or a restored snapshot / staging copy). Never set
// by any automation in this repo, so a mistyped DB_URL can never carry it.
export const WOODS_IMPORT_ALLOW_REMOTE_ENV_VAR = 'WOODS_IMPORT_ALLOW_REMOTE';

export type WoodsImportDecision = 'local' | 'remote-allowed' | 'remote-refused';

/**
 * Pure decision logic for whether import-woods-catalog.ts should be allowed to
 * run against `databaseUrl`.
 *
 * Unlike the MoonBoard guard, this importer is NOT deprecated — it is the one
 * and only path the Woods catalog gets into a database, and running it against
 * prod is an expected, signed-off operation. What the guard prevents is doing it
 * by accident: the script upserts the full 5,400-climb catalog in one go, and an
 * inherited or mistyped DB_URL would land that write on whatever database it
 * happened to point at. So a non-local target needs a second, deliberate signal
 * (WOODS_IMPORT_ALLOW_REMOTE=1) alongside DB_URL.
 *
 * Takes the override value as a parameter (rather than reading process.env
 * itself) so this stays pure and unit-testable; only the exact string '1' opts
 * in — any other value (unset, 'true', 'yes', '') fails closed to
 * 'remote-refused'.
 */
export function resolveWoodsImportDecision(
  databaseUrl: string,
  allowRemoteEnvValue: string | undefined,
): WoodsImportDecision {
  if (isLocalDatabaseUrl(databaseUrl)) return 'local';
  return allowRemoteEnvValue === '1' ? 'remote-allowed' : 'remote-refused';
}

/**
 * Enforces resolveWoodsImportDecision for the Woods catalog importer. Callers
 * must print the resolved target host themselves before calling this, so the
 * operator sees it regardless of which branch is taken.
 *
 * Return type is `void`, not `never`: only the 'remote-refused' branch calls
 * process.exit (which TypeScript types as `never`) — the 'local' and
 * 'remote-allowed' branches return normally, so the function as a whole does
 * have a reachable return path and `never` would be inaccurate here.
 */
export function assertWoodsImportAllowed(databaseUrl: string, scriptLabel: string): void {
  const decision = resolveWoodsImportDecision(databaseUrl, process.env[WOODS_IMPORT_ALLOW_REMOTE_ENV_VAR]);

  if (decision === 'local') return;

  if (decision === 'remote-allowed') {
    console.warn(
      `⚠️  ${WOODS_IMPORT_ALLOW_REMOTE_ENV_VAR}=1 set — ${scriptLabel} is proceeding against a non-local database. Check the host printed above.`,
    );
    return;
  }

  console.error(`❌ ${scriptLabel} refuses to run against a non-local database without an explicit opt-in.`);
  console.error(
    scriptLabel === 'repair-woods-rules.ts'
      ? '   It updates matching and feet rules on existing imported Woods climbs.'
      : '   It upserts the entire Woods catalog (5,400+ climbs, stats, holds and aliases) in one pass.',
  );
  console.error('   That is a deliberate, signed-off operation against prod — not something to do by accident');
  console.error('   because DB_URL was inherited from the shell or pointed at the wrong host.');
  console.error(
    `   If you meant this host, re-run with ${WOODS_IMPORT_ALLOW_REMOTE_ENV_VAR}=1 alongside an inline DB_URL.`,
  );
  process.exit(1);
}
