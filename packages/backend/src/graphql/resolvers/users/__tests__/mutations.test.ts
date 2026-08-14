/**
 * Unit tests for userMutations.updateProfile — covers the cohort-property
 * fields added for issue #3399 (createdAt, favoriteCount) mapped from the
 * merged profile read. Since #3603 the resolver runs a single transaction
 * (one upsert + one leftJoin select), so the db client is mocked at the
 * transaction boundary. The failure-handling and no-write paths are covered
 * separately in src/__tests__/update-profile.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const { onConflictMock, limitMock, userUpdateSetMock } = vi.hoisted(() => ({
  onConflictMock: vi.fn(async () => undefined),
  limitMock: vi.fn(),
  userUpdateSetMock: vi.fn(() => ({ where: async () => undefined })),
}));

vi.mock('../../../../db/client', () => ({
  db: {
    transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        insert: () => ({ values: () => ({ onConflictDoUpdate: onConflictMock }) }),
        update: () => ({ set: userUpdateSetMock }),
        select: () => {
          const chain = {
            from: () => chain,
            leftJoin: () => chain,
            where: () => chain,
            limit: () => Promise.resolve(limitMock()),
          };
          return chain;
        },
      }),
  },
}));

vi.mock('../tester', () => ({
  userIsTester: vi.fn(async () => false),
}));

import { userMutations } from '../mutations';
import { userIsTester } from '../tester';

const userIsTesterMock = vi.mocked(userIsTester);

function makeCtx(userId = 'user-1'): ConnectionContext {
  return { connectionId: `http-${userId}`, userId, isAuthenticated: true };
}

const JOINED_ROW = {
  id: 'user-1',
  email: 'climber@example.com',
  name: 'Climber',
  image: null,
  createdAt: new Date('2024-02-02T00:00:00.000Z'),
  displayName: 'New Name',
  avatarUrl: null,
  instagramUrl: null,
  hasPassword: false,
  linkedProviders: [],
  favoriteCount: 3,
};

describe('userMutations.updateProfile', () => {
  beforeEach(() => {
    onConflictMock.mockClear();
    userUpdateSetMock.mockClear();
    limitMock.mockReset();
    userIsTesterMock.mockReset();
    userIsTesterMock.mockResolvedValue(false);
  });

  it('upserts the profile and maps createdAt/favoriteCount/displayName from the joined row', async () => {
    limitMock.mockReturnValueOnce([JOINED_ROW]);

    const result = await userMutations.updateProfile(undefined, { input: { displayName: 'New Name' } }, makeCtx());

    expect(onConflictMock).toHaveBeenCalledOnce();
    expect(result.createdAt).toBe('2024-02-02T00:00:00.000Z');
    expect(result.favoriteCount).toBe(3);
    expect(result.displayName).toBe('New Name');
    expect(userUpdateSetMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'New Name' }));
  });

  it('still returns createdAt/favoriteCount when only avatarUrl changes', async () => {
    limitMock.mockReturnValueOnce([{ ...JOINED_ROW, avatarUrl: 'https://cdn/pic.png' }]);

    const result = await userMutations.updateProfile(
      undefined,
      { input: { avatarUrl: 'https://cdn/pic.png' } },
      makeCtx(),
    );

    expect(onConflictMock).toHaveBeenCalledOnce();
    expect(result.avatarUrl).toBe('https://cdn/pic.png');
    expect(result.createdAt).toBe('2024-02-02T00:00:00.000Z');
    expect(result.favoriteCount).toBe(3);
    // An avatar-only save must not touch users.name.
    expect(userUpdateSetMock).not.toHaveBeenCalled();
  });

  it('returns the account-shape fields the settings form needs', async () => {
    limitMock.mockReturnValueOnce([
      { ...JOINED_ROW, instagramUrl: 'https://instagram.com/climber', hasPassword: true, linkedProviders: ['apple'] },
    ]);

    const result = await userMutations.updateProfile(
      undefined,
      { input: { instagramUrl: 'https://instagram.com/climber' } },
      makeCtx(),
    );

    expect(result.instagramUrl).toBe('https://instagram.com/climber');
    expect(result.hasPassword).toBe(true);
    expect(result.linkedProviders).toEqual(['apple']);
  });
});
