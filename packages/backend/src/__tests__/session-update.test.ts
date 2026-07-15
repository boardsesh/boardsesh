/**
 * Real-DB coverage for the session-notes feature:
 *   - `updateSession` (title + recap notes) partial-update semantics, creator
 *     authorization, validation, and the SessionNameChanged broadcast,
 *   - `endSession` persisting the recap and echoing it in the summary,
 *   - `sessionDetail` round-tripping the stored notes.
 *
 * `applyRateLimit` is stubbed to a no-op (matching session-context.test.ts) so
 * these tests don't depend on the per-process/Redis rate limiter. Everything
 * else — the resolvers, validation, and the `db` client — is real.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vite-plus/test';
import { eq, sql } from 'drizzle-orm';
import type { ConnectionContext, SessionEvent } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { sessions } from '../db/schema';
import { sessionEditMutations } from '../graphql/resolvers/social/session-mutations';
import { sessionMutations } from '../graphql/resolvers/sessions/mutations';
import { sessionFeedQueries } from '../graphql/resolvers/social/session-feed';
import { pubsub } from '../pubsub/index';
import { roomManager } from '../services/room-manager';
import { createMockRedis } from './helpers/mock-redis';

vi.mock('../graphql/resolvers/shared/helpers', async (importOriginal) => {
  // Real validateInput / requireAuthenticated; bypass applyRateLimit so these
  // tests aren't subject to per-process/Redis rate limits.
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    applyRateLimit: vi.fn().mockResolvedValue(undefined),
  };
});

const CREATOR_ID = 'su-creator';
const OTHER_ID = 'su-other';

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'Test ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

const insertSession = (params: {
  id: string;
  createdBy: string | null;
  name?: string | null;
  notes?: string | null;
  status?: string;
}) =>
  db.execute(sql`
    INSERT INTO board_sessions (id, board_path, created_by_user_id, name, notes, status)
    VALUES (
      ${params.id},
      ${'kilter/1/10/1,20/40'},
      ${params.createdBy},
      ${params.name ?? null},
      ${params.notes ?? null},
      ${params.status ?? 'active'}
    )
    ON CONFLICT (id) DO NOTHING
  `);

const readRow = async (id: string) => {
  const [row] = await db
    .select({ name: sessions.name, notes: sessions.notes, lastActivity: sessions.lastActivity })
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);
  return row;
};

const creatorCtx = (overrides: Partial<ConnectionContext> = {}): ConnectionContext => ({
  connectionId: 'conn-su',
  transport: 'ws',
  userId: CREATOR_ID,
  participantId: CREATOR_ID,
  isAuthenticated: true,
  ...overrides,
});

const nameChangedEvents = () =>
  vi
    .mocked(pubsub.publishSessionEvent)
    .mock.calls.map((call) => call[1] as SessionEvent)
    .filter((event) => event.__typename === 'SessionNameChanged');

describe('updateSession (real DB)', () => {
  let publishSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    publishSpy = vi.spyOn(pubsub, 'publishSessionEvent').mockImplementation(() => {});
    await db.execute(sql`DELETE FROM board_sessions WHERE created_by_user_id IN (${CREATOR_ID}, ${OTHER_ID})`);
    await db.execute(sql`DELETE FROM board_sessions WHERE created_by_user_id IS NULL AND id LIKE 'su-%'`);
    await insertUser(CREATOR_ID);
    await insertUser(OTHER_ID);
  });

  afterEach(() => {
    publishSpy.mockRestore();
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM board_sessions WHERE id LIKE 'su-%'`);
    await db.execute(sql`DELETE FROM "users" WHERE id IN (${CREATOR_ID}, ${OTHER_ID})`);
  });

  it('sets the name only, leaving notes untouched', async () => {
    await insertSession({ id: 'su-name-only', createdBy: CREATOR_ID, name: 'Old', notes: 'Keep me' });

    const result = await sessionEditMutations.updateSession(
      undefined,
      { input: { sessionId: 'su-name-only', name: 'New title' } },
      creatorCtx(),
    );

    expect(result).toEqual({ sessionId: 'su-name-only', name: 'New title', notes: 'Keep me' });
    const row = await readRow('su-name-only');
    expect(row.name).toBe('New title');
    expect(row.notes).toBe('Keep me');
  });

  it('sets the notes only, leaving name untouched', async () => {
    await insertSession({ id: 'su-notes-only', createdBy: CREATOR_ID, name: 'Keep title', notes: null });

    const result = await sessionEditMutations.updateSession(
      undefined,
      { input: { sessionId: 'su-notes-only', notes: '  Great sesh  ' } },
      creatorCtx(),
    );

    expect(result).toEqual({ sessionId: 'su-notes-only', name: 'Keep title', notes: 'Great sesh' });
    const row = await readRow('su-notes-only');
    expect(row.name).toBe('Keep title');
    expect(row.notes).toBe('Great sesh');
  });

  it('sets name and notes together', async () => {
    await insertSession({ id: 'su-both', createdBy: CREATOR_ID, name: null, notes: null });

    await sessionEditMutations.updateSession(
      undefined,
      { input: { sessionId: 'su-both', name: 'Titled', notes: 'Recapped' } },
      creatorCtx(),
    );

    const row = await readRow('su-both');
    expect(row.name).toBe('Titled');
    expect(row.notes).toBe('Recapped');
  });

  it('clears notes on explicit null and on a whitespace-only string', async () => {
    await insertSession({ id: 'su-clear-null', createdBy: CREATOR_ID, notes: 'was here' });
    await insertSession({ id: 'su-clear-ws', createdBy: CREATOR_ID, notes: 'was here' });

    await sessionEditMutations.updateSession(
      undefined,
      { input: { sessionId: 'su-clear-null', notes: null } },
      creatorCtx(),
    );
    await sessionEditMutations.updateSession(
      undefined,
      { input: { sessionId: 'su-clear-ws', notes: '   ' } },
      creatorCtx(),
    );

    expect((await readRow('su-clear-null')).notes).toBeNull();
    expect((await readRow('su-clear-ws')).notes).toBeNull();
  });

  it('bumps lastActivity when it writes', async () => {
    await insertSession({ id: 'su-activity', createdBy: CREATOR_ID, name: 'x' });
    // Force lastActivity into the past so the bump is observable.
    await db.execute(sql`UPDATE board_sessions SET last_activity = now() - interval '1 hour' WHERE id = 'su-activity'`);
    const before = (await readRow('su-activity')).lastActivity as Date;

    await sessionEditMutations.updateSession(
      undefined,
      { input: { sessionId: 'su-activity', notes: 'touch' } },
      creatorCtx(),
    );

    const after = (await readRow('su-activity')).lastActivity as Date;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it('rejects a non-creator', async () => {
    await insertSession({ id: 'su-noncreator', createdBy: CREATOR_ID, name: 'Mine', notes: 'Mine' });

    await expect(
      sessionEditMutations.updateSession(
        undefined,
        { input: { sessionId: 'su-noncreator', name: 'Hijacked' } },
        creatorCtx({ userId: OTHER_ID, participantId: OTHER_ID }),
      ),
    ).rejects.toThrow(/Only the session creator/);

    const row = await readRow('su-noncreator');
    expect(row.name).toBe('Mine');
  });

  it('rejects an unauthenticated caller', async () => {
    await insertSession({ id: 'su-unauth', createdBy: CREATOR_ID, name: 'Mine' });

    await expect(
      sessionEditMutations.updateSession(
        undefined,
        { input: { sessionId: 'su-unauth', name: 'Nope' } },
        creatorCtx({ isAuthenticated: false, userId: undefined }),
      ),
    ).rejects.toThrow(/Authentication required/);
  });

  it('throws Session not found for an unknown sessionId', async () => {
    await expect(
      sessionEditMutations.updateSession(undefined, { input: { sessionId: 'su-missing', name: 'x' } }, creatorCtx()),
    ).rejects.toThrow(/Session not found/);
  });

  it('rejects an anonymous-created session (createdByUserId NULL)', async () => {
    await insertSession({ id: 'su-anon', createdBy: null, name: 'Anon session' });

    await expect(
      sessionEditMutations.updateSession(undefined, { input: { sessionId: 'su-anon', name: 'x' } }, creatorCtx()),
    ).rejects.toThrow(/Only the session creator/);
  });

  it('rejects a name over 100 chars and leaves the row unchanged', async () => {
    await insertSession({ id: 'su-longname', createdBy: CREATOR_ID, name: 'Original' });

    await expect(
      sessionEditMutations.updateSession(
        undefined,
        { input: { sessionId: 'su-longname', name: 'a'.repeat(101) } },
        creatorCtx(),
      ),
    ).rejects.toThrow(/Session name too long/);

    expect((await readRow('su-longname')).name).toBe('Original');
  });

  it('rejects notes over 2000 chars and leaves the row unchanged', async () => {
    await insertSession({ id: 'su-longnotes', createdBy: CREATOR_ID, notes: 'Original notes' });

    await expect(
      sessionEditMutations.updateSession(
        undefined,
        { input: { sessionId: 'su-longnotes', notes: 'a'.repeat(2001) } },
        creatorCtx(),
      ),
    ).rejects.toThrow(/Session notes too long/);

    expect((await readRow('su-longnotes')).notes).toBe('Original notes');
  });

  it('publishes SessionNameChanged when the title changes on an active session', async () => {
    await insertSession({ id: 'su-pub', createdBy: CREATOR_ID, name: 'Before', status: 'active' });

    await sessionEditMutations.updateSession(
      undefined,
      { input: { sessionId: 'su-pub', name: 'After' } },
      creatorCtx({ participantId: 'creator-participant' }),
    );

    const events = nameChangedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      __typename: 'SessionNameChanged',
      name: 'After',
      changedByParticipantId: 'creator-participant',
    });
  });

  it('does NOT publish on a notes-only change', async () => {
    await insertSession({ id: 'su-nopub-notes', createdBy: CREATOR_ID, name: 'Same', status: 'active' });

    await sessionEditMutations.updateSession(
      undefined,
      { input: { sessionId: 'su-nopub-notes', notes: 'recap only' } },
      creatorCtx(),
    );

    expect(nameChangedEvents()).toHaveLength(0);
  });

  it('does NOT publish when the name write does not change the value', async () => {
    await insertSession({ id: 'su-nopub-same', createdBy: CREATOR_ID, name: 'Unchanged', status: 'active' });

    await sessionEditMutations.updateSession(
      undefined,
      { input: { sessionId: 'su-nopub-same', name: 'Unchanged' } },
      creatorCtx(),
    );

    expect(nameChangedEvents()).toHaveLength(0);
  });

  it('does NOT publish when the session is ended', async () => {
    await insertSession({ id: 'su-nopub-ended', createdBy: CREATOR_ID, name: 'Before', status: 'ended' });

    await sessionEditMutations.updateSession(
      undefined,
      { input: { sessionId: 'su-nopub-ended', name: 'After' } },
      creatorCtx(),
    );

    // Still writes the row, but no live subscribers to notify.
    expect((await readRow('su-nopub-ended')).name).toBe('After');
    expect(nameChangedEvents()).toHaveLength(0);
  });
});

describe('sessionDetail round-trips notes (real DB)', () => {
  const DETAIL_USER = 'sd-notes-user';
  const DETAIL_SESSION = 'sd-notes-session';

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM boardsesh_ticks WHERE session_id = ${DETAIL_SESSION}`);
    await db.execute(sql`DELETE FROM board_sessions WHERE id = ${DETAIL_SESSION}`);
    await insertUser(DETAIL_USER);
    await insertSession({
      id: DETAIL_SESSION,
      createdBy: DETAIL_USER,
      name: 'Detail session',
      notes: 'Round-trip recap',
    });
    await db.execute(sql`
      INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, attempt_count, difficulty, climbed_at, session_id)
      VALUES ('sd-notes-tick-1', ${DETAIL_USER}, 'kilter', 'sd-notes-climb', 40, 'send', 1, 15, '2026-03-01 10:00:00', ${DETAIL_SESSION})
    `);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM boardsesh_ticks WHERE session_id = ${DETAIL_SESSION}`);
    await db.execute(sql`DELETE FROM board_sessions WHERE id = ${DETAIL_SESSION}`);
    await db.execute(sql`DELETE FROM "users" WHERE id = ${DETAIL_USER}`);
  });

  it('exposes the stored notes on the session detail', async () => {
    const detail = await sessionFeedQueries.sessionDetail(null, { sessionId: DETAIL_SESSION });
    expect(detail).not.toBeNull();
    expect(detail!.notes).toBe('Round-trip recap');
  });
});

describe('endSession persists notes (real DB)', () => {
  let mockRedis: ReturnType<typeof createMockRedis>;
  const END_USER = 'end-notes-creator';

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRedis = createMockRedis();
    roomManager.reset();
    await roomManager.initialize(mockRedis);
    vi.spyOn(pubsub, 'publishSessionEvent').mockImplementation(() => {});
    await insertUser(END_USER);
  });

  afterEach(async () => {
    roomManager.reset();
    vi.restoreAllMocks();
    await db.execute(sql`DELETE FROM board_sessions WHERE created_by_user_id = ${END_USER}`);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM "users" WHERE id = ${END_USER}`);
  });

  const httpCreatorCtx = (): ConnectionContext => ({
    connectionId: 'http-end',
    transport: 'http',
    userId: END_USER,
    isAuthenticated: true,
  });

  it('persists a trimmed recap and echoes it in the returned summary', async () => {
    const sessionId = 'end-notes-session-1';
    await roomManager.registerClient('end-conn-1', 'Creator', END_USER);
    await roomManager.joinSession('end-conn-1', sessionId, '/kilter/1/2/3/40', 'Creator');

    const summary = await sessionMutations.endSession(
      undefined,
      { sessionId, notes: '  Sent my project!  ' },
      httpCreatorCtx(),
    );

    expect(summary?.notes).toBe('Sent my project!');
    const [row] = await db.select({ notes: sessions.notes }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    expect(row.notes).toBe('Sent my project!');
  });

  it('leaves an existing recap untouched when endSession is called without notes', async () => {
    const sessionId = 'end-notes-session-2';
    await roomManager.registerClient('end-conn-2', 'Creator', END_USER);
    await roomManager.joinSession('end-conn-2', sessionId, '/kilter/1/2/3/40', 'Creator');
    await db.update(sessions).set({ notes: 'pre-existing recap' }).where(eq(sessions.id, sessionId));

    const summary = await sessionMutations.endSession(undefined, { sessionId }, httpCreatorCtx());

    expect(summary?.notes).toBe('pre-existing recap');
    const [row] = await db.select({ notes: sessions.notes }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    expect(row.notes).toBe('pre-existing recap');
  });
});
