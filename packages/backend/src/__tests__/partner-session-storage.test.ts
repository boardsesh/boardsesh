import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import {
  boardClimbAliases,
  boardClimbs,
  boardSessions,
  boardSessionParticipants,
  boardseshTicks,
  logbookChanges,
  logbookSessionChanges,
  logbookChangeWatermark,
  users,
  sessionWorkouts,
} from '@boardsesh/db/schema';
import { db } from '../db/client';
import { readLogbookFeedPage, readLogbookFeedState } from '../services/logbook-feed';
import { pruneLogbookChanges } from '../services/logbook-prune';
import { getWorkerDatabaseUrl } from './worker-db';

const OWNER = 'user-123';
const writers: ReturnType<typeof postgres>[] = [];
function writer() {
  const client = postgres(getWorkerDatabaseUrl(), { max: 1, onnotice: () => {} });
  writers.push(client);
  return client;
}
afterAll(async () => {
  await Promise.all(writers.map((client) => client.end({ timeout: 2 })));
});
beforeEach(async () => {
  await db.execute(sql`TRUNCATE logbook_session_changes, logbook_changes`);
  await db.update(logbookChangeWatermark).set({ prunedThroughTxid: '0', prunedThroughSeq: 0n });
});
async function session(active = false) {
  const [created] = await db
    .insert(boardSessions)
    .values({
      id: randomUUID(),
      createdByUserId: OWNER,
      boardPath: 'kilter/1/1/1/40',
      status: active ? 'active' : 'ended',
      startedAt: new Date('2026-04-01T17:00:00Z'),
      endedAt: active ? null : new Date('2026-04-01T18:00:00Z'),
    })
    .returning();
  return created;
}
async function settle() {
  const [{ txid }] = await db.execute<{ txid: string }>(sql`SELECT pg_current_xact_id()::text AS txid`);
  const deadline = Date.now() + 60_000;
  for (;;) {
    const [{ horizon }] = await db.execute<{ horizon: string }>(
      sql`SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS horizon`,
    );
    if (BigInt(horizon) > BigInt(txid)) return;
    if (Date.now() > deadline) throw new Error('Test transaction horizon did not settle');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('partner session trigger consistency', () => {
  it.each(['participant', 'tick', 'workout'] as const)(
    'does not lose a concurrent %s write behind completion',
    async (kind) => {
      const guestId = randomUUID();
      await db.insert(users).values({ id: guestId, email: `${guestId}@example.test` });
      const created = await session(true);
      if (kind !== 'participant')
        await db.insert(boardSessionParticipants).values({ sessionId: created.id, userId: guestId });
      const initial = await db.transaction(readLogbookFeedState);
      const completion = await writer().reserve();
      const mutation = await writer().reserve();
      try {
        await completion`BEGIN`;
        await completion`UPDATE board_sessions SET status='ended',ended_at='2026-04-01 18:00:00' WHERE id=${created.id}`;
        await mutation`BEGIN`;
        await mutation`SET LOCAL lock_timeout='2s'`;
        if (kind === 'participant') {
          await mutation`INSERT INTO board_session_participants(session_id,user_id) VALUES(${created.id},${guestId})`;
        } else if (kind === 'tick') {
          await mutation`INSERT INTO boardsesh_ticks(uuid,user_id,board_type,climb_uuid,angle,status,climbed_at,session_id)
          VALUES(${randomUUID()},${guestId},'kilter','concurrent',40,'send','2026-04-01 17:30:00',${created.id})`;
        } else {
          await mutation`INSERT INTO session_workouts(session_id,user_id,plan,revision)
          VALUES(${created.id},${guestId},' {"version":1,"stages":[]}'::jsonb,1)`;
        }
        await completion`COMMIT`;
        // A partner can consume the completion while the second writer remains
        // uncommitted. That later write must retain its own durable session hint.
        const beforeMutation = await readLogbookFeedPage(db, {
          userId: guestId,
          includesSessions: true,
          cursor: { generation: initial.generation, txid: initial.horizon, seq: '0' },
          limit: 200,
        });
        if (beforeMutation.status !== 'ok') throw new Error('Unexpected expired cursor');
        await mutation`COMMIT`;
        await settle();
        const afterMutation = await readLogbookFeedPage(db, {
          userId: guestId,
          includesSessions: true,
          cursor: { generation: initial.generation, ...beforeMutation.next },
          limit: 200,
        });
        expect(afterMutation.status).toBe('ok');
        if (afterMutation.status === 'ok')
          expect(afterMutation.entries).toContainEqual(
            expect.objectContaining({ type: 'session', id: created.exportId }),
          );
      } finally {
        await completion`ROLLBACK`;
        await mutation`ROLLBACK`;
        completion.release();
        mutation.release();
      }
    },
    90_000,
  );

  it('retains a tick hint when participation commits after the tick writer took its snapshot', async () => {
    const guestId = randomUUID();
    await db.insert(users).values({ id: guestId, email: `${guestId}@example.test` });
    const created = await session();
    const initial = await db.transaction(readLogbookFeedState);
    const joining = await writer().reserve();
    const ticking = await writer().reserve();
    try {
      await joining`BEGIN`;
      await joining`INSERT INTO board_session_participants(session_id,user_id) VALUES(${created.id},${guestId})`;
      await ticking`BEGIN`;
      await ticking`INSERT INTO boardsesh_ticks(uuid,user_id,board_type,climb_uuid,angle,status,climbed_at,session_id)
        VALUES(${randomUUID()},${guestId},'kilter','joined-late',40,'send','2026-04-01 17:30:00',${created.id})`;
      await joining`COMMIT`;
      const beforeTick = await readLogbookFeedPage(db, {
        userId: guestId,
        includesSessions: true,
        cursor: { generation: initial.generation, txid: initial.horizon, seq: '0' },
        limit: 200,
      });
      if (beforeTick.status !== 'ok') throw new Error('Unexpected expired cursor');
      await ticking`COMMIT`;
      await settle();
      const afterTick = await readLogbookFeedPage(db, {
        userId: guestId,
        includesSessions: true,
        cursor: { generation: initial.generation, ...beforeTick.next },
        limit: 200,
      });
      if (afterTick.status !== 'ok') throw new Error('Unexpected expired cursor');
      expect(afterTick.entries).toContainEqual(expect.objectContaining({ type: 'session', id: created.exportId }));
    } finally {
      await joining`ROLLBACK`;
      await ticking`ROLLBACK`;
      joining.release();
      ticking.release();
    }
  }, 90_000);

  it('invalidates skipped workout climbs after an alias merge without a tick', async () => {
    const created = await session();
    const alias = randomUUID();
    const canonical = randomUUID();
    await db.insert(boardClimbs).values({ uuid: canonical, boardType: 'kilter', layoutId: 1, name: 'Canonical' });
    await db.insert(sessionWorkouts).values({
      sessionId: created.id,
      userId: OWNER,
      revision: 1,
      plan: {
        version: 1,
        stages: [
          { id: 'skipped', kind: 'volume', items: [{ queueItemUuid: randomUUID(), climbUuid: alias, angle: 40 }] },
        ],
      },
    });
    await db.delete(logbookSessionChanges);
    await db
      .insert(boardClimbAliases)
      .values({ boardType: 'kilter', aliasUuid: alias, canonicalUuid: canonical, source: 'test' });
    expect((await db.select().from(logbookSessionChanges)).map((change) => change.sessionExportId)).toContain(
      created.exportId,
    );
  });

  it('logs board-path and origin repairs on an ended session', async () => {
    const created = await session();
    await db.delete(logbookSessionChanges);
    await db
      .update(boardSessions)
      .set({ boardPath: 'kilter/1/1/1/45', origin: 'inferred' })
      .where(eq(boardSessions.id, created.id));
    expect((await db.select().from(logbookSessionChanges)).map((change) => change.sessionExportId)).toContain(
      created.exportId,
    );
  });

  it('does not fan out recap-only edits to every tick', async () => {
    const created = await session();
    await db.insert(boardseshTicks).values({
      uuid: randomUUID(),
      userId: OWNER,
      boardType: 'kilter',
      climbUuid: 'recap',
      angle: 40,
      status: 'send',
      climbedAt: '2026-04-01 17:30:00',
      sessionId: created.id,
    });
    await db.delete(logbookChanges);
    await db.delete(logbookSessionChanges);
    await db.update(boardSessions).set({ notes: 'Fresh recap' }).where(eq(boardSessions.id, created.id));
    expect(await db.select().from(logbookChanges)).toHaveLength(0);
    expect(await db.select().from(logbookSessionChanges)).toHaveLength(1);
  });

  it('invalidates another session when an Aurora twin is revealed', async () => {
    const first = await session();
    const second = await session();
    const [smallest] = await db
      .insert(boardseshTicks)
      .values({
        uuid: randomUUID(),
        userId: OWNER,
        boardType: 'kilter',
        climbUuid: 'twins',
        angle: 40,
        status: 'send',
        climbedAt: '2026-04-01 17:30:00',
        updatedAt: '2026-04-01 17:30:00',
        auroraSyncedAt: '2026-04-01 17:30:00',
        origin: 'aurora_pull',
        auroraId: 'aur-1',
        sessionId: first.id,
      })
      .returning();
    await db.insert(boardseshTicks).values({
      uuid: randomUUID(),
      userId: OWNER,
      boardType: 'kilter',
      climbUuid: 'twins',
      angle: 40,
      status: 'send',
      climbedAt: '2026-04-01 17:30:00',
      updatedAt: '2026-04-01 17:30:00',
      auroraSyncedAt: '2026-04-01 17:30:00',
      origin: 'aurora_pull',
      auroraId: 'aur-2',
      sessionId: second.id,
    });
    await db.delete(logbookSessionChanges);
    await db.delete(boardseshTicks).where(eq(boardseshTicks.uuid, smallest.uuid));
    expect((await db.select().from(logbookSessionChanges)).map((change) => change.sessionExportId)).toEqual(
      expect.arrayContaining([first.exportId, second.exportId]),
    );
  });

  it('invalidates workout results after an alias merge', async () => {
    const created = await session();
    const canonical = randomUUID();
    const alias = randomUUID();
    await db.insert(boardClimbs).values({ uuid: canonical, boardType: 'kilter', layoutId: 1, name: 'Canonical' });
    await db.insert(boardseshTicks).values({
      uuid: randomUUID(),
      userId: OWNER,
      boardType: 'kilter',
      climbUuid: alias,
      angle: 40,
      status: 'send',
      climbedAt: '2026-04-01 17:30:00',
      sessionId: created.id,
    });
    await db.delete(logbookSessionChanges);
    await db
      .insert(boardClimbAliases)
      .values({ boardType: 'kilter', aliasUuid: alias, canonicalUuid: canonical, source: 'test' });
    expect((await db.select().from(logbookSessionChanges)).map((change) => change.sessionExportId)).toContain(
      created.exportId,
    );
  });

  it('prunes session changes through the same atomic retention watermark', async () => {
    const created = await session();
    await db.delete(logbookChanges);
    await db.delete(logbookSessionChanges);
    const [change] = await db
      .insert(logbookSessionChanges)
      .values({ userId: OWNER, sessionExportId: created.exportId, createdAt: '2001-01-01 00:00:00' })
      .returning();
    await settle();
    const pruned = await pruneLogbookChanges({
      read: (callback) => db.transaction(callback),
      runBatch: (callback) => db.transaction(callback),
    });
    expect(pruned.rowsDeleted).toBe(1);
    expect(pruned.prunedThrough).toEqual({ txid: change.txid, seq: change.seq.toString() });
    expect(await db.select().from(logbookSessionChanges)).toHaveLength(0);
  });
});
