import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vite-plus/test';
import { sql, eq, and, asc } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { reconcileInferredSessions } from '../services/inferred-sessions/reconcile';

/**
 * Real-DB coverage for turning a reconciliation decision into rows.
 *
 * The algorithm itself is unit-tested in `@boardsesh/session-inference` without a
 * database. What is exercised here is everything that pure function cannot see: the
 * window query, inheriting a session through its anchor, moving votes and comments off
 * a session that loses a merge, and the unique-anchor constraint that settles
 * concurrent reconciliation.
 */

const USER_ID = 'inf-recon-user';
const CLIMB_UUID = 'inf-recon-climb';
const BOARD_UUID = 'inf-recon-board';
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const BASE = Date.UTC(2026, 4, 10, 9, 0, 0);

let boardId: number;

const iso = (epochMs: number) => new Date(epochMs).toISOString().replace('T', ' ').replace('Z', '');

async function seedFixtures() {
  await db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${USER_ID}, ${USER_ID + '@test.com'}, 'Reconcile User', now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
  const boardResult = await db.execute(sql`
    INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name)
    VALUES (${BOARD_UUID}, ${BOARD_UUID}, ${USER_ID}, 'kilter', 1, 10, '1,20', 'Reconcile Board')
    ON CONFLICT (uuid) DO UPDATE SET slug = excluded.slug
    RETURNING id
  `);
  boardId = Number(Array.from(boardResult as Iterable<{ id: number }>)[0].id);
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, frames, frames_count, is_draft, is_listed, edge_left, edge_right, edge_bottom, edge_top, created_at)
    VALUES (${CLIMB_UUID}, 'kilter', 1, 'test-setter', 'Reconcile Climb', 'p1r1', 1, false, true, 0, 100, 0, 150, '2024-01-01')
    ON CONFLICT (uuid) DO NOTHING
  `);
}

/** Insert a tick and return the bigserial id reconciliation anchors on. */
async function insertTick(climbedAtMs: number, sessionId: string | null = null): Promise<number> {
  const [row] = await db
    .insert(dbSchema.boardseshTicks)
    .values({
      uuid: uuidv4(),
      userId: USER_ID,
      boardType: 'kilter',
      boardId,
      climbUuid: CLIMB_UUID,
      angle: 40,
      status: 'send',
      attemptCount: 1,
      climbedAt: iso(climbedAtMs),
      sessionId,
    })
    .returning({ id: dbSchema.boardseshTicks.id });
  return Number(row.id);
}

async function sessionsForUser() {
  return db
    .select({
      id: dbSchema.boardSessions.id,
      origin: dbSchema.boardSessions.origin,
      anchorTickId: dbSchema.boardSessions.anchorTickId,
      name: dbSchema.boardSessions.name,
      startedAt: dbSchema.boardSessions.startedAt,
      endedAt: dbSchema.boardSessions.endedAt,
    })
    .from(dbSchema.boardSessions)
    .where(eq(dbSchema.boardSessions.createdByUserId, USER_ID))
    .orderBy(asc(dbSchema.boardSessions.startedAt));
}

async function ticksForUser() {
  return db
    .select({ id: dbSchema.boardseshTicks.id, sessionId: dbSchema.boardseshTicks.sessionId })
    .from(dbSchema.boardseshTicks)
    .where(eq(dbSchema.boardseshTicks.userId, USER_ID))
    .orderBy(asc(dbSchema.boardseshTicks.climbedAt));
}

const reconcileAt = (epochMs: number) =>
  db.transaction((tx) => reconcileInferredSessions(tx, USER_ID, new Date(epochMs)));

async function cleanup() {
  await db.execute(sql`DELETE FROM boardsesh_ticks WHERE user_id = ${USER_ID}`);
  await db.execute(sql`DELETE FROM votes WHERE entity_type = 'session'`);
  await db.execute(sql`DELETE FROM comments WHERE entity_type = 'session' AND user_id = ${USER_ID}`);
  await db.execute(sql`DELETE FROM board_sessions WHERE created_by_user_id = ${USER_ID}`);
}

describe('reconcileInferredSessions (real DB)', () => {
  beforeEach(async () => {
    process.env.INFERRED_SESSIONS_ENABLED = 'true';
    await cleanup();
    await seedFixtures();
  });

  // Cleared per test, not per file: vitest reuses a worker process across files, so a
  // failure that skipped an afterAll would leave reconciliation switched on for
  // whatever ran next — and the tick-mutation suites would start writing sessions.
  afterEach(() => {
    delete process.env.INFERRED_SESSIONS_ENABLED;
  });

  afterAll(async () => {
    await cleanup();
    await db.execute(sql`DELETE FROM board_climbs WHERE uuid = ${CLIMB_UUID}`);
    await db.execute(sql`DELETE FROM user_boards WHERE uuid = ${BOARD_UUID}`);
    await db.execute(sql`DELETE FROM "users" WHERE id = ${USER_ID}`);
  });

  it('does nothing while the flag is off', async () => {
    delete process.env.INFERRED_SESSIONS_ENABLED;
    await insertTick(BASE);

    await reconcileAt(BASE);

    expect(await sessionsForUser()).toHaveLength(0);
    expect((await ticksForUser())[0].sessionId).toBeNull();
  });

  it('creates one session per run and assigns every tick', async () => {
    await insertTick(BASE);
    await insertTick(BASE + 20 * MINUTE);
    await insertTick(BASE + 10 * HOUR);

    await reconcileAt(BASE);
    await reconcileAt(BASE + 10 * HOUR);

    const sessions = await sessionsForUser();
    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => session.origin === 'inferred')).toBe(true);

    const ticks = await ticksForUser();
    expect(ticks.every((tick) => tick.sessionId !== null)).toBe(true);
    // The two morning climbs share a session; the evening one does not.
    expect(ticks[0].sessionId).toBe(ticks[1].sessionId);
    expect(ticks[2].sessionId).not.toBe(ticks[0].sessionId);
  });

  it("anchors the session on the run's lowest tick id and spans its climbs", async () => {
    const first = await insertTick(BASE);
    await insertTick(BASE + 30 * MINUTE);

    await reconcileAt(BASE);

    const [session] = await sessionsForUser();
    expect(session.anchorTickId).toBe(first);
    expect(session.startedAt?.getTime()).toBe(BASE);
    expect(session.endedAt?.getTime()).toBe(BASE + 30 * MINUTE);
  });

  it('is a no-op when run again over the same window', async () => {
    await insertTick(BASE);
    await insertTick(BASE + 30 * MINUTE);

    await reconcileAt(BASE);
    const first = await sessionsForUser();
    await reconcileAt(BASE);
    const second = await sessionsForUser();

    expect(second).toEqual(first);
  });

  // The case that broke v1: a back-dated import landing inside an existing run.
  it('keeps the session id when a back-dated tick joins the run', async () => {
    await insertTick(BASE);
    await insertTick(BASE + 30 * MINUTE);
    await reconcileAt(BASE);
    const [before] = await sessionsForUser();

    await insertTick(BASE - 20 * MINUTE);
    await reconcileAt(BASE - 20 * MINUTE);

    const sessions = await sessionsForUser();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(before.id);
    // The span grows backwards even though the identity does not move.
    expect(sessions[0].startedAt?.getTime()).toBe(BASE - 20 * MINUTE);
  });

  it('merges two sessions a back-dated tick bridges, keeping the named one', async () => {
    await insertTick(BASE);
    await insertTick(BASE + 10 * HOUR);
    await reconcileAt(BASE);
    await reconcileAt(BASE + 10 * HOUR);

    const [morning, evening] = await sessionsForUser();
    await db
      .update(dbSchema.boardSessions)
      .set({ name: 'Evening burn', userEdited: true })
      .where(eq(dbSchema.boardSessions.id, evening.id));

    // Lands within 4h of both, welding the two runs together.
    await insertTick(BASE + 4 * HOUR);
    await insertTick(BASE + 7 * HOUR);
    await reconcileAt(BASE + 4 * HOUR);

    const sessions = await sessionsForUser();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(evening.id);
    expect(sessions[0].name).toBe('Evening burn');
    expect(morning.id).not.toBe(sessions[0].id);
  });

  it('moves votes and comments off the session that loses a merge', async () => {
    await insertTick(BASE);
    await insertTick(BASE + 10 * HOUR);
    await reconcileAt(BASE);
    await reconcileAt(BASE + 10 * HOUR);
    const [morning, evening] = await sessionsForUser();

    await db.insert(dbSchema.votes).values({
      userId: USER_ID,
      entityType: 'session',
      entityId: morning.id,
      value: 1,
    });

    await insertTick(BASE + 4 * HOUR);
    await insertTick(BASE + 7 * HOUR);
    await reconcileAt(BASE + 4 * HOUR);

    const [survivor] = await sessionsForUser();
    const votes = await db
      .select({ entityId: dbSchema.votes.entityId })
      .from(dbSchema.votes)
      .where(and(eq(dbSchema.votes.entityType, 'session'), eq(dbSchema.votes.userId, USER_ID)));

    // Re-pointed onto whichever session survived, never left on the deleted row.
    expect(votes).toHaveLength(1);
    expect(votes[0].entityId).toBe(survivor.id);
    expect([morning.id, evening.id]).toContain(survivor.id);
  });

  it("gives the day's loose ticks to an explicit session", async () => {
    const explicitId = uuidv4();
    await db.insert(dbSchema.boardSessions).values({
      id: explicitId,
      boardPath: '/kilter/1/10/1,20/40',
      createdByUserId: USER_ID,
      status: 'ended',
    });
    // Two climbs before Start, four inside the session.
    await insertTick(BASE);
    await insertTick(BASE + 15 * MINUTE);
    await insertTick(BASE + 90 * MINUTE, explicitId);
    await insertTick(BASE + 100 * MINUTE, explicitId);

    await reconcileAt(BASE);

    const ticks = await ticksForUser();
    expect(ticks.every((tick) => tick.sessionId === explicitId)).toBe(true);
    // No inferred session is left standing beside it.
    const inferred = (await sessionsForUser()).filter((session) => session.origin === 'inferred');
    expect(inferred).toHaveLength(0);
  });

  it('refuses a duplicate session for the same anchor', async () => {
    const anchor = await insertTick(BASE);
    await reconcileAt(BASE);

    // What a second writer racing the first would attempt.
    await expect(
      db.insert(dbSchema.boardSessions).values({
        id: uuidv4(),
        boardPath: null,
        origin: 'inferred',
        createdByUserId: USER_ID,
        status: 'ended',
        anchorTickId: anchor,
      }),
    ).rejects.toThrow();
  });
});
