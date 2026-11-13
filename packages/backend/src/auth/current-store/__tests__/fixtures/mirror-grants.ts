import { accounts, authAccount, authSession, userCredentials, users } from '@boardsesh/db/schema/auth';
import { sql } from 'drizzle-orm';
import type { CurrentStoreTransaction } from '../../foundation-context';
import { identityMirrorMode } from '../../../authority/mirror-configuration';

/** Only backend command actors, never the fenced legacy/read-only web actors. */
export async function grantIdentityMirrorBackendTables(transaction: CurrentStoreTransaction, backendRole: string) {
  // Fixed system identities reject canonical authentication history with
  // mirroring off too. Only backend actors receive these read-only checks.
  await transaction.execute(
    sql`GRANT SELECT ON TABLE ${authAccount}, ${authSession} TO ${sql.identifier(backendRole)}`,
  );
  if (identityMirrorMode() === 'off') return;
  await transaction.execute(
    sql`GRANT SELECT ON TABLE ${accounts}, ${userCredentials} TO ${sql.identifier(backendRole)}`,
  );
  await transaction.execute(sql`GRANT UPDATE (updated_at) ON TABLE ${users} TO ${sql.identifier(backendRole)}`);
  await transaction.execute(
    sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${authAccount} TO ${sql.identifier(backendRole)}`,
  );
}

/** Remove only fixture-owned grants before dropping the generated role. */
export async function revokeIdentityMirrorBackendTables(
  executor: Pick<CurrentStoreTransaction, 'execute'>,
  backendRole: string,
) {
  await executor.execute(
    sql`REVOKE SELECT ON TABLE ${authAccount}, ${authSession} FROM ${sql.identifier(backendRole)}`,
  );
  if (identityMirrorMode() === 'off') return;
  await executor.execute(
    sql`REVOKE ALL PRIVILEGES ON TABLE ${authAccount}, ${accounts}, ${userCredentials} FROM ${sql.identifier(backendRole)}`,
  );
  await executor.execute(sql`REVOKE UPDATE (updated_at) ON TABLE ${users} FROM ${sql.identifier(backendRole)}`);
}
