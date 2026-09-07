import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { newClimbSubscriptionResolvers } from '../graphql/resolvers/social/new-climb-subscriptions';
import { sessionFeedQueries } from '../graphql/resolvers/social/session-feed';

/**
 * #5127 review gap: feed / tick / notification payloads derived `isNoMatch` from
 * the description alone, so a climb whose author turned the rule OFF — the editor
 * stores `[]` while keeping the setter's prose — published `isNoMatch: true` while
 * the climb view said false. Every payload now goes through resolveClimbNoMatch,
 * which needs `characteristics` selected in the query behind it.
 *
 * Real Postgres on purpose: a missing column in the drizzle select, or a typo'd
 * alias in the raw-SQL select list, reads back as `undefined` and silently falls
 * back to the description — exactly the bug. A mock cannot see that.
 */

const RUN_ID = crypto.randomUUID().slice(0, 8);
const LAYOUT_ID = 900127;
const OWNER_ID = `nm5127-owner-${RUN_ID}`;
const BOARD_UUID = `nm5127-board-${RUN_ID}`;
// The description that made the two disagree: the rule is declared after prose.
const TRAILING_NO_MATCH = 'Kick board is off. No matching.';
const CLIMB_EXPLICIT_FALSE = `nm5127-climb-off-${RUN_ID}`;
const CLIMB_NULL_ARRAY = `nm5127-climb-null-${RUN_ID}`;
const CLIMB_EXPLICIT_TRUE = `nm5127-climb-on-${RUN_ID}`;
const SESSION_EXPLICIT_FALSE = `nm5127-session-off-${RUN_ID}`;
const SESSION_NULL_ARRAY = `nm5127-session-null-${RUN_ID}`;

let boardId: number;

type NewClimbFeedItem = { uuid: string; isNoMatch: boolean };
type SessionFeedResult = {
  sessions: Array<{ sessionId: string; hardestSend: { climbUuid: string; isNoMatch: boolean } | null }>;
};

async function insertClimb(uuid: string, characteristics: string | null, description: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO board_climbs
      (uuid, board_type, layout_id, angle, setter_username, name, description, characteristics, frames, is_draft, is_listed, created_at)
    VALUES (
      ${uuid}, 'kilter', ${LAYOUT_ID}, 40, 'nm5127-setter', 'No-match fixture', ${description},
      ${characteristics}::text[], 'p1080r12', false, true, '2026-01-01'
    )
    ON CONFLICT (uuid) DO NOTHING
  `);
}

async function insertSessionWithSend(sessionId: string, climbUuid: string, climbedAt: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO board_sessions (id, board_path, created_by_user_id, name, board_id, status)
    VALUES (${sessionId}, ${`kilter/${LAYOUT_ID}/10/1,20/40`}, ${OWNER_ID}, 'No-match fixture session', ${boardId}, 'active')
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO boardsesh_ticks
      (uuid, user_id, board_type, board_id, climb_uuid, angle, status, attempt_count, difficulty, climbed_at, session_id)
    VALUES (${`${sessionId}-tick`}, ${OWNER_ID}, 'kilter', ${boardId}, ${climbUuid}, 40, 'send', 1, 20, ${climbedAt}, ${sessionId})
    ON CONFLICT (uuid) DO NOTHING
  `);
}

// Scoped to the fixture LAYOUT_ID, not to this run's uuids: a run that dies
// between beforeAll and afterAll would otherwise strand its rows forever, and
// newClimbFeed reads this layout with a fixed limit — enough leaked runs and the
// current one falls off the page.
async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM boardsesh_ticks WHERE climb_uuid IN (
    SELECT uuid FROM board_climbs WHERE board_type = 'kilter' AND layout_id = ${LAYOUT_ID})`);
  await db.execute(sql`DELETE FROM board_sessions WHERE created_by_user_id = ${OWNER_ID}`);
  await db.execute(sql`DELETE FROM board_climbs WHERE board_type = 'kilter' AND layout_id = ${LAYOUT_ID}`);
  await db.execute(sql`DELETE FROM user_boards WHERE owner_id = ${OWNER_ID}`);
  await db.execute(sql`DELETE FROM "users" WHERE id = ${OWNER_ID}`);
}

describe('no-match payloads read characteristics, not just the description (#5127)', () => {
  beforeAll(async () => {
    await cleanup();

    await db.execute(sql`
      INSERT INTO "users" (id, email, name, created_at, updated_at)
      VALUES (${OWNER_ID}, ${`${OWNER_ID}@test.invalid`}, 'No-match fixture owner', now(), now())
      ON CONFLICT (id) DO NOTHING
    `);
    const boardRows = await db.execute(sql`
      INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name)
      VALUES (${BOARD_UUID}, ${`nm5127-${RUN_ID}`}, ${OWNER_ID}, 'kilter', ${LAYOUT_ID}, 10, '1,20', 'No-match fixture board')
      ON CONFLICT (uuid) DO UPDATE SET slug = excluded.slug
      RETURNING id
    `);
    boardId = Number(Array.from(boardRows as Iterable<{ id: number }>)[0].id);

    // The author turned the rule off; the prose still declares it.
    await insertClimb(CLIMB_EXPLICIT_FALSE, '{}', TRAILING_NO_MATCH);
    // Never edited on Boardsesh — the Aurora description is all there is.
    await insertClimb(CLIMB_NULL_ARRAY, null, TRAILING_NO_MATCH);
    // The rule is on, and the description says nothing about it.
    await insertClimb(CLIMB_EXPLICIT_TRUE, '{no_match}', 'Crimpy start, big move off the gaston');

    await insertSessionWithSend(SESSION_EXPLICIT_FALSE, CLIMB_EXPLICIT_FALSE, '2026-02-01 10:00:00');
    await insertSessionWithSend(SESSION_NULL_ARRAY, CLIMB_NULL_ARRAY, '2026-02-02 10:00:00');
  });

  afterAll(async () => {
    await cleanup();
  });

  it('newClimbFeed lets an empty characteristics array override the prose', async () => {
    const result = (await newClimbSubscriptionResolvers.Query.newClimbFeed(null, {
      input: { boardType: 'kilter', layoutId: LAYOUT_ID, limit: 100 },
    })) as { items: NewClimbFeedItem[] };

    const byUuid = new Map(result.items.map((item) => [item.uuid, item.isNoMatch]));
    expect(byUuid.get(CLIMB_EXPLICIT_FALSE)).toBe(false);
    // Same description, no array — the Aurora fallback still applies.
    expect(byUuid.get(CLIMB_NULL_ARRAY)).toBe(true);
    // The array is authoritative in both directions.
    expect(byUuid.get(CLIMB_EXPLICIT_TRUE)).toBe(true);
  });

  it("sessionGroupedFeed's hardest send reads the array through the raw-SQL select list", async () => {
    const result = (await sessionFeedQueries.sessionGroupedFeed(null, {
      input: { boardUuid: BOARD_UUID, limit: 50 },
    })) as SessionFeedResult;

    const sends = new Map(result.sessions.map((session) => [session.sessionId, session.hardestSend]));
    expect(sends.get(SESSION_EXPLICIT_FALSE)?.climbUuid).toBe(CLIMB_EXPLICIT_FALSE);
    expect(sends.get(SESSION_EXPLICIT_FALSE)?.isNoMatch).toBe(false);
    expect(sends.get(SESSION_NULL_ARRAY)?.climbUuid).toBe(CLIMB_NULL_ARRAY);
    expect(sends.get(SESSION_NULL_ARRAY)?.isNoMatch).toBe(true);
  });
});
