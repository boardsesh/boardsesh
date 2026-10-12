import type { Sql, TransactionSql } from 'postgres';

const RECONCILE_MIGRATION_SUFFIX = '_privacy_reconcile_tick_tombstones';

export type PrivacyReconcileCounts = { tickStamps: string; legacySessions: string };
export type PrivacyReconcilePreflight = PrivacyReconcileCounts & { hash: string; tag: string };

/** Read only. The predicates intentionally match both immutable 0265 blocks. */
export async function readPrivacyReconcileCounts(client: Sql | TransactionSql): Promise<PrivacyReconcileCounts> {
  const relations = await client<{ present: number }[]>`
    SELECT COUNT(*)::int AS present FROM unnest(ARRAY[
      'public.content_privacy', 'public.resource_privacy', 'public.boardsesh_ticks',
      'public.board_sessions', 'public.user_profiles'
    ]) relation_name WHERE to_regclass(relation_name) IS NOT NULL
  `;
  if (relations[0].present === 0) return { tickStamps: '0', legacySessions: '0' };
  if (relations[0].present !== 5)
    throw new Error('Privacy reconcile preflight: incomplete privacy schema; inspect before migrating.');
  const counts = await client<PrivacyReconcileCounts[]>`
    SELECT (
      SELECT COUNT(*) FROM content_privacy stamp
      WHERE stamp.entity_type = 'tick' AND stamp.audience = 'only_me'
        AND stamp.updated_at >= '2026-10-09'
        AND EXISTS (SELECT 1 FROM boardsesh_ticks tick JOIN board_sessions session ON session.id = tick.session_id
                    WHERE tick.uuid = stamp.entity_id AND session.origin = 'explicit')
        AND NOT EXISTS (SELECT 1 FROM user_profiles profile
                        WHERE profile.user_id = stamp.owner_id AND profile.privacy_revision <> 0)
        AND NOT EXISTS (SELECT 1 FROM content_privacy consent
                        WHERE consent.owner_id = stamp.owner_id AND consent.public_consent_revision IS NOT NULL)
    )::text AS "tickStamps", (
      SELECT COUNT(*) FROM resource_privacy policy
      JOIN board_sessions session ON session.id = policy.resource_id AND session.is_public = false
      WHERE policy.kind = 'session' AND policy.audience = 'invite_only'
        AND policy.updated_at >= '2026-10-09'
        AND NOT EXISTS (SELECT 1 FROM user_profiles profile WHERE profile.user_id = policy.owner_id
                        AND (profile.privacy_revision <> 0 OR profile.default_session_audience IS NOT NULL))
    )::text AS "legacySessions"
  `;
  return counts[0];
}

/** No DDL, guard insertion, migration or application-data write occurs here. */
export async function readPrivacyReconcilePreflight(
  client: Sql,
  migrations: readonly { tag: string; hash: string }[],
): Promise<PrivacyReconcilePreflight | null> {
  const migration = migrations.find((entry) => entry.tag.endsWith(RECONCILE_MIGRATION_SUFFIX));
  if (!migration) return null;
  const ledger = await client<{ present: boolean }[]>`
    SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present
  `;
  if (ledger[0].present) {
    const applied = await client`SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = ${migration.hash} LIMIT 1`;
    if (applied.length) return null;
  }
  return { ...migration, ...(await readPrivacyReconcileCounts(client)) };
}

export function privacyReconcileScope(environment: Record<string, string | undefined>): string | undefined {
  if (environment.GITHUB_ACTIONS === 'true' || environment.GITHUB_RUN_ID || environment.GITHUB_RUN_ATTEMPT) {
    const runId = environment.GITHUB_RUN_ID;
    const attempt = environment.GITHUB_RUN_ATTEMPT;
    return runId && attempt && /^\d+$/.test(runId) && /^\d+$/.test(attempt) ? `${runId}.${attempt}` : undefined;
  }
  const scope = environment.PRIVACY_RECONCILE_CUTOVER_SCOPE;
  return scope && /^[A-Za-z0-9._-]{1,128}$/.test(scope) ? scope : undefined;
}

export function privacyReconcileAcknowledgement(preflight: PrivacyReconcilePreflight, scope: string): string {
  return `${preflight.hash}:${preflight.tickStamps}:${preflight.legacySessions}:readers-paused:${scope}`;
}

/** Counts alone are not approval or proof that older readers/writers stopped. */
export function requirePrivacyReconcileCutover(
  preflight: PrivacyReconcilePreflight | null,
  acknowledgement: string | undefined,
  scope: string | undefined,
): void {
  if (!preflight) return;
  if (!scope)
    throw new Error(
      'Pending privacy reconcile cleanup requires the GitHub run ID and attempt, or a fresh CLI PRIVACY_RECONCILE_CUTOVER_SCOPE. No migration was run.',
    );
  if (acknowledgement !== privacyReconcileAcknowledgement(preflight, scope)) {
    throw new Error(
      `Pending ${preflight.tag}: dry-run tick stamps=${preflight.tickStamps}, legacy sessions=${preflight.legacySessions}. ` +
        'Pause and drain older release jobs and EVERY backend/worker reading or reconciling sessions, obtain owner approval for the counted cleanup, ' +
        `then set PRIVACY_RECONCILE_CUTOVER=${privacyReconcileAcknowledgement(preflight, scope)} for this run attempt. ` +
        'Keep readers paused until an Unlisted-aware backend is healthy. See docs/privacy-reconcile-cutover.md. No migration was run.',
    );
  }
}
