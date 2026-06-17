import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vite-plus/test';
import { eq, sql } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { screenshotFixtureMutations } from '../graphql/resolvers/sessions/screenshot-fixture';
import { sessionQueries } from '../graphql/resolvers/sessions/queries';

/**
 * Integration test for the App Store screenshot fixture.
 *
 * The per-worker test DB is built from migrations only (no board data), so we
 * seed the minimum the fixture queries: the screenshot user, a Kilter board
 * they own, a handful of listed climbs with stats, and the matching named
 * difficulty grades. We then drive `createScreenshotSession` end-to-end and
 * assert the seeded session is ACTIVE with 2 participants, a non-empty queue,
 * and ticks from 2 distinct climbers with non-null difficulty — exactly what
 * the in-session analytics / leaderboard render from. Finally
 * `endScreenshotSession` must remove the session AND its ticks, and the guard
 * must reject when SCREENSHOT_FIXTURE_USER_ID is unset.
 */

const SCREENSHOT_USER_ID = 'screenshot-fixture-test-user';
const DEMO_USER_ID = 'screenshot-demo-user';
const SESSION_ID = 'screenshot-party-session';
const BOARD_TYPE = 'kilter';
const LAYOUT_ID = 1;
const SIZE_ID = 2;
const SET_IDS = '3';
const ANGLE = 40;
const CLIMB_PREFIX = 'screenshot-fixture-climb-';

// Named grade ids that exist in board_difficulty_grades after seeding. The
// seeded climbs' display_difficulty rounds onto these so the fixture's
// grade-name lookup keeps them.
const GRADE_IDS = [10, 13, 15, 18, 20, 22];

function makeCtx(userId: string | undefined): ConnectionContext {
  return {
    connectionId: 'screenshot-fixture-test-conn',
    transport: 'http',
    isAuthenticated: userId != null,
    userId,
  };
}

async function seedUser(id: string, name: string): Promise<void> {
  await db
    .insert(dbSchema.users)
    .values({ id, name, email: `${id}@test.com`, emailVerified: new Date() })
    .onConflictDoNothing();
}

async function seedBoard(): Promise<void> {
  // Raw SQL (not Drizzle .insert) because the per-worker test DB schema
  // (schema-sql.ts) can lag the @boardsesh/db Drizzle schema; a Drizzle insert
  // auto-emits columns the worker table may not have yet. Reference only
  // worker-schema columns.
  await db.execute(sql`
    INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, angle, is_public)
    VALUES (${CLIMB_PREFIX + 'board'}, ${CLIMB_PREFIX + 'board'}, ${SCREENSHOT_USER_ID}, ${BOARD_TYPE}, ${LAYOUT_ID}, ${SIZE_ID}, ${SET_IDS}, 'Screenshot Test Board', ${ANGLE}, true)
    ON CONFLICT (uuid) DO NOTHING
  `);
}

async function seedGrades(): Promise<void> {
  for (const difficulty of GRADE_IDS) {
    const vGrade = difficulty - 6; // arbitrary but stable V-grade label
    await db
      .insert(dbSchema.boardDifficultyGrades)
      .values({
        boardType: BOARD_TYPE,
        difficulty,
        boulderName: `V${vGrade}`,
        routeName: null,
        isListed: true,
      })
      .onConflictDoNothing();
  }
}

async function seedClimbs(): Promise<void> {
  // Raw SQL for the same worker-schema-drift reason as seedBoard. Mirrors the
  // proven insertClimb / insertBoardClimbStats helpers in tick-queries.test.ts.
  for (let index = 0; index < GRADE_IDS.length; index++) {
    const uuid = `${CLIMB_PREFIX}${index}`;
    const difficulty = GRADE_IDS[index];
    await db.execute(sql`
      INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, frames, frames_count, is_draft, is_listed, edge_left, edge_right, edge_bottom, edge_top, created_at)
      VALUES (${uuid}, ${BOARD_TYPE}, ${LAYOUT_ID}, 'test-setter', ${'Screenshot Climb ' + index}, 'p1r1', 1, false, true, 0, 100, 0, 150, '2024-01-01')
      ON CONFLICT (uuid) DO NOTHING
    `);

    // Exact integer display_difficulty so Math.round maps cleanly onto the
    // named grade id.
    await db.execute(sql`
      INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, ascensionist_count, difficulty_average, quality_average)
      VALUES (${BOARD_TYPE}, ${uuid}, ${ANGLE}, ${difficulty}, 25, ${difficulty}, 4)
      ON CONFLICT (board_type, climb_uuid, angle) DO NOTHING
    `);
  }
}

async function cleanupSeed(): Promise<void> {
  await db.delete(dbSchema.boardseshTicks).where(eq(dbSchema.boardseshTicks.sessionId, SESSION_ID));
  await db.delete(dbSchema.boardSessions).where(eq(dbSchema.boardSessions.id, SESSION_ID));
}

describe('screenshot fixture mutations', () => {
  const previousEnv = process.env.SCREENSHOT_FIXTURE_USER_ID;

  beforeAll(async () => {
    await seedUser(SCREENSHOT_USER_ID, 'Screenshot User');
    await seedBoard();
    await seedGrades();
    await seedClimbs();
  });

  beforeEach(() => {
    // setup.ts truncates board_sessions/participants/queues between tests, so
    // re-establish a clean fixture-user state. (Seeded board/climbs/grades are
    // NOT in setup.ts's TRUNCATE set, so they survive across tests.)
    process.env.SCREENSHOT_FIXTURE_USER_ID = SCREENSHOT_USER_ID;
  });

  afterAll(async () => {
    if (previousEnv === undefined) {
      delete process.env.SCREENSHOT_FIXTURE_USER_ID;
    } else {
      process.env.SCREENSHOT_FIXTURE_USER_ID = previousEnv;
    }
    await cleanupSeed();
  });

  it('creates an ACTIVE 2-climber session with queue and ticks, then tears it down', async () => {
    const result = await screenshotFixtureMutations.createScreenshotSession(
      undefined,
      undefined,
      makeCtx(SCREENSHOT_USER_ID),
    );

    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.boardPath).toBe(`/${BOARD_TYPE}/${LAYOUT_ID}/${SIZE_ID}/${SET_IDS}/${ANGLE}`);

    // Session is active.
    const [session] = await db
      .select()
      .from(dbSchema.boardSessions)
      .where(eq(dbSchema.boardSessions.id, SESSION_ID))
      .limit(1);
    expect(session).toBeDefined();
    expect(session.status).toBe('active');
    expect(session.endedAt).toBeNull();
    expect(session.createdByUserId).toBe(SCREENSHOT_USER_ID);

    // Two participants: the screenshot user + the demo climber.
    const participants = await db
      .select()
      .from(dbSchema.boardSessionParticipants)
      .where(eq(dbSchema.boardSessionParticipants.sessionId, SESSION_ID));
    const participantIds = participants.map((p) => p.userId).sort();
    expect(participantIds).toEqual([DEMO_USER_ID, SCREENSHOT_USER_ID].sort());

    // The demo climber has a display name so it renders in the leaderboard.
    const [demoProfile] = await db
      .select()
      .from(dbSchema.userProfiles)
      .where(eq(dbSchema.userProfiles.userId, DEMO_USER_ID))
      .limit(1);
    expect(demoProfile?.displayName).toBeTruthy();

    // Non-empty queue with a current climb.
    const [queueRow] = await db
      .select()
      .from(dbSchema.boardSessionQueues)
      .where(eq(dbSchema.boardSessionQueues.sessionId, SESSION_ID))
      .limit(1);
    expect(queueRow).toBeDefined();
    expect(queueRow.queue.length).toBeGreaterThan(0);
    expect(queueRow.currentClimbQueueItem).not.toBeNull();
    expect(queueRow.currentClimbQueueItem?.uuid).toBe(queueRow.queue[0].uuid);

    // Ticks from 2 distinct users, every one with a non-null difficulty.
    const ticks = await db
      .select()
      .from(dbSchema.boardseshTicks)
      .where(eq(dbSchema.boardseshTicks.sessionId, SESSION_ID));
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.every((tick) => tick.difficulty != null)).toBe(true);
    expect(ticks.every((tick) => tick.status === 'send' || tick.status === 'flash')).toBe(true);
    const tickUserIds = new Set(ticks.map((tick) => tick.userId));
    expect(tickUserIds.size).toBe(2);
    expect(tickUserIds.has(SCREENSHOT_USER_ID)).toBe(true);
    expect(tickUserIds.has(DEMO_USER_ID)).toBe(true);

    // Tear down — the session AND its ticks must be gone.
    const ended = await screenshotFixtureMutations.endScreenshotSession(
      undefined,
      { sessionId: SESSION_ID },
      makeCtx(SCREENSHOT_USER_ID),
    );
    expect(ended).toBe(true);

    const sessionsAfter = await db
      .select()
      .from(dbSchema.boardSessions)
      .where(eq(dbSchema.boardSessions.id, SESSION_ID));
    expect(sessionsAfter).toHaveLength(0);

    const ticksAfter = await db
      .select()
      .from(dbSchema.boardseshTicks)
      .where(eq(dbSchema.boardseshTicks.sessionId, SESSION_ID));
    expect(ticksAfter).toHaveLength(0);
  });

  it('re-running createScreenshotSession resets to a clean, deterministic state', async () => {
    await screenshotFixtureMutations.createScreenshotSession(undefined, undefined, makeCtx(SCREENSHOT_USER_ID));
    const firstTicks = await db
      .select()
      .from(dbSchema.boardseshTicks)
      .where(eq(dbSchema.boardseshTicks.sessionId, SESSION_ID));

    // Second run reuses the same id and does not duplicate ticks/participants.
    const second = await screenshotFixtureMutations.createScreenshotSession(
      undefined,
      undefined,
      makeCtx(SCREENSHOT_USER_ID),
    );
    expect(second.sessionId).toBe(SESSION_ID);

    const secondTicks = await db
      .select()
      .from(dbSchema.boardseshTicks)
      .where(eq(dbSchema.boardseshTicks.sessionId, SESSION_ID));
    expect(secondTicks.length).toBe(firstTicks.length);

    const participants = await db
      .select()
      .from(dbSchema.boardSessionParticipants)
      .where(eq(dbSchema.boardSessionParticipants.sessionId, SESSION_ID));
    expect(participants).toHaveLength(2);

    await screenshotFixtureMutations.endScreenshotSession(
      undefined,
      { sessionId: SESSION_ID },
      makeCtx(SCREENSHOT_USER_ID),
    );
  });

  it('throws when SCREENSHOT_FIXTURE_USER_ID is unset (inert by default)', async () => {
    delete process.env.SCREENSHOT_FIXTURE_USER_ID;
    await expect(
      screenshotFixtureMutations.createScreenshotSession(undefined, undefined, makeCtx(SCREENSHOT_USER_ID)),
    ).rejects.toThrow(/disabled|SCREENSHOT_FIXTURE_USER_ID/);
  });

  it('throws when the caller is not the configured screenshot user', async () => {
    await expect(
      screenshotFixtureMutations.createScreenshotSession(undefined, undefined, makeCtx('some-other-user')),
    ).rejects.toThrow(/screenshot user/);
  });

  it('throws when the caller is unauthenticated', async () => {
    await expect(
      screenshotFixtureMutations.createScreenshotSession(undefined, undefined, makeCtx(undefined)),
    ).rejects.toThrow(/Authentication required/);
  });

  it('endScreenshotSession is idempotent when the session is already gone', async () => {
    const ended = await screenshotFixtureMutations.endScreenshotSession(
      undefined,
      { sessionId: 'screenshot-party-session-nonexistent' },
      makeCtx(SCREENSHOT_USER_ID),
    );
    expect(ended).toBe(true);
  });

  it('the session query returns a durable payload for the seeded session (join preview works with no live members)', async () => {
    await screenshotFixtureMutations.createScreenshotSession(undefined, undefined, makeCtx(SCREENSHOT_USER_ID));

    // Nobody is connected to the room manager for this DB-seeded session, so the
    // `session` query must fall back to the durable Postgres row — otherwise the
    // mobile join preview gets null and the screenshot auto-join never fires.
    const payload = await sessionQueries.session(undefined, { sessionId: SESSION_ID }, makeCtx(SCREENSHOT_USER_ID));
    expect(payload).not.toBeNull();
    expect(payload?.id).toBe(SESSION_ID);
    expect(payload?.boardPath).toBe(`/${BOARD_TYPE}/${LAYOUT_ID}/${SIZE_ID}/${SET_IDS}/${ANGLE}`);
    expect(payload?.endedAt).toBeNull();
    const userIds = new Set((payload?.users ?? []).map((sessionUser) => sessionUser.userId));
    expect(userIds).toEqual(new Set([DEMO_USER_ID, SCREENSHOT_USER_ID]));

    // A genuinely absent session is still null.
    const missing = await sessionQueries.session(
      undefined,
      { sessionId: 'no-such-session-xyz' },
      makeCtx(SCREENSHOT_USER_ID),
    );
    expect(missing).toBeNull();

    await screenshotFixtureMutations.endScreenshotSession(
      undefined,
      { sessionId: SESSION_ID },
      makeCtx(SCREENSHOT_USER_ID),
    );
  });

  it('endScreenshotSession leaves a session created by a different user untouched', async () => {
    // A real session owned by someone else — the screenshot user must not be able
    // to tear it down by passing its id.
    const otherSessionId = 'someone-elses-session';
    await seedUser('other-owner-user', 'Other Owner');
    await db.insert(dbSchema.boardSessions).values({
      id: otherSessionId,
      boardPath: `/${BOARD_TYPE}/${LAYOUT_ID}/${SIZE_ID}/${SET_IDS}/${ANGLE}`,
      status: 'active',
      createdByUserId: 'other-owner-user',
    });

    const ended = await screenshotFixtureMutations.endScreenshotSession(
      undefined,
      { sessionId: otherSessionId },
      makeCtx(SCREENSHOT_USER_ID),
    );
    expect(ended).toBe(true); // idempotent no-op — guard scopes teardown to the caller's own sessions

    const stillThere = await db
      .select()
      .from(dbSchema.boardSessions)
      .where(eq(dbSchema.boardSessions.id, otherSessionId));
    expect(stillThere).toHaveLength(1);

    await db.delete(dbSchema.boardSessions).where(eq(dbSchema.boardSessions.id, otherSessionId));
  });
});
