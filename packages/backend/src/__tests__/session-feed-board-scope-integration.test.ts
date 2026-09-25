import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
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
// Logs on board A without ever pressing Start: no session_id on the tick, so the
// feed can only show it as a daily highlight group (#5567, #5576).
const SOLO_USER_ID = 'sf-board-scope-solo';
const SOLO_DAY = '2026-02-04';
const SOLO_DAILY_GROUP = `daily:${SOLO_USER_ID}:${SOLO_DAY}`;
// 2026-02-06: the same climber also logged in a session (on board B) late that
// day, so the day belongs to that session's card. 2026-02-07: the session tick
// lands at midnight the NEXT day, so it must not hide the 7th.
const SESSION_DAY_GROUP = `daily:${SOLO_USER_ID}:2026-02-06`;
const EVE_OF_SESSION_GROUP = `daily:${SOLO_USER_ID}:2026-02-07`;
const CLIMB_UUID = 'sf-board-scope-climb-1';
const BOARD_A_UUID = 'sf-board-scope-board-a';
const BOARD_B_UUID = 'sf-board-scope-board-b';
const SESSION_ON_A = 'sf-board-scope-session-a';
const SESSION_ON_B = 'sf-board-scope-session-b';
const SESSION_NULL_BOARD = 'sf-board-scope-session-null';

let boardAId: number;
let boardBId: number;

type SessionFeedResult = {
  sessions: Array<{ sessionId: string; sessionType: string; tickCount: number }>;
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
  userId?: string;
}) => {
  await db.execute(sql`
    INSERT INTO boardsesh_ticks (uuid, user_id, board_type, board_id, climb_uuid, angle, status, attempt_count, difficulty, climbed_at, session_id)
    VALUES (${params.uuid}, ${params.userId ?? CLIMBER_USER_ID}, 'kilter', ${params.boardId}, ${CLIMB_UUID}, 40, 'send', 1, 20, ${params.climbedAt}, ${params.sessionId})
  `);
};

const cleanup = async () => {
  await db.execute(
    sql`DELETE FROM boardsesh_ticks WHERE session_id IN (${SESSION_ON_A}, ${SESSION_ON_B}, ${SESSION_NULL_BOARD})`,
  );
  await db.execute(sql`DELETE FROM boardsesh_ticks WHERE user_id = ${SOLO_USER_ID}`);
  await db.execute(
    sql`DELETE FROM board_sessions WHERE id IN (${SESSION_ON_A}, ${SESSION_ON_B}, ${SESSION_NULL_BOARD})`,
  );
  await db.execute(sql`DELETE FROM board_climbs WHERE uuid = ${CLIMB_UUID}`);
  await db.execute(sql`DELETE FROM user_boards WHERE uuid IN (${BOARD_A_UUID}, ${BOARD_B_UUID})`);
  await db.execute(sql`DELETE FROM "users" WHERE id IN (${OWNER_USER_ID}, ${CLIMBER_USER_ID}, ${SOLO_USER_ID})`);
};

describe('sessionGroupedFeed — exact board_id scoping (real DB)', () => {
  beforeAll(async () => {
    await cleanup();
    await insertUser(OWNER_USER_ID);
    await insertUser(CLIMBER_USER_ID);
    await insertUser(SOLO_USER_ID);
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

    // Two session-less ticks on board A, same day: one daily highlight group.
    await insertTick({
      uuid: 'sf-tick-solo-1',
      sessionId: null,
      boardId: boardAId,
      climbedAt: `${SOLO_DAY} 18:00:00`,
      userId: SOLO_USER_ID,
    });
    await insertTick({
      uuid: 'sf-tick-solo-2',
      sessionId: null,
      boardId: boardAId,
      climbedAt: `${SOLO_DAY} 18:30:00`,
      userId: SOLO_USER_ID,
    });

    await insertTick({
      uuid: 'sf-tick-solo-session-day',
      sessionId: null,
      boardId: boardAId,
      climbedAt: '2026-02-06 00:01:00',
      userId: SOLO_USER_ID,
    });
    await insertTick({
      uuid: 'sf-tick-solo-in-session',
      sessionId: SESSION_ON_B,
      boardId: boardBId,
      climbedAt: '2026-02-06 23:59:00',
      userId: SOLO_USER_ID,
    });
    await insertTick({
      uuid: 'sf-tick-solo-eve',
      sessionId: null,
      boardId: boardAId,
      climbedAt: '2026-02-07 23:59:00',
      userId: SOLO_USER_ID,
    });
    await insertTick({
      uuid: 'sf-tick-solo-midnight-session',
      sessionId: SESSION_ON_B,
      boardId: boardBId,
      climbedAt: '2026-02-08 00:00:00',
      userId: SOLO_USER_ID,
    });
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

  it('is unscoped when the boardUuid does not resolve to a board', async () => {
    const result = await callFeed({ boardUuid: 'sf-board-scope-nonexistent', limit: 50 });
    const sessionIds = result.sessions.map((s) => s.sessionId);

    // Unknown uuid behaves as today: no board filter, no error.
    expect(sessionIds).toContain(SESSION_ON_A);
    expect(sessionIds).toContain(SESSION_ON_B);
    expect(sessionIds).toContain(SESSION_NULL_BOARD);
  });

  describe('climbs logged without a session (daily highlights, #5567 / #5576)', () => {
    it("shows them on the board's own feed", async () => {
      const result = await callFeed({ boardUuid: BOARD_A_UUID, includeDailyHighlights: true, limit: 50 });

      const dailyGroup = result.sessions.find((session) => session.sessionId === SOLO_DAILY_GROUP);
      expect(dailyGroup?.sessionType).toBe('daily_highlight');
      expect(dailyGroup?.tickCount).toBe(2);
      // Party sessions on the board are still there alongside it.
      expect(result.sessions.map((session) => session.sessionId)).toContain(SESSION_ON_A);
    });

    it("keeps them off another board's feed", async () => {
      const result = await callFeed({ boardUuid: BOARD_B_UUID, includeDailyHighlights: true, limit: 50 });
      const sessionIds = result.sessions.map((session) => session.sessionId);

      expect(sessionIds).toContain(SESSION_ON_B);
      expect(sessionIds).not.toContain(SOLO_DAILY_GROUP);
    });

    it('keeps them off the unscoped Everyone feed (#4105 cost guard)', async () => {
      const result = await callFeed({ includeDailyHighlights: true, limit: 50 });
      const sessionIds = result.sessions.map((session) => session.sessionId);

      expect(sessionIds).toContain(SESSION_ON_A);
      expect(result.sessions.some((session) => session.sessionType === 'daily_highlight')).toBe(false);
    });

    it('leaves a day the climber spent in a session to that session, by calendar day', async () => {
      const result = await callFeed({ boardUuid: BOARD_A_UUID, includeDailyHighlights: true, limit: 50 });
      const sessionIds = result.sessions.map((session) => session.sessionId);

      expect(sessionIds).not.toContain(SESSION_DAY_GROUP);
      expect(sessionIds).toContain(EVE_OF_SESSION_GROUP);
    });

    it('pages through the same cards, in the same order, one at a time', async () => {
      const onePage = await callFeed({ boardUuid: BOARD_A_UUID, includeDailyHighlights: true, limit: 50 });
      expect(onePage.sessions.map((session) => session.sessionId)).toEqual([
        EVE_OF_SESSION_GROUP,
        SOLO_DAILY_GROUP,
        SESSION_ON_A,
      ]);

      const paged: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const result: SessionFeedResult = await callFeed({
          boardUuid: BOARD_A_UUID,
          includeDailyHighlights: true,
          limit: 1,
          ...(cursor ? { cursor } : {}),
        });
        paged.push(...result.sessions.map((session) => session.sessionId));
        if (!result.hasMore) break;
        cursor = result.cursor;
      }

      expect(paged).toEqual(onePage.sessions.map((session) => session.sessionId));
    });

    it('keeps them off the feed when the boardUuid does not resolve to a board', async () => {
      const result = await callFeed({
        boardUuid: 'sf-board-scope-nonexistent',
        includeDailyHighlights: true,
        limit: 50,
      });

      expect(result.sessions.some((session) => session.sessionType === 'daily_highlight')).toBe(false);
    });
  });
});
