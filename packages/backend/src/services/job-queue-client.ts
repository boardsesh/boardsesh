import { PgBoss, type Db } from 'pg-boss';
import { logger } from '../utils/logger';

export async function assertQueuePrimary(database: Db): Promise<void> {
  const result = await database.executeSql(
    "SELECT pg_is_in_recovery() AS recovery, current_setting('transaction_read_only') AS read_only",
  );
  const row: unknown = result.rows[0];
  if (
    !row ||
    typeof row !== 'object' ||
    !('recovery' in row) ||
    row.recovery !== false ||
    !('read_only' in row) ||
    row.read_only !== 'off'
  ) {
    throw new Error('Job queue requires a writable primary');
  }
}

/**
 * Refuse owner/superuser credentials even when a deployment uses the right username.
 *
 * The backend runtime login also lacks schema CREATE, so the privilege bits alone
 * cannot tell it apart from a worker. The migrator grants that role CRUD on every
 * application table, including DELETE on the ledger, while worker logins only ever
 * receive SELECT/INSERT/UPDATE there (the backend reconciler owns purging). A login
 * that can delete ledger rows is therefore never a restricted worker identity.
 */
export async function assertWorkerPrivileges(database: Db): Promise<void> {
  const result = await database.executeSql(`SELECT
    rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls AS privileged,
    has_schema_privilege(current_user, 'public', 'CREATE') OR has_schema_privilege(current_user, 'pgboss', 'CREATE') AS can_create,
    has_table_privilege(current_user, 'public.background_job_runs', 'SELECT')
      AND has_table_privilege(current_user, 'public.background_job_runs', 'INSERT')
      AND has_table_privilege(current_user, 'public.background_job_runs', 'UPDATE') AS ledger_access,
    has_table_privilege(current_user, 'public.background_job_runs', 'DELETE') AS ledger_delete
    FROM pg_roles WHERE rolname = current_user`);
  const row: unknown = result.rows[0];
  if (
    !row ||
    typeof row !== 'object' ||
    !('privileged' in row) ||
    row.privileged !== false ||
    !('can_create' in row) ||
    row.can_create !== false ||
    !('ledger_access' in row) ||
    row.ledger_access !== true ||
    !('ledger_delete' in row) ||
    row.ledger_delete !== false
  ) {
    throw new Error('Worker requires a restricted database login and migrated ledger grants');
  }
}

/** Shared connection factory. Only the backend owns scheduling/supervision. */
export function createJobQueueClient(options: {
  connectionString: string;
  poolSize: number;
  owner: 'backend' | 'worker';
  testBootstrap?: boolean;
}): PgBoss {
  if (
    !Number.isInteger(options.poolSize) ||
    options.poolSize < 1 ||
    (options.owner === 'worker' && options.poolSize !== 1)
  ) {
    throw new Error('Invalid job queue pool size');
  }
  const instance = new PgBoss({
    connectionString: options.connectionString,
    max: options.poolSize,
    connectionTimeoutMillis: 10_000,
    migrate: options.owner === 'backend' && options.testBootstrap === true,
    schedule: options.owner === 'backend',
    supervise: options.owner === 'backend',
    // Owner migrations maintain indexes; restricted runtimes never perform DDL.
    reindex: false,
  });
  instance.on('error', () => {
    // Driver errors can contain credentials/SQL. Emit a bounded operational error.
    logger.error('[job-queue] connection or execution failed', new Error('JOB_QUEUE_ERROR'));
  });
  return instance;
}
