/**
 * Unit tests for userQueries.profile — covers the cohort-property fields added
 * for issue #3399 (createdAt, favoriteCount) and the account-shape fields the
 * resolver took over from the deleted REST route for issue #1884
 * (instagramUrl, hasPassword, linkedProviders), alongside the existing
 * auth-gating and null-row behaviour. The db client is mocked, mirroring
 * tester.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const { limitMock, selectSpy } = vi.hoisted(() => ({
  limitMock: vi.fn(),
  selectSpy: vi.fn(),
}));

vi.mock('../../../../db/client', () => ({
  db: {
    select: (...args: unknown[]) => {
      selectSpy(...args);
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
    selectSpy.mockReset();
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
        instagramUrl: null,
        hasPassword: false,
        linkedProviders: [],
        favoriteCount: 7,
      },
    ]);

    const result = await userQueries.profile(undefined, undefined, makeCtx());

    expect(result).toEqual({
      id: 'user-1',
      email: 'climber@example.com',
      displayName: 'Climber',
      avatarUrl: undefined,
      instagramUrl: undefined,
      hasPassword: false,
      linkedProviders: [],
      isTester: false,
      createdAt: '2024-01-01T00:00:00.000Z',
      favoriteCount: 7,
    });
  });

  it('surfaces instagramUrl, hasPassword and linkedProviders from the joined row', async () => {
    limitMock.mockReturnValue([
      {
        id: 'user-3',
        email: 'linked@example.com',
        name: 'Linked',
        image: null,
        createdAt: new Date('2024-03-03T00:00:00.000Z'),
        displayName: 'Linked',
        avatarUrl: null,
        instagramUrl: 'https://instagram.com/linked',
        hasPassword: true,
        linkedProviders: ['google', 'apple'],
        favoriteCount: 0,
      },
    ]);

    const result = await userQueries.profile(undefined, undefined, makeCtx({ userId: 'user-3' }));

    expect(result?.instagramUrl).toBe('https://instagram.com/linked');
    expect(result?.hasPassword).toBe(true);
    expect(result?.linkedProviders).toEqual(['google', 'apple']);
  });

  // The whole point of the correlated subqueries: one select, not four.
  // A regression here (splitting the credentials/accounts reads back out into
  // their own queries) re-introduces exactly what issue #3603 collapsed.
  it('reads the whole profile in a single select', async () => {
    limitMock.mockReturnValue([
      {
        id: 'user-1',
        email: 'climber@example.com',
        name: 'Climber',
        image: null,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        displayName: null,
        avatarUrl: null,
        instagramUrl: null,
        hasPassword: false,
        linkedProviders: null,
        favoriteCount: 0,
      },
    ]);

    const result = await userQueries.profile(undefined, undefined, makeCtx());

    expect(selectSpy).toHaveBeenCalledOnce();
    // A user with no accounts rows yields NULL from array_agg's coalesce in
    // some drivers — the mapper must still hand GraphQL a non-null list.
    expect(result?.linkedProviders).toEqual([]);
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
        instagramUrl: null,
        hasPassword: false,
        linkedProviders: [],
        favoriteCount: 0,
      },
    ]);
    userIsTesterMock.mockResolvedValue(true);

    const result = await userQueries.profile(undefined, undefined, makeCtx({ userId: 'user-2' }));

    expect(result?.isTester).toBe(true);
    expect(result?.favoriteCount).toBe(0);
  });
});
