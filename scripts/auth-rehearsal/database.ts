import { timingSafeEqual } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import postgres from 'postgres';
import { schemaSQL } from '../../packages/backend/src/__tests__/schema-sql';
import { openRuntimePostgres, type RuntimeFixture } from './isolated-runtime';
import { keyedReference, RehearsalSafetyError } from './target-guard';

export type RehearsalSql = ReturnType<typeof postgres>;
export interface OwnedDatabase {
  readonly target: RuntimeFixture;
  readonly client: RehearsalSql;
  assertMarker(): Promise<void>;
  close(): Promise<void>;
}

/** Docker capability must exist before the first SQL client is constructed. */
export async function prepareOwnedDatabase(target: RuntimeFixture): Promise<OwnedDatabase> {
  await target.revalidate();
  const admin = openRuntimePostgres(target, 'admin-create');
  try {
    const deadline = Date.now() + 20000;
    for (;;) {
      try {
        await admin`SELECT 1`;
        break;
      } catch {
        if (Date.now() >= deadline) throw new RehearsalSafetyError('OWNED_POSTGRES_NOT_READY');
        await pause(100);
      }
    }
    // The only identifier is derived from a validated in-memory nonce, never operator input.
    await admin.unsafe(`CREATE DATABASE "boardsesh_auth_rehearsal_${target.runNonce}"`);
  } finally {
    await admin.end({ timeout: 2 });
  }
  const client = openRuntimePostgres(target, 'owned-database');
  const marker = keyedReference(target.secrets.reportKey, `owned-auth-fixture:${target.runNonce}`);
  try {
    await client.unsafe(schemaSQL);
    await client`CREATE TABLE auth_rehearsal_marker (singleton boolean PRIMARY KEY CHECK (singleton), proof text NOT NULL)`;
    await client`INSERT INTO auth_rehearsal_marker VALUES (true, ${marker})`;
  } catch {
    await client.end({ timeout: 2 });
    throw new RehearsalSafetyError('OWNED_SCHEMA_PREPARATION_FAILED');
  }
  return Object.freeze({
    target,
    client,
    async assertMarker() {
      await target.revalidate();
      const rows = await client<{ proof: string }[]>`SELECT proof FROM auth_rehearsal_marker WHERE singleton`;
      const actual = rows.length === 1 ? rows[0].proof : '';
      if (!/^[a-f0-9]{64}$/.test(actual) || !timingSafeEqual(Buffer.from(actual), Buffer.from(marker)))
        throw new RehearsalSafetyError('OWNED_DATABASE_MARKER_REQUIRED');
    },
    async close() {
      await client.end({ timeout: 2 });
    },
  });
}
