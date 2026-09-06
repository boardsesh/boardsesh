import { describe, it, expect } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/client';
import { sessions } from '../db/schema';
import { users } from '@boardsesh/db/schema/auth';
import { eq } from 'drizzle-orm';
import { endStaleInactiveSessions, getSessionById, getUserSessions } from '../services/room-manager/session-discovery';

/**
 * `board_sessions` holds two kinds of row: explicit sessions (someone pressed Start,
 * live party mode applies) and inferred ones reconstructed from tick timing, which are
 * over before they exist and have no board path.
 *
 * Every live-session path has to scope itself to `origin = 'explicit'`. A missing guard
 * here does not throw or fail a request — it quietly rewrites reconstructed history, or
 * hands the party-mode machinery a row with nothing to join. So these assertions carry
 * the weight that an error message otherwise would.
 *
 * See docs/inferred-sessions.md.
 */

const ONE_HOUR_MS = 60 * 60 * 1000;

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60 * 1000);
}

async function insertInferredSession(overrides: Partial<typeof sessions.$inferInsert> = {}): Promise<string> {
  const id = uuidv4();
  await db.insert(sessions).values({
    id,
    // Null board path is the shape that would break a live path expecting a string.
    boardPath: null,
    origin: 'inferred',
    status: 'ended',
    isPermanent: false,
    ...overrides,
  });
  return id;
}

describe('live-session paths exclude inferred sessions', () => {
  it('getSessionById does not return an inferred session', async () => {
    const inferredId = await insertInferredSession();

    expect(await getSessionById(inferredId)).toBeNull();
  });

  it('getSessionById still returns an explicit session', async () => {
    const explicitId = uuidv4();
    await db.insert(sessions).values({ id: explicitId, boardPath: '/kilter/1/2/3/40', status: 'active' });

    const session = await getSessionById(explicitId);

    expect(session?.id).toBe(explicitId);
    expect(session?.boardPath).toBe('/kilter/1/2/3/40');
  });

  it('getUserSessions omits inferred sessions from a climber that has both', async () => {
    const userId = `user-${uuidv4()}`;
    await db
      .insert(users)
      .values({ id: userId, email: `${userId}@inferred-guard-test.local`, name: userId })
      .onConflictDoNothing();
    await db.insert(sessions).values({
      id: `explicit-${uuidv4()}`,
      boardPath: '/kilter/1/2/3/40',
      createdByUserId: userId,
      status: 'active',
    });
    const inferredId = await insertInferredSession({ createdByUserId: userId });

    const results = await getUserSessions(userId);

    expect(results).toHaveLength(1);
    expect(results.map((session) => session.id)).not.toContain(inferredId);
    // The survivor is usable as a live session — a board path, not null.
    expect(typeof results[0].boardPath).toBe('string');
  });

  // The sweep writes `ended_at` from `last_activity`. Letting it touch inferred rows
  // would overwrite durations derived from real tick times, silently.
  it('the auto-end sweep leaves an inferred session alone', async () => {
    const lastActivity = minutesAgo(180);
    const inferredId = await insertInferredSession({
      // Deliberately the shape the sweep looks for, so only the origin guard saves it.
      status: 'active',
      lastActivity,
      endedAt: null,
    });

    await endStaleInactiveSessions(ONE_HOUR_MS);

    const [row] = await db.select().from(sessions).where(eq(sessions.id, inferredId)).limit(1);
    expect(row?.status).toBe('active');
    expect(row?.endedAt).toBeNull();
  });

  it('the auto-end sweep still ends a stale explicit session', async () => {
    const explicitId = uuidv4();
    await db.insert(sessions).values({
      id: explicitId,
      boardPath: '/kilter/1/2/3/40',
      status: 'active',
      isPermanent: false,
      lastActivity: minutesAgo(180),
    });

    await endStaleInactiveSessions(ONE_HOUR_MS);

    const [row] = await db.select().from(sessions).where(eq(sessions.id, explicitId)).limit(1);
    expect(row?.status).toBe('ended');
  });
});

// reconcileWindow is idempotent when re-run in sequence, but two writers reconciling
// the same previously-unassigned run both read `sessionId: null` and both decide to
// create a session against the same anchor tick. Without this constraint both inserts
// land and their tick updates race, leaving a duplicate or empty session. The unique
// index is what turns that into a retryable error instead of silent corruption.
// Random rather than sequential so two parallel test runs never pick the same
// anchor tick id and collide on the unique partial index. A 10^15 range (safely
// under Number.MAX_SAFE_INTEGER, since anchor_tick_id is a bigint in number mode)
// keeps the collision odds negligible even if the integration test DB accumulates
// rows across many CI runs without cleanup.
function randomAnchorTickId(): number {
  return Math.floor(Math.random() * 1_000_000_000_000_000);
}

describe('anchor tick uniqueness', () => {
  it('refuses a second inferred session on the same anchor tick', async () => {
    const anchorTickId = randomAnchorTickId();
    await insertInferredSession({ anchorTickId });

    await expect(insertInferredSession({ anchorTickId })).rejects.toThrow();
  });

  it('lets an explicit session coexist with an inferred one on the same anchor', async () => {
    // The index is partial on origin='inferred', so explicit rows are unconstrained.
    const anchorTickId = randomAnchorTickId();
    await insertInferredSession({ anchorTickId });

    const explicitId = uuidv4();
    await expect(
      db.insert(sessions).values({ id: explicitId, boardPath: '/kilter/1/2/3/40', anchorTickId }),
    ).resolves.toBeDefined();
  });

  it('allows many inferred sessions with no anchor yet', async () => {
    // Postgres treats NULLs as distinct, so an unanchored row never blocks another.
    await insertInferredSession({ anchorTickId: null });

    await expect(insertInferredSession({ anchorTickId: null })).resolves.toBeTruthy();
  });
});

describe('board_sessions defaults', () => {
  it('defaults origin to explicit so existing party-mode inserts are unchanged', async () => {
    const id = uuidv4();
    await db.insert(sessions).values({ id, boardPath: '/kilter/1/2/3/40' });

    const [row] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    expect(row?.origin).toBe('explicit');
    expect(row?.userEdited).toBe(false);
    expect(row?.anchorTickId).toBeNull();
  });
});

// Backs up the origin guard at the DB level: even if a bug slipped a null path onto
// an explicit row, toLiveSession would silently return null for what should be a
// live session. Mirrors migration 0216's board_sessions_explicit_board_path_check.
describe('explicit sessions require a board path', () => {
  it('rejects an explicit session with a null board path', async () => {
    await expect(db.insert(sessions).values({ id: uuidv4(), boardPath: null, status: 'active' })).rejects.toThrow();
  });

  it('still allows an inferred session with a null board path', async () => {
    await expect(insertInferredSession()).resolves.toBeTruthy();
  });
});
