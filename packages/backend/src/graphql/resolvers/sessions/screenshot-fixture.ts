import { v4 as uuidv4 } from 'uuid';
import { eq, and, desc, isNotNull } from 'drizzle-orm';
import type { ConnectionContext, ClimbQueueItem, Climb } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { requireAuthenticated } from '../shared/helpers';
import { logger } from '../../../utils/logger';

/**
 * App Store screenshot fixture.
 *
 * Stands up a fresh, ACTIVE, two-climber party session in Postgres so an
 * automated screenshot run (signed in as the curated screenshot user) can
 * deep-link into it and capture the live in-session view (queue, the
 * 2-climber leaderboard, the grade-distribution chart, per-climber hardest
 * sends and the tick history). `endScreenshotSession` tears it down so prod
 * stays clean.
 *
 * Inert by default: both mutations require the caller to be authenticated AND
 * to be the exact user named by `SCREENSHOT_FIXTURE_USER_ID`. A normal backend
 * leaves that env var unset, so the fixture rejects every caller. It is the
 * only switch that enables this code path.
 */

// Env-var that gates the whole fixture. Unset/empty ⇒ both mutations throw.
const SCREENSHOT_FIXTURE_USER_ID_ENV = 'SCREENSHOT_FIXTURE_USER_ID';

// Stable demo climber that plays the 2nd participant. Idempotent upsert keyed
// on this id, so re-runs reuse the same row (and its profile).
const DEMO_USER_ID = 'screenshot-demo-user';
const DEMO_USER_EMAIL = 'demo@screenshots.boardsesh.com';
const DEMO_USER_NAME = 'demo-climber';
const DEMO_USER_DISPLAY_NAME = 'Demo Climber';

// Deterministic session id so each run reuses (and resets) the same row.
const SCREENSHOT_SESSION_ID = 'screenshot-party-session';
const SCREENSHOT_SESSION_NAME = 'Sunset session';

// Fallback board when the screenshot user has no saved board. Kilter Original
// 12x12 @ 40° — mirrors the shape seed-social.ts uses for party sessions.
const FALLBACK_BOARD_TYPE = 'kilter';
const FALLBACK_BOARD_PATH = '/kilter/1/2/3/40';

// How many real climbs to pull for the queue + ticks.
const CLIMB_COUNT = 6;

type ResolvedBoard = {
  boardType: string;
  boardPath: string;
  boardId: number | null;
};

type ScreenshotClimb = {
  uuid: string;
  name: string;
  angle: number;
  difficulty: number;
  difficultyName: string;
};

type SeededTick = {
  userId: string;
  climb: ScreenshotClimb;
  status: 'send' | 'flash';
  minutesAgo: number;
};

/**
 * Guard shared by both mutations. Throws unless the caller is the configured
 * screenshot user. Returns the validated screenshot user id.
 */
function requireScreenshotUser(ctx: ConnectionContext): string {
  requireAuthenticated(ctx);
  const fixtureUserId = process.env[SCREENSHOT_FIXTURE_USER_ID_ENV]?.trim();
  if (!fixtureUserId) {
    throw new Error(
      `Screenshot fixture is disabled: ${SCREENSHOT_FIXTURE_USER_ID_ENV} is not set. ` +
        'This mutation is only available in screenshot environments.',
    );
  }
  if (ctx.userId !== fixtureUserId) {
    throw new Error('Screenshot fixture is only available to the configured screenshot user.');
  }
  return fixtureUserId;
}

/**
 * Resolve the screenshot user's board to a `boardPath` + numeric board id.
 * Falls back to a sane Kilter default when the user has no saved board so the
 * fixture still works on a fresh account.
 */
async function resolveScreenshotBoard(userId: string): Promise<ResolvedBoard> {
  const [board] = await db
    .select({
      id: dbSchema.userBoards.id,
      boardType: dbSchema.userBoards.boardType,
      layoutId: dbSchema.userBoards.layoutId,
      sizeId: dbSchema.userBoards.sizeId,
      setIds: dbSchema.userBoards.setIds,
      angle: dbSchema.userBoards.angle,
    })
    .from(dbSchema.userBoards)
    .where(eq(dbSchema.userBoards.ownerId, userId))
    .orderBy(desc(dbSchema.userBoards.id))
    .limit(1);

  if (board) {
    return {
      boardType: board.boardType,
      boardPath: `/${board.boardType}/${board.layoutId}/${board.sizeId}/${board.setIds}/${board.angle}`,
      boardId: board.id,
    };
  }

  return { boardType: FALLBACK_BOARD_TYPE, boardPath: FALLBACK_BOARD_PATH, boardId: null };
}

/**
 * Pull ~CLIMB_COUNT real, listed climbs on the given board type, each tagged
 * with a grade *id* that has a named row in `board_difficulty_grades`. The
 * tick `difficulty` written from these must be a valid grade id because the
 * session-detail / summary resolvers join `board_difficulty_grades` on
 * `(difficulty, boardType)` to label the grade chart, the hardest-send badges
 * and the leaderboard.
 *
 * `board_climb_stats.display_difficulty` is a float; grade ids are integers.
 * We can't join the two with `=` (the float rarely equals the id exactly), so
 * we round in JS and keep only climbs whose rounded difficulty is a named
 * grade id for the board type — pulled once into `gradeNameById`.
 */
async function fetchScreenshotClimbs(boardType: string): Promise<ScreenshotClimb[]> {
  const gradeRows = await db
    .select({
      difficulty: dbSchema.boardDifficultyGrades.difficulty,
      boulderName: dbSchema.boardDifficultyGrades.boulderName,
    })
    .from(dbSchema.boardDifficultyGrades)
    .where(
      and(eq(dbSchema.boardDifficultyGrades.boardType, boardType), eq(dbSchema.boardDifficultyGrades.isListed, true)),
    );

  const gradeNameById = new Map<number, string>();
  for (const grade of gradeRows) {
    if (grade.boulderName != null) gradeNameById.set(grade.difficulty, grade.boulderName);
  }

  // Pull more than CLIMB_COUNT so we can drop climbs whose rounded difficulty
  // has no named grade id and still end up with CLIMB_COUNT.
  const rows = await db
    .select({
      uuid: dbSchema.boardClimbs.uuid,
      name: dbSchema.boardClimbs.name,
      angle: dbSchema.boardClimbStats.angle,
      displayDifficulty: dbSchema.boardClimbStats.displayDifficulty,
    })
    .from(dbSchema.boardClimbs)
    .innerJoin(
      dbSchema.boardClimbStats,
      and(
        eq(dbSchema.boardClimbs.uuid, dbSchema.boardClimbStats.climbUuid),
        eq(dbSchema.boardClimbs.boardType, dbSchema.boardClimbStats.boardType),
      ),
    )
    .where(
      and(
        eq(dbSchema.boardClimbs.boardType, boardType),
        eq(dbSchema.boardClimbs.isListed, true),
        isNotNull(dbSchema.boardClimbStats.displayDifficulty),
      ),
    )
    .orderBy(desc(dbSchema.boardClimbStats.displayDifficulty))
    .limit(CLIMB_COUNT * 8);

  const climbs: ScreenshotClimb[] = [];
  for (const row of rows) {
    if (row.displayDifficulty == null) continue;
    const difficulty = Math.round(row.displayDifficulty);
    const gradeName = gradeNameById.get(difficulty);
    if (!gradeName) continue;
    climbs.push({
      uuid: row.uuid,
      name: row.name ?? 'Untitled climb',
      angle: row.angle,
      difficulty,
      difficultyName: gradeName,
    });
    if (climbs.length >= CLIMB_COUNT) break;
  }
  return climbs;
}

/**
 * Upsert the demo climber + its profile so it renders with a name in the
 * leaderboard and history. Idempotent on the stable id.
 */
async function upsertDemoUser(): Promise<void> {
  await db
    .insert(dbSchema.users)
    .values({
      id: DEMO_USER_ID,
      name: DEMO_USER_NAME,
      email: DEMO_USER_EMAIL,
      emailVerified: new Date(),
    })
    .onConflictDoNothing();

  await db
    .insert(dbSchema.userProfiles)
    .values({
      userId: DEMO_USER_ID,
      displayName: DEMO_USER_DISPLAY_NAME,
    })
    .onConflictDoUpdate({
      target: dbSchema.userProfiles.userId,
      set: { displayName: DEMO_USER_DISPLAY_NAME },
    });
}

/**
 * Build a hydrated ClimbQueueItem for the session queue. `tickedBy` reflects
 * the seeded ticks so the queue rows show their done-state.
 */
function buildQueueItem(climb: ScreenshotClimb, addedBy: string, tickedBy: string[]): ClimbQueueItem {
  const hydratedClimb: Climb = {
    uuid: climb.uuid,
    setter_username: '',
    name: climb.name,
    frames: '',
    angle: climb.angle,
    ascensionist_count: 0,
    difficulty: climb.difficultyName,
    quality_average: '0',
    stars: 0,
    difficulty_error: '0',
    benchmark_difficulty: null,
  };
  return {
    uuid: uuidv4(),
    climb: hydratedClimb,
    addedBy,
    tickedBy: tickedBy.length > 0 ? tickedBy : undefined,
    suggested: false,
  };
}

/**
 * Delete this session's children (ticks, queue, participants) so a re-run
 * starts from a clean, deterministic state. Ticks FK `set null` on session
 * delete, so they must be removed explicitly; queue + participants cascade,
 * but we delete them up-front so a reset can run without dropping the row.
 */
async function resetSessionChildren(sessionId: string): Promise<void> {
  await db.delete(dbSchema.boardseshTicks).where(eq(dbSchema.boardseshTicks.sessionId, sessionId));
  await db.delete(dbSchema.boardSessionQueues).where(eq(dbSchema.boardSessionQueues.sessionId, sessionId));
  await db.delete(dbSchema.boardSessionParticipants).where(eq(dbSchema.boardSessionParticipants.sessionId, sessionId));
}

export const screenshotFixtureMutations = {
  /**
   * Create (or reset + reuse) the deterministic screenshot party session.
   * Inert unless the caller is the configured screenshot user.
   */
  createScreenshotSession: async (
    _: unknown,
    __: unknown,
    ctx: ConnectionContext,
  ): Promise<{ sessionId: string; boardPath: string }> => {
    const screenshotUserId = requireScreenshotUser(ctx);

    const board = await resolveScreenshotBoard(screenshotUserId);
    const climbs = await fetchScreenshotClimbs(board.boardType);
    if (climbs.length === 0) {
      throw new Error(
        `Screenshot fixture: no listed climbs with a named grade found for board type "${board.boardType}". ` +
          'The board data must be seeded before running the screenshot fixture.',
      );
    }

    await upsertDemoUser();

    const now = Date.now();
    const startedAt = new Date(now);

    // Upsert the ACTIVE session row on the deterministic id, then reset its
    // children so a re-run is clean.
    await db
      .insert(dbSchema.boardSessions)
      .values({
        id: SCREENSHOT_SESSION_ID,
        boardPath: board.boardPath,
        status: 'active',
        createdByUserId: screenshotUserId,
        name: SCREENSHOT_SESSION_NAME,
        isPublic: true,
        startedAt,
        endedAt: null,
        boardId: board.boardId,
        createdAt: startedAt,
        lastActivity: startedAt,
      })
      .onConflictDoUpdate({
        target: dbSchema.boardSessions.id,
        set: {
          boardPath: board.boardPath,
          status: 'active',
          createdByUserId: screenshotUserId,
          name: SCREENSHOT_SESSION_NAME,
          isPublic: true,
          startedAt,
          endedAt: null,
          boardId: board.boardId,
          lastActivity: startedAt,
        },
      });

    await resetSessionChildren(SCREENSHOT_SESSION_ID);

    // Participants: both the screenshot user and the demo climber.
    await db
      .insert(dbSchema.boardSessionParticipants)
      .values([
        { sessionId: SCREENSHOT_SESSION_ID, userId: screenshotUserId, joinedAt: startedAt },
        { sessionId: SCREENSHOT_SESSION_ID, userId: DEMO_USER_ID, joinedAt: startedAt },
      ])
      .onConflictDoNothing();

    // Ticks: a believable mix — screenshot user 3 sends + 1 flash, demo
    // climber 2 sends + 1 flash — spread across the queried climbs over the
    // last hour. Each carries `difficulty` (with a resolvable grade name) so
    // the grade chart, hardest-send labels and 2-climber leaderboard render.
    const tickPlan: SeededTick[] = [
      { userId: screenshotUserId, climb: climbs[0], status: 'send', minutesAgo: 52 },
      { userId: screenshotUserId, climb: climbs[1 % climbs.length], status: 'send', minutesAgo: 41 },
      { userId: screenshotUserId, climb: climbs[2 % climbs.length], status: 'flash', minutesAgo: 28 },
      { userId: screenshotUserId, climb: climbs[3 % climbs.length], status: 'send', minutesAgo: 12 },
      { userId: DEMO_USER_ID, climb: climbs[1 % climbs.length], status: 'send', minutesAgo: 47 },
      { userId: DEMO_USER_ID, climb: climbs[4 % climbs.length], status: 'flash', minutesAgo: 33 },
      { userId: DEMO_USER_ID, climb: climbs[5 % climbs.length], status: 'send', minutesAgo: 6 },
    ];

    const tickRows: (typeof dbSchema.boardseshTicks.$inferInsert)[] = tickPlan.map((plan) => ({
      uuid: uuidv4(),
      userId: plan.userId,
      boardType: board.boardType,
      climbUuid: plan.climb.uuid,
      angle: plan.climb.angle,
      isMirror: false,
      status: plan.status,
      attemptCount: plan.status === 'flash' ? 1 : 2,
      quality: 4,
      difficulty: plan.climb.difficulty,
      isBenchmark: false,
      comment: '',
      climbedAt: new Date(now - plan.minutesAgo * 60 * 1000).toISOString(),
      sessionId: SCREENSHOT_SESSION_ID,
      boardId: board.boardId,
    }));
    await db.insert(dbSchema.boardseshTicks).values(tickRows);

    // Queue: ~5 hydrated items, with current = first. Mark queue items ticked
    // by whoever sent that climb so done-state shows on the rows.
    const tickedByClimb = new Map<string, Set<string>>();
    for (const plan of tickPlan) {
      const existing = tickedByClimb.get(plan.climb.uuid) ?? new Set<string>();
      existing.add(plan.userId);
      tickedByClimb.set(plan.climb.uuid, existing);
    }
    const queueClimbs = climbs.slice(0, Math.min(5, climbs.length));
    const queue: ClimbQueueItem[] = queueClimbs.map((climb, index) => {
      const addedBy = index % 2 === 0 ? screenshotUserId : DEMO_USER_ID;
      const tickedBy = [...(tickedByClimb.get(climb.uuid) ?? new Set<string>())];
      return buildQueueItem(climb, addedBy, tickedBy);
    });

    await db.insert(dbSchema.boardSessionQueues).values({
      sessionId: SCREENSHOT_SESSION_ID,
      queue,
      currentClimbQueueItem: queue[0] ?? null,
      version: 1,
      sequence: queue.length,
      updatedAt: startedAt,
    });

    logger.info(
      `[screenshot-fixture] created session ${SCREENSHOT_SESSION_ID} on ${board.boardPath} ` +
        `with ${queue.length} queue items + ${tickRows.length} ticks (2 climbers)`,
    );

    return { sessionId: SCREENSHOT_SESSION_ID, boardPath: board.boardPath };
  },

  /**
   * Tear down a screenshot session. Idempotent: no error if already gone.
   * Deletes the seeded ticks first (they FK `set null` on session delete, so
   * they would otherwise linger), then the session row (cascade removes queue
   * + participants). Inert unless the caller is the configured screenshot user.
   */
  endScreenshotSession: async (
    _: unknown,
    { sessionId }: { sessionId: string },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    const screenshotUserId = requireScreenshotUser(ctx);

    // Defense in depth (this deletes prod data): only tear down a session the
    // screenshot user actually created, so the env-gated fixture user can't
    // delete an arbitrary session's ticks by passing its id. Idempotent — a
    // missing or unowned session is a no-op.
    const [target] = await db
      .select({ id: dbSchema.boardSessions.id })
      .from(dbSchema.boardSessions)
      .where(
        and(eq(dbSchema.boardSessions.id, sessionId), eq(dbSchema.boardSessions.createdByUserId, screenshotUserId)),
      )
      .limit(1);
    if (!target) {
      logger.info(
        `[screenshot-fixture] endScreenshotSession: no fixture session ${sessionId} for caller; nothing to do`,
      );
      return true;
    }

    // Delete ticks explicitly so prod stays clean (session-delete only nulls
    // their sessionId), then drop the session — its queue + participants
    // cascade away.
    await db.delete(dbSchema.boardseshTicks).where(eq(dbSchema.boardseshTicks.sessionId, sessionId));
    await db.delete(dbSchema.boardSessions).where(eq(dbSchema.boardSessions.id, sessionId));

    logger.info(`[screenshot-fixture] ended session ${sessionId}`);
    return true;
  },
};
