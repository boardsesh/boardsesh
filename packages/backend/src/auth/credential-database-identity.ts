import { createDedicatedPoolFromUrl, type PoolInstance } from '@boardsesh/db/client';

interface DatabaseTarget {
  readonly role: string;
  readonly sessionRole: string;
  readonly database: string;
  readonly databaseOid: string;
  readonly address: string | null;
  readonly port: number | null;
  readonly postmasterEpoch: string;
  readonly serverVersion: string;
  readonly recovery: boolean;
  readonly readOnly: string;
}

async function readTarget(pool: PoolInstance): Promise<DatabaseTarget> {
  const [target] = await pool<DatabaseTarget[]>`
    SELECT current_user AS role, session_user AS "sessionRole",
      pg_catalog.current_database() AS database, database.oid::text AS "databaseOid",
      pg_catalog.inet_server_addr()::text AS address, pg_catalog.inet_server_port() AS port,
      extract(epoch FROM pg_catalog.pg_postmaster_start_time())::text AS "postmasterEpoch",
      pg_catalog.current_setting('server_version_num') AS "serverVersion",
      pg_catalog.pg_is_in_recovery() AS recovery,
      pg_catalog.current_setting('transaction_read_only') AS "readOnly"
    FROM pg_catalog.pg_database database WHERE database.datname=pg_catalog.current_database()`;
  if (!target) throw new Error('CREDENTIAL_DATABASE_TARGET_UNAVAILABLE');
  return target;
}

/** A per-user pooler can route equal host/database URLs to different servers.
 * Compare the actual server/database on both authenticated connections. */
export async function assertSameCredentialDatabaseTarget(
  writer: PoolInstance,
  contentConnectionString: string,
  expected: { readonly writerRole: string; readonly contentRole: string; readonly database: string },
): Promise<void> {
  const contentUrl = new URL(contentConnectionString);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(contentUrl.hostname)) {
    contentUrl.searchParams.set('sslmode', 'verify-full');
  }
  const content = createDedicatedPoolFromUrl(contentUrl.href, 1, {
    connect_timeout: 2,
    connection: { application_name: 'boardsesh-credential-target-probe', statement_timeout: 5_000 },
  });
  try {
    const [actualWriter, actualContent] = await Promise.all([readTarget(writer), readTarget(content)]);
    if (
      actualWriter.role !== expected.writerRole ||
      actualWriter.sessionRole !== expected.writerRole ||
      actualContent.role !== expected.contentRole ||
      actualContent.sessionRole !== expected.contentRole ||
      actualWriter.database !== expected.database ||
      actualContent.database !== expected.database ||
      actualWriter.databaseOid !== actualContent.databaseOid ||
      actualWriter.address !== actualContent.address ||
      actualWriter.port !== actualContent.port ||
      actualWriter.postmasterEpoch !== actualContent.postmasterEpoch ||
      actualWriter.serverVersion !== actualContent.serverVersion ||
      actualWriter.recovery ||
      actualContent.recovery ||
      actualWriter.readOnly !== 'off' ||
      actualContent.readOnly !== 'off'
    )
      throw new Error('CREDENTIAL_DATABASE_TARGET_MISMATCH');
  } finally {
    await content.end({ timeout: 3 });
  }
}
