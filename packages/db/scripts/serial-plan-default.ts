/**
 * Round 5b of the DSM saga (#5352). Migration `0225_dsm_serial_plan_default.sql`
 * tried to set `max_parallel_workers_per_gather = 0` as the database default and
 * **cannot ever have worked in production**.
 *
 * `ALTER DATABASE ... SET` requires ownership of the database (or superuser).
 * The production migration session is deliberately the opposite of that: the
 * deploy connects as `boardsesh_migrator` and `SET ROLE`s to `boardsesh_owner`,
 * and `reserveMigrationOwnerSession` refuses to proceed unless
 * `ownerDoesNotOwnDatabase` holds (migration-owner-role.ts). Reproduced against
 * a stock `docker run postgres:17` with the production role shape:
 *
 *     WARNING:  boardsesh: could not set max_parallel_workers_per_gather on
 *               database railway; (must be owner of database railway)
 *     -- pg_db_role_setting: 0 rows;  a runtime session still reports 2
 *
 * 0225's `EXCEPTION WHEN insufficient_privilege THEN RAISE WARNING` turned that
 * into a zero-exit-code success, drizzle recorded the migration, and it will
 * never be retried. So the statement cannot live in a migration at all, and
 * re-editing 0225 would fix nothing.
 *
 * `ALTER ROLE <app_role> SET ...` — the pooled-URL escape hatch documented for
 * `statement_timeout` — is closed for the same reason. Measured on the same
 * container:
 *
 *     ERROR:  permission denied to alter role
 *     DETAIL: Only roles with the CREATEROLE attribute and the ADMIN option on
 *             role "boardsesh_runtime" may alter this role.
 *
 * So this module is the separate, idempotent step that owns the setting:
 *
 * - It **checks** through an ordinary application connection, because the fact
 *   that matters is what a new app session actually gets — the same fact
 *   `GET /health/db → database.maxParallelWorkersPerGather` reports.
 * - It **applies** through a database-owner/admin connection when one is
 *   supplied in `ADMIN_DATABASE_URL` (the name the collation-repair and PG18
 *   role-transition runbooks already use for exactly this).
 * - It **fails loudly** when the setting is missing and it has no credential
 *   that could fix it. A warning nobody reads is what let five rounds of this
 *   bug ship; a red deploy job with a one-line remediation is not.
 *
 * Portability holds: two plain statements against a stock `postgres:17`. No
 * Railway knob, no dashboard setting, no extension, nothing that would not
 * survive `pg_dump`/`pg_restore` onto another host.
 */

/** The GUC. A parallel plan is the only way to reach the DSM exhaustion of #5352. */
export const SERIAL_PLAN_SETTING = 'max_parallel_workers_per_gather';

/** The value every Boardsesh session must start with. */
export const SERIAL_PLAN_TARGET_VALUE = '0';

/** SQLSTATE for `must be owner of database ...`. */
export const INSUFFICIENT_PRIVILEGE = '42501';

const SIMPLE_POSTGRES_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The narrowest shape this module needs from postgres.js, so the whole decision
 * tree is testable against a fake without a database.
 */
export type SerialPlanClient = {
  unsafe(statement: string): PromiseLike<unknown>;
};

export type SerialPlanReading = {
  databaseName: string;
  /**
   * What THIS session resolves the GUC to — database default, role default and
   * postgresql.conf folded together. The number that decides whether a plan can
   * reach for a Gather.
   */
  effectiveValue: string;
  /**
   * The database-scoped default recorded in `pg_db_role_setting`, or null when
   * the database carries none. Distinct from `effectiveValue` on purpose:
   * `ALTER DATABASE ... SET` does NOT change the session that issued it, so the
   * catalog is the only way to verify an apply without reconnecting.
   */
  databaseDefault: string | null;
};

export type SerialPlanOutcome =
  /** The database already carries the default. No statement was issued. */
  | { status: 'already-applied'; reading: SerialPlanReading }
  /** `ALTER DATABASE ... SET` ran and the catalog now reports the target value. */
  | { status: 'applied'; reading: SerialPlanReading }
  /** The connection does not own the database. Never swallowed — see `isSerialPlanFailure`. */
  | { status: 'not-permitted'; reading: SerialPlanReading; detail: string };

/**
 * One statement, three facts. `current_setting` is what the session sees;
 * the `pg_db_role_setting` sub-select is the durable database-scoped default.
 * `setrole = 0` selects the database-wide row rather than a per-role override,
 * and the catalog is readable by an ordinary login role (verified on
 * postgres:17 as a non-owner, non-superuser role).
 */
export const SERIAL_PLAN_READ_SQL = `
  SELECT current_database() AS "databaseName",
         current_setting('${SERIAL_PLAN_SETTING}') AS "effectiveValue",
         (
           SELECT split_part(entry, '=', 2)
           FROM pg_catalog.pg_db_role_setting AS setting
           JOIN pg_catalog.pg_database AS database ON database.oid = setting.setdatabase
           CROSS JOIN LATERAL unnest(setting.setconfig) AS entry
           WHERE database.datname = current_database()
             AND setting.setrole = 0
             AND entry LIKE '${SERIAL_PLAN_SETTING}=%'
           LIMIT 1
         ) AS "databaseDefault"
`;

/**
 * `ALTER DATABASE` takes no parameters, so the database name is interpolated.
 * Validate it as a simple identifier first — same guard as
 * `migrationOwnerRoleStatement`, for the same reason.
 */
export function serialPlanAlterStatement(databaseName: string): string {
  if (!SIMPLE_POSTGRES_IDENTIFIER.test(databaseName)) {
    throw new Error(`database name ${JSON.stringify(databaseName)} is not a simple PostgreSQL identifier`);
  }
  return `ALTER DATABASE "${databaseName}" SET ${SERIAL_PLAN_SETTING} = ${SERIAL_PLAN_TARGET_VALUE}`;
}

function firstRow(result: unknown): Record<string, unknown> {
  if (!Array.isArray(result) || result.length === 0) {
    throw new Error('serial-plan probe returned no row');
  }
  const [row] = result as unknown[];
  if (!row || typeof row !== 'object') {
    throw new Error('serial-plan probe returned a non-row');
  }
  return row as Record<string, unknown>;
}

export async function readSerialPlanState(client: SerialPlanClient): Promise<SerialPlanReading> {
  const row = firstRow(await client.unsafe(SERIAL_PLAN_READ_SQL));
  const { databaseName, effectiveValue, databaseDefault } = row;
  if (typeof databaseName !== 'string' || typeof effectiveValue !== 'string') {
    throw new Error('serial-plan probe returned an unexpected row shape');
  }
  return {
    databaseName,
    effectiveValue,
    databaseDefault: typeof databaseDefault === 'string' ? databaseDefault : null,
  };
}

export function isInsufficientPrivilege(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code } = error as { code?: unknown };
  return code === INSUFFICIENT_PRIVILEGE;
}

function describeError(error: unknown): string {
  if (error && typeof error === 'object') {
    const { message } = error as { message?: unknown };
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return 'unknown error';
}

/**
 * Applies the database-scoped default, idempotently.
 *
 * A privilege failure is returned as `not-permitted`, never swallowed: the
 * caller decides what to do with it, and `isSerialPlanFailure` says it is a
 * failure. Any other error propagates — misreading, say, a connection drop as
 * "the role cannot do this" is how a no-op reports success.
 */
export async function applySerialPlanDatabaseDefault(client: SerialPlanClient): Promise<SerialPlanOutcome> {
  const reading = await readSerialPlanState(client);
  if (reading.databaseDefault === SERIAL_PLAN_TARGET_VALUE) {
    return { status: 'already-applied', reading };
  }

  try {
    await client.unsafe(serialPlanAlterStatement(reading.databaseName));
  } catch (error) {
    if (isInsufficientPrivilege(error)) {
      return { status: 'not-permitted', reading, detail: describeError(error) };
    }
    throw error;
  }

  // Read back from the catalog rather than trusting the ALTER: `current_setting`
  // on this session still reports the OLD value (the default applies to new
  // sessions), so a session-level read here would be a vacuous check.
  const applied = await readSerialPlanState(client);
  if (applied.databaseDefault !== SERIAL_PLAN_TARGET_VALUE) {
    throw new Error(
      `ALTER DATABASE reported success but ${SERIAL_PLAN_SETTING} is ` +
        `${applied.databaseDefault ?? 'unset'} on database ${applied.databaseName}`,
    );
  }
  return { status: 'applied', reading: applied };
}

export function isSerialPlanFailure(
  outcome: SerialPlanOutcome,
): outcome is Extract<SerialPlanOutcome, { status: 'not-permitted' }> {
  return outcome.status === 'not-permitted';
}

/**
 * What an operator has to run when the deploy has no credential that owns the
 * database. One statement, from any admin/superuser psql session; it survives
 * restarts and `pg_dumpall`, so it is a one-time action rather than a per-deploy
 * one.
 */
export function serialPlanRemediation(databaseName: string): string[] {
  return [
    `${SERIAL_PLAN_SETTING} is not 0 for application sessions on database ${databaseName}.`,
    'Parallel-query DSM exhaustion (SQLSTATE 53100) can recur until it is. Migration 0225',
    'cannot fix this: ALTER DATABASE needs database ownership and the migration role is',
    'deliberately not the database owner.',
    '',
    'Fix it once, from a psql session that owns the database (or is superuser):',
    '',
    `  ${serialPlanAlterStatement(databaseName)};`,
    '',
    'Or set ADMIN_DATABASE_URL on this job to such a connection and this step will',
    'apply it itself. Confirm afterwards with GET /health/db →',
    'database.maxParallelWorkersPerGather, which must read "0".',
  ];
}

export type SerialPlanConnection = { client: SerialPlanClient; close: () => Promise<void> };

export type SerialPlanVerificationPorts = {
  /** Opens a fresh application-credential connection. Called again after an apply. */
  openApplicationClient: () => Promise<SerialPlanConnection>;
  /** Opens a database-owner connection, or null when no admin credential is configured. */
  openAdminClient: (() => Promise<SerialPlanConnection>) | null;
  log: (message: string) => void;
  warn: (message: string) => void;
};

async function withConnection<T>(
  open: () => Promise<SerialPlanConnection>,
  use: (client: SerialPlanClient) => Promise<T>,
): Promise<T> {
  const { client, close } = await open();
  try {
    return await use(client);
  } finally {
    await close().catch(() => {});
  }
}

/**
 * Returns the process exit code: 0 when application sessions start with parallel
 * query off, 1 when they do not.
 *
 * Lives here rather than in the CLI so every branch — already applied, applied
 * through the admin connection, refused for want of privilege, applied but still
 * not effective — is testable without a database and without the CLI's env and
 * connection side effects.
 */
export async function runSerialPlanVerification(ports: SerialPlanVerificationPorts): Promise<number> {
  const reading = await withConnection(ports.openApplicationClient, readSerialPlanState);

  ports.log(
    `[serial-plan] ${reading.databaseName}: application sessions see ${SERIAL_PLAN_SETTING}=${reading.effectiveValue} ` +
      `(database default: ${reading.databaseDefault ?? 'unset'})`,
  );

  if (reading.effectiveValue === SERIAL_PLAN_TARGET_VALUE) {
    ports.log('[serial-plan] ✅ parallel query is off for application sessions');
    return 0;
  }

  if (!ports.openAdminClient) {
    return reportSerialPlanFailure(ports, reading.databaseName);
  }

  const outcome = await withConnection(ports.openAdminClient, applySerialPlanDatabaseDefault);

  if (isSerialPlanFailure(outcome)) {
    ports.warn(`[serial-plan] ADMIN_DATABASE_URL does not own ${outcome.reading.databaseName}: ${outcome.detail}`);
    return reportSerialPlanFailure(ports, outcome.reading.databaseName);
  }

  ports.log(`[serial-plan] database default ${outcome.status} on ${outcome.reading.databaseName}`);

  // Re-check on a NEW application connection: `ALTER DATABASE ... SET` changes
  // what future sessions start with, never the session that issued it or one
  // already open. Trusting the ALTER instead of re-reading is the same vacuous
  // check that made 0225 look like it worked.
  const confirmed = await withConnection(ports.openApplicationClient, readSerialPlanState);

  if (confirmed.effectiveValue !== SERIAL_PLAN_TARGET_VALUE) {
    ports.warn(
      `[serial-plan] applied the database default but application sessions still see ` +
        `${SERIAL_PLAN_SETTING}=${confirmed.effectiveValue}`,
    );
    return reportSerialPlanFailure(ports, confirmed.databaseName);
  }

  ports.log('[serial-plan] ✅ parallel query is off for application sessions');
  return 0;
}

function reportSerialPlanFailure(ports: SerialPlanVerificationPorts, databaseName: string): number {
  for (const line of serialPlanRemediation(databaseName)) {
    ports.warn(line);
  }
  ports.warn('[serial-plan] ❌ parallel query is ON for application sessions');
  return 1;
}
