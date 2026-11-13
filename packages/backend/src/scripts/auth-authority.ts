import type postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, ne, sql } from 'drizzle-orm';
import {
  authEmailProjection,
  authEmailReservations,
  authEmailReservationMembers,
  users,
} from '@boardsesh/db/schema/auth';
import {
  lockAuthorityGateExclusively,
  CURRENT_EMAIL_NORMALIZER_VERSION,
  type CurrentStoreTransaction,
} from '../auth/current-store/foundation-context';
import { prepareProjectionUnderUsersTableLock, rebuildLiveProjection } from '../auth/current-store/email-reservations';
import { operatorClient, parseOperatorArguments } from './auth-fence/operator';
import { verifyFence } from './auth-fence/catalog';

/** These are code gates. Neither an environment variable nor an operator flag closes one. */
export const AUTHORITY_ACTIVATION_BLOCKERS: readonly string[] = Object.freeze([
  'GARMIN_OFFLINE_TICK_QUEUE_PRESERVATION',
  'STAGED_WEB_PROOF_GENERATION_STAMP',
  'NATIVE_REVOKE_RESET_LOCK_ORDER',
]);
export function assertAuthorityActivationGates(): void {
  if (AUTHORITY_ACTIVATION_BLOCKERS.length) throw new Error('ACTIVATION_CODE_GATES_OPEN');
}

export async function runAuthAuthority(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const options = parseOperatorArguments(arguments_, ['status', 'prepare', 'activate']);
  if (options.planSha256 || (options.command !== 'prepare' && options.projectionId))
    throw new Error('INVALID_ARGUMENTS');
  const client = operatorClient(environment, options.confirmHost, options.command !== 'status');
  try {
    if (options.command === 'status') {
      return await client.begin('isolation level repeatable read read only', async (transaction) => {
        const [manifest] = await transaction<
          { phase: string; writerEpoch: number; sourceUserCount: number; keyCount: number; ambiguousKeyCount: number }[]
        >`
          SELECT phase, writer_epoch AS "writerEpoch", source_user_count AS "sourceUserCount", key_count AS "keyCount", ambiguous_key_count AS "ambiguousKeyCount"
          FROM auth_email_projection WHERE is_current`;
        let fence: Awaited<ReturnType<typeof verifyFence>> | undefined;
        try {
          fence = await verifyFence(transaction);
        } catch {
          /* Missing or unsafe role is a status, never evidence. */
        }
        return {
          mode: 'status',
          manifest: manifest ?? null,
          fence: fence ?? { verified: false },
          activationBlockers: AUTHORITY_ACTIVATION_BLOCKERS,
        };
      });
    }
    return await client.begin('isolation level read committed', async (connection) => {
      // postgres.js transaction handles omit the options metadata Drizzle reads.
      // Forward SQL to that handle while exposing only the original parser metadata.
      const transactionClient = new Proxy(connection, {
        get(target, property, receiver) {
          return property === 'options' ? client.options : Reflect.get(target, property, receiver);
        },
      });
      const transaction = drizzle(transactionClient as unknown as postgres.Sql) as unknown as CurrentStoreTransaction;
      await lockAuthorityGateExclusively(transaction);
      if (options.command === 'prepare') {
        const manifest = await prepareProjectionUnderUsersTableLock(transaction, {
          projectionId: options.projectionId ?? randomUUID(),
        });
        return {
          mode: 'prepared',
          projectionId: manifest.projectionId,
          writerEpoch: manifest.writerEpoch,
          sourceUserCount: manifest.sourceUserCount,
          keyCount: manifest.keyCount,
          ambiguousKeyCount: manifest.ambiguousKeyCount,
          activationBlockers: AUTHORITY_ACTIVATION_BLOCKERS,
        };
      }
      // A prepared snapshot, SQL file or caller-provided digest is never fence evidence.
      // This is a fresh catalog check on the same connection and transaction.
      const evidence = await verifyFence(connection);
      await transaction.execute(sql`LOCK TABLE ${users} IN SHARE ROW EXCLUSIVE MODE`);
      const [manifest] = await transaction
        .select()
        .from(authEmailProjection)
        .where(eq(authEmailProjection.isCurrent, true));
      if (!manifest || manifest.phase !== 'prepared' || manifest.normalizerVersion !== CURRENT_EMAIL_NORMALIZER_VERSION)
        throw new Error('PREPARED_PROJECTION_REQUIRED');
      await transaction.delete(authEmailReservationMembers);
      await transaction.delete(authEmailReservations).where(ne(authEmailReservations.state, 'blocked_deleted'));
      const counts = await rebuildLiveProjection(transaction, manifest.projectionId);
      if (counts.ambiguousKeyCount !== 0) throw new Error('EMAIL_COLLISIONS_REMAIN');
      const [invalid] = await transaction
        .select({
          exists: sql<boolean>`exists (select 1 from users where email <> lower(email) or email <> btrim(email) or email = '')`,
        })
        .from(users)
        .limit(1);
      if (invalid?.exists) throw new Error('NORMALIZED_EMAILS_REQUIRED');
      assertAuthorityActivationGates();
      await transaction
        .update(authEmailProjection)
        .set({ ...counts, phase: 'enforced', writerEpoch: manifest.writerEpoch })
        .where(eq(authEmailProjection.projectionId, manifest.projectionId));
      return { mode: 'enforced', writerEpoch: manifest.writerEpoch, evidence };
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}
async function main() {
  try {
    process.stdout.write(`${JSON.stringify(await runAuthAuthority(process.argv.slice(2)))}\n`);
  } catch {
    process.stderr.write(`Auth authority refused. Open code gates: ${AUTHORITY_ACTIVATION_BLOCKERS.join(', ')}.\n`);
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
