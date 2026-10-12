import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { rowsFromResult } from '@boardsesh/db/client';
import type { ConnectionContext, SyncCursorInput } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { syncQueries } from '../graphql/resolvers/sync/queries';

const userId = 'user-123';
const context = { userId, isAuthenticated: true } as ConnectionContext;
const pull = (cursor?: SyncCursorInput, limit = 10) => syncQueries.syncDeletions(undefined, { cursor, limit }, context);

/**
 * Pull until a page delivers something, for at most eight seconds, and return
 * that page. The cutoff holds every marker behind the oldest open write
 * transaction in the whole database, and the other backend test files run
 * against it at the same time. So the first poll after this file's own writer
 * commits can still be held, correctly, by another file's write. Waiting for
 * the marker to arrive, instead of expecting it on that exact poll, keeps what
 * these tests prove (held while a writer is open, then delivered with nothing
 * skipped) and drops the race. A held page echoes its cursor, so every retry
 * reads from the same position. The tests that use it get a 20 s timeout.
 */
async function pullUntilDelivered(cursor?: SyncCursorInput, limit = 10) {
  const deadline = Date.now() + 8_000;
  for (;;) {
    const page = await pull(cursor, limit);
    if (page.deletions.length > 0 || Date.now() >= deadline) return page;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
const helperSql = readFileSync(
  new URL('../../../db/scripts/sync-deletions-cutoff-function.sql', import.meta.url),
  'utf8',
);
const helperContractSql = readFileSync(
  new URL('../../../db/scripts/sync-deletions-cutoff-contract.sql', import.meta.url),
  'utf8',
);
const prerequisiteSql = readFileSync(
  new URL('../../../db/drizzle/0272_sync_deletions_cutoff_guard.sql', import.meta.url),
  'utf8',
).split('--> statement-breakpoint')[0];
const clients: postgres.Sql[] = [];
function connection(): postgres.Sql {
  const client = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  clients.push(client);
  return client;
}

describe('deletion cursor commit ordering (real PostgreSQL, zero stability window)', () => {
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE sync_deletions RESTART IDENTITY`);
  });
  afterAll(async () => {
    await Promise.all(clients.map((client) => client.end()));
  });

  it('holds newer committed markers until an older idle writer commits, then delivers both', async () => {
    const writer = connection();
    await writer.unsafe('BEGIN');
    try {
      await writer`
        INSERT INTO sync_deletions (table_name, record_id, user_id, deleted_at, stream_at)
        VALUES ('board_climbs', 'late-old-writer', ${userId}, '2026-05-01'::timestamp, '1970-01-01'::timestamp)
      `;
      await db.execute(sql`
        INSERT INTO sync_deletions (table_name, record_id, user_id, deleted_at)
        VALUES ('board_climbs', 'newer-committed-writer', ${userId}, '2026-05-02'::timestamp)
      `);
      const held = await pull();
      expect(held.deletions).toEqual([]);
      expect(held.cursor).toEqual({ updatedAt: '1970-01-01T00:00:00.000Z', syncSeq: '0' });
      expect(held.hasMore).toBe(false);

      await writer.unsafe('COMMIT');
      const first = await pullUntilDelivered(held.cursor, 1);
      expect(first.deletions.map((marker) => marker.recordId)).toEqual(['late-old-writer']);
      expect(first.deletions[0].deletedAt).toBe('2026-05-01T00:00:00Z');
      expect(Date.parse(first.cursor.updatedAt!)).toBeGreaterThan(Date.parse('2026-05-02'));
      expect(first.hasMore).toBe(true);
      const second = await pullUntilDelivered(first.cursor, 1);
      expect(second.deletions.map((marker) => marker.recordId)).toEqual(['newer-committed-writer']);
      expect((await pull(second.cursor)).deletions).toEqual([]);
    } finally {
      await writer.unsafe('ROLLBACK');
    }
  }, 20_000);

  it('takes the page snapshot after cutoff sampling, including a writer committed between queries', async () => {
    const writer = connection();
    await writer.unsafe('BEGIN');
    await writer`
      INSERT INTO sync_deletions (table_name, record_id, user_id)
      VALUES ('board_climbs', 'commit-between-snapshots', ${userId})
    `;
    const execute = db.execute.bind(db);
    let queryCount = 0;
    const spy = vi.spyOn(db, 'execute').mockImplementation((...arguments_) => {
      const query = execute(...arguments_);
      const executeQuery = query.execute.bind(query);
      query.execute = async () => {
        const result = await executeQuery();
        queryCount += 1;
        if (queryCount === 1) await writer.unsafe('COMMIT');
        return result;
      };
      return query;
    });
    try {
      // The sampled cutoff still holds this marker for the next poll; once the
      // writer commits the following fresh poll receives it without a skip.
      const held = await pull();
      expect(queryCount).toBe(2);
      expect(held.deletions).toEqual([]);
      spy.mockRestore();
      expect((await pullUntilDelivered(held.cursor)).deletions.map((marker) => marker.recordId)).toEqual([
        'commit-between-snapshots',
      ]);
    } finally {
      spy.mockRestore();
      await writer.unsafe('ROLLBACK');
    }
  }, 20_000);

  it('preserves legacy NULL stream positions and keeps backdated payload guards independent', async () => {
    await db.execute(sql`ALTER TABLE sync_deletions DISABLE TRIGGER trg_sync_deletion_stream_at`);
    try {
      await db.execute(sql`
        INSERT INTO sync_deletions (table_name, record_id, user_id, deleted_at)
        VALUES ('board_climbs', 'legacy-position', ${userId}, '2026-05-01 00:00:00.123456'::timestamp)
      `);
    } finally {
      await db.execute(sql`ALTER TABLE sync_deletions ENABLE TRIGGER trg_sync_deletion_stream_at`);
    }
    const legacy = await pullUntilDelivered(undefined, 1);
    expect(legacy.cursor.updatedAt).toBe('2026-05-01T00:00:00.123456Z');
    await db.execute(sql`
      INSERT INTO sync_deletions (table_name, record_id, user_id, deleted_at, stream_at)
      VALUES ('board_climbs', 'new-backdated-guard', ${userId}, '2026-04-01'::timestamp, '1970-01-01'::timestamp)
    `);
    const appended = await pullUntilDelivered(legacy.cursor);
    expect(appended.deletions.map((marker) => marker.recordId)).toEqual(['new-backdated-guard']);
    expect(appended.deletions[0].deletedAt).toBe('2026-04-01T00:00:00Z');
    expect(Date.parse(appended.cursor.updatedAt!)).toBeGreaterThan(Date.parse(legacy.cursor.updatedAt!));
  }, 20_000);

  it('pauses without advancing when the helper loses effective stats access', async () => {
    const admin = connection();
    const ownerRole = `cutoff_no_stats_${randomUUID().replaceAll('-', '')}`;
    await admin.unsafe(`CREATE ROLE "${ownerRole}" NOLOGIN NOINHERIT`);
    const [original] = await admin<{ owner: string }[]>`
      SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc
      WHERE oid = 'public.sync_deletions_safe_cutoff(double precision)'::regprocedure
    `;
    try {
      // Declared membership without inheritance must still fail closed.
      await admin.unsafe(`GRANT pg_read_all_stats TO "${ownerRole}"`);
      await admin.unsafe(`ALTER FUNCTION public.sync_deletions_safe_cutoff(double precision) OWNER TO "${ownerRole}"`);
      const cursor = { updatedAt: '2026-05-01T00:00:00.123456Z', syncSeq: '72' };
      expect(await pull(cursor)).toEqual({ deletions: [], cursor, hasMore: false });
    } finally {
      await admin.unsafe(
        `ALTER FUNCTION public.sync_deletions_safe_cutoff(double precision) OWNER TO "${original.owner}"`,
      );
      await admin.unsafe(`DROP ROLE "${ownerRole}"`);
    }
  });

  it('pauses without advancing when the helper query fails', async () => {
    const spy = vi.spyOn(db, 'execute').mockRejectedValueOnce(new Error('helper execute denied'));
    const cursor = { updatedAt: '2026-05-01T00:00:00.123456Z', syncSeq: '72' };
    try {
      expect(await pull(cursor)).toEqual({ deletions: [], cursor, hasMore: false });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('blocks for a relevant prepared transaction instead of treating prepare time as transaction start', async () => {
    const admin = connection();
    // postgres:15 test infrastructure disables two-phase commit. Run the real
    // function body against a catalog fixture, preserving the ordering/guard.
    await admin.unsafe('CREATE TABLE test_sync_prepared_xacts (database text, prepared timestamptz)');
    const fixtureSql = helperSql
      .replaceAll('sync_deletions_safe_cutoff', 'sync_deletions_prepared_fixture_cutoff')
      .replace('pg_catalog.pg_prepared_xacts', 'public.test_sync_prepared_xacts');
    await admin.unsafe(fixtureSql);
    try {
      const [open] = await admin<{ cutoff: string | null }[]>`
        SELECT public.sync_deletions_prepared_fixture_cutoff(0)::text AS cutoff
      `;
      expect(open.cutoff).not.toBeNull();
      await admin`INSERT INTO test_sync_prepared_xacts VALUES (current_database(), clock_timestamp())`;
      const [blocked] = await admin<{ cutoff: string | null }[]>`
        SELECT public.sync_deletions_prepared_fixture_cutoff(0)::text AS cutoff
      `;
      expect(blocked.cutoff).toBeNull();
      await admin`UPDATE test_sync_prepared_xacts SET database = 'another_database'`;
      const [unrelated] = await admin<{ cutoff: string | null }[]>`
        SELECT public.sync_deletions_prepared_fixture_cutoff(0)::text AS cutoff
      `;
      expect(unrelated.cutoff).not.toBeNull();
    } finally {
      await admin.unsafe('DROP FUNCTION public.sync_deletions_prepared_fixture_cutoff(double precision)');
      await admin.unsafe('DROP TABLE test_sync_prepared_xacts');
    }
  });

  it('blocks disabled activity metadata and rejects a future cutoff configuration', async () => {
    const observer = connection();
    await observer.unsafe('SET track_activities = off');
    try {
      expect((await pull()).deletions).toEqual([]);
      const [cutoff] = rowsFromResult<{ safe_cutoff: string | null }>(
        await db.execute(sql`SELECT public.sync_deletions_safe_cutoff(0)::text AS safe_cutoff`),
      );
      expect(cutoff.safe_cutoff).toBeNull();
    } finally {
      await observer.unsafe('SET track_activities = on');
    }
    const [invalid] = rowsFromResult<{ safe_cutoff: string | null }>(
      await db.execute(sql`SELECT public.sync_deletions_safe_cutoff(-1)::text AS safe_cutoff`),
    );
    expect(invalid.safe_cutoff).toBeNull();
  });

  it('allows only the canonical NOLOGIN helper boundary and rejects privilege/body drift', async () => {
    const admin = connection();
    const suffix = randomUUID().replaceAll('-', '');
    const ownerRole = `cutoff_owner_${suffix}`;
    const runtimeRole = `cutoff_runtime_${suffix}`;
    const contractSql = helperContractSql
      .replaceAll('boardsesh_sync_cutoff_owner', ownerRole)
      .replaceAll('__SYNC_RUNTIME_ROLE__', runtimeRole);
    const migrationGate = prerequisiteSql.replaceAll('boardsesh_sync_cutoff_owner', ownerRole);
    const [original] = await admin<{ owner: string }[]>`
      SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc
      WHERE oid = 'public.sync_deletions_safe_cutoff(double precision)'::regprocedure
    `;
    const matches = async () => {
      const [contract] = await admin.unsafe<{ matches: boolean }[]>(contractSql);
      return contract.matches;
    };
    await admin.unsafe(`CREATE ROLE "${ownerRole}" NOLOGIN INHERIT`);
    await admin.unsafe(`CREATE ROLE "${runtimeRole}" LOGIN`);
    try {
      const [server] = await admin<
        { version: number }[]
      >`SELECT current_setting('server_version_num')::integer AS version`;
      await admin.unsafe(
        server.version >= 160000
          ? `GRANT pg_read_all_stats TO "${ownerRole}" WITH ADMIN FALSE, INHERIT TRUE, SET FALSE`
          : `GRANT pg_read_all_stats TO "${ownerRole}"`,
      );
      await admin.unsafe(`ALTER FUNCTION public.sync_deletions_safe_cutoff(double precision) OWNER TO "${ownerRole}"`);
      await admin.unsafe(
        `GRANT EXECUTE ON FUNCTION public.sync_deletions_safe_cutoff(double precision) TO "${runtimeRole}"`,
      );
      expect(await matches()).toBe(true);
      await admin.unsafe(migrationGate);

      await admin.unsafe(`SET ROLE "${runtimeRole}"`);
      try {
        const [runtime] = await admin<{ cutoff: string | null; hasStats: boolean }[]>`
          SELECT public.sync_deletions_safe_cutoff(0)::text AS cutoff,
                 pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') AS "hasStats"
        `;
        expect(runtime.cutoff).not.toBeNull();
        expect(runtime.hasStats).toBe(false);
      } finally {
        await admin.unsafe('RESET ROLE');
      }

      await admin.unsafe('GRANT EXECUTE ON FUNCTION public.sync_deletions_safe_cutoff(double precision) TO PUBLIC');
      expect(await matches()).toBe(false);
      await expect(admin.unsafe(migrationGate)).rejects.toThrow('prerequisite missing/unsafe');
      await admin.unsafe('REVOKE EXECUTE ON FUNCTION public.sync_deletions_safe_cutoff(double precision) FROM PUBLIC');

      await admin.unsafe(`GRANT "${ownerRole}" TO "${runtimeRole}"`);
      expect(await matches()).toBe(false);
      await admin.unsafe(`REVOKE "${ownerRole}" FROM "${runtimeRole}"`);

      await admin.unsafe(`ALTER ROLE "${ownerRole}" LOGIN`);
      expect(await matches()).toBe(false);
      await admin.unsafe(`ALTER ROLE "${ownerRole}" NOLOGIN`);

      await admin.unsafe(helperSql.replace('RETURN NULL;', "RETURN '2099-01-01'::timestamp;"));
      expect(await matches()).toBe(false);
      await expect(admin.unsafe(migrationGate)).rejects.toThrow('prerequisite missing/unsafe');
      await admin.unsafe(helperSql);
      expect(await matches()).toBe(true);

      await admin.unsafe(
        'ALTER FUNCTION public.sync_deletions_safe_cutoff(double precision) RENAME TO sync_deletions_missing_helper',
      );
      try {
        expect(await matches()).toBe(false);
        await expect(admin.unsafe(migrationGate)).rejects.toThrow('prerequisite missing/unsafe');
      } finally {
        await admin.unsafe(
          'ALTER FUNCTION public.sync_deletions_missing_helper(double precision) RENAME TO sync_deletions_safe_cutoff',
        );
      }
    } finally {
      await admin.unsafe('RESET ROLE');
      await admin.unsafe(
        `ALTER FUNCTION public.sync_deletions_safe_cutoff(double precision) OWNER TO "${original.owner}"`,
      );
      await admin.unsafe(`DROP OWNED BY "${ownerRole}", "${runtimeRole}"`);
      await admin.unsafe(`DROP ROLE "${ownerRole}", "${runtimeRole}"`);
      await admin.unsafe(helperSql);
    }
  });
});
