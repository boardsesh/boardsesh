/**
 * Regression coverage for migration 0131: the system catalog owner is exempt
 * from the per-owner serial uniqueness index, so the location sync can mirror
 * the upstream catalog's duplicate serials ("same serial shipped to two gyms").
 * Real (non-system) owners must still be blocked from binding one serial twice.
 *
 * Skips unless DATABASE_URL points at a local, migrated Postgres.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sql, type SQLWrapper } from 'drizzle-orm';
import { createScriptDb } from './db-connection.js';
import { executeRows } from '../src/client/index.js';

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

type ExecuteDb = {
  execute(query: SQLWrapper | string): PromiseLike<unknown>;
};

type CountRow = { count: number | string };

function localDatabaseUrl(): string | null {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return null;
  }
  const databaseHostname = new URL(databaseUrl).hostname.toLowerCase();
  if (!['localhost', '127.0.0.1', 'postgres'].includes(databaseHostname)) {
    return null;
  }
  return databaseUrl;
}

function testDatabaseUrl(): string | null {
  return process.env.USER_BOARDS_SERIAL_DB_URL ?? localDatabaseUrl();
}

async function skipReason(commandDb: ExecuteDb): Promise<string | null> {
  try {
    const [state] = await executeRows<{ boardsTable: string | null; systemExcluded: boolean }>(
      commandDb,
      sql`
        SELECT
          to_regclass('public.user_boards')::text AS "boardsTable",
          EXISTS (
            SELECT 1 FROM pg_indexes
            WHERE indexname = 'user_boards_unique_owner_serial'
              AND indexdef LIKE '%00000000-0000-0000-0000-000000000000%'
          ) AS "systemExcluded"
      `,
    );
    if (!state?.boardsTable) {
      return 'user_boards is missing; run migrations before this integration test';
    }
    if (!state.systemExcluded) {
      return 'migration 0131 (system-user serial exemption) not applied; run migrations';
    }
  } catch (error: unknown) {
    return `database unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
  return null;
}

async function ensureUser(commandDb: ExecuteDb, id: string, email: string): Promise<void> {
  await commandDb.execute(sql`
    INSERT INTO users (id, email, name)
    VALUES (${id}, ${email}, ${'Serial Test'})
    ON CONFLICT (id) DO NOTHING
  `);
}

async function insertBoard(
  commandDb: ExecuteDb,
  values: { uuid: string; slug: string; ownerId: string; serial: string },
): Promise<void> {
  await commandDb.execute(sql`
    INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, serial_number, is_owned)
    VALUES (
      ${values.uuid}, ${values.slug}, ${values.ownerId}, 'kilter', 1, 10, '20',
      ${'Serial Test Board'}, ${values.serial}, false
    )
  `);
}

describe('user_boards serial uniqueness — system catalog exemption', () => {
  const sharedSerial = 'SERIALUNIQ-TEST-75934';
  const otherOwnerId = 'serial-uniqueness-test-owner';
  const uuids = {
    system1: 'aaaa1111-0000-0000-0000-000000000001',
    system2: 'aaaa1111-0000-0000-0000-000000000002',
    other1: 'bbbb2222-0000-0000-0000-000000000001',
    other2: 'bbbb2222-0000-0000-0000-000000000002',
  };

  it('lets two system-owned boards share a serial, but blocks a non-system owner from reusing one', async () => {
    const databaseUrl = testDatabaseUrl();
    if (!databaseUrl) {
      console.warn('[serial-uniqueness] skipped: set DATABASE_URL to a local Postgres to run');
      return;
    }

    const { db, close } = createScriptDb(databaseUrl);
    try {
      const reason = await skipReason(db);
      if (reason) {
        console.warn(`[serial-uniqueness] skipped: ${reason}`);
        return;
      }

      // Clean any prior run.
      await db.execute(sql`DELETE FROM user_boards WHERE serial_number = ${sharedSerial}`);

      await ensureUser(db, otherOwnerId, 'serial-uniqueness-test@example.com');

      // Two SYSTEM-owned boards with the same serial must both persist.
      await insertBoard(db, {
        uuid: uuids.system1,
        slug: 'serialuniq-sys-1',
        ownerId: SYSTEM_USER_ID,
        serial: sharedSerial,
      });
      await insertBoard(db, {
        uuid: uuids.system2,
        slug: 'serialuniq-sys-2',
        ownerId: SYSTEM_USER_ID,
        serial: sharedSerial,
      });

      const [systemCount] = await executeRows<CountRow>(
        db,
        sql`SELECT count(*)::int AS count FROM user_boards WHERE owner_id = ${SYSTEM_USER_ID} AND serial_number = ${sharedSerial}`,
      );
      assert.equal(Number(systemCount?.count ?? 0), 2, 'both system-owned boards should persist with the same serial');

      // The first non-system board with the serial succeeds...
      await insertBoard(db, {
        uuid: uuids.other1,
        slug: 'serialuniq-other-1',
        ownerId: otherOwnerId,
        serial: sharedSerial,
      });
      // ...but a second one for the same owner must violate the unique index.
      await assert.rejects(
        () =>
          insertBoard(db, {
            uuid: uuids.other2,
            slug: 'serialuniq-other-2',
            ownerId: otherOwnerId,
            serial: sharedSerial,
          }),
        /user_boards_unique_owner_serial|duplicate key/i,
        'a non-system owner must not bind the same serial twice',
      );

      // Cleanup.
      await db.execute(sql`DELETE FROM user_boards WHERE serial_number = ${sharedSerial}`);
      await db.execute(sql`DELETE FROM users WHERE id = ${otherOwnerId}`);
    } finally {
      await close();
    }
  });
});
