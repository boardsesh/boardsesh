/**
 * Tests for the sessionStatus query (#2683).
 *
 * sessionStatus reads the durable session row so an ended session reads as
 * ended even when no participants are connected — unlike `session`, which
 * returns null for any empty roster and so can't tell an ended session apart
 * from a dormant-but-active solo session. Clients call it on cold start to
 * decide whether to restore or drop a persisted session id.
 */

import type { ConnectionContext } from '@boardsesh/shared-schema';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const dbClient = vi.hoisted(() => {
  const limit = vi.fn();
  return {
    limit,
    db: {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit,
    },
  };
});

// Mock connection-opening modules so importing the resolver barrel is side-effect-free.
const restore = vi.hoisted(() => ({ canAccess: vi.fn(), getSessionById: vi.fn(), project: vi.fn() }));
vi.mock('../services/room-manager', () => ({ roomManager: { getSessionById: restore.getSessionById } }));
vi.mock('../services/privacy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/privacy')>()),
  canAccessResource: restore.canAccess,
}));
vi.mock('../services/board-session-privacy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/board-session-privacy')>()),
  projectSessionBoardPath: restore.project,
}));
vi.mock('../pubsub/index', () => ({ pubsub: {} }));
vi.mock('../services/distributed-state', () => ({ getDistributedState: () => null }));
vi.mock('../db/client', () => ({ db: dbClient.db, dbRead: dbClient.db }));

import { sessionQueries } from '../graphql/resolvers/sessions/queries';

describe('sessionStatus query', () => {
  beforeEach(() => {
    // limit holds per-test return values, so reset it; the chain stubs keep
    // their mockReturnThis impl but get their call history cleared.
    dbClient.limit.mockReset();
    dbClient.db.select.mockClear();
    dbClient.db.from.mockClear();
    dbClient.db.where.mockClear();
  });

  it('returns active for a live session row', async () => {
    dbClient.limit.mockResolvedValue([{ status: 'active', endedAt: null }]);

    const result = await sessionQueries.sessionStatus({}, { sessionId: 'session-1' });

    expect(result).toBe('active');
  });

  it("normalizes a legacy 'inactive' row to active (CHECK-permitted, never written; restore-safe)", async () => {
    dbClient.limit.mockResolvedValue([{ status: 'inactive', endedAt: null }]);

    const result = await sessionQueries.sessionStatus({}, { sessionId: 'session-1' });

    expect(result).toBe('active');
  });

  it('reports an ended session even with zero connected participants', async () => {
    dbClient.limit.mockResolvedValue([{ status: 'ended', endedAt: new Date('2026-06-10T12:00:00.000Z') }]);

    const result = await sessionQueries.sessionStatus({}, { sessionId: 'session-1' });

    expect(result).toBe('ended');
  });

  it('treats a skewed row with endedAt set but status not updated as ended', async () => {
    dbClient.limit.mockResolvedValue([{ status: 'active', endedAt: new Date('2026-06-10T12:00:00.000Z') }]);

    const result = await sessionQueries.sessionStatus({}, { sessionId: 'session-1' });

    expect(result).toBe('ended');
  });

  it('returns null when the session row does not exist', async () => {
    dbClient.limit.mockResolvedValue([]);

    const result = await sessionQueries.sessionStatus({}, { sessionId: 'session-gone' });

    expect(result).toBeNull();
  });

  it('rejects a malformed session id before querying', async () => {
    await expect(sessionQueries.sessionStatus({}, { sessionId: 'bad id!' })).rejects.toThrow();
    expect(dbClient.limit).not.toHaveBeenCalled();
  });
});

describe('sessionRestoreBoardPath query', () => {
  const context = { isAuthenticated: true, userId: 'viewer' } as ConnectionContext;

  beforeEach(() => {
    restore.canAccess.mockReset().mockResolvedValue(true);
    restore.getSessionById.mockReset();
    restore.project.mockReset();
  });

  it('does not expose a public or unlisted session board to an anonymous restore request', async () => {
    const anonymous = { isAuthenticated: false } as ConnectionContext;
    await expect(sessionQueries.sessionRestoreBoardPath({}, { sessionId: 'public' }, anonymous)).rejects.toThrow(
      'Authentication required',
    );
    expect(restore.canAccess).not.toHaveBeenCalled();
    expect(restore.getSessionById).not.toHaveBeenCalled();
  });

  it('checks privacy before reading the session', async () => {
    restore.canAccess.mockResolvedValue(false);
    await expect(sessionQueries.sessionRestoreBoardPath({}, { sessionId: 'private' }, context)).resolves.toBeNull();
    expect(restore.getSessionById).not.toHaveBeenCalled();
  });

  it('reads the durable target of a dormant session and returns only geometry', async () => {
    restore.getSessionById.mockResolvedValue({ boardPath: '/b/slug' });
    restore.project.mockResolvedValue('/kilter/8/17/27,28/35');

    await expect(sessionQueries.sessionRestoreBoardPath({}, { sessionId: 'dormant' }, context)).resolves.toBe(
      '/kilter/8/17/27,28/35',
    );
    expect(restore.project).toHaveBeenCalledWith('/b/slug', 'viewer', { geometryOnly: true });
  });
});
