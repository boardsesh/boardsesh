import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { roomManager } from '../services/room-manager';
import { db } from '../db/client';
import { sessions } from '../db/schema';
import { eq, and, ne, lt, isNull } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { createMockRedis, type MockRedis } from './helpers/mock-redis';

// Helper function to register a client before joining
const registerAndJoinSession = async (
  clientId: string,
  sessionId: string,
  boardPath: string,
  username?: string
) => {
  await roomManager.registerClient(clientId);
  return roomManager.joinSession(clientId, sessionId, boardPath, username);
};

describe('Session Expiration - Max Duration', () => {
  let mockRedis: MockRedis;

  beforeEach(async () => {
    mockRedis = createMockRedis();
    roomManager.reset();
    await roomManager.initialize(mockRedis);
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it('should find sessions older than 6 hours with the expiration query', async () => {
    const sessionId = uuidv4();
    const boardPath = '/kilter/1/2/3/40';

    // Create session and join
    await registerAndJoinSession('client-exp-1', sessionId, boardPath, 'User1');

    // Manually set startedAt to 7 hours ago
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000);
    await db
      .update(sessions)
      .set({ startedAt: sevenHoursAgo, createdAt: sevenHoursAgo })
      .where(eq(sessions.id, sessionId));

    // Run the same query as the auto-end job
    const maxDurationThreshold = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const expired = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.isPermanent, false),
          isNull(sessions.endedAt),
          ne(sessions.status, 'ended'),
          lt(sql`COALESCE(${sessions.startedAt}, ${sessions.createdAt})`, maxDurationThreshold)
        )
      )
      .limit(50);

    expect(expired.some((r) => r.id === sessionId)).toBe(true);

    // Clean up
    await roomManager.leaveSession('client-exp-1');
    await roomManager.endSession(sessionId);
  });

  it('should NOT find sessions younger than 6 hours', async () => {
    const sessionId = uuidv4();
    const boardPath = '/kilter/1/2/3/40';

    // Create session — startedAt will be now
    await registerAndJoinSession('client-exp-2', sessionId, boardPath, 'User2');

    const maxDurationThreshold = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const expired = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.isPermanent, false),
          isNull(sessions.endedAt),
          ne(sessions.status, 'ended'),
          lt(sql`COALESCE(${sessions.startedAt}, ${sessions.createdAt})`, maxDurationThreshold)
        )
      )
      .limit(50);

    expect(expired.some((r) => r.id === sessionId)).toBe(false);

    // Clean up
    await roomManager.leaveSession('client-exp-2');
    await roomManager.endSession(sessionId);
  });

  it('should NOT find isPermanent sessions even if older than 6 hours', async () => {
    const sessionId = uuidv4();
    const boardPath = '/kilter/1/2/3/40';

    // Create session
    await registerAndJoinSession('client-exp-3', sessionId, boardPath, 'User3');

    // Set as permanent and old
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000);
    await db
      .update(sessions)
      .set({ isPermanent: true, startedAt: sevenHoursAgo, createdAt: sevenHoursAgo })
      .where(eq(sessions.id, sessionId));

    const maxDurationThreshold = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const expired = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.isPermanent, false),
          isNull(sessions.endedAt),
          ne(sessions.status, 'ended'),
          lt(sql`COALESCE(${sessions.startedAt}, ${sessions.createdAt})`, maxDurationThreshold)
        )
      )
      .limit(50);

    expect(expired.some((r) => r.id === sessionId)).toBe(false);

    // Clean up — reset isPermanent to allow cleanup
    await db.update(sessions).set({ isPermanent: false }).where(eq(sessions.id, sessionId));
    await roomManager.leaveSession('client-exp-3');
    await roomManager.endSession(sessionId);
  });

  it('should NOT find already-ended sessions', async () => {
    const sessionId = uuidv4();
    const boardPath = '/kilter/1/2/3/40';

    // Create session, join, leave, end
    await registerAndJoinSession('client-exp-4', sessionId, boardPath, 'User4');
    await roomManager.leaveSession('client-exp-4');

    // Backdate and end
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000);
    await db
      .update(sessions)
      .set({ startedAt: sevenHoursAgo, createdAt: sevenHoursAgo })
      .where(eq(sessions.id, sessionId));

    await roomManager.endSession(sessionId);

    const maxDurationThreshold = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const expired = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.isPermanent, false),
          isNull(sessions.endedAt),
          ne(sessions.status, 'ended'),
          lt(sql`COALESCE(${sessions.startedAt}, ${sessions.createdAt})`, maxDurationThreshold)
        )
      )
      .limit(50);

    expect(expired.some((r) => r.id === sessionId)).toBe(false);
  });

  it('should use createdAt as fallback when startedAt is null', async () => {
    const sessionId = uuidv4();
    const boardPath = '/kilter/1/2/3/40';

    // Create session
    await registerAndJoinSession('client-exp-5', sessionId, boardPath, 'User5');

    // Set startedAt to null and createdAt to 7 hours ago
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000);
    await db
      .update(sessions)
      .set({ startedAt: null, createdAt: sevenHoursAgo })
      .where(eq(sessions.id, sessionId));

    const maxDurationThreshold = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const expired = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.isPermanent, false),
          isNull(sessions.endedAt),
          ne(sessions.status, 'ended'),
          lt(sql`COALESCE(${sessions.startedAt}, ${sessions.createdAt})`, maxDurationThreshold)
        )
      )
      .limit(50);

    expect(expired.some((r) => r.id === sessionId)).toBe(true);

    // Clean up
    await roomManager.leaveSession('client-exp-5');
    await roomManager.endSession(sessionId);
  });

  it('should find both active and inactive expired sessions', async () => {
    const activeSessionId = uuidv4();
    const inactiveSessionId = uuidv4();
    const boardPath = '/kilter/1/2/3/40';

    // Create active session (user still connected)
    await registerAndJoinSession('client-exp-6a', activeSessionId, boardPath, 'Active');

    // Create inactive session (user left)
    await registerAndJoinSession('client-exp-6b', inactiveSessionId, boardPath, 'Inactive');
    await roomManager.leaveSession('client-exp-6b');

    // Backdate both
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000);
    await db
      .update(sessions)
      .set({ startedAt: sevenHoursAgo, createdAt: sevenHoursAgo })
      .where(eq(sessions.id, activeSessionId));
    await db
      .update(sessions)
      .set({ startedAt: sevenHoursAgo, createdAt: sevenHoursAgo })
      .where(eq(sessions.id, inactiveSessionId));

    const maxDurationThreshold = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const expired = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.isPermanent, false),
          isNull(sessions.endedAt),
          ne(sessions.status, 'ended'),
          lt(sql`COALESCE(${sessions.startedAt}, ${sessions.createdAt})`, maxDurationThreshold)
        )
      )
      .limit(50);

    const expiredIds = expired.map((r) => r.id);
    expect(expiredIds).toContain(activeSessionId);
    expect(expiredIds).toContain(inactiveSessionId);

    // Clean up
    await roomManager.leaveSession('client-exp-6a');
    await roomManager.endSession(activeSessionId);
    await roomManager.endSession(inactiveSessionId);
  });
});
