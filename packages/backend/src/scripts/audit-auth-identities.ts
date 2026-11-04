/**
 * Read-only audit of a local disposable/restored database. No DATABASE_URL fallback.
 *
 * AUTH_IDENTITY_AUDIT_DATABASE_URL=postgresql://...@localhost/... \
 *   vp exec tsx packages/backend/src/scripts/audit-auth-identities.ts
 */
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { users, userCredentials, accounts } from '@boardsesh/db/schema/auth';
import { auditIdentitySnapshot } from '../auth/identity-audit';

export function auditDatabaseUrl(environment: Readonly<Record<string, string | undefined>>): string {
  const databaseUrl = environment.AUTH_IDENTITY_AUDIT_DATABASE_URL;
  if (!databaseUrl) throw new Error('AUTH_IDENTITY_AUDIT_DATABASE_URL is required; no default database is used');
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    throw new Error('AUTH_IDENTITY_AUDIT_DATABASE_URL must be a local PostgreSQL URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsedUrl.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname) ||
    parsedUrl.pathname.length < 2 ||
    parsedUrl.search.length > 0
  ) {
    throw new Error('Audit requires a local PostgreSQL database; remote hosts and URL options are refused');
  }
  return databaseUrl;
}

export async function runIdentityAudit(environment: Readonly<Record<string, string | undefined>>) {
  const client = postgres(auditDatabaseUrl(environment), {
    max: 1,
    connect_timeout: 10,
    connection: {
      application_name: 'boardsesh-auth-identity-audit',
      default_transaction_read_only: true,
      statement_timeout: 30_000,
      idle_in_transaction_session_timeout: 30_000,
    },
    onnotice: () => {},
  });
  try {
    const database = drizzle(client);
    return await database.transaction(
      async (transaction) => {
        const auditUsers = await transaction
          .select({ id: users.id, email: users.email, emailVerified: users.emailVerified })
          .from(users);
        const credentials = await transaction
          .select({ userId: userCredentials.userId, passwordHash: userCredentials.passwordHash })
          .from(userCredentials);
        const providerAccounts = await transaction
          .select({
            userId: accounts.userId,
            provider: accounts.provider,
            providerAccountId: accounts.providerAccountId,
          })
          .from(accounts);
        return auditIdentitySnapshot({ users: auditUsers, credentials, providerAccounts }, randomBytes(32));
      },
      { accessMode: 'read only', isolationLevel: 'repeatable read' },
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) {
    process.stderr.write('Usage: vp exec tsx packages/backend/src/scripts/audit-auth-identities.ts\n');
    process.exitCode = 1;
    return;
  }
  try {
    const report = await runIdentityAudit(process.env);
    process.stdout.write(`${JSON.stringify({ measuredAt: new Date().toISOString(), ...report }, null, 2)}\n`);
  } catch {
    // Driver errors may contain SQL parameters, addresses or connection secrets.
    process.stderr.write(
      'Identity audit failed. Check the explicit local audit URL, database availability, and schema.\n',
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
