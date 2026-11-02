import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vite-plus/test';
import { eq, sql } from 'drizzle-orm';
import { boardseshTicks } from '@boardsesh/db/schema';
import type { SessionFeedItem } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { sessionFeedQueries } from '../graphql/resolvers/social/session-feed';

/**
 * Real-DB integration coverage for exact-board scoping of the session-grouped
 * feed. The mock-based session-feed-board-scope.test.ts proves the SQL *shape*
 * (the query carries `AND t.board_id = <id>` and drops board_type/layout_id);
 * this proves the actual row-level behavior the product wants:
 *
 *   - a boardUuid scope returns ONLY sessions whose ticks have board_id = that
 *     board's id,
 *   - a session on a DIFFERENT board_id but the SAME board_type + layout_id is
 *     EXCLUDED (the whole point of the change — a layout is shared by 1,000+
 *     gyms),
 *   - a session whose ticks have NULL board_id is EXCLUDED from a board-scoped
 *     feed,
 *   - a feed with no boardUuid is unscoped and includes all of the above.
 *
 * Two boards share board_type 'kilter' + layout_id 1 on purpose, so the only
 * thing distinguishing them is user_boards.id (board_id) — exactly the coarse
 * vs. exact distinction under test.
 */

const OWNER_USER_ID = 'sf-board-scope-owner';
const CLIMBER_USER_ID = 'sf-board-scope-climber';
const CLIMB_UUID = 'sf-board-scope-climb-1';
const BOARD_A_UUID = 'sf-board-scope-board-a';
const BOARD_B_UUID = 'sf-board-scope-board-b';
const SESSION_ON_A = 'sf-board-scope-session-a';
const SESSION_ON_B = 'sf-board-scope-session-b';
const SESSION_NULL_BOARD = 'sf-board-scope-session-null';

let boardAId: number;
let boardBId: number;

type SessionFeedResult = {
  sessions: SessionFeedItem[];
  cursor: string | null;
  hasMore: boolean;
};

const callFeed = (input: Record<string, unknown>) =>
  sessionFeedQueries.sessionGroupedFeed(null, { input }) as Promise<SessionFeedResult>;

const insertUser = async (id: string) => {
  await db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'Test ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
};

// Both boards share board_type + layout_id (the dimensions the OLD feed scoped
// on). size_id/set_ids differ only to satisfy the (owner, type, layout, size,
// set_ids) unique config constraint — the scoping under test is by board_id, so
// what distinguishes the boards otherwise is irrelevant to the assertions.
const insertBoard = async (uuid: string, slug: string, sizeId: number, setIds: string): Promise<number> => {
  const result = await db.execute(sql`
    INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name)
    VALUES (${uuid}, ${slug}, ${OWNER_USER_ID}, 'kilter', 1, ${sizeId}, ${setIds}, ${'Board ' + slug})
    ON CONFLICT (uuid) DO UPDATE SET slug = excluded.slug
    RETURNING id
  `);
  const rows = Array.from(result as Iterable<{ id: number }>);
  return Number(rows[0].id);
};

const insertClimb = async () => {
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, frames, frames_count, is_draft, is_listed, edge_left, edge_right, edge_bottom, edge_top, created_at)
    VALUES (${CLIMB_UUID}, 'kilter', 1, 'test-setter', 'Board Scope Climb', 'p1r1', 1, false, true, 0, 100, 0, 150, '2024-01-01')
    ON CONFLICT (uuid) DO NOTHING
  `);
};

const insertSession = async (id: string, boardId: number | null) => {
  await db.execute(sql`
    INSERT INTO board_sessions (id, board_path, created_by_user_id, name, board_id, status)
    VALUES (${id}, ${'kilter/1/10/1,20/40'}, ${OWNER_USER_ID}, ${'Session ' + id}, ${boardId}, 'active')
    ON CONFLICT (id) DO NOTHING
  `);
};

const insertTick = async (params: {
  uuid: string;
  sessionId: string | null;
  boardId: number | null;
  climbedAt: string;
  status?: 'send' | 'attempt';
  difficulty?: number;
}) => {
  await db.insert(boardseshTicks).values({
    userId: CLIMBER_USER_ID,
    boardType: 'kilter',
    climbUuid: CLIMB_UUID,
    angle: 40,
    status: 'send',
    attemptCount: 1,
    difficulty: 20,
    ...params,
  });
};

const cleanup = async () => {
  await db.delete(boardseshTicks).where(eq(boardseshTicks.userId, CLIMBER_USER_ID));
  await db.execute(
    sql`DELETE FROM board_sessions WHERE id IN (${SESSION_ON_A}, ${SESSION_ON_B}, ${SESSION_NULL_BOARD})`,
  );
  await db.execute(sql`DELETE FROM board_climbs WHERE uuid = ${CLIMB_UUID}`);
  await db.execute(sql`DELETE FROM user_boards WHERE uuid IN (${BOARD_A_UUID}, ${BOARD_B_UUID})`);
  await db.execute(sql`DELETE FROM "users" WHERE id IN (${OWNER_USER_ID}, ${CLIMBER_USER_ID})`);
};

describe('sessionGroupedFeed — exact board_id scoping (real DB)', () => {
  beforeAll(async () => {
    await cleanup();
    await insertUser(OWNER_USER_ID);
    await insertUser(CLIMBER_USER_ID);
    await insertClimb();

    boardAId = await insertBoard(BOARD_A_UUID, 'board-a', 10, '1,20');
    boardBId = await insertBoard(BOARD_B_UUID, 'board-b', 11, '1,21');

    // Session A: ticks on board A.
    await insertSession(SESSION_ON_A, boardAId);
    await insertTick({
      uuid: 'sf-tick-a',
      sessionId: SESSION_ON_A,
      boardId: boardAId,
      climbedAt: '2026-02-01 10:00:00',
    });

    // Session B: ticks on board B — same board_type 'kilter' + layout_id 1 as A.
    await insertSession(SESSION_ON_B, boardBId);
    await insertTick({
      uuid: 'sf-tick-b',
      sessionId: SESSION_ON_B,
      boardId: boardBId,
      climbedAt: '2026-02-02 10:00:00',
    });

    // Session NULL: ticks with no board_id (legacy / unmapped) — same type + layout.
    await insertSession(SESSION_NULL_BOARD, null);
    await insertTick({
      uuid: 'sf-tick-null',
      sessionId: SESSION_NULL_BOARD,
      boardId: null,
      climbedAt: '2026-02-03 10:00:00',
    });

    // The board feed must include climbing logged without starting a session.
    // A harder send on another board that day must not affect this board's card.
    await insertTick({
      uuid: 'sf-daily-a',
      sessionId: null,
      boardId: boardAId,
      climbedAt: '2026-10-01 10:00:00',
    });
    await insertTick({
      uuid: 'sf-daily-b',
      sessionId: null,
      boardId: boardBId,
      difficulty: 30,
      climbedAt: '2026-10-01 11:00:00',
    });
    await insertTick({
      uuid: 'sf-daily-null',
      sessionId: null,
      boardId: null,
      difficulty: 35,
      climbedAt: '2026-10-01 12:00:00',
    });
    await insertTick({
      uuid: 'sf-daily-attempt-a',
      sessionId: null,
      boardId: boardAId,
      status: 'attempt',
      difficulty: 24,
      climbedAt: '2026-10-02 10:00:00',
    });
  });

  // The shared backend harness clears sessions before each case.
  beforeEach(async () => {
    await insertSession(SESSION_ON_A, boardAId);
    await insertSession(SESSION_ON_B, boardBId);
    await insertSession(SESSION_NULL_BOARD, null);
  });

  afterAll(async () => {
    await cleanup();
  });

  it('returns only sessions whose ticks have board_id = the scoped board', async () => {
    const result = await callFeed({ boardUuid: BOARD_A_UUID, limit: 50 });
    const sessionIds = result.sessions.map((s) => s.sessionId);

    expect(sessionIds).toContain(SESSION_ON_A);
    // Same board_type + layout, different board_id → excluded.
    expect(sessionIds).not.toContain(SESSION_ON_B);
    // NULL board_id → excluded from a board-scoped feed.
    expect(sessionIds).not.toContain(SESSION_NULL_BOARD);
  });

  it('scopes to the other board independently (proves it is not a board_type/layout match)', async () => {
    const result = await callFeed({ boardUuid: BOARD_B_UUID, limit: 50 });
    const sessionIds = result.sessions.map((s) => s.sessionId);

    expect(sessionIds).toContain(SESSION_ON_B);
    expect(sessionIds).not.toContain(SESSION_ON_A);
    expect(sessionIds).not.toContain(SESSION_NULL_BOARD);
  });

  it('is unscoped (includes every board and NULL-board session) with no boardUuid', async () => {
    const result = await callFeed({ limit: 50 });
    const sessionIds = result.sessions.map((s) => s.sessionId);

    expect(sessionIds).toContain(SESSION_ON_A);
    expect(sessionIds).toContain(SESSION_ON_B);
    expect(sessionIds).toContain(SESSION_NULL_BOARD);
  });

  it('returns an empty feed when the requested board does not exist', async () => {
    const result = await callFeed({ boardUuid: 'unknown-uuid', limit: 50 });
    expect(result.sessions).toEqual([]);
  });

  it('puts recent sessionless activity ahead of older sessions on the selected board', async () => {
    const result = await callFeed({ boardUuid: BOARD_A_UUID, includeDailyHighlights: true, limit: 50 });

    expect(result.sessions.map((session) => session.sessionId)).toEqual([
      `daily:board:${BOARD_A_UUID}:sf-daily-attempt-a`,
      `daily:board:${BOARD_A_UUID}:sf-daily-a`,
      SESSION_ON_A,
    ]);
    const sendDay = result.sessions[1];
    expect(sendDay).toMatchObject({
      sessionType: 'daily_highlight',
      tickCount: 1,
      totalSends: 1,
      participants: [expect.objectContaining({ userId: CLIMBER_USER_ID, sends: 1 })],
      hardestSend: { uuid: 'sf-daily-a', difficulty: 20 },
      socialEntityType: 'tick',
      socialEntityId: 'sf-daily-a',
    });
    expect(sendDay.gradeDistribution.reduce((total, grade) => total + grade.send + grade.flash, 0)).toBe(1);
  });

  it('includes attempt-only days without reporting a send', async () => {
    const result = await callFeed({ boardUuid: BOARD_A_UUID, includeDailyHighlights: true, limit: 50 });

    expect(result.sessions[0]).toMatchObject({
      sessionId: `daily:board:${BOARD_A_UUID}:sf-daily-attempt-a`,
      tickCount: 1,
      totalSends: 0,
      totalAttempts: 1,
      hardestSend: null,
      socialEntityType: 'tick',
      socialEntityId: 'sf-daily-attempt-a',
    });
  });

  it('scopes daily highlights independently to another board with the same layout', async () => {
    const result = await callFeed({ boardUuid: BOARD_B_UUID, includeDailyHighlights: true, limit: 50 });

    expect(result.sessions.map((session) => session.sessionId)).toEqual([
      `daily:board:${BOARD_B_UUID}:sf-daily-b`,
      SESSION_ON_B,
    ]);
    expect(result.sessions[0]).toMatchObject({
      tickCount: 1,
      hardestSend: { uuid: 'sf-daily-b', difficulty: 30 },
    });
  });

  it('paginates across daily highlights and explicit sessions without duplicates', async () => {
    const input = { boardUuid: BOARD_A_UUID, includeDailyHighlights: true, limit: 1 };
    const first = await callFeed(input);
    const second = await callFeed({ ...input, cursor: first.cursor });
    const third = await callFeed({ ...input, cursor: second.cursor });

    expect([first, second, third].flatMap((page) => page.sessions.map((session) => session.sessionId))).toEqual([
      `daily:board:${BOARD_A_UUID}:sf-daily-attempt-a`,
      `daily:board:${BOARD_A_UUID}:sf-daily-a`,
      SESSION_ON_A,
    ]);
    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(true);
    expect(third.hasMore).toBe(false);
    expect(third.cursor).toBeNull();
  });

  it('keeps daily highlights opt-in and leaves the unscoped Everyone feed unchanged', async () => {
    const scoped = await callFeed({ boardUuid: BOARD_A_UUID, includeDailyHighlights: false, limit: 50 });
    const unscoped = await callFeed({ includeDailyHighlights: true, limit: 50 });

    expect(scoped.sessions.map((session) => session.sessionId)).toEqual([SESSION_ON_A]);
    expect(unscoped.sessions.every((session) => session.sessionType !== 'daily_highlight')).toBe(true);
  });

  it('opens a daily card with only its selected board’s logs', async () => {
    const result = await callFeed({ boardUuid: BOARD_A_UUID, includeDailyHighlights: true, limit: 50 });
    const detail = await sessionFeedQueries.sessionDetail(null, { sessionId: result.sessions[1].sessionId });

    expect(detail).toMatchObject({
      sessionType: 'daily_highlight',
      tickCount: 1,
      totalSends: 1,
      ticks: [expect.objectContaining({ uuid: 'sf-daily-a' })],
    });
    expect(JSON.stringify(detail)).not.toContain('sf-daily-b');
    expect(JSON.stringify(detail)).not.toContain('sf-daily-null');
  });

  it('rejects a daily card whose anchor belongs to a different or nonexistent board', async () => {
    expect(
      await sessionFeedQueries.sessionDetail(null, { sessionId: `daily:board:${BOARD_A_UUID}:sf-daily-b` }),
    ).toBeNull();
    expect(
      await sessionFeedQueries.sessionDetail(null, { sessionId: 'daily:board:unknown-uuid:sf-daily-a' }),
    ).toBeNull();
  });

  it('preserves the existing profile daily-card identifier and cross-board detail', async () => {
    const result = await callFeed({ userId: CLIMBER_USER_ID, includeDailyHighlights: true, limit: 50 });
    const sessionId = `daily:${CLIMBER_USER_ID}:2026-10-01`;
    expect(result.sessions.map((session) => session.sessionId)).toContain(sessionId);

    const detail = await sessionFeedQueries.sessionDetail(null, { sessionId });
    expect(detail?.ticks.map((tick) => tick.uuid).sort()).toEqual(['sf-daily-a', 'sf-daily-b', 'sf-daily-null']);
    expect(detail?.tickCount).toBe(3);
  });
});
