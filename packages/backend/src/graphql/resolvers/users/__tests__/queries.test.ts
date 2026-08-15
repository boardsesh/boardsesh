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

vi.mock('../tester', () => ({
  userIsTester: vi.fn(async () => false),
}));

import { userQueries } from '../queries';
import { userIsTester } from '../tester';

const userIsTesterMock = vi.mocked(userIsTester);

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
    userIsTesterMock.mockReset();
    userIsTesterMock.mockResolvedValue(false);
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
      createdAt: '2024-01-01T00:00:00.000Z',
      favoriteCount: 7,
      // The mocked row carries no user_profiles columns at all, which is what
      // the LEFT JOIN yields for a climber with no profile row. Both consent
      // fields must fall back to the column default rather than surfacing null:
      // a null reads as "no opinion" downstream and could drop a climber from
      // rankings they never opted out of.
      leaderboardVisibility: 'public',
      gymScreenVisibility: 'public',
    });
  });

  it('passes stored visibility choices through instead of always reporting the default', async () => {
    limitMock.mockReturnValue([
      {
        id: 'user-3',
        email: 'private@example.com',
        name: 'Quiet Climber',
        image: null,
        createdAt: new Date('2025-02-02T00:00:00.000Z'),
        displayName: null,
        avatarUrl: null,
        favoriteCount: 0,
        leaderboardVisibility: 'off',
        gymScreenVisibility: 'anonymous',
      },
    ]);

    const result = await userQueries.profile(undefined, undefined, makeCtx({ userId: 'user-3' }));

    // The two settings are independent — reading one must not coerce the other.
    expect(result?.leaderboardVisibility).toBe('off');
    expect(result?.gymScreenVisibility).toBe('anonymous');
  });

  it('reflects isTester from userIsTester and a zero favoriteCount', async () => {
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
    userIsTesterMock.mockResolvedValue(true);

    const result = await userQueries.profile(undefined, undefined, makeCtx({ userId: 'user-2' }));

    expect(result?.isTester).toBe(true);
    expect(result?.favoriteCount).toBe(0);
  });
});
