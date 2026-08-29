/**
 * Unit tests for userIsAdmin — the lookup behind UserProfile.isAdmin. It decides
 * whether the client shows admin-only tooling, and it rides inside the core
 * `profile` query, so a role-table failure has to degrade to "not an admin"
 * rather than break the You tab. The db client is mocked so the helper never
 * touches real infrastructure.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { limitMock, loggerErrorMock } = vi.hoisted(() => ({
  limitMock: vi.fn(),
  loggerErrorMock: vi.fn(),
}));

vi.mock('../../../../db/client', () => ({
  db: {
    select: () => {
      const chain = {
        from: () => chain,
        where: () => chain,
        limit: () => Promise.resolve(limitMock()),
      };
      return chain;
    },
  },
}));

vi.mock('../../../../utils/logger', () => ({
  logger: { error: loggerErrorMock, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { userIsAdmin } from '../admin';

describe('userIsAdmin', () => {
  beforeEach(() => {
    limitMock.mockReset();
    loggerErrorMock.mockReset();
  });

  it('returns true when the user holds an admin role row', async () => {
    limitMock.mockReturnValue([{ id: 11 }]);
    await expect(userIsAdmin('user-1')).resolves.toBe(true);
  });

  it('returns true for a board-scoped admin — the flag decides visibility, not reach', async () => {
    // The query does not filter on board_type, so a row scoped to one board is
    // still a row. Every operation re-checks the scope server-side.
    limitMock.mockReturnValue([{ id: 12 }]);
    await expect(userIsAdmin('user-2')).resolves.toBe(true);
  });

  it('returns false when the user has no admin role', async () => {
    limitMock.mockReturnValue([]);
    await expect(userIsAdmin('user-3')).resolves.toBe(false);
  });

  it('fails closed and logs when the role lookup throws', async () => {
    limitMock.mockImplementation(() => {
      throw new Error('connection terminated unexpectedly');
    });
    await expect(userIsAdmin('user-4')).resolves.toBe(false);
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
  });
});
