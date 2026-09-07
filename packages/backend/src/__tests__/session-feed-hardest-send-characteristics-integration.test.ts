import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { sessionFeedQueries } from '../graphql/resolvers/social/session-feed';

/**
 * Real-DB regression guard for #5245: `sessionGroupedFeed`'s hardestSend card
 * is built by `fetchHardestSendsBatch` -> `tickHighlightSelectSql` /
 * `mapTickHighlightRow`, the one tick-feed site the mock-based test suites
 * don't reach (the shared owner-boards lookup those mocks stub isn't shaped
 * for a populated hardestSend row). A real DB sidesteps that entirely: no
 * owner boards are inserted for the climber, so `fetchOwnerBoards` returns the
 * same empty result it would in production for an unmapped tick.
 *
 * Before this fix, `isNoMatch` here came from `isNoMatchClimb(description)`
 * alone — a documented no-op on Woods/MoonBoard — so a no-match climb whose
 * state lives only in `characteristics` (empty description) showed no ⊘ and
 * the Woods play drawer showed "Matching rule not recorded".
 */

const OWNER_USER_ID = 'sf-hardest-chars-owner';
const CLIMB_NO_MATCH = 'sf-hardest-chars-climb-no-match';
const CLIMB_UNRECORDED = 'sf-hardest-chars-climb-unrecorded';
const SESSION_NO_MATCH = 'sf-hardest-chars-session-no-match';
const SESSION_UNRECORDED = 'sf-hardest-chars-session-unrecorded';

type HardestSend = {
  characteristics: string[] | null;
  isNoMatch: boolean;
} | null;

type SessionFeedResult = {
  sessions: Array<{ sessionId: string; hardestSend: HardestSend }>;
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

const insertClimb = async (uuid: string, name: string, characteristics: string[] | null) => {
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, description, frames, frames_count, is_draft, is_listed, edge_left, edge_right, edge_bottom, edge_top, created_at)
    VALUES (${uuid}, 'kilter', 1, 'test-setter', ${name}, '', 'p1r1', 1, false, true, 0, 100, 0, 150, '2024-01-01')
    ON CONFLICT (uuid) DO NOTHING
  `);
  if (characteristics != null) {
    await db.execute(sql`
      UPDATE board_climbs
      SET characteristics = ${sql`ARRAY[${sql.join(
        characteristics.map((token) => sql`${token}`),
        sql`, `,
      )}]::text[]`}
      WHERE uuid = ${uuid}
    `);
  }
};

const insertSession = async (id: string) => {
  await db.execute(sql`
    INSERT INTO board_sessions (id, board_path, created_by_user_id, name, status)
    VALUES (${id}, ${'kilter/1/10/1,20/40'}, ${OWNER_USER_ID}, ${'Session ' + id}, 'active')
    ON CONFLICT (id) DO NOTHING
  `);
};

const insertSendTick = async (params: { uuid: string; sessionId: string; climbUuid: string; climbedAt: string }) => {
  await db.execute(sql`
    INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, attempt_count, difficulty, climbed_at, session_id)
    VALUES (${params.uuid}, ${OWNER_USER_ID}, 'kilter', ${params.climbUuid}, 40, 'send', 1, 20, ${params.climbedAt}, ${params.sessionId})
  `);
};

const cleanup = async () => {
  await db.execute(sql`DELETE FROM boardsesh_ticks WHERE session_id IN (${SESSION_NO_MATCH}, ${SESSION_UNRECORDED})`);
  await db.execute(sql`DELETE FROM board_sessions WHERE id IN (${SESSION_NO_MATCH}, ${SESSION_UNRECORDED})`);
  await db.execute(sql`DELETE FROM board_climbs WHERE uuid IN (${CLIMB_NO_MATCH}, ${CLIMB_UNRECORDED})`);
  await db.execute(sql`DELETE FROM "users" WHERE id = ${OWNER_USER_ID}`);
};

describe('sessionGroupedFeed hardestSend — characteristics (real DB, #5245)', () => {
  beforeAll(async () => {
    await cleanup();
    await insertUser(OWNER_USER_ID);

    await insertClimb(CLIMB_NO_MATCH, 'Hardest Chars No Match', ['no_match']);
    await insertSession(SESSION_NO_MATCH);
    await insertSendTick({
      uuid: 'sf-hardest-chars-tick-no-match',
      sessionId: SESSION_NO_MATCH,
      climbUuid: CLIMB_NO_MATCH,
      climbedAt: '2026-03-01 10:00:00',
    });

    await insertClimb(CLIMB_UNRECORDED, 'Hardest Chars Unrecorded', null);
    await insertSession(SESSION_UNRECORDED);
    await insertSendTick({
      uuid: 'sf-hardest-chars-tick-unrecorded',
      sessionId: SESSION_UNRECORDED,
      climbUuid: CLIMB_UNRECORDED,
      climbedAt: '2026-03-02 10:00:00',
    });
  });

  afterAll(async () => {
    await cleanup();
  });

  it('carries characteristics onto hardestSend and derives isNoMatch from it, not the (empty) description', async () => {
    const result = await callFeed({ limit: 50 });
    const session = result.sessions.find((candidate) => candidate.sessionId === SESSION_NO_MATCH);

    expect(session?.hardestSend?.characteristics).toEqual(['no_match']);
    expect(session?.hardestSend?.isNoMatch).toBe(true);
  });

  it('carries null (not []) when no characteristics are recorded', async () => {
    const result = await callFeed({ limit: 50 });
    const session = result.sessions.find((candidate) => candidate.sessionId === SESSION_UNRECORDED);

    expect(session?.hardestSend?.characteristics).toBeNull();
    expect(session?.hardestSend?.isNoMatch).toBe(false);
  });
});
