/**
 * Regression coverage for the per-owner serial uniqueness index, which is scoped
 * two ways:
 *  - migration 0131: the system catalog owner is exempt, so the location sync can
 *    mirror the upstream catalog's duplicate serials ("same serial shipped to two
 *    gyms");
 *  - migration 0207: the key carries `board_type`, because Aurora runs a separate
 *    serial sequence per board app — one owner may hold a Kilter #12345 and a
 *    Tension #12345.
 * Real (non-system) owners must still be blocked from binding one serial twice
 * within a single board type.
 *
 * Skips unless DATABASE_URL points at a local, migrated Postgres.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sql, type SQLWrapper } from 'drizzle-orm';
import { createScriptDb } from './db-connection.js';
import { executeRows } from '../src/client/index.js';

// Mirrors packages/location-sync/src/ids.ts and the ensureSystemUser() upsert in
// packages/location-sync/src/upsert.ts. Kept as literals so @boardsesh/db doesn't
// take a dependency on location-sync; seeding the identical row here means a later
// real sync's ON CONFLICT DO NOTHING is a genuine no-op instead of leaving a
// permanently wrong email/name behind on a dev database.
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
const SYSTEM_USER_EMAIL = 'system@boardsesh.com';
const SYSTEM_USER_NAME = 'Boardsesh';

const SERIAL_UNIQUENESS_INDEX = 'user_boards_unique_owner_serial';
const UNIQUE_VIOLATION_CODE = '23505';

type ExecuteDb = {
  execute(query: SQLWrapper | string): PromiseLike<unknown>;
};

type CountRow = { count: number | string };

type ErrorRecord = Record<string, unknown>;

function asErrorRecord(error: unknown): ErrorRecord | null {
  return typeof error === 'object' && error !== null ? (error as ErrorRecord) : null;
}

// drizzle-orm >= 0.44 wraps driver failures in a DrizzleQueryError whose own
// fields are a generic "Failed query: ..." message — the underlying PostgresError
// (with `code` and `constraint_name`) lives on `.cause`. Walk the cause chain
// (bounded, in case of cycles) so the assertion below inspects the real Postgres
// fields. Mirrors packages/backend/src/utils/postgres-errors.ts.
function* errorChain(error: unknown): Generator<ErrorRecord> {
  let currentRecord = asErrorRecord(error);
  let depth = 0;
  while (currentRecord && depth < 5) {
    yield currentRecord;
    currentRecord = asErrorRecord(currentRecord.cause);
    depth += 1;
  }
}

// Assert on the structured Postgres fields rather than error message text. A
// message match on "duplicate key" is satisfied by any unique violation on the
// table — the uuid primary key and user_boards_unique_slug both qualify — so it
// would go green without proving anything about the serial index.
// Both fields must come from the SAME chain node: a code read off one wrapper and
// a constraint name off another would let two unrelated failures satisfy the
// assertion together.
function violatesConstraint(error: unknown, constraintName: string): boolean {
  for (const errorRecord of errorChain(error)) {
    const constraint = errorRecord.constraint ?? errorRecord.constraint_name;
    if (errorRecord.code === UNIQUE_VIOLATION_CODE && constraint === constraintName) {
      return true;
    }
  }
  return false;
}

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
    const [state] = await executeRows<{
      boardsTable: string | null;
      systemExcluded: boolean;
      boardTypeScoped: boolean;
    }>(
      commandDb,
      sql`
        SELECT
          to_regclass('public.user_boards')::text AS "boardsTable",
          EXISTS (
            SELECT 1 FROM pg_indexes
            WHERE indexname = ${SERIAL_UNIQUENESS_INDEX}
              AND indexdef LIKE '%00000000-0000-0000-0000-000000000000%'
          ) AS "systemExcluded",
          EXISTS (
            SELECT 1 FROM pg_indexes
            WHERE indexname = ${SERIAL_UNIQUENESS_INDEX}
              AND indexdef LIKE '%board_type%'
          ) AS "boardTypeScoped"
      `,
    );
    if (!state?.boardsTable) {
      return 'user_boards is missing; run migrations before this integration test';
    }
    if (!state.systemExcluded) {
      return 'migration 0131 (system-user serial exemption) not applied; run migrations';
    }
    if (!state.boardTypeScoped) {
      return 'migration 0207 (board-type-scoped serial uniqueness) not applied; run migrations';
    }
  } catch (error: unknown) {
    return `database unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
  return null;
}

async function ensureUser(commandDb: ExecuteDb, id: string, email: string, name = 'Serial Test'): Promise<void> {
  await commandDb.execute(sql`
    INSERT INTO users (id, email, name)
    VALUES (${id}, ${email}, ${name})
    ON CONFLICT (id) DO NOTHING
  `);
}

// `layoutId` varies so two boards owned by the same non-system user differ in
// board config. This used to be load-bearing: a second insert would otherwise
// collide with the user_boards_unique_owner_config index and Postgres would
// report that constraint instead, proving nothing about the serial index. That
// index was dropped in #4166 (a config tuple no longer identifies a board), so
// the variation is now belt-and-braces — keep it so the fixtures stay honest
// about representing distinct boards.
async function insertBoard(
  commandDb: ExecuteDb,
  values: {
    uuid: string;
    slug: string;
    ownerId: string;
    serial: string;
    layoutId: number;
    boardType?: string;
  },
): Promise<void> {
  await commandDb.execute(sql`
    INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, serial_number, is_owned)
    VALUES (
      ${values.uuid}, ${values.slug}, ${values.ownerId}, ${values.boardType ?? 'kilter'}, ${values.layoutId}, 10, '20',
      ${'Serial Test Board'}, ${values.serial}, false
    )
  `);
}

void describe('user_boards serial uniqueness — system catalog exemption and board-type scoping', () => {
  const sharedSerial = 'SERIALUNIQ-TEST-75934';
  const otherOwnerId = 'serial-uniqueness-test-owner';
  const uuids = {
    system1: 'aaaa1111-0000-0000-0000-000000000001',
    system2: 'aaaa1111-0000-0000-0000-000000000002',
    other1: 'bbbb2222-0000-0000-0000-000000000001',
    other2: 'bbbb2222-0000-0000-0000-000000000002',
    otherTension: 'bbbb2222-0000-0000-0000-000000000003',
  };

  void it('exempts the system owner, scopes by board type, and blocks same-type reuse', async () => {
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
      // The SYSTEM catalog user isn't seeded by any migration (production relies
      // on location-sync's own idempotent upsert) — seed it here so this test is
      // self-contained on a fresh DB, using location-sync's exact identity so the
      // row this test leaves behind is the row a real sync would have written.
      // ON CONFLICT DO NOTHING keeps it safe when the row already exists.
      await ensureUser(db, SYSTEM_USER_ID, SYSTEM_USER_EMAIL, SYSTEM_USER_NAME);

      // Two SYSTEM-owned boards with the same serial must both persist.
      await insertBoard(db, {
        uuid: uuids.system1,
        slug: 'serialuniq-sys-1',
        ownerId: SYSTEM_USER_ID,
        serial: sharedSerial,
        layoutId: 1,
      });
      await insertBoard(db, {
        uuid: uuids.system2,
        slug: 'serialuniq-sys-2',
        ownerId: SYSTEM_USER_ID,
        serial: sharedSerial,
        layoutId: 1,
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
        layoutId: 1,
      });
      // ...but a second one of the SAME board type for that owner must violate
      // the serial unique index. A different layout keeps the per-owner config
      // index out of the way, so this assertion exercises the serial index alone.
      await assert.rejects(
        () =>
          insertBoard(db, {
            uuid: uuids.other2,
            slug: 'serialuniq-other-2',
            ownerId: otherOwnerId,
            serial: sharedSerial,
            // A different layout, so this row is unambiguously a distinct board
            // and only the serial index can reject it.
            layoutId: 2,
          }),
        (error: unknown) => violatesConstraint(error, SERIAL_UNIQUENESS_INDEX),
        'a non-system owner must not bind the same serial twice on one board type',
      );

      // ...while the SAME serial on a DIFFERENT board type is a different
      // physical controller (Aurora numbers each board app separately), so one
      // owner may hold both. This is the Benchmark Climbing case: a Tension
      // controller whose serial also exists on some Kilter board.
      await insertBoard(db, {
        uuid: uuids.otherTension,
        slug: 'serialuniq-other-tension',
        ownerId: otherOwnerId,
        serial: sharedSerial,
        layoutId: 1,
        boardType: 'tension',
      });
      const [ownerCount] = await executeRows<CountRow>(
        db,
        sql`SELECT count(*)::int AS count FROM user_boards WHERE owner_id = ${otherOwnerId} AND serial_number = ${sharedSerial}`,
      );
      assert.equal(
        Number(ownerCount?.count ?? 0),
        2,
        'one owner should hold the same serial on a Kilter and a Tension board',
      );

      // Cleanup.
      await db.execute(sql`DELETE FROM user_boards WHERE serial_number = ${sharedSerial}`);
      await db.execute(sql`DELETE FROM users WHERE id = ${otherOwnerId}`);
    } finally {
      await close();
    }
  });
});
