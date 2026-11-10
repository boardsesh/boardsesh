import { afterAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { and, eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { notAuroraTwinDuplicate } from '@boardsesh/db/queries';
import {
  boardClimbAliases,
  boardClimbs,
  boardseshTicks,
  contentPrivacy,
  logbookChangeWatermark,
  logbookSnapshotChunks,
  logbookSnapshots,
  oauthClient,
  oauthConnections,
  users,
} from '@boardsesh/db/schema';
import { db } from '../db/client';
import { logger } from '../utils/logger';
import { getPostgresErrorCode } from '../utils/postgres-errors';
import { readLogbookFeedPage, type LogbookFeedCursor, type LogbookFeedTick } from '../services/logbook-feed';
import {
  LOGBOOK_SNAPSHOT_BUILD_SLOT_LOCK_CLASS,
  LOGBOOK_SNAPSHOT_CHUNK_TICKS,
  LOGBOOK_SNAPSHOT_START_LOCK_SEED,
  advanceLogbookSnapshotBuild,
  readLogbookSnapshotPage,
  reclaimExpiredLogbookSnapshots,
  startLogbookSnapshot,
  type LogbookSnapshotBinding,
  type LogbookSnapshotCursor,
} from '../services/logbook-snapshot';
import { getWorkerDatabaseUrl } from './worker-db';

/**
 * The bootstrap's hand-off from snapshot to change feed
 * (docs/integration-platform.md, "Complete bootstrap and transition") and the
 * build, expiry and reclaim rules around it.
 *
 * Remove these protections to prove the tests fail:
 * - use `pg_snapshot_xmax` as H instead of `xmin`: the out-of-order test fails.
 * - use the start transaction's own xid as H: the open-writer test fails.
 * - drop the build step's row lock: the concurrent-builders test fails.
 * - drop `snapshotIsLive()` from the read or the build step: the expiry tests fail.
 * - drop `snapshotBelongsTo` from the read: the binding test fails.
 * - drop the twin filter: the twin tests fail.
 * - drop `ON DELETE CASCADE` on `user_id`: the account-deletion test fails.
 * - drop the `connection_id` foreign key or its cascade: the connection tests fail.
 * - ignore `expires_at` in the reclaim scan: the reclaim test fails.
 * - wait for row locks in reclaim: the in-flight build test fails.
 * - remove the planner settings or timeouts: the chunk-settings test fails.
 * - remove the build slots: the slots test fails.
 * - retire before the capacity check: the capacity-refusal test fails.
 * - keep status out of the join, or generation or watermark: the join tests fail.
 */

const CLIMBER_A = 'snapshot-climber-a';
const CLIMBER_B = 'snapshot-climber-b';
const BOARD = 'kilter';
const ANGLE = 40;

const BINDING: LogbookSnapshotBinding = { userId: CLIMBER_A, connectionId: 'connection-a', connectionGeneration: 0 };

let nextId = 0;
function uniqueId(prefix: string): string {
  nextId += 1;
  return `${prefix}-${process.pid}-${nextId}`;
}

const writerClients: Array<ReturnType<typeof postgres>> = [];

function openWriterClient(): ReturnType<typeof postgres> {
  const client = postgres(getWorkerDatabaseUrl(), { max: 1, onnotice: () => {} });
  writerClients.push(client);
  return client;
}

afterAll(async () => {
  await Promise.all(writerClients.map((client) => client.end({ timeout: 2 }).catch(() => {})));
});

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

async function seedTicks(count: number, overrides: TickOverrides = {}): Promise<string[]> {
  const rows = Array.from({ length: count }, (_unused, index) =>
    tickRow({
      climbedAt: `2026-05-01 ${String(10 + Math.floor(index / 3600)).padStart(2, '0')}:${String(Math.floor(index / 60) % 60).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`,
      ...overrides,
    }),
  );
  await db.insert(boardseshTicks).values(rows);
  return rows.map((row) => row.uuid);
}

/**
 * A snapshot's `connection_id` references `oauth_connections`, so every binding
 * a test starts a snapshot under needs its connection row. A climber has one
 * connection per app, so each connection gets an app of its own. Idempotent.
 */
async function ensureConnection(binding: LogbookSnapshotBinding): Promise<void> {
  const clientId = `app-of-${binding.connectionId}`;
  await db
    .insert(oauthClient)
    .values({ id: clientId, clientId, redirectUris: ['https://app.example.test/callback'] })
    .onConflictDoNothing();
  await db
    .insert(oauthConnections)
    .values({ id: binding.connectionId, userId: binding.userId, clientId, connectedAt: new Date() })
    .onConflictDoNothing();
}

async function startSnapshot(binding: LogbookSnapshotBinding = BINDING): Promise<LogbookSnapshotCursor> {
  await ensureConnection(binding);
  const started = await startLogbookSnapshot(db, binding);
  if (started.status !== 'started') throw new Error('snapshot did not start');
  return started.cursor;
}

/**
 * Copies a snapshot chunk by chunk with a callback between chunks, the way
 * writes can land between the short transactions of a real build.
 */
async function buildChunkByChunk(
  binding: LogbookSnapshotBinding,
  cursor: LogbookSnapshotCursor,
  afterChunk?: (chunkIndex: number) => Promise<void>,
): Promise<void> {
  for (let chunkIndex = 0; ; chunkIndex += 1) {
    const progress = await advanceLogbookSnapshotBuild(db, {
      binding,
      snapshotId: cursor.snapshotId,
      timeBudgetMs: 0,
    });
    if (progress.status === 'ready') return;
    if (progress.status !== 'building') throw new Error(`build stopped: ${progress.status}`);
    await afterChunk?.(chunkIndex);
  }
}

async function downloadSnapshot(
  binding: LogbookSnapshotBinding,
  cursor: LogbookSnapshotCursor,
  limit = 200,
): Promise<{ ticks: LogbookFeedTick[]; changeCursor: LogbookFeedCursor }> {
  const ticks: LogbookFeedTick[] = [];
  let current = cursor;
  for (;;) {
    const page = await readLogbookSnapshotPage(db, { binding, cursor: current, limit });
    if (page.status !== 'ok') throw new Error(`snapshot read failed: ${JSON.stringify(page)}`);
    expect(page.hasMore).toBe(true);
    for (const entry of page.entries) {
      if (entry.type === 'tick') ticks.push(entry.tick);
    }
    if (page.next.kind === 'changes') return { ticks, changeCursor: page.next.cursor };
    current = page.next.cursor;
  }
}

function applyTo(reader: Map<string, LogbookFeedTick>, ticks: LogbookFeedTick[]): void {
  for (const tick of ticks) reader.set(tick.uuid, tick);
}

/**
 * Follow the feed the way an app does until it stops, once every write so far
 * has settled below the horizon.
 */
async function catchUp(
  reader: Map<string, LogbookFeedTick>,
  userId: string,
  cursor: LogbookFeedCursor,
): Promise<LogbookFeedCursor> {
  await waitForWritesToSettle();
  let current = cursor;
  for (;;) {
    const page = await readLogbookFeedPage(db, { userId, cursor: current, limit: 100 });
    if (page.status !== 'ok') throw new Error(`Feed expired: ${page.reason}`);
    for (const entry of page.entries) {
      if (entry.type === 'tick') reader.set(entry.tick.uuid, entry.tick);
      else reader.delete(entry.id);
    }
    current = { generation: page.generation, ...page.next };
    if (!page.hasMore) return current;
  }
}

/** Waits until every write committed so far is below the horizon, as logbook-changes.test.ts does. */
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
    await delay(20);
  }
}

/** Seconds from now until a snapshot expires, by the database clock. */
async function secondsUntilExpiry(cursor: LogbookSnapshotCursor): Promise<number> {
  const [row] = (await db.execute(
    sql`SELECT extract(epoch FROM expires_at - now())::float8 AS seconds FROM logbook_snapshots WHERE id = ${cursor.snapshotId}::uuid`,
  )) as unknown as Array<{ seconds: number }>;
  return Number(row.seconds);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function byUuid(left: { uuid: string }, right: { uuid: string }): number {
  return left.uuid < right.uuid ? -1 : left.uuid > right.uuid ? 1 : 0;
}

/** The database's public view of a climber's logbook, independent of the code under test. */
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

async function expectReaderMatchesDatabase(reader: Map<string, LogbookFeedTick>, userId: string): Promise<void> {
  expect([...reader.values()].sort(byUuid)).toEqual(await publicLogbookView(userId));
}

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE TABLE logbook_snapshot_chunks, logbook_snapshots, logbook_changes, boardsesh_ticks, board_climb_aliases, board_climbs CASCADE`,
  );
  await db.update(logbookChangeWatermark).set({ prunedThroughTxid: '0', prunedThroughSeq: 0n });
  await db
    .insert(users)
    .values([
      { id: CLIMBER_A, email: 'a@example.com' },
      { id: CLIMBER_B, email: 'b@example.com' },
    ])
    .onConflictDoNothing();
  await ensureConnection(BINDING);
  await ensureConnection({ userId: CLIMBER_B, connectionId: 'connection-b', connectionGeneration: 0 });
});

describe('hand-off from snapshot to feed', { timeout: 120_000 }, () => {
  it('holds exactly the public logbook, ends on the feed cursor (H, 0) and says hasMore on the last page', async () => {
    await seedTicks(LOGBOOK_SNAPSHOT_CHUNK_TICKS + 37);
    const cursor = await startSnapshot();
    await buildChunkByChunk(BINDING, cursor);

    const { ticks, changeCursor } = await downloadSnapshot(BINDING, cursor, 73);
    const reader = new Map<string, LogbookFeedTick>();
    applyTo(reader, ticks);
    await expectReaderMatchesDatabase(reader, CLIMBER_A);

    expect(changeCursor.seq).toBe('0');
    const [{ horizon }] = await db.select({ horizon: logbookSnapshots.horizonTxid }).from(logbookSnapshots);
    expect(changeCursor.txid).toBe(horizon);
    const [{ generation }] = await db
      .select({ generation: logbookChangeWatermark.feedGeneration })
      .from(logbookChangeWatermark);
    expect(changeCursor.generation).toBe(generation);

    await catchUp(reader, CLIMBER_A, changeCursor);
    await expectReaderMatchesDatabase(reader, CLIMBER_A);
  });

  it('returns an empty snapshot for a climber with no ticks, and the last page still leads into catch-up', async () => {
    const cursor = await startSnapshot();
    await buildChunkByChunk(BINDING, cursor);
    const page = await readLogbookSnapshotPage(db, { binding: BINDING, cursor, limit: 50 });
    if (page.status !== 'ok') throw new Error('expected a page');
    expect(page.entries).toEqual([]);
    expect(page.hasMore).toBe(true);
    expect(page.next.kind).toBe('changes');
  });

  it('delivers a tick from a transaction open across the whole build, through the feed', async () => {
    await seedTicks(5);
    const client = await openWriterClient().reserve();
    const openTick = uniqueId('tick');
    await client`BEGIN`;
    await client`
      INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, climbed_at)
      VALUES (${openTick}, ${CLIMBER_A}, ${BOARD}, 'climb-open', ${ANGLE}, 'send', '2026-05-02 10:00:00')
    `;

    const cursor = await startSnapshot();
    await buildChunkByChunk(BINDING, cursor);
    const { ticks, changeCursor } = await downloadSnapshot(BINDING, cursor);
    expect(ticks.map((tick) => tick.uuid)).not.toContain(openTick);

    await client`COMMIT`;
    client.release();

    const reader = new Map<string, LogbookFeedTick>();
    applyTo(reader, ticks);
    await catchUp(reader, CLIMBER_A, changeCursor);
    expect(reader.has(openTick)).toBe(true);
    await expectReaderMatchesDatabase(reader, CLIMBER_A);
  });

  it('covers both sides when commits land out of order around the start of the snapshot', async () => {
    const firstWriter = await openWriterClient().reserve();
    const secondWriter = await openWriterClient().reserve();
    const firstTick = uniqueId('tick');
    const secondTick = uniqueId('tick');

    await firstWriter`BEGIN`;
    await firstWriter`
      INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, climbed_at)
      VALUES (${firstTick}, ${CLIMBER_A}, ${BOARD}, 'climb-first', ${ANGLE}, 'send', '2026-05-02 10:00:00')
    `;
    await secondWriter`BEGIN`;
    await secondWriter`
      INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, climbed_at)
      VALUES (${secondTick}, ${CLIMBER_A}, ${BOARD}, 'climb-second', ${ANGLE}, 'send', '2026-05-02 10:00:01')
    `;
    await secondWriter`COMMIT`;
    secondWriter.release();

    // The second, newer transaction is visible to the snapshot; the first,
    // older one is still open and commits only after the build ends.
    const cursor = await startSnapshot();
    await buildChunkByChunk(BINDING, cursor);
    const { ticks, changeCursor } = await downloadSnapshot(BINDING, cursor);
    expect(ticks.map((tick) => tick.uuid)).toEqual([secondTick]);

    await firstWriter`COMMIT`;
    firstWriter.release();

    const reader = new Map<string, LogbookFeedTick>();
    applyTo(reader, ticks);
    await catchUp(reader, CLIMBER_A, changeCursor);
    expect([...reader.keys()].sort()).toEqual([firstTick, secondTick].sort());
  });

  it('keeps every write made between chunks, whatever part of the logbook it touches', async () => {
    const tickCount = LOGBOOK_SNAPSHOT_CHUNK_TICKS * 3 + 11;
    const [editedAlreadyCopied, movedForwardPastCursor, ...others] = await seedTicks(tickCount);
    const deletedNotYetCopied = others[others.length - 1];
    const movedBackIntoCopiedRange = others[others.length - 2];
    const insertedAfterCursor = uniqueId('tick-late');

    const cursor = await startSnapshot();
    await buildChunkByChunk(BINDING, cursor, async (chunkIndex) => {
      if (chunkIndex !== 0) return;
      // Written after the first chunk commits: each change is behind or ahead
      // of the build's position in a way that a single read of the logbook
      // would either miss or double-count.
      await db.update(boardseshTicks).set({ quality: 5 }).where(eq(boardseshTicks.uuid, editedAlreadyCopied));
      await db.delete(boardseshTicks).where(eq(boardseshTicks.uuid, deletedNotYetCopied));
      await db
        .update(boardseshTicks)
        .set({ climbedAt: '2026-05-01 00:00:01' })
        .where(eq(boardseshTicks.uuid, movedBackIntoCopiedRange));
      await db
        .update(boardseshTicks)
        .set({ climbedAt: '2026-05-03 12:00:00' })
        .where(eq(boardseshTicks.uuid, movedForwardPastCursor));
      await insertTick({ uuid: insertedAfterCursor, climbedAt: '2026-05-01 00:00:02' });
    });

    const { ticks, changeCursor } = await downloadSnapshot(BINDING, cursor);

    // A tick can appear twice only because a write during the build moved its
    // updated_at past the build's position after it was copied, and the later
    // copy is the newer state. Nothing is lost, and nothing untouched repeats.
    const writtenDuringBuild = new Set([editedAlreadyCopied, movedForwardPastCursor, movedBackIntoCopiedRange]);
    const copies = new Map<string, number>();
    for (const tick of ticks) copies.set(tick.uuid, (copies.get(tick.uuid) ?? 0) + 1);
    const repeated = [...copies.entries()].filter(([, count]) => count > 1).map(([uuid]) => uuid);
    expect(repeated.length).toBeGreaterThan(0);
    expect(repeated.filter((uuid) => !writtenDuringBuild.has(uuid))).toEqual([]);

    const reader = new Map<string, LogbookFeedTick>();
    applyTo(reader, ticks);
    await catchUp(reader, CLIMBER_A, changeCursor);

    expect(reader.get(editedAlreadyCopied)?.quality).toBe(5);
    expect(reader.has(deletedNotYetCopied)).toBe(false);
    expect(reader.get(movedBackIntoCopiedRange)?.climbedAt).toBe('2026-05-01 00:00:01');
    expect(reader.get(movedForwardPastCursor)?.climbedAt).toBe('2026-05-03 12:00:00');
    expect(reader.has(insertedAfterCursor)).toBe(true);
    await expectReaderMatchesDatabase(reader, CLIMBER_A);
  });

  it('keeps Aurora twins consistent when one flips between chunks', async () => {
    await insertCatalogClimb('climb-twin');
    const twinClimbedAt = '2026-05-01 09:00:00';
    const survivor = await insertAuroraTick('aurora-a', { climbUuid: 'climb-twin', climbedAt: twinClimbedAt });
    const hidden = await insertAuroraTick('aurora-b', { climbUuid: 'climb-twin', climbedAt: twinClimbedAt });
    await seedTicks(LOGBOOK_SNAPSHOT_CHUNK_TICKS + 5);

    const cursor = await startSnapshot();
    await buildChunkByChunk(BINDING, cursor, async (chunkIndex) => {
      // The survivor was copied in the first chunk. Deleting it now reveals
      // the hidden twin, which the build will not read again.
      if (chunkIndex === 0) await db.delete(boardseshTicks).where(eq(boardseshTicks.uuid, survivor));
    });
    const { ticks, changeCursor } = await downloadSnapshot(BINDING, cursor);
    expect(ticks.map((tick) => tick.uuid)).toContain(survivor);
    expect(ticks.map((tick) => tick.uuid)).not.toContain(hidden);

    const reader = new Map<string, LogbookFeedTick>();
    applyTo(reader, ticks);
    await catchUp(reader, CLIMBER_A, changeCursor);
    expect(reader.has(survivor)).toBe(false);
    expect(reader.has(hidden)).toBe(true);
    await expectReaderMatchesDatabase(reader, CLIMBER_A);
  });

  it('resolves a climb merged before H in the snapshot itself, because the feed never replays it', async () => {
    await insertCatalogClimb('climb-old-alias');
    await insertCatalogClimb('climb-old-canonical');
    const merged = await insertTick({ climbUuid: 'climb-old-alias', climbedAt: '2026-05-01 01:00:00' });
    await db.insert(boardClimbAliases).values({
      boardType: BOARD,
      aliasUuid: 'climb-old-alias',
      canonicalUuid: 'climb-old-canonical',
      source: 'kilter',
    });
    await waitForWritesToSettle();

    const cursor = await startSnapshot();
    await buildChunkByChunk(BINDING, cursor);
    const { ticks, changeCursor } = await downloadSnapshot(BINDING, cursor);
    expect(ticks.find((tick) => tick.uuid === merged)?.canonicalClimbUuid).toBe('climb-old-canonical');

    const feedOnly = new Map<string, LogbookFeedTick>();
    await catchUp(feedOnly, CLIMBER_A, changeCursor);
    expect(feedOnly.has(merged)).toBe(false);
  });

  it('redelivers a tick whose climb is merged during the build', async () => {
    await insertCatalogClimb('climb-alias');
    await insertCatalogClimb('climb-canonical');
    const merged = await insertTick({ climbUuid: 'climb-alias', climbedAt: '2026-05-01 01:00:00' });

    const cursor = await startSnapshot();
    await buildChunkByChunk(BINDING, cursor);
    const { ticks, changeCursor } = await downloadSnapshot(BINDING, cursor);
    expect(ticks[0].canonicalClimbUuid).toBe('climb-alias');

    await db
      .insert(boardClimbAliases)
      .values({ boardType: BOARD, aliasUuid: 'climb-alias', canonicalUuid: 'climb-canonical', source: 'kilter' });

    const reader = new Map<string, LogbookFeedTick>();
    applyTo(reader, ticks);
    await catchUp(reader, CLIMBER_A, changeCursor);
    expect(reader.get(merged)?.canonicalClimbUuid).toBe('climb-canonical');
    await expectReaderMatchesDatabase(reader, CLIMBER_A);
  });

  describe('randomized writers throughout a build', () => {
    // Reproduce a failure with LOGBOOK_SNAPSHOT_TEST_SEED=<printed seed>.
    const baseSeed = Number(process.env.LOGBOOK_SNAPSHOT_TEST_SEED ?? Date.now() % 1_000_000);

    function mulberry32(seed: number): () => number {
      let state = seed;
      return () => {
        state = (state + 0x6d2b79f5) | 0;
        let value = Math.imul(state ^ (state >>> 15), 1 | state);
        value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
      };
    }

    type Writer = ReturnType<typeof postgres>;

    async function randomizedRun(seed: number): Promise<void> {
      const random = mulberry32(seed);
      const randomInt = (bound: number): number => Math.floor(random() * bound);
      const climbs = ['r-climb-0', 'r-climb-1', 'r-climb-2', 'r-climb-3'];
      const mergeClimb = 'r-merge-climb';
      const mergeCanonical = 'r-merge-canonical';
      await Promise.all([...climbs, mergeClimb, mergeCanonical].map((climb) => insertCatalogClimb(climb)));
      await db.insert(boardClimbAliases).values({
        boardType: BOARD,
        aliasUuid: 'r-climb-0',
        canonicalUuid: 'r-climb-0',
        source: 'kilter',
      });
      // Ticks on a climb no writer touches: a merge overlapping a tick on its
      // own climb is the commit-gap race the deferred fan-out already narrows,
      // which logbook-changes.test.ts covers. Here the merge fan-out only has
      // to survive a build running alongside it.
      await db.insert(boardseshTicks).values(
        Array.from({ length: 12 }, (_unused, index) =>
          tickRow({
            uuid: uniqueId('r-merge-tick'),
            climbUuid: mergeClimb,
            climbedAt: `2026-05-02 03:00:${String(index).padStart(2, '0')}`,
          }),
        ),
      );
      const twinUuids: string[] = [];

      const live = new Set<string>();
      const baseRows = Array.from({ length: 900 }, (_unused, index) => {
        const uuid = uniqueId('r-tick');
        live.add(uuid);
        return tickRow({
          uuid,
          climbUuid: climbs[randomInt(climbs.length)],
          climbedAt: `2026-05-01 ${String(10 + (index % 6)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00`,
        });
      });
      await db.insert(boardseshTicks).values(baseRows);
      // The seed settles below H, so the feed does not replay it and the
      // snapshot has to carry those ticks itself.
      await waitForWritesToSettle();

      const writers: Writer[] = Array.from({ length: 3 }, () => openWriterClient());
      let stop = false;
      let writeCount = 0;
      const writerErrors: unknown[] = [];
      const touched = new Set<string>();

      /** The lock the Aurora pull takes: twin rows are written under it in production. */
      const takeUserTickLock = async (transaction: postgres.TransactionSql): Promise<void> => {
        await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${CLIMBER_A}, 1414087499::bigint))`;
      };

      async function writeLoop(writer: Writer): Promise<void> {
        while (!stop) {
          const action = randomInt(8);
          const target = [...live][randomInt(live.size)];
          if (target) touched.add(target);
          try {
            if (action === 5) {
              const uuids = [uniqueId('r-twin'), uniqueId('r-twin')];
              const instant = `2026-05-02 ${String(randomInt(24)).padStart(2, '0')}:${String(randomInt(60)).padStart(2, '0')}:00`;
              const climb = `r-twin-climb-${randomInt(3)}`;
              await writer.begin(async (transaction) => {
                await takeUserTickLock(transaction);
                for (const uuid of uuids) {
                  await transaction`
                    INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, climbed_at, origin, aurora_id, aurora_type, updated_at, aurora_synced_at)
                    VALUES (${uuid}, ${CLIMBER_A}, ${BOARD}, ${climb}, ${ANGLE}, 'send', ${instant}, 'aurora_pull', ${uniqueId('aurora')}, 'ascents', ${instant}, ${instant})
                  `;
                }
              });
              twinUuids.push(...uuids);
            } else if (action === 6) {
              if (twinUuids.length > 0) {
                const [twin] = twinUuids.splice(randomInt(twinUuids.length), 1);
                await writer.begin(async (transaction) => {
                  await takeUserTickLock(transaction);
                  await transaction`DELETE FROM boardsesh_ticks WHERE uuid = ${twin}`;
                });
              }
            } else if (action === 7) {
              await writer`
                INSERT INTO board_climb_aliases (board_type, alias_uuid, canonical_uuid, source)
                VALUES (${BOARD}, ${mergeClimb}, ${mergeCanonical}, 'kilter')
                ON CONFLICT (board_type, alias_uuid) DO UPDATE SET canonical_uuid =
                  CASE WHEN board_climb_aliases.canonical_uuid = ${mergeCanonical} THEN ${mergeClimb} ELSE ${mergeCanonical} END
              `;
            } else if (action === 0 || !target) {
              const uuid = uniqueId('r-tick');
              live.add(uuid);
              await writer`
                INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, climbed_at)
                VALUES (${uuid}, ${CLIMBER_A}, ${BOARD}, ${climbs[randomInt(climbs.length)]}, ${ANGLE}, 'send', ${`2026-05-0${1 + randomInt(4)} 0${randomInt(10)}:00:00`})
              `;
            } else if (action === 1) {
              await writer`UPDATE boardsesh_ticks SET quality = ${1 + randomInt(5)} WHERE uuid = ${target}`;
            } else if (action === 2) {
              // Moves the row across the build's keyset, in both directions.
              await writer`UPDATE boardsesh_ticks SET climbed_at = ${`2026-05-01 ${String(randomInt(24)).padStart(2, '0')}:00:00`} WHERE uuid = ${target}`;
            } else if (action === 3) {
              live.delete(target);
              await writer`DELETE FROM boardsesh_ticks WHERE uuid = ${target}`;
            } else {
              // A long-ish transaction that interleaves with the build's chunks.
              await writer.begin(async (transaction) => {
                await transaction`UPDATE boardsesh_ticks SET attempt_count = ${2 + randomInt(9)} WHERE uuid = ${target}`;
                await delay(randomInt(40));
              });
            }
            writeCount += 1;
          } catch (error) {
            // A row deleted by a sibling writer is fine. Anything else fails the run.
            if (!/could not serialize|does not exist/.test(String(error))) writerErrors.push(error);
          }
        }
      }

      const writing = Promise.all(writers.map(writeLoop));
      await delay(60);

      const cursor = await startSnapshot();
      await buildChunkByChunk(BINDING, cursor, () => delay(1 + randomInt(10)));
      const { ticks, changeCursor } = await downloadSnapshot(BINDING, cursor);

      await delay(40);
      stop = true;
      await writing;
      expect(writerErrors).toEqual([]);
      expect(writeCount).toBeGreaterThan(30);

      // The snapshot alone, before any catch-up: every seeded tick no writer
      // touched is in it, value for value, wherever H landed.
      const copied = new Map(ticks.map((tick) => [tick.uuid, tick]));
      const databaseView = new Map((await publicLogbookView(CLIMBER_A)).map((tick) => [tick.uuid, tick]));
      const untouchedSeed = baseRows.map((row) => row.uuid).filter((uuid) => !touched.has(uuid));
      expect(untouchedSeed.length).toBeGreaterThan(100);
      for (const uuid of untouchedSeed) expect(copied.get(uuid)).toEqual(databaseView.get(uuid));

      const reader = new Map<string, LogbookFeedTick>();
      applyTo(reader, ticks);
      await catchUp(reader, CLIMBER_A, changeCursor);
      await expectReaderMatchesDatabase(reader, CLIMBER_A);
    }

    for (const offset of [0, 1, 2, 3, 4, 5]) {
      it(`matches the public logbook after concurrent writes (seed ${baseSeed + offset})`, async () => {
        await randomizedRun(baseSeed + offset);
      });
    }
  });
});

describe('bounded build', { timeout: 60_000 }, () => {
  it('copies full chunks, keeps the tick order, and counts every tick once', async () => {
    const uuids = await seedTicks(LOGBOOK_SNAPSHOT_CHUNK_TICKS * 2 + 3);
    const cursor = await startSnapshot();
    await buildChunkByChunk(BINDING, cursor);

    const chunks = await db
      .select({ chunkIndex: logbookSnapshotChunks.chunkIndex, ticks: logbookSnapshotChunks.ticks })
      .from(logbookSnapshotChunks)
      .where(eq(logbookSnapshotChunks.snapshotId, cursor.snapshotId))
      .orderBy(logbookSnapshotChunks.chunkIndex);
    expect(chunks.map((chunk) => chunk.ticks.length)).toEqual([
      LOGBOOK_SNAPSHOT_CHUNK_TICKS,
      LOGBOOK_SNAPSHOT_CHUNK_TICKS,
      3,
    ]);

    const [header] = await db.select().from(logbookSnapshots).where(eq(logbookSnapshots.id, cursor.snapshotId));
    expect(header).toMatchObject({ status: 'ready', tickCount: uuids.length, chunkCount: 3 });
    expect(new Set(chunks.flatMap((chunk) => chunk.ticks.map((tick) => tick.uuid))).size).toBe(uuids.length);
  });

  it('serves a page that starts inside a chunk and spans two', async () => {
    const uuids = await seedTicks(LOGBOOK_SNAPSHOT_CHUNK_TICKS + 20);
    const cursor = await startSnapshot();
    await buildChunkByChunk(BINDING, cursor);

    const { ticks } = await downloadSnapshot(BINDING, cursor, 150);
    expect(ticks.map((tick) => tick.uuid).sort()).toEqual([...uuids].sort());

    const spanning = await readLogbookSnapshotPage(db, {
      binding: BINDING,
      cursor: { snapshotId: cursor.snapshotId, position: LOGBOOK_SNAPSHOT_CHUNK_TICKS - 5 },
      limit: 10,
    });
    if (spanning.status !== 'ok') throw new Error('expected a page');
    expect(spanning.entries).toHaveLength(10);
  });

  it('makes one chunk of progress per call with no time budget and resumes where it stopped', async () => {
    await seedTicks(LOGBOOK_SNAPSHOT_CHUNK_TICKS * 2 + 1);
    const cursor = await startSnapshot();

    const first = await advanceLogbookSnapshotBuild(db, {
      binding: BINDING,
      snapshotId: cursor.snapshotId,
      timeBudgetMs: 0,
    });
    expect(first).toEqual({ status: 'building' });
    const [afterOne] = await db.select().from(logbookSnapshots).where(eq(logbookSnapshots.id, cursor.snapshotId));
    expect(afterOne.tickCount).toBe(LOGBOOK_SNAPSHOT_CHUNK_TICKS);
    expect(afterOne.chunkCount).toBe(1);

    // A page requested mid-build is refused rather than served partially.
    expect(await readLogbookSnapshotPage(db, { binding: BINDING, cursor, limit: 10 })).toEqual({ status: 'building' });

    await buildChunkByChunk(BINDING, cursor);
    const [finished] = await db.select().from(logbookSnapshots).where(eq(logbookSnapshots.id, cursor.snapshotId));
    expect(finished).toMatchObject({ status: 'ready', tickCount: LOGBOOK_SNAPSHOT_CHUNK_TICKS * 2 + 1 });
  });

  it('lets only one of two concurrent builders write each chunk', async () => {
    const uuids = await seedTicks(LOGBOOK_SNAPSHOT_CHUNK_TICKS * 3);
    const cursor = await startSnapshot();

    const advance = () =>
      advanceLogbookSnapshotBuild(db, { binding: BINDING, snapshotId: cursor.snapshotId, timeBudgetMs: 50 });
    let finished = false;
    while (!finished) {
      const results = await Promise.all([advance(), advance(), advance()]);
      finished = results.some((result) => result.status === 'ready');
    }

    const chunks = await db
      .select({ ticks: logbookSnapshotChunks.ticks })
      .from(logbookSnapshotChunks)
      .where(eq(logbookSnapshotChunks.snapshotId, cursor.snapshotId));
    const copied = chunks.flatMap((chunk) => chunk.ticks.map((tick) => tick.uuid));
    expect(copied).toHaveLength(uuids.length);
    expect(new Set(copied).size).toBe(uuids.length);
  });

  it('stops at once when another caller holds the row, without writing or spinning', async () => {
    await seedTicks(LOGBOOK_SNAPSHOT_CHUNK_TICKS + 1);
    const cursor = await startSnapshot();
    const holder = await openWriterClient().reserve();
    await holder`BEGIN`;
    await holder`SELECT 1 FROM logbook_snapshots WHERE id = ${cursor.snapshotId} FOR NO KEY UPDATE`;

    try {
      const startedAt = Date.now();
      const progress = await advanceLogbookSnapshotBuild(db, {
        binding: BINDING,
        snapshotId: cursor.snapshotId,
        timeBudgetMs: 8_000,
      });
      expect(progress).toEqual({ status: 'building' });
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(await db.select().from(logbookSnapshotChunks)).toHaveLength(0);
    } finally {
      await holder`ROLLBACK`;
      holder.release();
    }
  });

  it('answers too_large rather than truncating, and keeps refusing a restart until the verdict expires', async () => {
    await seedTicks(LOGBOOK_SNAPSHOT_CHUNK_TICKS + 1);
    const cursor = await startSnapshot();

    const first = await advanceLogbookSnapshotBuild(db, {
      binding: BINDING,
      snapshotId: cursor.snapshotId,
      timeBudgetMs: 0,
      maxTicks: LOGBOOK_SNAPSHOT_CHUNK_TICKS,
    });
    expect(first).toEqual({ status: 'building' });
    const second = await advanceLogbookSnapshotBuild(db, {
      binding: BINDING,
      snapshotId: cursor.snapshotId,
      timeBudgetMs: 0,
      maxTicks: LOGBOOK_SNAPSHOT_CHUNK_TICKS,
    });
    expect(second).toEqual({ status: 'too_large' });
    // Terminal, with the seconds until the one-hour verdict lapses.
    const verdictSeconds = expect.toSatisfy((seconds: number) => seconds > 3500 && seconds <= 3600);
    expect(await readLogbookSnapshotPage(db, { binding: BINDING, cursor, limit: 10 })).toEqual({
      status: 'expired',
      reason: 'too_large',
      retryAfterSeconds: verdictSeconds,
    });

    expect(await startLogbookSnapshot(db, BINDING)).toEqual({
      status: 'unavailable',
      reason: 'too_large',
      retryAfterSeconds: verdictSeconds,
    });
    expect(await db.select().from(logbookSnapshots)).toHaveLength(1);
    expect(await secondsUntilExpiry(cursor)).toBeGreaterThan(3500);
    expect(await secondsUntilExpiry(cursor)).toBeLessThanOrEqual(3600);

    await db
      .update(logbookSnapshots)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(logbookSnapshots.id, cursor.snapshotId));
    const restarted = await startLogbookSnapshot(db, BINDING);
    expect(restarted).toMatchObject({ status: 'started', created: true });
  });

  it('gives a build its deadline at the start and the one-hour window only once it is ready', async () => {
    await seedTicks(LOGBOOK_SNAPSHOT_CHUNK_TICKS + 1);
    const cursor = await startSnapshot();
    // Literal on purpose: these are the promises in the docs, not the constants.
    expect(await secondsUntilExpiry(cursor)).toBeGreaterThan(3 * 3600 - 100);
    expect(await secondsUntilExpiry(cursor)).toBeLessThanOrEqual(3 * 3600);

    await buildChunkByChunk(BINDING, cursor);
    expect(await secondsUntilExpiry(cursor)).toBeGreaterThan(3600 - 100);
    expect(await secondsUntilExpiry(cursor)).toBeLessThanOrEqual(3600);
  });

  it('never moves H once the snapshot exists', async () => {
    await seedTicks(LOGBOOK_SNAPSHOT_CHUNK_TICKS + 1);
    const cursor = await startSnapshot();
    const [before] = await db.select({ horizon: logbookSnapshots.horizonTxid }).from(logbookSnapshots);
    await insertTick({ climbedAt: '2026-06-01 10:00:00' });
    await waitForWritesToSettle();

    await buildChunkByChunk(BINDING, cursor);

    const [after] = await db.select({ horizon: logbookSnapshots.horizonTxid }).from(logbookSnapshots);
    expect(after.horizon).toBe(before.horizon);
  });

  it('does not touch a finished snapshot when advance is called again', async () => {
    await seedTicks(5);
    const cursor = await startSnapshot();
    await buildChunkByChunk(BINDING, cursor);
    await insertTick({ climbedAt: '2026-07-01 10:00:00' });

    expect(
      await advanceLogbookSnapshotBuild(db, { binding: BINDING, snapshotId: cursor.snapshotId, timeBudgetMs: 0 }),
    ).toEqual({ status: 'ready' });

    const [header] = await db.select().from(logbookSnapshots);
    expect(header).toMatchObject({ status: 'ready', tickCount: 5, chunkCount: 1 });
    expect(await db.select().from(logbookSnapshotChunks)).toHaveLength(1);
  });

  it('copies nothing while every build slot is taken and carries on when one frees up', async () => {
    await seedTicks(LOGBOOK_SNAPSHOT_CHUNK_TICKS + 1);
    const cursor = await startSnapshot();
    const holder = await openWriterClient().reserve();
    try {
      // Literal on purpose: two slots is the promise, not whatever the constant says.
      for (const slot of [0, 1]) {
        await holder`SELECT pg_advisory_lock(${LOGBOOK_SNAPSHOT_BUILD_SLOT_LOCK_CLASS}::int, ${slot}::int)`;
      }
      expect(
        await advanceLogbookSnapshotBuild(db, { binding: BINDING, snapshotId: cursor.snapshotId, timeBudgetMs: 0 }),
      ).toEqual({ status: 'building' });
      expect(await db.select().from(logbookSnapshotChunks)).toHaveLength(0);

      await holder`SELECT pg_advisory_unlock(${LOGBOOK_SNAPSHOT_BUILD_SLOT_LOCK_CLASS}::int, 0::int)`;
      expect(
        await advanceLogbookSnapshotBuild(db, { binding: BINDING, snapshotId: cursor.snapshotId, timeBudgetMs: 0 }),
      ).toEqual({ status: 'building' });
      expect(await db.select().from(logbookSnapshotChunks)).toHaveLength(1);
    } finally {
      await holder`SELECT pg_advisory_unlock_all()`;
      holder.release();
    }
  });

  it('stops copying at the storage cap and picks up again once there is room', async () => {
    await seedTicks(LOGBOOK_SNAPSHOT_CHUNK_TICKS + 1);
    const cursor = await startSnapshot();
    const advanceWithCap = (maxStoredTicks: number) =>
      advanceLogbookSnapshotBuild(db, {
        binding: BINDING,
        snapshotId: cursor.snapshotId,
        timeBudgetMs: 0,
        maxStoredTicks,
      });

    expect(await advanceWithCap(LOGBOOK_SNAPSHOT_CHUNK_TICKS)).toEqual({ status: 'building' });
    expect(await advanceWithCap(LOGBOOK_SNAPSHOT_CHUNK_TICKS)).toEqual({ status: 'building' });
    expect(await db.select().from(logbookSnapshotChunks)).toHaveLength(1);

    expect(await advanceWithCap(LOGBOOK_SNAPSHOT_CHUNK_TICKS * 10)).toEqual({ status: 'ready' });
    expect(await db.select().from(logbookSnapshotChunks)).toHaveLength(2);
  });

  it('runs each chunk under its timeouts and with the join plan that keeps it bounded', async () => {
    await seedTicks(3);
    const cursor = await startSnapshot();

    type TransactionSettings = {
      statement_timeout: string;
      lock_timeout: string;
      idle_in_transaction_session_timeout: string;
      enable_mergejoin: string;
      enable_hashjoin: string;
    };
    const observed: TransactionSettings[] = [];
    const observingDatabase = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'transaction') return Reflect.get(target, property, receiver);
        return async (
          callback: Parameters<typeof db.transaction>[0],
          config?: Parameters<typeof db.transaction>[1],
        ): Promise<unknown> =>
          target.transaction(async (transaction) => {
            const result = await callback(transaction);
            const [settings] = (await transaction.execute(sql`
              SELECT current_setting('statement_timeout') AS statement_timeout,
                     current_setting('lock_timeout') AS lock_timeout,
                     current_setting('idle_in_transaction_session_timeout') AS idle_in_transaction_session_timeout,
                     current_setting('enable_mergejoin') AS enable_mergejoin,
                     current_setting('enable_hashjoin') AS enable_hashjoin
            `)) as unknown as TransactionSettings[];
            observed.push(settings);
            return result;
          }, config);
      },
    });

    await advanceLogbookSnapshotBuild(observingDatabase, {
      binding: BINDING,
      snapshotId: cursor.snapshotId,
      timeBudgetMs: 0,
    });

    expect(observed).toEqual([
      {
        statement_timeout: '5s',
        lock_timeout: '2s',
        idle_in_transaction_session_timeout: '10s',
        enable_mergejoin: 'off',
        enable_hashjoin: 'off',
      },
    ]);
  });

  it('leaves nothing behind on the pooled connection when a chunk commits', async () => {
    await seedTicks(3);
    const cursor = await startSnapshot();
    await buildChunkByChunk(BINDING, cursor);

    // More statements at once than the pool has connections, so every one is sampled.
    const settingsOfEveryConnection = await Promise.all(
      Array.from(
        { length: 24 },
        () =>
          db.execute(sql`
            SELECT current_setting('statement_timeout') AS statement_timeout,
                   current_setting('lock_timeout') AS lock_timeout,
                   current_setting('idle_in_transaction_session_timeout') AS idle_in_transaction_session_timeout,
                   current_setting('enable_mergejoin') AS enable_mergejoin,
                   current_setting('enable_hashjoin') AS enable_hashjoin,
                   pg_sleep(0.05)
          `) as unknown as Promise<Array<Record<string, string>>>,
      ),
    );
    for (const [settings] of settingsOfEveryConnection) {
      expect(settings).toMatchObject({
        statement_timeout: '0',
        lock_timeout: '0',
        idle_in_transaction_session_timeout: '0',
        enable_mergejoin: 'on',
        enable_hashjoin: 'on',
      });
    }
  });

  it('bounds the start transaction by the same timeouts, and answers busy', async () => {
    const holder = await openWriterClient().reserve();
    try {
      await holder`SELECT pg_advisory_lock(hashtextextended(${BINDING.connectionId}, ${LOGBOOK_SNAPSHOT_START_LOCK_SEED}::bigint))`;
      // Bounded so a start that waited forever fails this test, not the run.
      const outcome = await Promise.race([
        startLogbookSnapshot(db, BINDING),
        delay(4_000).then(() => 'still waiting' as const),
      ]);
      expect(outcome).toEqual({ status: 'unavailable', reason: 'busy' });
    } finally {
      await holder`SELECT pg_advisory_unlock_all()`;
      holder.release();
    }
  });

  it('answers busy when a chunk is holding the row a restart needs to retire', async () => {
    const old = await startSnapshot();
    const holder = await openWriterClient().reserve();
    try {
      await holder`BEGIN`;
      await holder`SELECT 1 FROM logbook_snapshots WHERE id = ${old.snapshotId} FOR NO KEY UPDATE`;
      const outcome = await Promise.race([
        startLogbookSnapshot(db, { ...BINDING, connectionGeneration: 1 }),
        delay(4_000).then(() => 'still waiting' as const),
      ]);
      expect(outcome).toEqual({ status: 'unavailable', reason: 'busy' });
    } finally {
      await holder`ROLLBACK`;
      holder.release();
    }
    const [row] = await db.select().from(logbookSnapshots).where(eq(logbookSnapshots.id, old.snapshotId));
    expect(row.status).toBe('building');
  });

  it('copies in (updated_at, id) order, which the index serves without reading a timestamp group whole', async () => {
    const copiedSecond = await insertTick({ updatedAt: '2026-01-02 00:00:00', climbedAt: '2026-01-01 00:00:00' });
    const copiedFirst = await insertTick({ updatedAt: '2026-01-01 00:00:00', climbedAt: '2026-06-01 00:00:00' });
    const cursor = await startSnapshot();
    await buildChunkByChunk(BINDING, cursor);
    const { ticks } = await downloadSnapshot(BINDING, cursor);
    expect(ticks.map((tick) => tick.uuid)).toEqual([copiedFirst, copiedSecond]);
  });

  it('answers building when the step cannot get its lock, and resumes on the next call', async () => {
    await seedTicks(3);
    const cursor = await startSnapshot();
    const holder = await openWriterClient().reserve();
    try {
      await holder`BEGIN`;
      await holder`LOCK TABLE boardsesh_ticks IN ACCESS EXCLUSIVE MODE`;
      // Bounded so a step that waited forever fails this test, not the run.
      const outcome = await Promise.race([
        advanceLogbookSnapshotBuild(db, { binding: BINDING, snapshotId: cursor.snapshotId, timeBudgetMs: 0 }),
        delay(8_000).then(() => 'still waiting' as const),
      ]);
      expect(outcome).toEqual({ status: 'building' });
      expect(await db.select().from(logbookSnapshotChunks)).toHaveLength(0);
    } finally {
      await holder`ROLLBACK`;
      holder.release();
    }
    // A blocked lock says nothing about the chunk, so it does not count.
    expect((await db.select().from(logbookSnapshots))[0].chunkTimeoutStreak).toBe(0);
    await buildChunkByChunk(BINDING, cursor);
    expect((await db.select().from(logbookSnapshots))[0].status).toBe('ready');
  });

  describe('a chunk that keeps timing out', () => {
    function failingDatabase(error: unknown): typeof db {
      return new Proxy(db, {
        get(target, property, receiver) {
          if (property === 'transaction') return () => Promise.reject(error);
          return Reflect.get(target, property, receiver);
        },
      });
    }
    const statementTimeout = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    });
    const advanceThrough = (database: typeof db, cursor: LogbookSnapshotCursor) =>
      advanceLogbookSnapshotBuild(database, { binding: BINDING, snapshotId: cursor.snapshotId, timeBudgetMs: 0 });
    const snapshotRow = async (cursor: LogbookSnapshotCursor) => {
      const [row] = await db.select().from(logbookSnapshots).where(eq(logbookSnapshots.id, cursor.snapshotId));
      return row;
    };
    const clearCooldown = (cursor: LogbookSnapshotCursor) =>
      db
        .update(logbookSnapshots)
        .set({ retryNotBefore: sql`now() - interval '1 second'` })
        .where(eq(logbookSnapshots.id, cursor.snapshotId));

    it('counts the timeout, reports no progress, and surfaces any other failure', async () => {
      await seedTicks(3);
      const cursor = await startSnapshot();

      expect(await advanceThrough(failingDatabase(statementTimeout), cursor)).toEqual({ status: 'building' });
      expect((await snapshotRow(cursor)).chunkTimeoutStreak).toBe(1);

      const brokenConstraint = Object.assign(new Error('boom'), { code: '23505' });
      await expect(advanceThrough(failingDatabase(brokenConstraint), cursor)).rejects.toBe(brokenConstraint);
      expect((await snapshotRow(cursor)).chunkTimeoutStreak).toBe(1);
    });

    it('logs the timeout with the snapshot id and no climber data', async () => {
      await seedTicks(3);
      const cursor = await startSnapshot();
      const warn = vi.spyOn(logger, 'warn');
      try {
        await advanceThrough(failingDatabase(statementTimeout), cursor);
        const logged = warn.mock.calls.map((call) => call as unknown as [string, Record<string, unknown>]);
        const timeoutLine = logged.find(([text]) => text.includes('statement timeout'));
        expect(timeoutLine?.[1]).toEqual({ snapshotId: cursor.snapshotId, timeoutStreak: 1, stalled: false });
        expect(JSON.stringify(timeoutLine)).not.toContain(BINDING.userId);
        expect(JSON.stringify(timeoutLine)).not.toContain(BINDING.connectionId);
      } finally {
        warn.mockRestore();
      }
    });

    it('sits out a short cooldown, then copies, and a copied chunk clears the streak', async () => {
      await seedTicks(3);
      const cursor = await startSnapshot();
      await advanceThrough(failingDatabase(statementTimeout), cursor);
      await clearCooldown(cursor);
      await advanceThrough(failingDatabase(statementTimeout), cursor);

      const [{ seconds }] = (await db.execute(
        sql`SELECT extract(epoch FROM retry_not_before - now())::float8 AS seconds FROM logbook_snapshots WHERE id = ${cursor.snapshotId}::uuid`,
      )) as unknown as Array<{ seconds: number }>;
      expect(Number(seconds)).toBeGreaterThan(0);
      expect(Number(seconds)).toBeLessThanOrEqual(5);

      expect(await advanceThrough(db, cursor)).toEqual({ status: 'building' });
      expect(await db.select().from(logbookSnapshotChunks)).toHaveLength(0);
      expect((await snapshotRow(cursor)).chunkTimeoutStreak).toBe(2);

      await clearCooldown(cursor);
      expect(await advanceThrough(db, cursor)).toEqual({ status: 'ready' });
      const row = await snapshotRow(cursor);
      expect(row.chunkTimeoutStreak).toBe(0);
      expect(row.retryNotBefore).toBeNull();
    });

    it('ends the build as stalled on the twentieth timeout in a row, and refuses a restart until that expires', async () => {
      await seedTicks(3);
      const cursor = await startSnapshot();
      const timingOut = failingDatabase(statementTimeout);

      for (let attempt = 1; attempt < 20; attempt += 1) {
        expect(await advanceThrough(timingOut, cursor)).toEqual({ status: 'building' });
      }
      expect((await snapshotRow(cursor)).status).toBe('building');
      expect(await advanceThrough(timingOut, cursor)).toEqual({ status: 'stalled' });

      expect((await snapshotRow(cursor)).status).toBe('stalled');
      expect(await secondsUntilExpiry(cursor)).toBeGreaterThan(3500);
      expect(await secondsUntilExpiry(cursor)).toBeLessThanOrEqual(3600);
      await clearCooldown(cursor);
      expect(await advanceThrough(db, cursor)).toEqual({ status: 'stalled' });
      expect(await db.select().from(logbookSnapshotChunks)).toHaveLength(0);
      const verdictSeconds = expect.toSatisfy((seconds: number) => seconds > 3500 && seconds <= 3600);
      expect(await readLogbookSnapshotPage(db, { binding: BINDING, cursor, limit: 10 })).toEqual({
        status: 'expired',
        reason: 'stalled',
        retryAfterSeconds: verdictSeconds,
      });
      expect(await startLogbookSnapshot(db, BINDING)).toEqual({
        status: 'unavailable',
        reason: 'stalled',
        retryAfterSeconds: verdictSeconds,
      });
      expect(await db.select().from(logbookSnapshots)).toHaveLength(1);

      await db
        .update(logbookSnapshots)
        .set({ expiresAt: sql`now() - interval '1 second'` })
        .where(eq(logbookSnapshots.id, cursor.snapshotId));
      expect(await startLogbookSnapshot(db, BINDING)).toMatchObject({ status: 'started', created: true });
    });
  });

  it('holds no transaction open between chunks', async () => {
    await seedTicks(LOGBOOK_SNAPSHOT_CHUNK_TICKS * 2 + 1);
    const cursor = await startSnapshot();
    const observations: string[] = [];
    await buildChunkByChunk(BINDING, cursor, async () => {
      const inTransaction = (await db.execute(sql`
        SELECT count(*)::int AS count FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
           AND state LIKE 'idle in transaction%'
      `)) as unknown as Array<{ count: number }>;
      observations.push(String(inTransaction[0].count));
    });
    expect(observations.length).toBeGreaterThan(0);
    expect(observations.every((count) => count === '0')).toBe(true);
  });
});

describe('starting snapshots', { timeout: 60_000 }, () => {
  it('says whether it created a snapshot or joined the build already running', async () => {
    await seedTicks(LOGBOOK_SNAPSHOT_CHUNK_TICKS + 1);
    const first = await startLogbookSnapshot(db, BINDING);
    expect(first).toMatchObject({ status: 'started', created: true });
    const second = await startLogbookSnapshot(db, BINDING);
    expect(second).toMatchObject({ status: 'started', created: false });
    if (first.status !== 'started' || second.status !== 'started') throw new Error('expected both to start');
    expect(second.cursor.snapshotId).toBe(first.cursor.snapshotId);
    expect(await db.select().from(logbookSnapshots)).toHaveLength(1);
  });

  it('creates one snapshot when two requests start the same connection at once', async () => {
    const [left, right] = await Promise.all([startSnapshot(), startSnapshot()]);
    expect(right.snapshotId).toBe(left.snapshotId);
    expect(await db.select().from(logbookSnapshots)).toHaveLength(1);
  });

  it('joins a finished snapshot, so a second worker cannot destroy the first', async () => {
    await seedTicks(3);
    const first = await startSnapshot();
    await buildChunkByChunk(BINDING, first);

    const restarted = await startLogbookSnapshot(db, BINDING);
    expect(restarted).toMatchObject({ status: 'started', created: false, cursor: { snapshotId: first.snapshotId } });
    expect((await readLogbookSnapshotPage(db, { binding: BINDING, cursor: first, limit: 10 })).status).toBe('ok');
  });

  it('does not join a snapshot past its expiry, and retires it', async () => {
    const expired = await startSnapshot();
    await db
      .update(logbookSnapshots)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(logbookSnapshots.id, expired.snapshotId));

    const started = await startLogbookSnapshot(db, BINDING);
    expect(started).toMatchObject({ status: 'started', created: true });
    if (started.status !== 'started') throw new Error('expected a start');
    expect(started.cursor.snapshotId).not.toBe(expired.snapshotId);
    const [old] = await db.select().from(logbookSnapshots).where(eq(logbookSnapshots.id, expired.snapshotId));
    expect(old.status).toBe('retired');
  });

  it('does not join a snapshot bound to an earlier connection generation', async () => {
    const old = await startSnapshot();
    const reconnected = { ...BINDING, connectionGeneration: 1 };

    const started = await startLogbookSnapshot(db, reconnected);
    expect(started).toMatchObject({ status: 'started', created: true });
    if (started.status !== 'started') throw new Error('expected a start');
    expect(started.cursor.snapshotId).not.toBe(old.snapshotId);
    const [row] = await db.select().from(logbookSnapshots).where(eq(logbookSnapshots.id, old.snapshotId));
    expect(row.status).toBe('retired');
  });

  it('retires a running build from a rotated feed generation and starts a fresh one', async () => {
    await seedTicks(LOGBOOK_SNAPSHOT_CHUNK_TICKS + 1);
    const stale = await startSnapshot();
    await advanceLogbookSnapshotBuild(db, { binding: BINDING, snapshotId: stale.snapshotId, timeBudgetMs: 0 });
    await db.update(logbookChangeWatermark).set({ feedGeneration: '00000000-0000-4000-8000-0000000000bb' });
    try {
      expect(await readLogbookSnapshotPage(db, { binding: BINDING, cursor: stale, limit: 5 })).toEqual({
        status: 'expired',
        reason: 'generation_mismatch',
      });

      const started = await startLogbookSnapshot(db, BINDING);
      expect(started).toMatchObject({ status: 'started', created: true });
      if (started.status !== 'started') throw new Error('expected a start');
      expect(started.cursor.snapshotId).not.toBe(stale.snapshotId);

      await buildChunkByChunk(BINDING, started.cursor);
      expect((await readLogbookSnapshotPage(db, { binding: BINDING, cursor: started.cursor, limit: 5 })).status).toBe(
        'ok',
      );
    } finally {
      await db.update(logbookChangeWatermark).set({ feedGeneration: sql`gen_random_uuid()` });
    }
  });

  it('does not join a snapshot whose catch-up history was pruned', async () => {
    const stale = await startSnapshot();
    const [{ horizon }] = await db.select({ horizon: logbookSnapshots.horizonTxid }).from(logbookSnapshots);
    await waitForWritesToSettle();
    await db
      .update(logbookChangeWatermark)
      .set({ prunedThroughTxid: (BigInt(horizon) + 1n).toString(), prunedThroughSeq: 0n });

    const started = await startLogbookSnapshot(db, BINDING);
    expect(started).toMatchObject({ status: 'started', created: true });
    if (started.status !== 'started') throw new Error('expected a start');
    expect(started.cursor.snapshotId).not.toBe(stale.snapshotId);
  });

  it('still joins when creation is not allowed, and refuses only what would create', async () => {
    await seedTicks(2);
    const cursor = await startSnapshot();
    expect(await startLogbookSnapshot(db, BINDING, { createAllowed: false })).toEqual({
      status: 'started',
      cursor: { snapshotId: cursor.snapshotId, position: 0 },
      created: false,
    });
    expect(await startLogbookSnapshot(db, { ...BINDING, connectionGeneration: 1 }, { createAllowed: false })).toEqual({
      status: 'unavailable',
      reason: 'creation_limited',
    });
    const [row] = await db.select().from(logbookSnapshots);
    expect(row.status).toBe('building');
    expect(await db.select().from(logbookSnapshots)).toHaveLength(1);
  });

  it('allows one active build per connection in the database, not just in the code', async () => {
    await startSnapshot();
    await expect(
      db.insert(logbookSnapshots).values({
        userId: CLIMBER_A,
        connectionId: BINDING.connectionId,
        connectionGeneration: 0,
        feedGeneration: '00000000-0000-4000-8000-000000000000',
        horizonTxid: '1',
        expiresAt: sql`now() + interval '1 hour'`,
      }),
    ).rejects.toThrow();
  });

  it('leaves the old snapshot alone when a new one is refused for capacity', async () => {
    await seedTicks(5);
    const old = await startSnapshot();
    await buildChunkByChunk(BINDING, old);

    const refused = await startLogbookSnapshot(db, { ...BINDING, connectionGeneration: 1 }, { maxStoredTicks: 5 });
    expect(refused).toEqual({ status: 'unavailable', reason: 'capacity' });

    const [row] = await db.select().from(logbookSnapshots).where(eq(logbookSnapshots.id, old.snapshotId));
    expect(row.status).toBe('ready');
    expect(await secondsUntilExpiry(old)).toBeGreaterThan(0);
  });

  it('refuses a new build once stored ticks reach the cap', async () => {
    await seedTicks(5);
    const cursor = await startSnapshot();
    await buildChunkByChunk(BINDING, cursor);
    expect(
      await startLogbookSnapshot(
        db,
        { userId: CLIMBER_B, connectionId: 'connection-b', connectionGeneration: 0 },
        { maxStoredTicks: 5 },
      ),
    ).toEqual({ status: 'unavailable', reason: 'capacity' });
  });
});

describe('expiry and reclaim', { timeout: 60_000 }, () => {
  async function buildExpiredSnapshot(binding: LogbookSnapshotBinding = BINDING): Promise<LogbookSnapshotCursor> {
    const cursor = await startSnapshot(binding);
    await buildChunkByChunk(binding, cursor);
    await db
      .update(logbookSnapshots)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(logbookSnapshots.id, cursor.snapshotId));
    return cursor;
  }

  it('is unreadable once expired even if the reclaim job has not run', async () => {
    await seedTicks(3);
    const cursor = await startSnapshot();
    await buildChunkByChunk(BINDING, cursor);
    expect((await readLogbookSnapshotPage(db, { binding: BINDING, cursor, limit: 10 })).status).toBe('ok');

    await db
      .update(logbookSnapshots)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(logbookSnapshots.id, cursor.snapshotId));

    expect(await readLogbookSnapshotPage(db, { binding: BINDING, cursor, limit: 10 })).toEqual({
      status: 'expired',
      reason: 'snapshot_not_found',
    });
    expect(await db.select().from(logbookSnapshots)).toHaveLength(1);
  });

  it('stops a build that has passed its expiry', async () => {
    await seedTicks(LOGBOOK_SNAPSHOT_CHUNK_TICKS + 1);
    const cursor = await startSnapshot();
    await db
      .update(logbookSnapshots)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(logbookSnapshots.id, cursor.snapshotId));
    expect(
      await advanceLogbookSnapshotBuild(db, { binding: BINDING, snapshotId: cursor.snapshotId, timeBudgetMs: 0 }),
    ).toEqual({ status: 'expired' });
  });

  it('reclaims expired snapshots and their chunks, leaves live ones, and is safe to repeat', async () => {
    await seedTicks(LOGBOOK_SNAPSHOT_CHUNK_TICKS + 1);
    const liveCursor = await startSnapshot({
      userId: CLIMBER_A,
      connectionId: 'live-connection',
      connectionGeneration: 0,
    });
    await buildChunkByChunk(
      { userId: CLIMBER_A, connectionId: 'live-connection', connectionGeneration: 0 },
      liveCursor,
    );
    await buildExpiredSnapshot({ userId: CLIMBER_A, connectionId: 'expired-connection', connectionGeneration: 0 });

    const first = await reclaimExpiredLogbookSnapshots((callback) => db.transaction(callback));
    expect(first).toEqual({ snapshotsRemoved: 1, chunksRemoved: 2, capped: false });

    const remaining = await db.select({ id: logbookSnapshots.id }).from(logbookSnapshots);
    expect(remaining.map((row) => row.id)).toEqual([liveCursor.snapshotId]);
    expect(await db.select({ count: sql<number>`count(*)::int` }).from(logbookSnapshotChunks)).toEqual([{ count: 2 }]);

    const second = await reclaimExpiredLogbookSnapshots((callback) => db.transaction(callback));
    expect(second).toEqual({ snapshotsRemoved: 0, chunksRemoved: 0, capped: false });
  });

  it('stops at its batch cap and leaves the rest for the next run', async () => {
    await seedTicks(1);
    for (let index = 0; index < 3; index += 1) {
      await buildExpiredSnapshot({ userId: CLIMBER_A, connectionId: `expired-${index}`, connectionGeneration: 0 });
    }

    expect(
      await reclaimExpiredLogbookSnapshots((callback) => db.transaction(callback), {
        maxBatches: 2,
        snapshotsPerBatch: 1,
      }),
    ).toEqual({
      snapshotsRemoved: 2,
      chunksRemoved: 2,
      capped: true,
    });
    expect(await db.select().from(logbookSnapshots)).toHaveLength(1);
    expect(await reclaimExpiredLogbookSnapshots((callback) => db.transaction(callback))).toEqual({
      snapshotsRemoved: 1,
      chunksRemoved: 1,
      capped: false,
    });
  });

  it('removes several small snapshots in one transaction', async () => {
    await seedTicks(1);
    for (let index = 0; index < 5; index += 1) {
      await buildExpiredSnapshot({ userId: CLIMBER_A, connectionId: `small-${index}`, connectionGeneration: 0 });
    }

    expect(await reclaimExpiredLogbookSnapshots((callback) => db.transaction(callback), { maxBatches: 1 })).toEqual({
      snapshotsRemoved: 5,
      chunksRemoved: 5,
      capped: true,
    });
    expect(await db.select().from(logbookSnapshots)).toHaveLength(0);
  });

  it('keeps a snapshot until its last chunk is gone when it spans batches', async () => {
    await seedTicks(LOGBOOK_SNAPSHOT_CHUNK_TICKS + 1);
    await buildExpiredSnapshot();

    expect(
      await reclaimExpiredLogbookSnapshots((callback) => db.transaction(callback), {
        maxBatches: 1,
        chunksPerBatch: 1,
      }),
    ).toEqual({ snapshotsRemoved: 0, chunksRemoved: 1, capped: true });
    expect(await db.select().from(logbookSnapshots)).toHaveLength(1);
    expect(await db.select().from(logbookSnapshotChunks)).toHaveLength(1);

    expect(await reclaimExpiredLogbookSnapshots((callback) => db.transaction(callback))).toEqual({
      snapshotsRemoved: 1,
      chunksRemoved: 1,
      capped: false,
    });
    expect(await db.select().from(logbookSnapshots)).toHaveLength(0);
  });

  it('reclaims a replaced snapshot on the next run rather than after its hour', async () => {
    await seedTicks(3);
    const old = await startSnapshot();
    await buildChunkByChunk(BINDING, old);
    const fresh = await startSnapshot({ ...BINDING, connectionGeneration: 1 });

    const [row] = await db.select().from(logbookSnapshots).where(eq(logbookSnapshots.id, old.snapshotId));
    expect(row.status).toBe('retired');
    expect(await secondsUntilExpiry(old)).toBeLessThanOrEqual(0);

    expect(await reclaimExpiredLogbookSnapshots((callback) => db.transaction(callback))).toMatchObject({
      snapshotsRemoved: 1,
    });
    expect(
      (await db.select({ id: logbookSnapshots.id }).from(logbookSnapshots)).map((snapshot) => snapshot.id),
    ).toEqual([fresh.snapshotId]);
  });

  it('never serves a retired row, even one still inside its window', async () => {
    await seedTicks(3);
    const cursor = await startSnapshot();
    await buildChunkByChunk(BINDING, cursor);
    await db.update(logbookSnapshots).set({ status: 'retired' }).where(eq(logbookSnapshots.id, cursor.snapshotId));

    expect(await readLogbookSnapshotPage(db, { binding: BINDING, cursor, limit: 10 })).toEqual({
      status: 'expired',
      reason: 'snapshot_not_found',
    });
  });

  it('is safe with two workers running at once', async () => {
    await seedTicks(1);
    for (let index = 0; index < 8; index += 1) {
      await buildExpiredSnapshot({ userId: CLIMBER_A, connectionId: `parallel-${index}`, connectionGeneration: 0 });
    }

    const [left, right] = await Promise.all([
      reclaimExpiredLogbookSnapshots((callback) => db.transaction(callback)),
      reclaimExpiredLogbookSnapshots((callback) => db.transaction(callback)),
    ]);

    expect(left.snapshotsRemoved + right.snapshotsRemoved).toBe(8);
    expect(await db.select().from(logbookSnapshots)).toHaveLength(0);
    expect(await db.select().from(logbookSnapshotChunks)).toHaveLength(0);
  });

  it('skips a row an in-flight build holds, without failing, and takes it on the next run', async () => {
    const cursor = await buildExpiredSnapshot();
    const holder = await openWriterClient().reserve();
    await holder`BEGIN`;
    await holder`SELECT 1 FROM logbook_snapshots WHERE id = ${cursor.snapshotId} FOR UPDATE`;

    // Bounded so a reclaim that waited on the lock fails this test, not the run,
    // and released in `finally` so a failure cannot block the next test's reset.
    let reclaimed: unknown;
    try {
      reclaimed = await Promise.race([
        reclaimExpiredLogbookSnapshots((callback) => db.transaction(callback)),
        delay(5_000).then(() => 'still waiting on the lock' as const),
      ]);
    } finally {
      await holder`ROLLBACK`;
      holder.release();
    }
    expect(reclaimed).toEqual({ snapshotsRemoved: 0, chunksRemoved: 0, capped: false });

    const taken = await reclaimExpiredLogbookSnapshots((callback) => db.transaction(callback));
    expect(taken.snapshotsRemoved).toBe(1);
  });
});

describe('privacy and binding', { timeout: 60_000 }, () => {
  it('refuses another climber, another app and an old connection generation', async () => {
    await seedTicks(2);
    const cursor = await startSnapshot();
    await buildChunkByChunk(BINDING, cursor);

    const expired = { status: 'expired', reason: 'snapshot_not_found' } as const;
    expect(await readLogbookSnapshotPage(db, { binding: { ...BINDING, userId: CLIMBER_B }, cursor, limit: 5 })).toEqual(
      expired,
    );
    expect(
      await readLogbookSnapshotPage(db, { binding: { ...BINDING, connectionId: 'another-app' }, cursor, limit: 5 }),
    ).toEqual(expired);
    expect(
      await readLogbookSnapshotPage(db, { binding: { ...BINDING, connectionGeneration: 1 }, cursor, limit: 5 }),
    ).toEqual(expired);
    expect((await readLogbookSnapshotPage(db, { binding: BINDING, cursor, limit: 5 })).status).toBe('ok');
  });

  it('refuses to build or join under another binding', async () => {
    await seedTicks(2);
    const cursor = await startSnapshot();
    expect(
      await advanceLogbookSnapshotBuild(db, {
        binding: { ...BINDING, connectionGeneration: 9 },
        snapshotId: cursor.snapshotId,
        timeBudgetMs: 0,
      }),
    ).toEqual({ status: 'expired' });
    const [row] = await db.select().from(logbookSnapshots);
    expect(row.status).toBe('building');
  });

  it('includes only-me ticks and hides twins, the same rules as the feed', async () => {
    const onlyMe = await insertTick({ climbUuid: 'climb-private', climbedAt: '2026-05-01 10:00:00' });
    await db
      .insert(contentPrivacy)
      .values({ entityType: 'tick', entityId: onlyMe, ownerId: CLIMBER_A, audience: 'only_me' });
    const survivor = await insertAuroraTick('aurora-a', { climbUuid: 'climb-twin', climbedAt: '2026-05-01 09:00:00' });
    const hiddenTwin = await insertAuroraTick('aurora-b', {
      climbUuid: 'climb-twin',
      climbedAt: '2026-05-01 09:00:00',
    });

    const cursor = await startSnapshot();
    await buildChunkByChunk(BINDING, cursor);
    const { ticks } = await downloadSnapshot(BINDING, cursor);

    expect(ticks.map((tick) => tick.uuid).sort()).toEqual([onlyMe, survivor].sort());
    expect(ticks.map((tick) => tick.uuid)).not.toContain(hiddenTwin);
  });

  it("never includes another climber's ticks", async () => {
    await seedTicks(3);
    await seedTicks(3, { userId: CLIMBER_B });
    const cursor = await startSnapshot();
    await buildChunkByChunk(BINDING, cursor);
    const { ticks } = await downloadSnapshot(BINDING, cursor);
    expect(ticks).toHaveLength(3);
    expect(new Set(ticks.map((tick) => tick.uuid)).size).toBe(3);
  });

  it('deletes a snapshot and its chunks when the account is deleted', async () => {
    await seedTicks(2);
    const cursor = await startSnapshot();
    await buildChunkByChunk(BINDING, cursor);
    expect(await db.select().from(logbookSnapshots)).toHaveLength(1);

    await db.delete(boardseshTicks).where(eq(boardseshTicks.userId, CLIMBER_A));
    await db.delete(users).where(eq(users.id, CLIMBER_A));

    expect(await db.select().from(logbookSnapshots)).toHaveLength(0);
    expect(await db.select().from(logbookSnapshotChunks)).toHaveLength(0);
  });

  it("deletes a connection's snapshots and chunks with its connection row, and leaves other connections' alone", async () => {
    await seedTicks(2);
    const other = { userId: CLIMBER_A, connectionId: 'connection-other-app', connectionGeneration: 0 };
    const kept = await startSnapshot(other);
    await buildChunkByChunk(other, kept);
    const cursor = await startSnapshot();
    await buildChunkByChunk(BINDING, cursor);
    expect(await db.select().from(logbookSnapshots)).toHaveLength(2);

    // What deleting the app or the connection does to the row.
    await db.delete(oauthConnections).where(eq(oauthConnections.id, BINDING.connectionId));

    const remaining = await db.select({ id: logbookSnapshots.id }).from(logbookSnapshots);
    expect(remaining.map((row) => row.id)).toEqual([kept.snapshotId]);
    const chunks = await db.select({ snapshotId: logbookSnapshotChunks.snapshotId }).from(logbookSnapshotChunks);
    expect(chunks.map((chunk) => chunk.snapshotId)).toEqual([kept.snapshotId]);
  });

  it('refuses a snapshot for a connection that does not exist', async () => {
    await seedTicks(1);
    const failure = await startLogbookSnapshot(db, {
      userId: CLIMBER_A,
      connectionId: 'no-such-connection',
      connectionGeneration: 0,
    }).catch((error: unknown) => error);
    expect(getPostgresErrorCode(failure)).toBe('23503');
  });

  it('expires a snapshot and the final cursor when the feed generation rotates', async () => {
    await seedTicks(2);
    const cursor = await startSnapshot();
    await buildChunkByChunk(BINDING, cursor);

    await db.update(logbookChangeWatermark).set({ feedGeneration: '00000000-0000-4000-8000-0000000000aa' });

    expect(await readLogbookSnapshotPage(db, { binding: BINDING, cursor, limit: 5 })).toEqual({
      status: 'expired',
      reason: 'generation_mismatch',
    });
    await db.update(logbookChangeWatermark).set({ feedGeneration: sql`gen_random_uuid()` });
  });

  it('expires a snapshot whose catch-up history was pruned during the download', async () => {
    await seedTicks(2);
    const cursor = await startSnapshot();
    await buildChunkByChunk(BINDING, cursor);

    await db.update(logbookChangeWatermark).set({ prunedThroughTxid: '9999999999999', prunedThroughSeq: 1n });

    expect(await readLogbookSnapshotPage(db, { binding: BINDING, cursor, limit: 5 })).toEqual({
      status: 'expired',
      reason: 'below_watermark',
    });
  });
});
