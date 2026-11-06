import { createHash } from 'node:crypto';
import { count, eq, exists, gt, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import { accounts, userCredentials, users } from '@boardsesh/db/schema/auth';
import { EmailAuditAccumulator, EmailAuditError, EMAIL_AUDIT_LIMITS, EMAIL_AUDIT_NORMALIZER_VERSION } from './report';

export interface EmailAuditSnapshotOptions {
  readonly pageSize?: number;
  readonly maxUsers?: number;
  readonly maxTextBytes?: number;
  readonly maximumMs?: number;
  /** Observation hook used to qualify concurrent writes on another connection. */
  readonly onPage?: () => Promise<void>;
}

function lowerLimit(candidate: number | undefined, maximum: number): number {
  if (candidate === undefined) return maximum;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximum)
    throw new EmailAuditError('CONFIGURATION');
  return candidate;
}

/** No app DB singleton, migrations, reservation preparation or credential reads. */
export async function auditAccountEmailSnapshot(client: postgres.Sql, options: EmailAuditSnapshotOptions = {}) {
  const pageSize = lowerLimit(options.pageSize, EMAIL_AUDIT_LIMITS.pageSize);
  const maxUsers = lowerLimit(options.maxUsers, EMAIL_AUDIT_LIMITS.maxUsers);
  const maxTextBytes = lowerLimit(options.maxTextBytes, EMAIL_AUDIT_LIMITS.maxTextBytes);
  const maximumMs = lowerLimit(options.maximumMs, EMAIL_AUDIT_LIMITS.maximumMs);
  const onPage = options.onPage;
  const started = performance.now();
  const accumulator = new EmailAuditAccumulator({ maxUsers, maxTextBytes });
  const checkTime = () => {
    if (performance.now() - started >= maximumMs) throw new EmailAuditError('TIME_LIMIT');
  };
  try {
    const report = await drizzle(client).transaction(
      async (transaction) => {
        checkTime();
        await transaction.execute(sql`SELECT pg_catalog.set_config('statement_timeout', '5000ms', true),
        pg_catalog.set_config('lock_timeout', '1000ms', true),
        pg_catalog.set_config('idle_in_transaction_session_timeout', '10000ms', true),
        pg_catalog.set_config('row_security', 'off', true),
        pg_catalog.set_config('search_path', 'pg_catalog', true)`);
        const metadata = await transaction.execute<{
          isolation: string;
          readOnly: string;
          snapshotId: string;
          startedAt: string;
          databaseName: string;
          serverAddress: string | null;
          serverPort: number | null;
          serverVersion: string;
          inRecovery: boolean;
        }>(sql`SELECT pg_catalog.current_setting('transaction_isolation') AS isolation,
        pg_catalog.current_setting('transaction_read_only') AS "readOnly",
        pg_catalog.pg_current_snapshot()::text AS "snapshotId",
        pg_catalog.transaction_timestamp()::text AS "startedAt",
        pg_catalog.current_database() AS "databaseName",
        pg_catalog.inet_server_addr()::text AS "serverAddress",
        pg_catalog.inet_server_port() AS "serverPort",
        pg_catalog.current_setting('server_version_num') AS "serverVersion",
        pg_catalog.pg_is_in_recovery() AS "inRecovery"`);
        const observed = metadata[0];
        if (
          !observed ||
          observed.isolation !== 'repeatable read' ||
          observed.readOnly !== 'on' ||
          observed.inRecovery !== false
        )
          throw new EmailAuditError('SNAPSHOT_UNAVAILABLE');
        // Qualify all three relations explicitly: search_path and temporary tables
        // cannot silently substitute a different users/credential/provider store.
        const [initial] = await transaction.select({ total: count() }).from(sql`"public".${users}`);
        if (!initial || !Number.isSafeInteger(initial.total) || initial.total < 0)
          throw new EmailAuditError('INVALID_ROW');
        if (initial.total > maxUsers) throw new EmailAuditError('INPUT_LIMIT');
        let afterId: string | undefined;
        let pages = 0;
        while (true) {
          checkTime();
          const identities = await transaction
            .select({
              // TEXT columns have no schema length limit. CASE prevents an oversized
              // value from being allocated by the driver before the cap is checked.
              userId: sql<
                string | null
              >`CASE WHEN pg_catalog.octet_length(${users.id}) <= ${EMAIL_AUDIT_LIMITS.maxFieldBytes} THEN ${users.id} ELSE NULL END`,
              email: sql<
                string | null
              >`CASE WHEN pg_catalog.octet_length(${users.email}) <= ${EMAIL_AUDIT_LIMITS.maxFieldBytes} THEN ${users.email} ELSE NULL END`,
              emailVerified: sql<Date | null>`${users.emailVerified}`.mapWith(users.emailVerified),
              hasPassword: sql<boolean>`${exists(
                transaction
                  .select({ present: sql<number>`1` })
                  .from(sql`"public".${userCredentials}`)
                  .where(eq(userCredentials.userId, users.id)),
              )}`,
            })
            .from(sql`"public".${users}`)
            .where(afterId === undefined ? undefined : gt(users.id, afterId))
            .orderBy(users.id)
            .limit(Math.min(pageSize, maxUsers - accumulator.userCount + 1));
          checkTime();
          const boundedIdentities = identities.map((identity) => {
            if (identity.userId === null || identity.email === null) throw new EmailAuditError('INPUT_LIMIT');
            return { ...identity, userId: identity.userId, email: identity.email };
          });
          if (identities.length === 0) break;
          // accounts has no userId index. Group once per page rather than
          // running one complete provider-table scan per individual user.
          const pageIds = boundedIdentities.map((identity) => identity.userId);
          const pageIdSet = new Set(pageIds);
          const providerCounts = await transaction
            .select({ userId: sql<string>`${accounts.userId}`, total: count() })
            .from(sql`"public".${accounts}`)
            .where(inArray(accounts.userId, pageIds))
            .groupBy(accounts.userId)
            .limit(pageIds.length + 1);
          if (providerCounts.some((providerCount) => !pageIdSet.has(providerCount.userId)))
            throw new EmailAuditError('INVALID_ROW');
          const providersByUserId = new Map(
            providerCounts.map((providerCount) => [providerCount.userId, providerCount.total]),
          );
          checkTime();
          for (const identity of boundedIdentities)
            accumulator.add({ ...identity, linkedProviderCount: providersByUserId.get(identity.userId) ?? 0 });
          pages += 1;
          afterId = identities.at(-1)?.userId ?? undefined;
          if (afterId === undefined) throw new EmailAuditError('INVALID_ROW');
          if (onPage) await onPage();
          checkTime();
        }
        const [final] = await transaction.select({ total: count() }).from(sql`"public".${users}`);
        checkTime();
        if (final?.total !== initial.total || accumulator.userCount !== initial.total)
          throw new EmailAuditError('COUNT_MISMATCH');
        const report = accumulator.finish();
        const targetFingerprint = createHash('sha256')
          .update(
            JSON.stringify({
              database: observed.databaseName,
              address: observed.serverAddress,
              port: observed.serverPort,
            }),
          )
          .digest('hex');
        checkTime();
        return {
          normalizerVersion: EMAIL_AUDIT_NORMALIZER_VERSION,
          snapshot: {
            id: observed.snapshotId,
            startedAt: new Date(observed.startedAt).toISOString(),
            isolation: 'repeatable read',
            readOnly: true,
            targetFingerprint,
            serverVersion: observed.serverVersion,
            pages,
            reachedEof: true,
            countReconciled: true,
          },
          ...report,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    // Await the real transaction result: an overdue COMMIT is not a timely
    // completed scan merely because the callback finished within its budget.
    checkTime();
    return { ...report, snapshot: { ...report.snapshot, elapsedMs: Math.ceil(performance.now() - started) } };
  } catch (error) {
    if (error instanceof EmailAuditError) throw error;
    // Database exceptions can contain row content, connection strings or SQL.
    throw new EmailAuditError('SNAPSHOT_UNAVAILABLE');
  }
}
