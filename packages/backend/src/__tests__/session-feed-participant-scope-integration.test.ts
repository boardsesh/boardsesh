import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { SessionFeedItem } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { sessionFeedQueries } from '../graphql/resolvers/social/session-feed';

/**
 * Real-DB integration coverage for PER-VIEWER scoping of the session-grouped
 * feed. The "You"/profile Sessions surfaces call sessionGroupedFeed({ userId }),
 * and used to show WHOLE-SESSION aggregates — so a party session inflated the
 * viewer's own sends/flashes/grades/hardest with their party-mates' climbs.
 *
 * This seeds one party session two climbers share:
 *   - VIEWER logs 3 sends (2 send + 1 flash), hardest at difficulty 15,
 *   - PARTNER logs 2 sends, BOTH harder (difficulty 20 and 25).
 *
 * and proves the product behaviour the fix wants:
 *   - sessionGroupedFeed({ userId: VIEWER }) returns the VIEWER's own totals
 *     (3 sends, 1 flash), grade distribution (sums to 3, not 5), and hardest
 *     send (difficulty 15 — the VIEWER's, not the partner's harder 25),
 *   - participants[] STAYS whole-session (both climbers, with each one's own
 *     sends) so the leaderboard is intact,
 *   - the same scoping holds independently for the PARTNER,
 *   - a feed with NO userId (the social/home feed) is UNSCOPED and keeps
 *     whole-session aggregates (5 sends, hardest 25).
 *
 * The mock-based session-feed-query.test.ts proves the SQL *shape* (the query
 * now carries `AND t.user_id = <id>` when a userId is set); this proves the
 * row-level numbers.
 */

const OWNER_USER_ID = 'sf-pscope-owner';
const VIEWER_USER_ID = 'sf-pscope-viewer';
const PARTNER_USER_ID = 'sf-pscope-partner';
const CLIMB_UUID = 'sf-pscope-climb-1';
const BOARD_UUID = 'sf-pscope-board';
const SESSION_ID = 'sf-pscope-session';

let boardId: number;

type SessionFeedResult = { sessions: SessionFeedItem[] };

const callFeed = (input: Record<string, unknown>) =>
  sessionFeedQueries.sessionGroupedFeed(null, { input }) as Promise<SessionFeedResult>;

const insertUser = async (id: string) => {
  await db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'Test ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
};

const insertBoard = async (uuid: string): Promise<number> => {
  const result = await db.execute(sql`
    INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name)
    VALUES (${uuid}, ${uuid}, ${OWNER_USER_ID}, 'kilter', 1, 10, '1,20', 'Participant Scope Board')
    ON CONFLICT (uuid) DO UPDATE SET slug = excluded.slug
    RETURNING id
  `);
  const rows = Array.from(result as Iterable<{ id: number }>);
  return Number(rows[0].id);
};

const insertClimb = async () => {
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, frames, frames_count, is_draft, is_listed, edge_left, edge_right, edge_bottom, edge_top, created_at)
    VALUES (${CLIMB_UUID}, 'kilter', 1, 'test-setter', 'Participant Scope Climb', 'p1r1', 1, false, true, 0, 100, 0, 150, '2024-01-01')
    ON CONFLICT (uuid) DO NOTHING
  `);
};

const insertSession = async () => {
  await db.execute(sql`
    INSERT INTO board_sessions (id, board_path, created_by_user_id, name, board_id, status)
    VALUES (${SESSION_ID}, ${'kilter/1/10/1,20/40'}, ${OWNER_USER_ID}, ${'Participant Scope Session'}, ${boardId}, 'active')
    ON CONFLICT (id) DO NOTHING
  `);
};

const insertTick = async (params: {
  uuid: string;
  userId: string;
  status: 'send' | 'flash' | 'attempt';
  difficulty: number;
  attemptCount: number;
  climbedAt: string;
}) => {
  await db.execute(sql`
    INSERT INTO boardsesh_ticks (uuid, user_id, board_type, board_id, climb_uuid, angle, status, attempt_count, difficulty, climbed_at, session_id)
    VALUES (${params.uuid}, ${params.userId}, 'kilter', ${boardId}, ${CLIMB_UUID}, 40, ${params.status}, ${params.attemptCount}, ${params.difficulty}, ${params.climbedAt}, ${SESSION_ID})
  `);
};

const cleanup = async () => {
  await db.execute(sql`DELETE FROM boardsesh_ticks WHERE session_id = ${SESSION_ID}`);
  await db.execute(sql`DELETE FROM board_sessions WHERE id = ${SESSION_ID}`);
  await db.execute(sql`DELETE FROM board_climbs WHERE uuid = ${CLIMB_UUID}`);
  await db.execute(sql`DELETE FROM user_boards WHERE uuid = ${BOARD_UUID}`);
  await db.execute(sql`DELETE FROM "users" WHERE id IN (${OWNER_USER_ID}, ${VIEWER_USER_ID}, ${PARTNER_USER_ID})`);
};

const findSession = (result: SessionFeedResult) => {
  const session = result.sessions.find((s) => s.sessionId === SESSION_ID);
  if (!session) throw new Error(`Seeded session ${SESSION_ID} missing from feed result`);
  return session;
};

const successCount = (session: SessionFeedItem) =>
  session.gradeDistribution.reduce((sum, item) => sum + item.flash + item.send, 0);

describe('sessionGroupedFeed — per-viewer scoping in party sessions (real DB)', () => {
  beforeAll(async () => {
    await cleanup();
    await insertUser(OWNER_USER_ID);
    await insertUser(VIEWER_USER_ID);
    await insertUser(PARTNER_USER_ID);
    await insertClimb();
    boardId = await insertBoard(BOARD_UUID);
    await insertSession();

    // VIEWER: 3 sends (2 send + 1 flash), 2 implicit attempts (the difficulty-15
    // send took 3 tries), hardest send at difficulty 15.
    await insertTick({
      uuid: 'sf-pscope-viewer-send-1',
      userId: VIEWER_USER_ID,
      status: 'send',
      difficulty: 10,
      attemptCount: 1,
      climbedAt: '2026-03-01 10:00:00',
    });
    await insertTick({
      uuid: 'sf-pscope-viewer-send-2',
      userId: VIEWER_USER_ID,
      status: 'send',
      difficulty: 15,
      attemptCount: 3,
      climbedAt: '2026-03-01 10:10:00',
    });
    await insertTick({
      uuid: 'sf-pscope-viewer-flash-1',
      userId: VIEWER_USER_ID,
      status: 'flash',
      difficulty: 12,
      attemptCount: 1,
      climbedAt: '2026-03-01 10:20:00',
    });

    // PARTNER: 2 sends, BOTH harder than the viewer's hardest (15) — so a
    // whole-session hardest would be the partner's 25, but the viewer-scoped
    // hardest must stay the viewer's 15.
    // The partner's ticks also BRACKET the viewer's 10:00-10:20 span (one before,
    // one after), so the viewer-scoped first/last tick (and durationMinutes) stay
    // the viewer's own 20-minute window while the whole session spans 35 minutes.
    await insertTick({
      uuid: 'sf-pscope-partner-send-1',
      userId: PARTNER_USER_ID,
      status: 'send',
      difficulty: 20,
      attemptCount: 1,
      climbedAt: '2026-03-01 09:55:00', // before the viewer's first tick
    });
    await insertTick({
      uuid: 'sf-pscope-partner-send-2',
      userId: PARTNER_USER_ID,
      status: 'send',
      difficulty: 25,
      attemptCount: 1,
      climbedAt: '2026-03-01 10:30:00', // after the viewer's last tick
    });
  });

  afterAll(async () => {
    await cleanup();
  });

  it('scopes the party-session aggregates to the viewer (their own 3 sends, not the whole party of 5)', async () => {
    const session = findSession(await callFeed({ userId: VIEWER_USER_ID, limit: 50 }));

    expect(session.totalSends).toBe(3);
    expect(session.totalFlashes).toBe(1);
    expect(session.totalAttempts).toBe(2);
    expect(session.tickCount).toBe(3);
    // Grade distribution is the viewer's own — sums to 3 successful ascents, not 5.
    expect(successCount(session)).toBe(3);
    // first/last tick (hence durationMinutes) are the viewer's 20-min window,
    // not the partner-widened 35-min whole-session span.
    expect(session.durationMinutes).toBe(20);
  });

  it("scopes hardestSend to the viewer (their difficulty 15, not the partner's harder 25)", async () => {
    const session = findSession(await callFeed({ userId: VIEWER_USER_ID, limit: 50 }));

    expect(session.hardestSend?.userId).toBe(VIEWER_USER_ID);
    expect(session.hardestSend?.difficulty).toBe(15);
  });

  it('keeps participants[] whole-session so the leaderboard stays intact', async () => {
    const session = findSession(await callFeed({ userId: VIEWER_USER_ID, limit: 50 }));

    expect(session.participants).toHaveLength(2);
    const viewer = session.participants.find((p) => p.userId === VIEWER_USER_ID);
    const partner = session.participants.find((p) => p.userId === PARTNER_USER_ID);
    expect(viewer).toMatchObject({ sends: 3, flashes: 1 });
    expect(partner).toMatchObject({ sends: 2, flashes: 0 });
  });

  it('scopes independently for the partner (their own 2 sends, hardest 25)', async () => {
    const session = findSession(await callFeed({ userId: PARTNER_USER_ID, limit: 50 }));

    expect(session.totalSends).toBe(2);
    expect(session.totalFlashes).toBe(0);
    expect(session.tickCount).toBe(2);
    expect(successCount(session)).toBe(2);
    expect(session.hardestSend?.userId).toBe(PARTNER_USER_ID);
    expect(session.hardestSend?.difficulty).toBe(25);
  });

  it('keeps whole-session aggregates when no userId is set (the social/home feed)', async () => {
    // boardUuid isolates the assertion to the seeded session without engaging
    // the per-user scope (participantFilterEnabled stays false).
    const session = findSession(await callFeed({ boardUuid: BOARD_UUID, limit: 50 }));

    expect(session.totalSends).toBe(5);
    expect(session.totalFlashes).toBe(1);
    expect(session.tickCount).toBe(5);
    expect(successCount(session)).toBe(5);
    // Whole-session hardest is the partner's 25.
    expect(session.hardestSend?.difficulty).toBe(25);
    expect(session.participants).toHaveLength(2);
    // Whole-session span covers both partner ticks (09:55 to 10:30).
    expect(session.durationMinutes).toBe(35);
  });
});
