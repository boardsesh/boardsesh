/**
 * Unit tests for userQueries.profile — covers the cohort-property fields added
 * for issue #3399 (createdAt, favoriteCount) alongside the existing auth-gating
 * and null-row behaviour. The db client is mocked, mirroring tester.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const { limitMock } = vi.hoisted(() => ({
  limitMock: vi.fn(),
}));

vi.mock('../../../../db/client', () => ({
  db: {
    select: () => {
      const chain = {
        from: () => chain,
        leftJoin: () => chain,
        where: () => chain,
        limit: () => Promise.resolve(limitMock()),
      };
      return chain;
    },
  },
}));

vi.mock('../role-flags', () => ({
  loadProfileRoleFlags: vi.fn(async () => ({ isTester: false, isAdmin: false })),
}));

import { userQueries } from '../queries';
import { loadProfileRoleFlags } from '../role-flags';

const roleFlagsMock = vi.mocked(loadProfileRoleFlags);

function makeCtx(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: 'http-user-1',
    userId: 'user-1',
    isAuthenticated: true,
    ...overrides,
  };
}

describe('userQueries.profile', () => {
  beforeEach(() => {
    limitMock.mockReset();
    roleFlagsMock.mockReset();
    roleFlagsMock.mockResolvedValue({ isTester: false, isAdmin: false });
  });

  it('returns null when not authenticated', async () => {
    const result = await userQueries.profile(
      undefined,
      undefined,
      makeCtx({ isAuthenticated: false, userId: undefined }),
    );

    expect(result).toBeNull();
    expect(limitMock).not.toHaveBeenCalled();
  });

  it('returns null when no matching user row exists', async () => {
    limitMock.mockReturnValue([]);

    const result = await userQueries.profile(undefined, undefined, makeCtx());

    expect(result).toBeNull();
  });

  it('maps createdAt to an ISO string and passes favoriteCount through', async () => {
    limitMock.mockReturnValue([
      {
        id: 'user-1',
        email: 'climber@example.com',
        name: 'Climber',
        image: null,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        displayName: null,
        avatarUrl: null,
        favoriteCount: 7,
      },
    ]);

    const result = await userQueries.profile(undefined, undefined, makeCtx());

    expect(result).toEqual({
      id: 'user-1',
      email: 'climber@example.com',
      displayName: 'Climber',
      avatarUrl: undefined,
      isTester: false,
      isAdmin: false,
      createdAt: '2024-01-01T00:00:00.000Z',
      favoriteCount: 7,
    });
  });

  it('reflects isTester from the role flags and a zero favoriteCount', async () => {
    limitMock.mockReturnValue([
      {
        id: 'user-2',
        email: 'tester@example.com',
        name: null,
        image: null,
        createdAt: new Date('2023-06-15T12:00:00.000Z'),
        displayName: null,
        avatarUrl: null,
        favoriteCount: 0,
      },
    ]);
    roleFlagsMock.mockResolvedValue({ isTester: true, isAdmin: false });

    const result = await userQueries.profile(undefined, undefined, makeCtx({ userId: 'user-2' }));

    expect(result?.isTester).toBe(true);
    expect(result?.favoriteCount).toBe(0);
  });

  it('reflects isAdmin independently of isTester, from the same read', async () => {
    limitMock.mockReturnValue([
      {
        id: 'user-3',
        email: 'admin@example.com',
        name: 'Admin',
        image: null,
        createdAt: new Date('2023-06-15T12:00:00.000Z'),
        displayName: null,
        avatarUrl: null,
        favoriteCount: 0,
      },
    ]);
    roleFlagsMock.mockResolvedValue({ isTester: false, isAdmin: true });

    const result = await userQueries.profile(undefined, undefined, makeCtx({ userId: 'user-3' }));

    expect(result?.isAdmin).toBe(true);
    expect(result?.isTester).toBe(false);
    // Both flags come from one read, not one call per flag.
    expect(roleFlagsMock).toHaveBeenCalledTimes(1);
  });
});
