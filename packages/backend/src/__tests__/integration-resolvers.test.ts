// @ts-nocheck — __tests__ is excluded from tsconfig.json, so the type-aware
// lint can't resolve node globals or `node:*` specifiers. Type-checking happens
// at test-run time via vitest.
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Mock the db client before importing the resolvers.
vi.mock('../db/client', () => {
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  return { db: mockDb };
});

// Mock the session-summary generator so the resolver path is deterministic.
vi.mock('../graphql/resolvers/sessions/session-summary', () => ({
  generateSessionSummary: vi.fn(),
}));

// Mock the export-service so we assert the resolver wiring, not the upload.
vi.mock('../integrations/export-service', () => ({
  syncPartySessionForUser: vi.fn(),
}));

// Rate limiting short-circuits in development; force it off explicitly.
process.env.NODE_ENV = 'development';
// Handoff minting signs with NEXTAUTH_SECRET.
process.env.NEXTAUTH_SECRET = 'test-secret-for-integration-resolvers';

import { db } from '../db/client';
import { integrationQueries } from '../graphql/resolvers/integrations/queries';
import { integrationMutations } from '../graphql/resolvers/integrations/mutations';
import { generateSessionSummary } from '../graphql/resolvers/sessions/session-summary';
import { syncPartySessionForUser } from '../integrations/export-service';
import { verifyIntegrationHandoff } from '../integrations/state';
import { IntegrationHttpError } from '../integrations/strava';

function makeCtx(userId = 'user-1') {
  return { isAuthenticated: true, userId, connectionId: 'conn-1' };
}

function makeUnauthCtx() {
  return { isAuthenticated: false, userId: undefined, connectionId: 'conn-unauth' };
}

// Queue up the results that successive db.select(...).from(...).where(...) chains
// resolve to. Each chain consumes one entry from the queue in call order.
function setupSelectResults(results) {
  let index = 0;
  db.select.mockImplementation(() => {
    const current = index++;
    const resolved = results[current] ?? [];
    const chain = {
      from: vi.fn(() => chain),
      // `.where(...)` may be awaited directly (no `.limit`) or chained to
      // `.limit(...)`. Return a real Promise (so awaiting works) with a `.limit`
      // method attached (so the chained form works too).
      where: vi.fn(() => {
        const whereResult = Promise.resolve(resolved);
        whereResult.limit = vi.fn(() => Promise.resolve(resolved));
        return whereResult;
      }),
    };
    return chain;
  });
}

describe('integration query/mutation resolvers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('authentication', () => {
    it('integrations query rejects unauthenticated callers', async () => {
      await expect(integrationQueries.integrations(null, {}, makeUnauthCtx())).rejects.toThrow(
        'Authentication required',
      );
    });

    it('disconnectIntegration rejects unauthenticated callers', async () => {
      await expect(
        integrationMutations.disconnectIntegration(null, { provider: 'STRAVA' }, makeUnauthCtx()),
      ).rejects.toThrow('Authentication required');
    });

    it('setIntegrationAutoSync rejects unauthenticated callers', async () => {
      await expect(
        integrationMutations.setIntegrationAutoSync(null, { provider: 'STRAVA', enabled: true }, makeUnauthCtx()),
      ).rejects.toThrow('Authentication required');
    });

    it('syncSessionToIntegration rejects unauthenticated callers', async () => {
      await expect(
        integrationMutations.syncSessionToIntegration(
          null,
          { provider: 'STRAVA', sessionId: 'session-1' },
          makeUnauthCtx(),
        ),
      ).rejects.toThrow('Authentication required');
    });

    it('createIntegrationOAuthHandoff rejects unauthenticated callers', async () => {
      await expect(
        integrationMutations.createIntegrationOAuthHandoff(null, { provider: 'STRAVA' }, makeUnauthCtx()),
      ).rejects.toThrow('Authentication required');
    });
  });

  describe('createIntegrationOAuthHandoff', () => {
    it('returns a verifiable purpose-bound handoff carrying the caller userId', async () => {
      const handoff = await integrationMutations.createIntegrationOAuthHandoff(
        null,
        { provider: 'STRAVA' },
        makeCtx('user-9'),
      );
      const verified = verifyIntegrationHandoff(handoff);
      expect(verified).toMatchObject({ userId: 'user-9', provider: 'strava' });
    });
  });

  describe('integrations query shape', () => {
    it('reports connected status from a credential row', async () => {
      const syncedAt = new Date('2026-06-01T00:00:00.000Z');
      setupSelectResults([
        [
          {
            provider: 'strava',
            externalAccountName: 'climber99',
            autoSyncEnabled: false,
            status: 'active',
            lastSyncAt: syncedAt,
            lastError: null,
          },
        ],
      ]);

      const result = await integrationQueries.integrations(null, {}, makeCtx());
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        provider: 'STRAVA',
        connected: true,
        externalAccountName: 'climber99',
        autoSyncEnabled: false,
        status: 'active',
        lastSyncAt: syncedAt.toISOString(),
        lastError: null,
      });
    });

    it('reports a not-connected default when no credential row exists', async () => {
      setupSelectResults([[]]);
      const result = await integrationQueries.integrations(null, {}, makeCtx());
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        provider: 'STRAVA',
        connected: false,
        externalAccountName: null,
        autoSyncEnabled: true,
        status: null,
        lastSyncAt: null,
        lastError: null,
      });
    });
  });

  describe('disconnectIntegration', () => {
    it('deletes the credential and reports true', async () => {
      // No encrypted token on the row, so the best-effort provider revoke is
      // skipped and the test stays off the network.
      setupSelectResults([[{ id: 7, userId: 'user-1', provider: 'strava', encryptedAccessToken: null }]]);
      const deleteWhere = vi.fn(() => Promise.resolve());
      const deleteChain = vi.fn(() => ({ where: deleteWhere }));
      db.delete.mockImplementation(deleteChain);

      await expect(integrationMutations.disconnectIntegration(null, { provider: 'STRAVA' }, makeCtx())).resolves.toBe(
        true,
      );
      expect(deleteChain).toHaveBeenCalledTimes(1);
      expect(deleteWhere).toHaveBeenCalledTimes(1);
    });

    it('reports false when no credential exists instead of claiming success', async () => {
      setupSelectResults([[]]);
      const deleteChain = vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) }));
      db.delete.mockImplementation(deleteChain);

      await expect(integrationMutations.disconnectIntegration(null, { provider: 'STRAVA' }, makeCtx())).resolves.toBe(
        false,
      );
      expect(deleteChain).not.toHaveBeenCalled();
    });
  });

  describe('setIntegrationAutoSync', () => {
    function setupUpdateReturning(rows) {
      db.update.mockImplementation(() => ({
        set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve(rows)) })) })),
      }));
    }

    it('throws when the integration is not connected', async () => {
      setupUpdateReturning([]);
      await expect(
        integrationMutations.setIntegrationAutoSync(null, { provider: 'STRAVA', enabled: false }, makeCtx()),
      ).rejects.toThrow('Integration not connected');
    });

    it('returns the updated status when a credential exists', async () => {
      setupUpdateReturning([
        {
          provider: 'strava',
          externalAccountName: 'climber99',
          autoSyncEnabled: false,
          status: 'active',
          lastSyncAt: null,
          lastError: null,
        },
      ]);

      const result = await integrationMutations.setIntegrationAutoSync(
        null,
        { provider: 'STRAVA', enabled: false },
        makeCtx(),
      );
      expect(result).toMatchObject({ provider: 'STRAVA', connected: true, autoSyncEnabled: false });
    });
  });

  describe('syncSessionToIntegration authorization', () => {
    it('throws when the session does not exist', async () => {
      // First slot: the EXISTS subquery builder (constructed, never awaited).
      setupSelectResults([[], []]); // session lookup → empty
      await expect(
        integrationMutations.syncSessionToIntegration(null, { provider: 'STRAVA', sessionId: 'session-x' }, makeCtx()),
      ).rejects.toThrow('Session not found');
    });

    it('throws when the session has not ended', async () => {
      setupSelectResults([
        [], // EXISTS subquery builder slot
        [
          {
            createdByUserId: 'user-1',
            boardPath: 'kilter/1',
            startedAt: new Date(),
            endedAt: null,
            callerHasTick: false,
          },
        ],
      ]);
      await expect(
        integrationMutations.syncSessionToIntegration(null, { provider: 'STRAVA', sessionId: 'session-x' }, makeCtx()),
      ).rejects.toThrow('Session has not ended');
    });

    it('throws when the caller is neither creator nor a participant', async () => {
      setupSelectResults([
        [], // EXISTS subquery builder slot
        // session row: created by someone else, ended, no tick by the caller —
        // the EXISTS rides the same SELECT so this is one atomic check.
        [
          {
            createdByUserId: 'owner',
            boardPath: 'kilter/1',
            startedAt: new Date(),
            endedAt: new Date(),
            callerHasTick: false,
          },
        ],
      ]);
      await expect(
        integrationMutations.syncSessionToIntegration(
          null,
          { provider: 'STRAVA', sessionId: 'session-x' },
          makeCtx('not-a-member'),
        ),
      ).rejects.toThrow('Not a participant of this session');
    });

    it('allows a non-creator participant whose tick EXISTS in the same snapshot', async () => {
      const startedAt = new Date('2026-06-01T10:00:00.000Z');
      const endedAt = new Date('2026-06-01T11:00:00.000Z');
      setupSelectResults([
        [], // EXISTS subquery builder slot
        [{ createdByUserId: 'owner', boardPath: 'kilter/1', startedAt, endedAt, callerHasTick: true }],
      ]);
      generateSessionSummary.mockResolvedValueOnce({
        sessionId: 'session-x',
        totalSends: 1,
        totalAttempts: 1,
        participants: [{ userId: 'member', sends: 1, attempts: 1 }],
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        gradeDistribution: [],
      });
      syncPartySessionForUser.mockResolvedValueOnce({
        provider: 'STRAVA',
        sessionId: 'session-x',
        externalActivityId: '123',
        externalActivityUrl: 'https://www.strava.com/activities/123',
        syncedAt: '2026-06-01T11:05:00.000Z',
        error: null,
      });

      const result = await integrationMutations.syncSessionToIntegration(
        null,
        { provider: 'STRAVA', sessionId: 'session-x' },
        makeCtx('member'),
      );
      expect(result.externalActivityId).toBe('123');
    });

    it('returns the export result for an authorized creator', async () => {
      const startedAt = new Date('2026-06-01T10:00:00.000Z');
      const endedAt = new Date('2026-06-01T11:00:00.000Z');
      setupSelectResults([
        [], // EXISTS subquery builder slot
        [{ createdByUserId: 'user-1', boardPath: 'kilter/1', startedAt, endedAt, callerHasTick: false }],
      ]);
      generateSessionSummary.mockResolvedValueOnce({
        sessionId: 'session-x',
        participants: [{ userId: 'user-1', sends: 3, attempts: 5 }],
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        gradeDistribution: [],
      });
      syncPartySessionForUser.mockResolvedValueOnce({
        provider: 'STRAVA',
        sessionId: 'session-x',
        externalActivityId: '777',
        externalActivityUrl: 'https://www.strava.com/activities/777',
        syncedAt: '2026-06-01T11:05:00.000Z',
        error: null,
      });

      const result = await integrationMutations.syncSessionToIntegration(
        null,
        { provider: 'STRAVA', sessionId: 'session-x' },
        makeCtx('user-1'),
      );
      expect(result.externalActivityId).toBe('777');
      expect(syncPartySessionForUser).toHaveBeenCalledWith(
        'strava',
        'user-1',
        'session-x',
        expect.any(Object),
        'kilter/1',
        { allowErrorStatus: true },
      );
    });

    it('returns a result with the error field set when the upload throws', async () => {
      const startedAt = new Date('2026-06-01T10:00:00.000Z');
      const endedAt = new Date('2026-06-01T11:00:00.000Z');
      setupSelectResults([
        [], // EXISTS subquery builder slot
        [{ createdByUserId: 'user-1', boardPath: 'kilter/1', startedAt, endedAt, callerHasTick: false }],
      ]);
      generateSessionSummary.mockResolvedValueOnce({
        sessionId: 'session-x',
        participants: [{ userId: 'user-1', sends: 1, attempts: 1 }],
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        gradeDistribution: [],
      });
      syncPartySessionForUser.mockRejectedValueOnce(new IntegrationHttpError('upload failed with status 500', 500));

      const result = await integrationMutations.syncSessionToIntegration(
        null,
        { provider: 'STRAVA', sessionId: 'session-x' },
        makeCtx('user-1'),
      );
      expect(result.externalActivityId).toBeNull();
      expect(result.error).toBe('The provider rejected the upload (status 500)');
    });

    it('sanitizes internal error detail out of the returned error message', async () => {
      const startedAt = new Date('2026-06-01T10:00:00.000Z');
      const endedAt = new Date('2026-06-01T11:00:00.000Z');
      setupSelectResults([
        [], // EXISTS subquery builder slot
        [{ createdByUserId: 'user-1', boardPath: 'kilter/1', startedAt, endedAt, callerHasTick: false }],
      ]);
      generateSessionSummary.mockResolvedValueOnce({
        sessionId: 'session-x',
        totalSends: 1,
        totalAttempts: 1,
        participants: [{ userId: 'user-1', sends: 1, attempts: 1 }],
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        gradeDistribution: [],
      });
      syncPartySessionForUser.mockRejectedValueOnce(
        new Error('connect ECONNREFUSED 10.0.0.5:5432 at /app/src/secret-path.ts'),
      );

      const result = await integrationMutations.syncSessionToIntegration(
        null,
        { provider: 'STRAVA', sessionId: 'session-x' },
        makeCtx('user-1'),
      );
      expect(result.error).toBe('Export failed');
    });
  });
});
