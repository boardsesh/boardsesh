import { afterAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { notAuroraTwinDuplicate } from '@boardsesh/db/queries';
import {
  boardClimbAliases,
  boardClimbs,
  boardseshTicks,
  logbookChangeWatermark,
  logbookChanges,
  users,
} from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { userMutations } from '../graphql/resolvers/users/mutations';
import {
  LOGBOOK_FEED_ORIGIN,
  readLogbookFeedPage,
  type LogbookFeedCursor,
  type LogbookFeedPosition,
  type LogbookFeedTick,
} from '../services/logbook-feed';
import { getWorkerDatabaseUrl } from './worker-db';

/**
 * The logbook change log and the feed read behind `GET /v1/logbook/changes`
 * (docs/integration-platform.md, "Incremental sync"). The migrations are real
 * (applied by schema-sql.ts) so these exercise the shipped triggers.
 *
 * Revert to prove these fail without their fix:
 * - remove `txid < horizon` from the page query: the interleaved test fails.
 * - make the alias trigger immediate: the merge-race interleave fails.
 * - drop SECURITY DEFINER: the restricted-role test fails.
 * - remove the twin fan-out: the twin and randomized tests fail.
 */

const CLIMBER_A = 'logbook-climber-a';
const CLIMBER_B = 'logbook-climber-b';
const BOARD = 'kilter';
const ANGLE = 40;

const writerClients: Array<ReturnType<typeof postgres>> = [];

function openWriterClient(): ReturnType<typeof postgres> {
  const client = postgres(getWorkerDatabaseUrl(), { max: 1, onnotice: () => {} });
  writerClients.push(client);
  return client;
}

afterAll(async () => {
  await Promise.all(writerClients.map((client) => client.end({ timeout: 2 }).catch(() => {})));
});

let nextId = 0;
function uniqueId(prefix: string): string {
  nextId += 1;
  return `${prefix}-${process.pid}-${nextId}`;
}

type TickOverrides = Partial<typeof boardseshTicks.$inferInsert>;

function tickRow(overrides: TickOverrides = {}): typeof boardseshTicks.$inferInsert {
  return {
    uuid: uniqueId('tick'),
    userId: CLIMBER_A,
    boardType: BOARD,
    climbUuid: 'climb-default',
    angle: ANGLE,
    status: 'send',
    attemptCount: 2,
    quality: 3,
    difficulty: 21,
    comment: 'crimpy',
    climbedAt: '2026-05-01 18:22:37',
    ...overrides,
  };
}

async function insertTick(overrides: TickOverrides = {}): Promise<string> {
  const row = tickRow(overrides);
  await db.insert(boardseshTicks).values(row);
  return row.uuid;
}

/** A real Aurora-pull row, stored the way the pull stores one (not locally edited). */
async function insertAuroraTick(auroraId: string, overrides: TickOverrides = {}): Promise<string> {
  return insertTick({
    origin: 'aurora_pull',
    auroraId,
    auroraType: 'ascents',
    updatedAt: '2026-05-01 18:22:37',
    auroraSyncedAt: '2026-05-01 18:22:37',
    ...overrides,
  });
}

async function insertCatalogClimb(uuid: string): Promise<void> {
  await db.insert(boardClimbs).values({ uuid, boardType: BOARD, layoutId: 1, name: uuid });
}

type ChangeRow = { user_id: string; tick_uuid: string };

async function changeRows(): Promise<ChangeRow[]> {
  return db
    .select({ user_id: logbookChanges.userId, tick_uuid: logbookChanges.tickUuid })
    .from(logbookChanges)
    .orderBy(logbookChanges.seq);
}

async function currentFeedCursor(position: LogbookFeedPosition = LOGBOOK_FEED_ORIGIN): Promise<LogbookFeedCursor> {
  const [row] = await db.select({ generation: logbookChangeWatermark.feedGeneration }).from(logbookChangeWatermark);
  return { generation: row.generation, ...position };
}

async function readAll(
  userId: string,
  cursor: LogbookFeedCursor,
): Promise<{ cursor: LogbookFeedCursor; ticks: LogbookFeedTick[]; deleted: string[] }> {
  const ticks = new Map<string, LogbookFeedTick>();
  const deleted = new Set<string>();
  let current = cursor;
  for (;;) {
    const page = await readLogbookFeedPage(db, { userId, cursor: current, limit: 100 });
    if (page.status !== 'ok') throw new Error(`Feed expired: ${page.reason}`);
    for (const entry of page.entries) {
      if (entry.type === 'tick') {
        deleted.delete(entry.tick.uuid);
        ticks.set(entry.tick.uuid, entry.tick);
      } else {
        ticks.delete(entry.id);
        deleted.add(entry.id);
      }
    }
    current = { generation: page.generation, ...page.next };
    if (!page.hasMore) break;
  }
  return { cursor: current, ticks: [...ticks.values()], deleted: [...deleted] };
}

/**
 * Wait until every write committed so far is below the horizon. The horizon is
 * cluster-wide, and other test files and sessions run transactions on this
 * Postgres, so a read straight after a write can legitimately see nothing yet.
 */
async function waitForWritesToSettle(): Promise<void> {
  const [fence] = (await db.execute(sql`SELECT pg_current_xact_id()::text AS txid`)) as unknown as Array<{
    txid: string;
  }>;
  const deadline = Date.now() + 60_000;
  for (;;) {
    const [snapshot] = (await db.execute(
      sql`SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS horizon`,
    )) as unknown as Array<{ horizon: string }>;
    if (BigInt(snapshot.horizon) > BigInt(fence.txid)) return;
    if (Date.now() > deadline) throw new Error(`Horizon stuck at ${snapshot.horizon}, waiting for ${fence.txid}`);
    await delay(25);
  }
}

/** `readAll` once every write so far is below the horizon. */
async function readSettled(
  userId: string,
  cursor: LogbookFeedCursor,
): Promise<{ cursor: LogbookFeedCursor; ticks: LogbookFeedTick[]; deleted: string[] }> {
  await waitForWritesToSettle();
  return readAll(userId, cursor);
}

function byUuid(left: { uuid: string }, right: { uuid: string }): number {
  return left.uuid < right.uuid ? -1 : left.uuid > right.uuid ? 1 : 0;
}

/**
 * The database's public view of one climber's logbook: visible rows with the
 * climb id resolved through the alias table. Independent of the feed code; the
 * test compares a reader that followed the feed against this.
 */
async function publicLogbookView(userId: string): Promise<LogbookFeedTick[]> {
  const rows = await db
    .select({
      uuid: boardseshTicks.uuid,
      boardType: boardseshTicks.boardType,
      climbUuid: boardseshTicks.climbUuid,
      canonicalClimbUuid: sql<string>`COALESCE(${boardClimbAliases.canonicalUuid}, ${boardseshTicks.climbUuid})`,
      angle: boardseshTicks.angle,
      isMirror: boardseshTicks.isMirror,
      status: boardseshTicks.status,
      attemptCount: boardseshTicks.attemptCount,
      quality: boardseshTicks.quality,
      difficulty: boardseshTicks.difficulty,
      isBenchmark: boardseshTicks.isBenchmark,
      comment: boardseshTicks.comment,
      climbedAt: boardseshTicks.climbedAt,
      createdAt: boardseshTicks.createdAt,
      updatedAt: boardseshTicks.updatedAt,
    })
    .from(boardseshTicks)
    .leftJoin(
      boardClimbAliases,
      and(
        eq(boardClimbAliases.boardType, boardseshTicks.boardType),
        eq(boardClimbAliases.aliasUuid, boardseshTicks.climbUuid),
      ),
    )
    .where(and(eq(boardseshTicks.userId, userId), notAuroraTwinDuplicate(boardseshTicks)));
  return rows.sort(byUuid);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE logbook_changes, boardsesh_ticks, board_climb_aliases, board_climbs CASCADE`);
  await db.update(logbookChangeWatermark).set({ prunedThroughTxid: '0', prunedThroughSeq: 0n });
});

describe('tick triggers', { timeout: 90_000 }, () => {
  it('writes one change row for an insert', async () => {
    const tickUuid = await insertTick();
    expect(await changeRows()).toEqual([{ user_id: CLIMBER_A, tick_uuid: tickUuid }]);
  });

  it('writes one change row for a delete', async () => {
    const tickUuid = await insertTick();
    await db.delete(boardseshTicks).where(eq(boardseshTicks.uuid, tickUuid));
    expect((await changeRows()).map((row) => row.tick_uuid)).toEqual([tickUuid, tickUuid]);
  });

  it('writes one row for a public-column update and none for bookkeeping columns', async () => {
    const tickUuid = await insertTick({ quality: 3 });
    await db.update(boardseshTicks).set({ quality: 4 }).where(eq(boardseshTicks.uuid, tickUuid));
    expect((await changeRows()).length).toBe(2);

    await db
      .update(boardseshTicks)
      .set({ auroraSyncError: 'boom', kilterSyncedAt: '2026-05-02 00:00:00', kilterSyncError: 'nope', boardId: 7 })
      .where(eq(boardseshTicks.uuid, tickUuid));
    expect((await changeRows()).length).toBe(2);
  });

  it.each([
    ['session_id', { sessionId: 'inferred-session' }],
    ['climb_revision', { climbRevision: 3 }],
    ['kilter_detached_at', { kilterDetachedAt: '2026-05-02 00:00:00' }],
  ] as const)('writes one row when %s changes, because it advances updated_at', async (_column, change) => {
    const tickUuid = await insertTick();
    await db.delete(logbookChanges);
    const [before] = await db
      .select({ updatedAt: boardseshTicks.updatedAt })
      .from(boardseshTicks)
      .where(eq(boardseshTicks.uuid, tickUuid));

    await db.update(boardseshTicks).set(change).where(eq(boardseshTicks.uuid, tickUuid));

    const [after] = await db
      .select({ updatedAt: boardseshTicks.updatedAt })
      .from(boardseshTicks)
      .where(eq(boardseshTicks.uuid, tickUuid));
    expect(after.updatedAt).not.toBe(before.updatedAt);
    expect(await changeRows()).toEqual([{ user_id: CLIMBER_A, tick_uuid: tickUuid }]);
  });

  it('writes one row for an update that only changes a twin-rule column', async () => {
    const tickUuid = await insertTick({ auroraId: null });
    await db
      .update(boardseshTicks)
      .set({ auroraSyncedAt: '2026-05-02 00:00:00', kilterId: 'kilter-123' })
      .where(eq(boardseshTicks.uuid, tickUuid));
    expect((await changeRows()).length).toBe(2);
  });

  it('writes a row for both climbers when a tick changes owner', async () => {
    const tickUuid = await insertTick({ userId: CLIMBER_A });
    await db.update(boardseshTicks).set({ userId: CLIMBER_B }).where(eq(boardseshTicks.uuid, tickUuid));
    expect(await changeRows()).toEqual([
      { user_id: CLIMBER_A, tick_uuid: tickUuid },
      { user_id: CLIMBER_A, tick_uuid: tickUuid },
      { user_id: CLIMBER_B, tick_uuid: tickUuid },
    ]);
  });

  it('refuses to TRUNCATE boardsesh_ticks while the guard is enabled', async () => {
    await db.execute(sql`ALTER TABLE boardsesh_ticks ENABLE TRIGGER trg_boardsesh_ticks_logbook_truncate`);
    try {
      await expect(db.execute(sql`TRUNCATE TABLE boardsesh_ticks CASCADE`)).rejects.toMatchObject({
        cause: { message: expect.stringContaining('bypass logbook_changes') },
      });
    } finally {
      await db.execute(sql`ALTER TABLE boardsesh_ticks DISABLE TRIGGER trg_boardsesh_ticks_logbook_truncate`);
    }
  });

  it('runs as the function owner, so a writer with no grant on logbook_changes still saves a tick', async () => {
    const restrictedRole = `logbook_restricted_${process.pid}`;
    // One transaction, rolled back: no role is left behind for other sessions.
    await expect(
      db.transaction(async (transaction) => {
        await transaction.execute(sql.raw(`CREATE ROLE "${restrictedRole}" NOLOGIN`));
        await transaction.execute(sql.raw(`GRANT USAGE ON SCHEMA public TO "${restrictedRole}"`));
        await transaction.execute(
          sql.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON boardsesh_ticks TO "${restrictedRole}"`),
        );
        await transaction.execute(sql.raw(`GRANT USAGE ON SEQUENCE boardsesh_ticks_id_seq TO "${restrictedRole}"`));
        const [privilege] = (await transaction.execute(sql`
          SELECT has_table_privilege(${restrictedRole}, 'logbook_changes', 'INSERT') AS can_insert
        `)) as unknown as Array<{ can_insert: boolean }>;
        expect(privilege.can_insert).toBe(false);

        await transaction.execute(sql.raw(`SET LOCAL ROLE "${restrictedRole}"`));
        const tickUuid = uniqueId('tick');
        await transaction.insert(boardseshTicks).values(tickRow({ uuid: tickUuid }));
        await transaction.execute(sql`RESET ROLE`);

        const rows = await transaction
          .select({ tickUuid: logbookChanges.tickUuid })
          .from(logbookChanges)
          .where(eq(logbookChanges.tickUuid, tickUuid));
        expect(rows).toHaveLength(1);
        throw new Error('rollback role fixture');
      }),
    ).rejects.toThrow('rollback role fixture');
  });

  it('pins search_path on every trigger function and is SECURITY DEFINER where it must be', async () => {
    const rows = (await db.execute(sql`
      SELECT proname, prosecdef, proconfig FROM pg_proc
      WHERE proname IN ('log_logbook_change_from_tick', 'log_logbook_change_from_alias', 'forbid_boardsesh_ticks_truncate')
      ORDER BY proname
    `)) as unknown as Array<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>;
    expect(
      rows.map(({ proname, prosecdef, proconfig }) => ({
        proname,
        prosecdef,
        config: proconfig?.map((setting) => setting.replace(/\s+/g, '')),
      })),
    ).toEqual([
      { proname: 'forbid_boardsesh_ticks_truncate', prosecdef: false, config: ['search_path=public,pg_catalog'] },
      { proname: 'log_logbook_change_from_alias', prosecdef: true, config: ['search_path=public,pg_catalog'] },
      { proname: 'log_logbook_change_from_tick', prosecdef: true, config: ['search_path=public,pg_catalog'] },
    ]);
  });

  it('never writes a change row for ticks of other climbers in one party session', async () => {
    const sessionId = uniqueId('session');
    const climberATick = await insertTick({ userId: CLIMBER_A, sessionId });
    const climberBTick = await insertTick({ userId: CLIMBER_B, sessionId });

    const feedForA = await readSettled(CLIMBER_A, await currentFeedCursor());
    const feedForB = await readSettled(CLIMBER_B, await currentFeedCursor());

    expect(feedForA.ticks.map((tick) => tick.uuid)).toEqual([climberATick]);
    expect(feedForB.ticks.map((tick) => tick.uuid)).toEqual([climberBTick]);
    expect((await changeRows()).filter((row) => row.user_id === CLIMBER_A).map((row) => row.tick_uuid)).toEqual([
      climberATick,
    ]);
  });
});

describe('aurora twin fan-out', { timeout: 90_000 }, () => {
  it('rewrites the other copies under the natural key and the feed shows one survivor', async () => {
    const smallest = await insertAuroraTick('aur-1');
    const larger = await insertAuroraTick('aur-2');

    const seenByReader = await readSettled(CLIMBER_A, await currentFeedCursor());
    expect(seenByReader.ticks.map((tick) => tick.uuid)).toEqual([smallest]);
    expect(seenByReader.deleted).toEqual([larger]);
    // The second insert wrote its own row plus one for the survivor it now hides.
    expect((await changeRows()).filter((row) => row.tick_uuid === smallest)).toHaveLength(2);
  });

  it('brings the next twin back when the survivor is deleted', async () => {
    const smallest = await insertAuroraTick('aur-1');
    const larger = await insertAuroraTick('aur-2');
    const firstRead = await readSettled(CLIMBER_A, await currentFeedCursor());

    await db.delete(boardseshTicks).where(eq(boardseshTicks.uuid, smallest));
    const secondRead = await readSettled(CLIMBER_A, firstRead.cursor);

    expect(secondRead.ticks.map((tick) => tick.uuid)).toEqual([larger]);
    expect(secondRead.deleted).toEqual([smallest]);
  });

  it('writes rows under both natural keys when an update moves the tick', async () => {
    const moved = await insertAuroraTick('aur-1', { climbedAt: '2026-05-01 18:22:37' });
    const twinAtOldKey = await insertAuroraTick('aur-2', { climbedAt: '2026-05-01 18:22:37' });
    const twinAtNewKey = await insertAuroraTick('aur-3', { climbedAt: '2026-05-01 19:00:00' });
    await db.execute(sql`DELETE FROM logbook_changes`);

    await db.update(boardseshTicks).set({ climbedAt: '2026-05-01 19:00:00' }).where(eq(boardseshTicks.uuid, moved));

    const rows = await changeRows();
    expect(rows.map((row) => row.tick_uuid).sort()).toEqual([moved, twinAtNewKey, twinAtOldKey].sort());
  });

  it('does not fan out for native ticks or JSON-import surrogates', async () => {
    await insertTick({ auroraId: 'aur-native', origin: 'native' });
    await insertTick({ auroraId: 'json-import-abc', origin: 'json_import' });
    expect(await changeRows()).toHaveLength(2);
  });

  it('feed collapses a repeated tick to its last position within a page', async () => {
    const firstRow = await insertTick();
    await insertTick({ uuid: 'tick-middle' });
    await db.update(boardseshTicks).set({ quality: 5 }).where(eq(boardseshTicks.uuid, firstRow));
    await waitForWritesToSettle();

    const page = await readLogbookFeedPage(db, { userId: CLIMBER_A, cursor: await currentFeedCursor(), limit: 50 });
    if (page.status !== 'ok') throw new Error('expired');
    expect(page.entries.map((entry) => (entry.type === 'tick' ? entry.tick.uuid : entry.id))).toEqual([
      'tick-middle',
      firstRow,
    ]);
  });
});

describe('alias triggers', { timeout: 90_000 }, () => {
  const ALIAS = 'climb-alias';
  const CANONICAL = 'climb-canonical';

  async function aliasRow(canonicalUuid = CANONICAL): Promise<void> {
    await db.insert(boardClimbAliases).values({ boardType: BOARD, aliasUuid: ALIAS, canonicalUuid, source: 'test' });
  }

  it('writes a row per tick on a merge, re-emits the tick with the canonical id', async () => {
    await insertCatalogClimb(CANONICAL);
    const onAlias = await insertTick({ climbUuid: ALIAS });
    await insertTick({ climbUuid: CANONICAL });
    const firstRead = await readSettled(CLIMBER_A, await currentFeedCursor());
    expect(firstRead.ticks.find((tick) => tick.uuid === onAlias)?.canonicalClimbUuid).toBe(ALIAS);

    await aliasRow();

    const secondRead = await readSettled(CLIMBER_A, firstRead.cursor);
    expect(secondRead.ticks.map((tick) => tick.uuid)).toEqual([onAlias]);
    expect(secondRead.ticks[0].canonicalClimbUuid).toBe(CANONICAL);
  });

  it('writes nothing for a self-alias or a last_seen_at refresh', async () => {
    await insertCatalogClimb(CANONICAL);
    await insertTick({ climbUuid: CANONICAL });
    await db.delete(logbookChanges);

    await db
      .insert(boardClimbAliases)
      .values({ boardType: BOARD, aliasUuid: CANONICAL, canonicalUuid: CANONICAL, source: 'kilter' });
    await db
      .update(boardClimbAliases)
      .set({ lastSeenAt: new Date('2026-11-09T00:00:00Z') })
      .where(eq(boardClimbAliases.aliasUuid, CANONICAL));

    expect(await changeRows()).toHaveLength(0);
  });

  it('writes rows when canonical changes and when the alias is deleted', async () => {
    await insertCatalogClimb(CANONICAL);
    await insertCatalogClimb('climb-new-canonical');
    const onAlias = await insertTick({ climbUuid: ALIAS });
    await aliasRow();
    await db.delete(logbookChanges);

    await db
      .update(boardClimbAliases)
      .set({ canonicalUuid: 'climb-new-canonical' })
      .where(eq(boardClimbAliases.aliasUuid, ALIAS));
    expect((await changeRows()).map((row) => row.tick_uuid)).toEqual([onAlias]);

    await db.delete(logbookChanges);
    await db.delete(boardClimbAliases).where(eq(boardClimbAliases.aliasUuid, ALIAS));
    expect((await changeRows()).map((row) => row.tick_uuid)).toEqual([onAlias]);
  });
});

describe('feed read', { timeout: 90_000 }, () => {
  it('returns expired for another generation and for a cursor below the watermark', async () => {
    const cursor = await currentFeedCursor();

    expect(
      await readLogbookFeedPage(db, {
        userId: CLIMBER_A,
        cursor: { ...cursor, generation: '00000000-0000-0000-0000-000000000000' },
        limit: 10,
      }),
    ).toEqual({ status: 'expired', reason: 'generation_mismatch' });

    await db.update(logbookChangeWatermark).set({ prunedThroughTxid: '500', prunedThroughSeq: 0n });
    expect(await readLogbookFeedPage(db, { userId: CLIMBER_A, cursor, limit: 10 })).toEqual({
      status: 'expired',
      reason: 'below_watermark',
    });

    // A position at the watermark is still valid.
    const atWatermark = { ...cursor, txid: '500', seq: '0' };
    expect((await readLogbookFeedPage(db, { userId: CLIMBER_A, cursor: atWatermark, limit: 10 })).status).toBe('ok');
  });

  it('paginates: a full page resumes after its last row, a short page after the horizon', async () => {
    const first = await insertTick();
    const second = await insertTick();
    const third = await insertTick();
    await waitForWritesToSettle();
    const cursor = await currentFeedCursor();

    const firstPage = await readLogbookFeedPage(db, { userId: CLIMBER_A, cursor, limit: 2 });
    if (firstPage.status !== 'ok') throw new Error('expired');
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.entries.map((entry) => (entry.type === 'tick' ? entry.tick.uuid : entry.id))).toEqual([
      first,
      second,
    ]);

    const lastPage = await readLogbookFeedPage(db, {
      userId: CLIMBER_A,
      cursor: { generation: firstPage.generation, ...firstPage.next },
      limit: 2,
    });
    if (lastPage.status !== 'ok') throw new Error('expired');
    expect(lastPage.hasMore).toBe(false);
    expect(lastPage.next).toEqual({ txid: lastPage.horizon, seq: '0' });
    expect(lastPage.entries.map((entry) => (entry.type === 'tick' ? entry.tick.uuid : entry.id))).toEqual([third]);
  });

  it('emits tick.deleted for a tick moved to another climber', async () => {
    const tickUuid = await insertTick({ userId: CLIMBER_A });
    const firstRead = await readSettled(CLIMBER_A, await currentFeedCursor());

    await db.update(boardseshTicks).set({ userId: CLIMBER_B }).where(eq(boardseshTicks.uuid, tickUuid));
    const secondRead = await readSettled(CLIMBER_A, firstRead.cursor);
    expect(secondRead.ticks).toEqual([]);
    expect(secondRead.deleted).toEqual([tickUuid]);

    const newOwnerFeed = await readSettled(CLIMBER_B, await currentFeedCursor());
    expect(newOwnerFeed.ticks.map((tick) => tick.uuid)).toEqual([tickUuid]);
  });

  it('rejects a malformed position and an out-of-range limit', async () => {
    const cursor = await currentFeedCursor();
    await expect(
      readLogbookFeedPage(db, { userId: CLIMBER_A, cursor: { ...cursor, txid: 'not-a-number' }, limit: 10 }),
    ).rejects.toThrow(RangeError);
    await expect(readLogbookFeedPage(db, { userId: CLIMBER_A, cursor, limit: 0 })).rejects.toThrow(RangeError);
    await expect(readLogbookFeedPage(db, { userId: CLIMBER_A, cursor, limit: 201 })).rejects.toThrow(RangeError);
  });
});

describe('account deletion', { timeout: 90_000 }, () => {
  const DELETED_CLIMBER = 'logbook-deleted-climber';
  const SURVIVING_CLIMBER = 'logbook-surviving-climber';

  function deletionContext(userId: string): ConnectionContext {
    return {
      connectionId: 'logbook-account-deletion',
      transport: 'http',
      isAuthenticated: true,
      userId,
    };
  }

  it('leaves no change row naming the deleted climber and keeps every other climber', async () => {
    await db
      .insert(users)
      .values([DELETED_CLIMBER, SURVIVING_CLIMBER].map((id) => ({ id, email: `${id}@test.invalid` })))
      .onConflictDoNothing();
    // Production's FK: the backend test schema leaves it out, and the cascade is
    // what writes the rows this test is about.
    await db.execute(sql`
      ALTER TABLE boardsesh_ticks ADD CONSTRAINT logbook_test_tick_user_fk
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    `);
    try {
      await insertTick({ userId: DELETED_CLIMBER });
      await insertAuroraTick('aurora-deleted-1', { userId: DELETED_CLIMBER });
      await insertAuroraTick('aurora-deleted-2', { userId: DELETED_CLIMBER });
      const survivingTick = await insertTick({ userId: SURVIVING_CLIMBER });

      const deleted = await userMutations.deleteAccount(
        undefined,
        { input: { removeSetterName: false } },
        deletionContext(DELETED_CLIMBER),
      );

      expect(deleted).toBe(true);
      expect(await db.select().from(boardseshTicks).where(eq(boardseshTicks.userId, DELETED_CLIMBER))).toEqual([]);
      expect(await changeRows()).toEqual([{ user_id: SURVIVING_CLIMBER, tick_uuid: survivingTick }]);
    } finally {
      await db.delete(boardseshTicks);
      await db.execute(sql`ALTER TABLE boardsesh_ticks DROP CONSTRAINT logbook_test_tick_user_fk`);
      await db.delete(users).where(inArray(users.id, [DELETED_CLIMBER, SURVIVING_CLIMBER]));
    }
  });
});

/** Runs until `reader` reports every transaction up to `fenceTxid` as settled. */
async function drainUntilHorizonPasses(
  userId: string,
  cursor: LogbookFeedCursor,
  fenceTxid: string,
): Promise<{ cursor: LogbookFeedCursor; ticks: Map<string, LogbookFeedTick>; deleted: Set<string> }> {
  const ticks = new Map<string, LogbookFeedTick>();
  const deleted = new Set<string>();
  let current = cursor;
  const deadline = Date.now() + 60_000;
  for (;;) {
    const page = await readLogbookFeedPage(db, { userId, cursor: current, limit: 200 });
    if (page.status !== 'ok') throw new Error(`Feed expired: ${page.reason}`);
    for (const entry of page.entries) {
      if (entry.type === 'tick') {
        deleted.delete(entry.tick.uuid);
        ticks.set(entry.tick.uuid, entry.tick);
      } else {
        ticks.delete(entry.id);
        deleted.add(entry.id);
      }
    }
    current = { generation: page.generation, ...page.next };
    const horizonPassedFence = BigInt(page.horizon) > BigInt(fenceTxid);
    if (!page.hasMore && horizonPassedFence) break;
    if (Date.now() > deadline) throw new Error(`Horizon stuck below ${fenceTxid} at ${page.horizon}`);
    if (!page.hasMore) await delay(25);
  }
  return { cursor: current, ticks, deleted };
}

/** Commit an empty write and return its transaction id: a fence every earlier write sits below. */
async function commitFence(client: ReturnType<typeof postgres>): Promise<string> {
  const [row] = await client<{ txid: string }[]>`SELECT pg_current_xact_id()::text AS txid`;
  return row.txid;
}

/**
 * An open transaction holds a lock on boardsesh_ticks that blocks the next
 * test's TRUNCATE, so a failed assertion must not leave one behind.
 */
async function reserveWriterConnection(): Promise<postgres.ReservedSql> {
  return openWriterClient().reserve();
}

async function rollBackAndRelease(...connections: postgres.ReservedSql[]): Promise<void> {
  await Promise.all(
    connections.map(async (connection) => {
      // Only a notice when the transaction already committed.
      await connection`ROLLBACK`;
      connection.release();
    }),
  );
}

describe('concurrent transactions', { timeout: 120_000 }, () => {
  it('does not pass a transaction that started first and commits last', async () => {
    const reservedFirst = await reserveWriterConnection();
    const reservedSecond = await reserveWriterConnection();
    const tickFirst = uniqueId('tick');
    const tickSecond = uniqueId('tick');

    try {
      await reservedFirst`BEGIN`;
      await reservedFirst`
      INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, climbed_at)
      VALUES (${tickFirst}, ${CLIMBER_A}, ${BOARD}, 'climb-x', 40, 'send', '2026-05-01 18:00:00')
    `;
      const [{ xid: firstWriterTxid }] = await reservedFirst<
        { xid: string }[]
      >`SELECT pg_current_xact_id()::text AS xid`;

      await reservedSecond`BEGIN`;
      await reservedSecond`
      INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, climbed_at)
      VALUES (${tickSecond}, ${CLIMBER_A}, ${BOARD}, 'climb-y', 40, 'send', '2026-05-01 18:00:00')
    `;
      const [{ xid: secondWriterTxid }] = await reservedSecond<
        { xid: string }[]
      >`SELECT pg_current_xact_id()::text AS xid`;
      expect(BigInt(secondWriterTxid)).toBeGreaterThan(BigInt(firstWriterTxid));
      await reservedSecond`COMMIT`;

      // The first writer is still open: the horizon sits at or below its txid, so
      // neither tick is served yet, and the cursor must not move past it.
      const whileFirstOpen = await readAll(CLIMBER_A, await currentFeedCursor());
      expect(whileFirstOpen.ticks).toEqual([]);
      expect(BigInt(whileFirstOpen.cursor.txid)).toBeLessThanOrEqual(BigInt(firstWriterTxid));

      await reservedFirst`COMMIT`;

      const fence = await commitFence(openWriterClient());
      const afterCommit = await drainUntilHorizonPasses(CLIMBER_A, whileFirstOpen.cursor, fence);
      expect([...afterCommit.ticks.keys()].sort()).toEqual([tickFirst, tickSecond].sort());
    } finally {
      await rollBackAndRelease(reservedFirst, reservedSecond);
    }
  });

  it('delivers a tick committed during a long catalog merge with the merged climb id', async () => {
    const ALIAS = 'climb-merge-race-alias';
    const CANONICAL = 'climb-merge-race-canonical';
    await insertCatalogClimb(CANONICAL);

    const reservedTick = await reserveWriterConnection();
    const reservedMerge = await reserveWriterConnection();
    const racingTick = uniqueId('tick');

    try {
      await reservedTick`BEGIN`;
      await reservedTick`
      INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, climbed_at)
      VALUES (${racingTick}, ${CLIMBER_A}, ${BOARD}, ${ALIAS}, 40, 'send', '2026-05-01 18:00:00')
    `;

      // The merge starts while the tick is uncommitted and stays open.
      await reservedMerge`BEGIN`;
      await reservedMerge`
      INSERT INTO board_climb_aliases (board_type, alias_uuid, canonical_uuid, source)
      VALUES (${BOARD}, ${ALIAS}, ${CANONICAL}, 'kilter')
    `;

      await reservedTick`COMMIT`;

      // The reader consumes the tick before the merge commits, with the old climb
      // id: resolving the alias at read time alone cannot hand it the new id later.
      let beforeMerge = await readAll(CLIMBER_A, await currentFeedCursor());
      const readDeadline = Date.now() + 20_000;
      while (!beforeMerge.ticks.some((tick) => tick.uuid === racingTick)) {
        if (Date.now() > readDeadline) throw new Error('Horizon held back; the tick was never served');
        await delay(25);
        beforeMerge = await readAll(CLIMBER_A, await currentFeedCursor());
      }
      expect(beforeMerge.ticks.find((tick) => tick.uuid === racingTick)?.canonicalClimbUuid).toBe(ALIAS);

      await reservedMerge`COMMIT`;

      const fence = await commitFence(openWriterClient());
      const afterMerge = await drainUntilHorizonPasses(CLIMBER_A, beforeMerge.cursor, fence);
      const racingRow = afterMerge.ticks.get(racingTick);
      expect(racingRow?.canonicalClimbUuid).toBe(CANONICAL);
    } finally {
      await rollBackAndRelease(reservedTick, reservedMerge);
    }
  });
});

function randomInt(random: () => number, bound: number): number {
  return Math.floor(random() * bound);
}

function randomElement<Item>(random: () => number, items: Item[]): Item {
  return items[randomInt(random, items.length)];
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Serializes async work per key, the way the sync lease serializes a climber's pull. */
class KeyedQueue {
  private tails = new Map<string, Promise<unknown>>();
  run<Result>(key: string, task: () => Promise<Result>): Promise<Result> {
    const tail = this.tails.get(key) ?? Promise.resolve();
    const next = tail.then(task, task);
    this.tails.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }
}

type Writer = ReturnType<typeof postgres>;

/** The seed `acquireUserTickMutationLock` uses: the same lock the pull and mutations take. */
const USER_TICK_LOCK_SEED = 1414087499;

async function takeUserTickLock(transaction: postgres.TransactionSql, userId: string): Promise<void> {
  await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, ${USER_TICK_LOCK_SEED}::bigint))`;
}

describe('randomized concurrent writers', () => {
  // Reproduce a failure with LOGBOOK_FEED_TEST_SEED=<printed seed>.
  const baseSeed = Number(process.env.LOGBOOK_FEED_TEST_SEED ?? Date.now() % 1_000_000);

  async function randomizedRun(seed: number): Promise<void> {
    const random = mulberry32(seed);
    // Separate stream so reader timing never shifts the writers' random choices.
    const readerDelayRandom = mulberry32(seed + 7919);
    const climbers = [CLIMBER_A, CLIMBER_B, 'logbook-climber-c'];
    const climbs = Array.from({ length: 8 }, (_, index) => `random-climb-${index}`);
    const baseInstants = ['2026-05-01 10:00:00', '2026-05-01 11:00:00', '2026-05-01 12:00:00'];
    const statuses = ['flash', 'send', 'attempt'] as const;
    await Promise.all(climbs.map((climb) => insertCatalogClimb(climb)));

    const liveTicks = new Map<string, { uuid: string; userId: string }>();
    const climbLock = new KeyedQueue();

    const writerPool: Writer[] = Array.from({ length: 4 }, () => openWriterClient());
    let writerIndex = 0;
    const nextWriter = (): Writer => writerPool[writerIndex++ % writerPool.length];

    const insertNative = async (userId: string): Promise<void> => {
      const row = tickRow({
        userId,
        climbUuid: randomElement(random, climbs),
        status: randomElement(random, [...statuses]),
        climbedAt: randomElement(random, baseInstants),
        sessionId: random() < 0.3 ? 'party-session' : undefined,
      });
      liveTicks.set(row.uuid, { uuid: row.uuid, userId });
      await climbLock.run(row.climbUuid, async () => {
        const client = nextWriter();
        await client`
          INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, climbed_at, session_id)
          VALUES (${row.uuid}, ${row.userId}, ${row.boardType}, ${row.climbUuid}, ${row.angle}, ${row.status}, ${row.climbedAt}, ${row.sessionId ?? null})
        `;
      });
    };

    const insertTwinPair = async (userId: string): Promise<void> => {
      const instant = randomElement(random, baseInstants);
      const climbUuid = randomElement(random, climbs);
      const uuids = [uniqueId('twin'), uniqueId('twin')];
      const auroraIds = [uniqueId('aurora'), uniqueId('aurora')];
      await climbLock.run(climbUuid, async () => {
        const client = nextWriter();
        await client.begin(async (transaction) => {
          await takeUserTickLock(transaction, userId);
          for (let index = 0; index < 2; index += 1) {
            await transaction`
              INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, climbed_at, origin, aurora_id, aurora_type, updated_at, aurora_synced_at)
              VALUES (${uuids[index]}, ${userId}, ${BOARD}, ${climbUuid}, 40, 'send', ${instant}, 'aurora_pull', ${auroraIds[index]}, 'ascents', ${instant}, ${instant})
            `;
          }
        });
      });
      for (const uuid of uuids) liveTicks.set(uuid, { uuid, userId });
    };

    const deleteRandomTick = async (): Promise<void> => {
      const ticks = [...liveTicks.values()];
      if (ticks.length === 0) return;
      const target = randomElement(random, ticks);
      liveTicks.delete(target.uuid);
      await nextWriter().begin(async (transaction) => {
        await takeUserTickLock(transaction, target.userId);
        await transaction`DELETE FROM boardsesh_ticks WHERE uuid = ${target.uuid}`;
      });
    };

    const editRandomTick = async (): Promise<void> => {
      const ticks = [...liveTicks.values()];
      if (ticks.length === 0) return;
      const target = randomElement(random, ticks);
      const comment = `edit-${randomInt(random, 1000)}`;
      await nextWriter().begin(async (transaction) => {
        await takeUserTickLock(transaction, target.userId);
        await transaction`UPDATE boardsesh_ticks SET comment = ${comment} WHERE uuid = ${target.uuid}`;
      });
    };

    const mergeRandomClimb = (): Promise<unknown> => {
      const aliasUuid = randomElement(random, climbs);
      const canonicalUuid = randomElement(random, climbs);
      if (aliasUuid === canonicalUuid) return Promise.resolve();
      // A merge overlapping a tick on its own climb is the narrow race the
      // deferred fan-out closes to its commit gap (covered by the interleaved
      // test). Here a merge never overlaps its own climb, so that window can't
      // make this run flaky.
      return climbLock.run(aliasUuid, async () => {
        const client = nextWriter();
        await client`
          INSERT INTO board_climb_aliases (board_type, alias_uuid, canonical_uuid, source)
          VALUES (${BOARD}, ${aliasUuid}, ${canonicalUuid}, 'kilter')
          ON CONFLICT (board_type, alias_uuid) DO UPDATE SET canonical_uuid = excluded.canonical_uuid
        `;
      });
    };

    const unmergeRandomClimb = (): Promise<unknown> => {
      const aliasUuid = randomElement(random, climbs);
      return climbLock.run(aliasUuid, async () => {
        const client = nextWriter();
        await client`DELETE FROM board_climb_aliases WHERE board_type = ${BOARD} AND alias_uuid = ${aliasUuid}`;
      });
    };

    const operations: Array<() => Promise<unknown>> = [];
    for (let index = 0; index < 90; index += 1) {
      const userId = randomElement(random, climbers);
      const roll = random();
      if (roll < 0.35) operations.push(() => insertNative(userId));
      else if (roll < 0.5) operations.push(() => insertTwinPair(userId));
      else if (roll < 0.7) operations.push(editRandomTick);
      else if (roll < 0.85) operations.push(deleteRandomTick);
      else if (roll < 0.95) operations.push(mergeRandomClimb);
      else operations.push(unmergeRandomClimb);
    }

    const copies = new Map<string, Map<string, LogbookFeedTick>>();
    const cursors = new Map<string, LogbookFeedCursor>();
    for (const userId of climbers) {
      copies.set(userId, new Map());
      cursors.set(userId, await currentFeedCursor());
    }

    let writersDone = false;
    const readerLoop = (async () => {
      while (!writersDone) {
        for (const userId of climbers) {
          const page = await readLogbookFeedPage(db, { userId, cursor: cursors.get(userId)!, limit: 50 });
          if (page.status !== 'ok') throw new Error(`Feed expired: ${page.reason}`);
          const copy = copies.get(userId)!;
          for (const entry of page.entries) {
            if (entry.type === 'tick') copy.set(entry.tick.uuid, entry.tick);
            else copy.delete(entry.id);
          }
          cursors.set(userId, { generation: page.generation, ...page.next });
        }
        await delay(randomInt(readerDelayRandom, 15));
      }
    })();

    // Run the operations through a bounded number of workers, interleaved.
    const queue = [...operations];
    const workers = Array.from({ length: 4 }, async () => {
      for (;;) {
        const operation = queue.shift();
        if (!operation) return;
        await operation();
      }
    });
    try {
      await Promise.all(workers);
    } finally {
      writersDone = true;
      await readerLoop;
    }

    const fence = await commitFence(openWriterClient());
    for (const userId of climbers) {
      const drained = await drainUntilHorizonPasses(userId, cursors.get(userId)!, fence);
      const copy = copies.get(userId)!;
      for (const tickUuid of drained.deleted) copy.delete(tickUuid);
      for (const [tickUuid, tick] of drained.ticks) copy.set(tickUuid, tick);

      const expected = await publicLogbookView(userId);
      const actual = [...copy.values()].sort(byUuid);
      expect(actual, `seed ${seed}: reader copy differs from database for ${userId}`).toEqual(expected);
    }
  }

  it.each([0, 1, 2])(
    'reader copy equals the public view after a randomized run (variant %i)',
    async (variant) => {
      await randomizedRun(baseSeed + variant);
    },
    120_000,
  );
});
