import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { SessionFeedItem } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { sessionFeedQueries } from '../graphql/resolvers/social/session-feed';

/**
 * A day spent projecting is still a day's climbing.
 *
 * The day-grouped rows that surface session-less ticks used to be built by
 * INNER JOINing a "hardest send" pick that only ranked flash/send rows, so a day of
 * pure attempts produced no row at all and the climber saw "No sessions yet" despite
 * having logged climbs — the same complaint #4975 was filed about. Fleet-wide that hid
 * 4,408 ticks across 1,343 days and 385 climbers.
 *
 * The highlight tick also anchors the row's votes and comments, so an attempt-only day
 * needs a real tick uuid — but must not report that attempt as an ascent.
 */

const USER_ID = 'sf-attempt-only-user';
const CLIMB_UUID = 'sf-attempt-only-climb';
const BOARD_UUID = 'sf-attempt-only-board';
const ATTEMPT_DAY = '2026-03-02';
const SEND_DAY = '2026-03-05';

let boardId: number;

type SessionFeedResult = { sessions: SessionFeedItem[] };

const callFeed = (input: Record<string, unknown>) =>
  sessionFeedQueries.sessionGroupedFeed(null, { input }) as Promise<SessionFeedResult>;

const insertTick = async (params: {
  uuid: string;
  status: 'send' | 'flash' | 'attempt';
  difficulty: number;
  climbedAt: string;
}) => {
  await db.execute(sql`
    INSERT INTO boardsesh_ticks (uuid, user_id, board_type, board_id, climb_uuid, angle, status, attempt_count, difficulty, climbed_at, session_id)
    VALUES (${params.uuid}, ${USER_ID}, 'kilter', ${boardId}, ${CLIMB_UUID}, 40, ${params.status}, 3, ${params.difficulty}, ${params.climbedAt}, NULL)
  `);
};

const cleanup = async () => {
  await db.execute(sql`DELETE FROM boardsesh_ticks WHERE user_id = ${USER_ID}`);
  await db.execute(sql`DELETE FROM board_climbs WHERE uuid = ${CLIMB_UUID}`);
  await db.execute(sql`DELETE FROM user_boards WHERE uuid = ${BOARD_UUID}`);
  await db.execute(sql`DELETE FROM "users" WHERE id = ${USER_ID}`);
};

const dayRow = (result: SessionFeedResult, day: string) =>
  result.sessions.find((session) => session.sessionId === `daily:${USER_ID}:${day}`);

describe('sessionGroupedFeed — attempt-only days (real DB)', () => {
  beforeAll(async () => {
    await cleanup();
    await db.execute(sql`
      INSERT INTO "users" (id, email, name, created_at, updated_at)
      VALUES (${USER_ID}, ${USER_ID + '@test.com'}, 'Attempt Only', now(), now())
      ON CONFLICT (id) DO NOTHING
    `);
    const boardResult = await db.execute(sql`
      INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name)
      VALUES (${BOARD_UUID}, ${BOARD_UUID}, ${USER_ID}, 'kilter', 1, 10, '1,20', 'Attempt Only Board')
      ON CONFLICT (uuid) DO UPDATE SET slug = excluded.slug
      RETURNING id
    `);
    boardId = Number(Array.from(boardResult as Iterable<{ id: number }>)[0].id);
    await db.execute(sql`
      INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, frames, frames_count, is_draft, is_listed, edge_left, edge_right, edge_bottom, edge_top, created_at)
      VALUES (${CLIMB_UUID}, 'kilter', 1, 'test-setter', 'Attempt Only Climb', 'p1r1', 1, false, true, 0, 100, 0, 150, '2024-01-01')
      ON CONFLICT (uuid) DO NOTHING
    `);

    // A day of pure projecting.
    await insertTick({
      uuid: 'sf-ao-attempt-1',
      status: 'attempt',
      difficulty: 20,
      climbedAt: `${ATTEMPT_DAY} 10:00:00`,
    });
    await insertTick({
      uuid: 'sf-ao-attempt-2',
      status: 'attempt',
      difficulty: 24,
      climbedAt: `${ATTEMPT_DAY} 10:30:00`,
    });
    // A day with a send, to prove the existing behaviour is untouched.
    await insertTick({ uuid: 'sf-ao-attempt-3', status: 'attempt', difficulty: 26, climbedAt: `${SEND_DAY} 10:00:00` });
    await insertTick({ uuid: 'sf-ao-send-1', status: 'send', difficulty: 22, climbedAt: `${SEND_DAY} 11:00:00` });
  });

  afterAll(cleanup);

  it('returns a day row for a day with only attempts', async () => {
    const result = await callFeed({ userId: USER_ID, includeDailyHighlights: true, limit: 50 });

    const row = dayRow(result, ATTEMPT_DAY);
    expect(row).toBeDefined();
    expect(row?.tickCount).toBe(2);
    expect(row?.totalSends).toBe(0);
  });

  it('anchors that row on a real tick so votes and comments can attach', async () => {
    const result = await callFeed({ userId: USER_ID, includeDailyHighlights: true, limit: 50 });

    const row = dayRow(result, ATTEMPT_DAY);
    // 'tick' + a real uuid, never the synthetic `daily:` id — validateEntityExists
    // would reject that, so voting and commenting would fail outright.
    expect(row?.socialEntityType).toBe('tick');
    expect(row?.socialEntityId).toMatch(/^sf-ao-attempt-/);
  });

  it('does not report the attempt as a send', async () => {
    const result = await callFeed({ userId: USER_ID, includeDailyHighlights: true, limit: 50 });

    expect(dayRow(result, ATTEMPT_DAY)?.hardestSend).toBeNull();
  });

  it('still picks the send as the highlight on a day that has one', async () => {
    const result = await callFeed({ userId: USER_ID, includeDailyHighlights: true, limit: 50 });

    const row = dayRow(result, SEND_DAY);
    expect(row?.socialEntityId).toBe('sf-ao-send-1');
    // The harder tick that day was an attempt (26 vs 22); sends still outrank it.
    expect(row?.hardestSend).not.toBeNull();
  });
});
