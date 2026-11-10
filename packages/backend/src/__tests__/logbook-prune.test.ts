import { afterAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import postgres from 'postgres';
import { boardClimbAliases, boardseshTicks, logbookChangeWatermark, logbookChanges } from '@boardsesh/db/schema';
import { db } from '../db/client';
import {
  LOGBOOK_FEED_ORIGIN,
  positionIsBefore,
  logbookFeedAliasJoin,
  logbookFeedTickColumns,
  logbookVisibleTicksFilter,
  readLogbookFeedPage,
  readLogbookFeedState,
  type LogbookFeedCursor,
  type LogbookFeedPage,
  type LogbookFeedPosition,
  type LogbookFeedTick,
} from '../services/logbook-feed';
import { pruneLogbookChanges, type BatchRunner, type LogbookPruneOptions } from '../services/logbook-prune';
import { getPostgresErrorCode } from '../utils/postgres-errors';
import { getWorkerDatabaseUrl } from './worker-db';

/**
 * The retention job behind the logbook feed's `410` (services/logbook-prune.ts,
 * docs/integration-platform.md "Retention, cursor validity and moving the
 * database"), against the real triggers and the real feed read.
 *
 * Remove a protection to prove these fail:
 * - the watermark update in the delete transaction: the old-cursor, in-flight
 *   page and randomized tests get a page with a gap instead of 410.
 * - the watermark update moved to a transaction of its own after the delete:
 *   the between-transactions test reads a page with a gap.
 * - the batch's highest position by `seq` alone: the out-of-feed-order batch
 *   leaves a deleted row above the watermark.
 * - the idle-in-transaction timeout: the bounds test.
 * - "never move the watermark back": the out-of-order test gets a page with a gap.
 * - the horizon check (`txid < xmin`): the open-transaction test deletes rows
 *   past the horizon and expires a current cursor.
 * - the 90-day check: the younger-row test deletes a row too young to go.
 * - SKIP LOCKED: the held-row test waits on the lock and fails the batch.
 */

const CLIMBER_A = 'prune-climber-a';
const CLIMBER_B = 'prune-climber-b';
const BOARD = 'kilter';

const clients: Array<ReturnType<typeof postgres>> = [];

function openClient(): ReturnType<typeof postgres> {
  const client = postgres(getWorkerDatabaseUrl(), { max: 1, onnotice: () => {} });
  clients.push(client);
  return client;
}

afterAll(async () => {
  await Promise.all(clients.map((client) => client.end({ timeout: 2 }).catch(() => {})));
});

let nextId = 0;
function uniqueId(prefix: string): string {
  nextId += 1;
  return `${prefix}-${process.pid}-${nextId}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** One tick in its own transaction, so each change row has its own txid. */
async function insertTick(userId = CLIMBER_A, overrides: Partial<typeof boardseshTicks.$inferInsert> = {}) {
  const uuid = uniqueId('tick');
  await db.insert(boardseshTicks).values({
    uuid,
    userId,
    boardType: BOARD,
    climbUuid: 'prune-climb',
    angle: 40,
    status: 'send',
    attemptCount: 1,
    climbedAt: '2026-05-01 18:22:37',
    ...overrides,
  });
  return uuid;
}

type ChangeRow = { seq: string; txid: string; tickUuid: string; userId: string };

async function changeRows(): Promise<ChangeRow[]> {
  return db
    .select({
      seq: sql<string>`${logbookChanges.seq}::text`,
      txid: sql<string>`${logbookChanges.txid}::text`,
      tickUuid: logbookChanges.tickUuid,
      userId: logbookChanges.userId,
    })
    .from(logbookChanges)
    .orderBy(asc(logbookChanges.seq));
}

const positionOf = (row: ChangeRow): LogbookFeedPosition => ({ txid: row.txid, seq: row.seq });

/** Makes change rows look `days` old, as if written then. */
async function ageChanges(where: SQL, days = 91): Promise<void> {
  await db
    .update(logbookChanges)
    .set({ createdAt: sql`localtimestamp - make_interval(days => ${days}::int)` })
    .where(where);
}

const ageRows = (rows: ChangeRow[], days = 91) =>
  ageChanges(
    inArray(
      logbookChanges.seq,
      rows.map((row) => BigInt(row.seq)),
    ),
    days,
  );

async function watermark(): Promise<LogbookFeedPosition> {
  const [state] = await db
    .select({
      txid: sql<string>`${logbookChangeWatermark.prunedThroughTxid}::text`,
      seq: sql<string>`${logbookChangeWatermark.prunedThroughSeq}::text`,
    })
    .from(logbookChangeWatermark);
  return state;
}

async function feedCursor(position: LogbookFeedPosition): Promise<LogbookFeedCursor> {
  const [row] = await db.select({ generation: logbookChangeWatermark.feedGeneration }).from(logbookChangeWatermark);
  return { generation: row.generation, ...position };
}

const prune = (options: LogbookPruneOptions = {}) =>
  pruneLogbookChanges(
    { read: (callback) => db.transaction(callback), runBatch: (callback) => db.transaction(callback) },
    options,
  );

/**
 * Waits until every write committed so far is below the cluster-wide horizon,
 * so a run is not stopped by another test file's open transaction.
 */
async function waitForWritesToSettle(): Promise<string> {
  const [fence] = (await db.execute(sql`SELECT pg_current_xact_id()::text AS txid`)) as unknown as Array<{
    txid: string;
  }>;
  const deadline = Date.now() + 60_000;
  for (;;) {
    const [snapshot] = (await db.execute(
      sql`SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS horizon`,
    )) as unknown as Array<{ horizon: string }>;
    if (BigInt(snapshot.horizon) > BigInt(fence.txid)) return fence.txid;
    if (Date.now() > deadline) throw new Error(`Horizon stuck at ${snapshot.horizon}, waiting for ${fence.txid}`);
    await delay(25);
  }
}

const tickIdsOf = (page: LogbookFeedPage) =>
  page.status === 'ok' ? page.entries.map((entry) => (entry.type === 'tick' ? entry.tick.uuid : entry.id)) : [];

const pageAt = (position: LogbookFeedPosition, limit = 50, userId = CLIMBER_A) =>
  feedCursor(position).then((cursor) => readLogbookFeedPage(db, { userId, cursor, limit }));

const EXPIRED = { status: 'expired', reason: 'below_watermark' };

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE logbook_changes, boardsesh_ticks, board_climb_aliases CASCADE`);
  await db
    .update(logbookChangeWatermark)
    .set({ prunedThroughTxid: '0', prunedThroughSeq: 0n, feedGeneration: sql`gen_random_uuid()` });
});

describe('pruning the logbook change log', { timeout: 90_000 }, () => {
  it('deletes rows older than 90 days and moves the watermark to the last one it deleted', async () => {
    const ticks: string[] = [];
    for (let index = 0; index < 5; index += 1) ticks.push(await insertTick());
    const rows = await changeRows();
    await ageRows(rows.slice(0, 3));
    await waitForWritesToSettle();

    const result = await prune();

    expect(result).toEqual({
      rowsDeleted: 3,
      batches: 1,
      prunedThrough: positionOf(rows[2]),
      stoppedBy: 'young_row',
    });
    expect((await changeRows()).map((row) => row.tickUuid)).toEqual(ticks.slice(3));
    // A second run finds nothing old enough and changes nothing.
    expect(await prune()).toEqual({ ...result, rowsDeleted: 0, batches: 0 });
  });

  it('keeps a row younger than 90 days, and stops at it even when older rows follow', async () => {
    for (let index = 0; index < 4; index += 1) await insertTick();
    const rows = await changeRows();
    await ageRows([rows[0], rows[2], rows[3]]);
    await ageRows([rows[1]], 89);
    await waitForWritesToSettle();

    expect(await prune()).toMatchObject({ rowsDeleted: 1, prunedThrough: positionOf(rows[0]), stoppedBy: 'young_row' });
    expect((await changeRows()).map((row) => row.seq)).toEqual(rows.slice(1).map((row) => row.seq));

    await ageRows([rows[1]]);
    expect(await prune()).toMatchObject({ rowsDeleted: 3, prunedThrough: positionOf(rows[3]), stoppedBy: 'caught_up' });
    expect(await changeRows()).toEqual([]);
  });

  it('answers 410 exactly below a non-zero watermark, and serves a cursor at it in full', async () => {
    const ticks: string[] = [];
    for (let index = 0; index < 5; index += 1) ticks.push(await insertTick());
    const rows = await changeRows();
    await ageRows(rows.slice(0, 3));
    await waitForWritesToSettle();
    await prune();
    const prunedThrough = await watermark();
    expect(prunedThrough).toEqual(positionOf(rows[2]));
    expect(BigInt(prunedThrough.txid)).toBeGreaterThan(0n);

    // At the watermark: everything after it, nothing missing.
    const atWatermark = await pageAt(prunedThrough);
    expect(atWatermark.status).toBe('ok');
    expect(tickIdsOf(atWatermark)).toEqual(ticks.slice(3));
    // One seq past it: still valid.
    const pastWatermark = await pageAt({ txid: prunedThrough.txid, seq: String(BigInt(prunedThrough.seq) + 1n) });
    expect(tickIdsOf(pastWatermark)).toEqual(ticks.slice(3));
    // One seq below it, the transaction before it, and the start: a row after each was deleted.
    expect(await pageAt({ txid: prunedThrough.txid, seq: String(BigInt(prunedThrough.seq) - 1n) })).toEqual(EXPIRED);
    expect(await pageAt({ txid: String(BigInt(prunedThrough.txid) - 1n), seq: '99999999' })).toEqual(EXPIRED);
    expect(await pageAt(positionOf(rows[1]))).toEqual(EXPIRED);
    expect(await pageAt(LOGBOOK_FEED_ORIGIN)).toEqual(EXPIRED);
  });

  it('answers 410 to a reader holding an old cursor, never a page with a gap', async () => {
    const ticks: string[] = [];
    for (let index = 0; index < 4; index += 1) ticks.push(await insertTick());
    await waitForWritesToSettle();
    // The reader stopped after the first change.
    const first = await pageAt(LOGBOOK_FEED_ORIGIN, 1);
    if (first.status !== 'ok') throw new Error('expired');
    expect(tickIdsOf(first)).toEqual([ticks[0]]);

    // The second change ages out while the reader is away.
    const rows = await changeRows();
    await ageRows(rows.slice(0, 2));
    await prune();

    expect(await pageAt(first.next)).toEqual(EXPIRED);
  });

  it('keeps a page read across a prune consistent, and its cursor then reads on in full or answers 410', async () => {
    const ticks: string[] = [];
    for (let index = 0; index < 6; index += 1) ticks.push(await insertTick());
    const rows = await changeRows();
    await ageRows(rows.slice(0, 4));
    await waitForWritesToSettle();

    /** Reads a page that stops inside its transaction until the prune has committed. */
    async function pageAcrossPrune(limit: number): Promise<LogbookFeedPage> {
      let inRead: () => void = () => {};
      const reachedRead = new Promise<void>((resolve) => {
        inRead = resolve;
      });
      let resume: () => void = () => {};
      const pruned = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const reading = readLogbookFeedPage(db, {
        userId: CLIMBER_A,
        cursor: await feedCursor(LOGBOOK_FEED_ORIGIN),
        limit,
        withinRead: async () => {
          inRead();
          await pruned;
        },
      });
      await reachedRead;
      expect((await prune()).rowsDeleted).toBeGreaterThan(0);
      resume();
      return reading;
    }

    // The page was read from the snapshot before the deletion, watermark included.
    const short = await pageAcrossPrune(2);
    if (short.status !== 'ok') throw new Error('expired');
    expect(tickIdsOf(short)).toEqual(ticks.slice(0, 2));
    // Its next position is below the new watermark: changes 3 and 4 are gone.
    expect(await pageAt(short.next)).toEqual(EXPIRED);

    // Again, with a page that ends exactly where the prune ended.
    await db.execute(sql`TRUNCATE TABLE logbook_changes`);
    await db.update(logbookChangeWatermark).set({ prunedThroughTxid: '0', prunedThroughSeq: 0n });
    for (const tickUuid of ticks) {
      await db.update(boardseshTicks).set({ comment: 'again' }).where(eq(boardseshTicks.uuid, tickUuid));
    }
    const again = await changeRows();
    await ageRows(again.slice(0, 4));
    await waitForWritesToSettle();
    const full = await pageAcrossPrune(4);
    if (full.status !== 'ok') throw new Error('expired');
    expect(full.next).toEqual(positionOf(again[3]));
    expect(await watermark()).toEqual(full.next);
    const rest = await pageAt(full.next);
    expect([...tickIdsOf(full), ...tickIdsOf(rest)]).toEqual(ticks);
  });

  it('never deletes at or past the horizon: an open write transaction keeps later rows and current cursors valid', async () => {
    const early = [await insertTick(), await insertTick()];
    await waitForWritesToSettle();

    // A write transaction that has its txid and stays open.
    const writer = openClient();
    let finish: () => void = () => {};
    const finishing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let started: () => void = () => {};
    const hasTxid = new Promise<void>((resolve) => {
      started = resolve;
    });
    const openUuid = uniqueId('tick');
    const open = writer.begin(async (transaction) => {
      await transaction`SELECT pg_current_xact_id()`;
      started();
      await finishing;
      await transaction`
        INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, attempt_count, climbed_at)
        VALUES (${openUuid}, ${CLIMBER_A}, ${BOARD}, 'prune-climb', 40, 'send', 1, '2026-05-01 18:22:37')`;
    });
    try {
      await hasTxid;
      const later = [await insertTick(), await insertTick()];
      const rows = await changeRows();
      await ageRows(rows);

      // A reader that has read everything below the horizon.
      const current = await pageAt(LOGBOOK_FEED_ORIGIN);
      if (current.status !== 'ok') throw new Error('expired');
      expect(tickIdsOf(current)).toEqual(early);

      const result = await prune();
      expect(result).toMatchObject({ rowsDeleted: 2, prunedThrough: positionOf(rows[1]), stoppedBy: 'unsettled_row' });
      expect((await changeRows()).map((row) => row.tickUuid)).toEqual(later);

      // That reader's cursor is still valid, and once the open transaction
      // commits it receives that change and both later ones.
      expect((await pageAt(current.next)).status).toBe('ok');
      finish();
      await open;
      await waitForWritesToSettle();
      const after = await pageAt(current.next);
      expect(new Set(tickIdsOf(after))).toEqual(new Set([openUuid, ...later]));
    } finally {
      finish();
      await open.catch(() => {});
    }
  });

  it('never moves the watermark back when a row it skipped ages out later', async () => {
    // Insertion order and feed order disagree: `younger` gets its txid first
    // but is written after `older`, so it sits below `older` in the feed.
    const writer = openClient();
    let written: () => void = () => {};
    const olderWritten = new Promise<void>((resolve) => {
      written = resolve;
    });
    let started: () => void = () => {};
    const hasTxid = new Promise<void>((resolve) => {
      started = resolve;
    });
    const younger = uniqueId('tick');
    const late = writer.begin(async (transaction) => {
      await transaction`SELECT pg_current_xact_id()`;
      started();
      await olderWritten;
      await transaction`
        INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, attempt_count, climbed_at)
        VALUES (${younger}, ${CLIMBER_A}, ${BOARD}, 'prune-climb', 40, 'send', 1, '2026-05-01 18:22:37')`;
    });
    await hasTxid;
    const older = await insertTick();
    written();
    await late;
    await waitForWritesToSettle();

    const [olderRow, youngerRow] = await changeRows();
    expect([olderRow.tickUuid, youngerRow.tickUuid]).toEqual([older, younger]);
    expect(BigInt(youngerRow.txid)).toBeLessThan(BigInt(olderRow.txid));

    await ageRows([olderRow]);
    expect(await prune()).toMatchObject({ rowsDeleted: 1, prunedThrough: positionOf(olderRow) });
    // The younger row is kept, below the watermark, until it is old enough.
    await ageRows([youngerRow]);
    expect(await prune()).toMatchObject({ rowsDeleted: 1, prunedThrough: positionOf(olderRow) });
    expect(await changeRows()).toEqual([]);

    // A cursor at the younger row must still answer 410: `older` came after it and is gone.
    expect(await pageAt(positionOf(youngerRow))).toEqual(EXPIRED);
  });

  it('skips a row another transaction holds, without waiting for it', async () => {
    for (let index = 0; index < 3; index += 1) await insertTick();
    const rows = await changeRows();
    await ageRows(rows);
    await waitForWritesToSettle();

    // An account deletion (or anything else) holding the middle row.
    const holder = openClient();
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => {};
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const held = holder.begin(async (transaction) => {
      await transaction`SELECT 1 FROM logbook_changes WHERE seq = ${rows[1].seq}::bigint FOR UPDATE`;
      locked();
      await released;
    });
    try {
      await holding;
      const startedAt = Date.now();
      const result = await prune();
      expect(Date.now() - startedAt).toBeLessThan(900);
      expect(result).toMatchObject({ rowsDeleted: 2, prunedThrough: positionOf(rows[2]) });
      expect((await changeRows()).map((row) => row.seq)).toEqual([rows[1].seq]);
    } finally {
      release();
      await held;
    }
    // Released and still old: the next run takes it and leaves the watermark alone.
    expect(await prune()).toMatchObject({ rowsDeleted: 1, prunedThrough: positionOf(rows[2]) });
  });

  it('runs two at once without deleting a row twice or losing the watermark', async () => {
    for (let index = 0; index < 12; index += 1) await insertTick(index % 2 === 0 ? CLIMBER_A : CLIMBER_B);
    const rows = await changeRows();
    await ageRows(rows);
    await waitForWritesToSettle();

    const runs = await Promise.allSettled([prune({ rowsPerBatch: 2 }), prune({ rowsPerBatch: 2 })]);
    // A batch waits at most 1 s for the other run's hold on the watermark row.
    // On a loaded machine that can run out: the batch fails whole (55P03, the
    // next test proves it) and the next run takes its rows. Nothing else may fail.
    for (const run of runs) {
      if (run.status === 'rejected') expect(getPostgresErrorCode(run.reason)).toBe('55P03');
    }
    const deletedByBoth = runs.map((run) => (run.status === 'fulfilled' ? run.value.rowsDeleted : null));
    if (!deletedByBoth.includes(null)) expect((deletedByBoth[0] ?? 0) + (deletedByBoth[1] ?? 0)).toBe(12);
    await prune();
    expect(await changeRows()).toEqual([]);
    expect(await watermark()).toEqual(positionOf(rows[11]));
  });

  it('fails a batch whole when the watermark row stays held past its 1 s lock timeout', async () => {
    for (let index = 0; index < 3; index += 1) await insertTick();
    const rows = await changeRows();
    await ageRows(rows);
    await waitForWritesToSettle();

    const holder = openClient();
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => {};
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const held = holder.begin(async (transaction) => {
      await transaction`SELECT 1 FROM logbook_change_watermark WHERE id = 1 FOR UPDATE`;
      locked();
      await released;
    });
    try {
      await holding;
      const refused = await prune().then(
        () => null,
        (error: unknown) => error,
      );
      expect(getPostgresErrorCode(refused)).toBe('55P03');
      // The deletes rolled back with the watermark raise: nothing is gone below an unmoved watermark.
      expect(await changeRows()).toHaveLength(3);
      expect(await watermark()).toEqual(LOGBOOK_FEED_ORIGIN);
    } finally {
      release();
      await held;
    }
    expect(await prune()).toMatchObject({ rowsDeleted: 3, prunedThrough: positionOf(rows[2]) });
  });

  it('leaves no moment between its transactions when a held cursor reads past a deleted change', async () => {
    const ticks: string[] = [];
    for (let index = 0; index < 6; index += 1) ticks.push(await insertTick());
    await waitForWritesToSettle();
    // A reader that has read the first change and stopped.
    const first = await pageAt(LOGBOOK_FEED_ORIGIN, 1);
    if (first.status !== 'ok') throw new Error('expired');
    const rows = await changeRows();
    await ageRows(rows.slice(0, 4));
    await waitForWritesToSettle();

    // After every transaction the job commits, that cursor answers 410 or gets every later change.
    const pagesWithAGap: string[][] = [];
    let commits = 0;
    await pruneLogbookChanges(
      {
        read: (callback) => db.transaction(callback),
        runBatch: async (callback) => {
          const result = await db.transaction(callback);
          commits += 1;
          const page = await pageAt(first.next);
          if (page.status === 'ok') {
            const missing = ticks.slice(1).filter((tickUuid) => !tickIdsOf(page).includes(tickUuid));
            if (missing.length > 0) pagesWithAGap.push(missing);
          }
          return result;
        },
      },
      { rowsPerBatch: 2 },
    );
    expect(commits).toBe(2);
    expect(pagesWithAGap).toEqual([]);
    expect(await pageAt(first.next)).toEqual(EXPIRED);
  });

  it('raises the watermark over the highest feed position a batch deleted, not the highest seq', async () => {
    // `lowTxid` gets its txid first but is written after `highTxid`, so in one
    // batch the highest seq is not the highest feed position.
    const writer = openClient();
    let written: () => void = () => {};
    const highWritten = new Promise<void>((resolve) => {
      written = resolve;
    });
    let started: () => void = () => {};
    const hasTxid = new Promise<void>((resolve) => {
      started = resolve;
    });
    const lowTxid = uniqueId('tick');
    const late = writer.begin(async (transaction) => {
      await transaction`SELECT pg_current_xact_id()`;
      started();
      await highWritten;
      await transaction`
        INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, attempt_count, climbed_at)
        VALUES (${lowTxid}, ${CLIMBER_A}, ${BOARD}, 'prune-climb', 40, 'send', 1, '2026-05-01 18:22:37')`;
    });
    await hasTxid;
    const highTxid = await insertTick();
    written();
    await late;
    const kept = await insertTick();
    await waitForWritesToSettle();
    const rows = await changeRows();
    // Insertion order: highTxid, lowTxid, kept. Feed order: lowTxid, highTxid, kept.
    expect(rows.map((row) => row.tickUuid)).toEqual([highTxid, lowTxid, kept]);

    // A reader that has read lowTxid, the first change in feed order, and stopped.
    const reader = await pageAt(LOGBOOK_FEED_ORIGIN, 1);
    if (reader.status !== 'ok') throw new Error('expired');
    expect(tickIdsOf(reader)).toEqual([lowTxid]);

    await ageRows(rows.slice(0, 2));
    expect(await prune()).toMatchObject({ rowsDeleted: 2, batches: 1, prunedThrough: positionOf(rows[0]) });
    // highTxid's change is gone, so the reader gets 410, not a page that skips it.
    expect(await pageAt(reader.next)).toEqual(EXPIRED);
  });

  it('bounds both of its transactions, including how long either may sit idle', async () => {
    await insertTick();
    const rows = await changeRows();
    await ageRows(rows);
    await waitForWritesToSettle();

    const seen: Record<'walk' | 'delete', Array<Record<string, string>>> = { walk: [], delete: [] };
    const recordingSettings =
      (kind: 'walk' | 'delete'): BatchRunner =>
      (callback) =>
        db.transaction(async (transaction) => {
          const result = await callback(transaction);
          const [settings] = (await transaction.execute(sql`
            SELECT current_setting('statement_timeout') AS statement,
                   current_setting('lock_timeout') AS lock,
                   current_setting('idle_in_transaction_session_timeout') AS idle
          `)) as unknown as Array<Record<string, string>>;
          seen[kind].push(settings);
          return result;
        });
    await pruneLogbookChanges({ read: recordingSettings('walk'), runBatch: recordingSettings('delete') });

    expect(seen.delete).toEqual([{ statement: '5s', lock: '1s', idle: '10s' }]);
    // The walk, then the read of the watermark at the end, which sets nothing.
    expect(seen.walk[0]).toEqual({ statement: '2min', lock: '0', idle: '10s' });
  });

  it('stops at its batch and time budgets and leaves the rest for the next run', async () => {
    for (let index = 0; index < 10; index += 1) await insertTick();
    const rows = await changeRows();
    await ageRows(rows);
    await waitForWritesToSettle();

    expect(await prune({ rowsPerBatch: 2, maxBatches: 2 })).toMatchObject({
      rowsDeleted: 4,
      batches: 2,
      prunedThrough: positionOf(rows[3]),
      stoppedBy: 'max_batches',
    });
    expect(await prune({ budgetMs: 0 })).toMatchObject({ rowsDeleted: 0, stoppedBy: 'time_budget' });
    const aborted = new AbortController();
    aborted.abort();
    await expect(prune({ signal: aborted.signal })).rejects.toThrow();
    expect(await prune({ rowsPerBatch: 4 })).toMatchObject({
      rowsDeleted: 6,
      prunedThrough: positionOf(rows[9]),
      stoppedBy: 'caught_up',
    });
  });
});

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** The climber's visible ticks, the way a snapshot bootstrap reads them. */
async function publicView(userId: string): Promise<Map<string, LogbookFeedTick>> {
  const rows = await db
    .select(logbookFeedTickColumns)
    .from(boardseshTicks)
    .leftJoin(boardClimbAliases, logbookFeedAliasJoin)
    .where(logbookVisibleTicksFilter(userId));
  return new Map(rows.map((row) => [row.uuid, row]));
}

/** A bootstrap: every visible tick and the horizon, from one snapshot. */
async function bootstrap(userId: string): Promise<{ copy: Map<string, LogbookFeedTick>; cursor: LogbookFeedCursor }> {
  return db.transaction(
    async (transaction) => {
      const state = await readLogbookFeedState(transaction);
      const rows = await transaction
        .select(logbookFeedTickColumns)
        .from(boardseshTicks)
        .leftJoin(boardClimbAliases, logbookFeedAliasJoin)
        .where(logbookVisibleTicksFilter(userId));
      return {
        copy: new Map(rows.map((row) => [row.uuid, row])),
        cursor: { generation: state.generation, txid: state.horizon, seq: '0' },
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

describe('a reader, writers and the prune at once', () => {
  // Reproduce a failure with LOGBOOK_PRUNE_TEST_SEED=<printed seed>.
  const baseSeed = Number(process.env.LOGBOOK_PRUNE_TEST_SEED ?? Date.now() % 1_000_000);

  async function randomizedRun(seed: number): Promise<{ expiries: number; checkedPages: number }> {
    const random = mulberry32(seed);
    const writers = Array.from({ length: 3 }, () => openClient());
    const live: string[] = [];
    let expiries = 0;

    const reader = { ...(await bootstrap(CLIMBER_A)) };
    let checkedPages = 0;
    /**
     * Reads one page and, unless it expired, checks the reader against the
     * database as the page saw it: every tick with no change past where the page
     * stopped must already be exactly what that snapshot holds. A change the
     * prune deleted without a 410 leaves its tick stale or missing here, on the
     * page that skipped it, before any later 410 and fresh start can hide it.
     */
    const readOnePage = async (): Promise<boolean> => {
      const captured: {
        truth?: { ticks: Map<string, LogbookFeedTick>; changes: LogbookFeedPosition[]; changedTicks: string[] };
      } = {};
      const page = await readLogbookFeedPage(db, {
        userId: CLIMBER_A,
        cursor: reader.cursor,
        limit: 2,
        withinRead: async (transaction) => {
          const ticks = await transaction
            .select(logbookFeedTickColumns)
            .from(boardseshTicks)
            .leftJoin(boardClimbAliases, logbookFeedAliasJoin)
            .where(logbookVisibleTicksFilter(CLIMBER_A));
          const changes = await transaction
            .select({
              txid: sql<string>`${logbookChanges.txid}::text`,
              seq: sql<string>`${logbookChanges.seq}::text`,
              tickUuid: logbookChanges.tickUuid,
            })
            .from(logbookChanges)
            .where(eq(logbookChanges.userId, CLIMBER_A));
          captured.truth = {
            ticks: new Map(ticks.map((row) => [row.uuid, row])),
            changes: changes.map(({ txid, seq }) => ({ txid, seq })),
            changedTicks: changes.map((change) => change.tickUuid),
          };
        },
      });
      if (page.status === 'expired') {
        expiries += 1;
        Object.assign(reader, await bootstrap(CLIMBER_A));
        return true;
      }
      for (const entry of page.entries) {
        if (entry.type === 'tick') reader.copy.set(entry.tick.uuid, entry.tick);
        else reader.copy.delete(entry.id);
      }
      reader.cursor = { generation: page.generation, ...page.next };

      const seen = captured.truth;
      if (!seen) throw new Error('the page was read without its snapshot');
      const readThrough: LogbookFeedPosition = page.hasMore ? page.next : { txid: page.horizon, seq: '0' };
      const pending = new Set(
        seen.changedTicks.filter((_tickUuid, index) => positionIsBefore(readThrough, seen.changes[index])),
      );
      for (const tickUuid of new Set([...seen.ticks.keys(), ...reader.copy.keys()])) {
        if (pending.has(tickUuid)) continue;
        expect(reader.copy.get(tickUuid), `seed ${seed}: ${tickUuid} after a page that read through it`).toEqual(
          seen.ticks.get(tickUuid),
        );
      }
      checkedPages += 1;
      return page.hasMore;
    };

    let writing = true;
    const readerLoop = (async () => {
      for (let iteration = 1; writing; iteration += 1) {
        // Every third page, let the prune overtake the reader first, so the 410
        // path runs mid-run and the pages after the fresh start are checked too.
        if (iteration % 3 === 0) {
          for (const deadline = Date.now() + 1000; writing && Date.now() < deadline; await delay(5)) {
            if (positionIsBefore(reader.cursor, await watermark())) break;
          }
        }
        await readOnePage();
        await delay(Math.floor(random() * 20));
      }
    })();
    // Ages everything written so far and prunes, over and over, beside the writers.
    const pruneLoop = (async () => {
      while (writing) {
        await ageChanges(sql`true`);
        await prune({ rowsPerBatch: 3 });
        await delay(15);
      }
    })();

    const operations = Array.from({ length: 150 }, () => random());
    const workers = writers.map(async (writer) => {
      for (;;) {
        const roll = operations.shift();
        if (roll === undefined) return;
        const userId = roll < 0.1 ? CLIMBER_B : CLIMBER_A;
        if (roll < 0.5 || live.length === 0) {
          const uuid = uniqueId('random');
          live.push(uuid);
          await writer`
            INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, attempt_count, climbed_at)
            VALUES (${uuid}, ${userId}, ${BOARD}, 'prune-climb', 40, 'send', 1, '2026-05-01 18:22:37')`;
        } else if (roll < 0.8) {
          const target = live[Math.floor(random() * live.length)];
          await writer`UPDATE boardsesh_ticks SET comment = ${`edit-${Math.floor(random() * 1000)}`} WHERE uuid = ${target}`;
        } else {
          const target = live.splice(Math.floor(random() * live.length), 1)[0];
          await writer`DELETE FROM boardsesh_ticks WHERE uuid = ${target}`;
        }
        await delay(Math.floor(random() * 4));
      }
    });
    try {
      await Promise.all(workers);
    } finally {
      writing = false;
      await Promise.all([readerLoop, pruneLoop]);
    }

    // Catch up, then make sure the prune overtakes the reader at least once,
    // whatever the timing above was: other test files' open transactions on
    // this Postgres can hold the horizon back for the whole concurrent phase.
    await waitForWritesToSettle();
    while (await readOnePage());
    const overtaken = await insertTick();
    await waitForWritesToSettle();
    await ageChanges(sql`true`);
    await prune();
    expect(positionIsBefore(reader.cursor, await watermark()), `seed ${seed}: the prune did not pass the reader`).toBe(
      true,
    );
    const expiriesBefore = expiries;
    await readOnePage();
    expect(expiries).toBe(expiriesBefore + 1);

    // After the fresh start, more changes, read and checked page by page. No
    // prune from here on: a 410 would start the reader over and hide a gap.
    const checkedBeforeFinalReads = checkedPages;
    await db.update(boardseshTicks).set({ comment: 'after the fresh start' }).where(eq(boardseshTicks.uuid, overtaken));
    await insertTick();
    await waitForWritesToSettle();
    while (await readOnePage());
    expect(checkedPages).toBeGreaterThan(checkedBeforeFinalReads);

    const expected = [...(await publicView(CLIMBER_A)).values()].sort((left, right) =>
      left.uuid.localeCompare(right.uuid),
    );
    const actual = [...reader.copy.values()].sort((left, right) => left.uuid.localeCompare(right.uuid));
    expect(actual, `seed ${seed}: the reader's copy differs from the database`).toEqual(expected);
    return { expiries, checkedPages };
  }

  it.each([0, 1, 2])(
    "keeps the reader's copy equal to the database after every page, through 410 and a fresh start (variant %i)",
    async (variant) => {
      const { expiries, checkedPages } = await randomizedRun(baseSeed + variant);
      // The 410 path ran, and pages after a fresh start were checked.
      expect(expiries).toBeGreaterThan(0);
      expect(checkedPages).toBeGreaterThan(expiries);
    },
    120_000,
  );
});
