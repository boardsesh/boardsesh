/**
 * Unit tests for userIsTester — the lookup behind UserProfile.isTester. It drives
 * whether the mobile app shows the tester-only developer tooling, so a user with a
 * `tester` or `admin` community role must resolve true, everyone else false. The db
 * client is mocked so the helper never touches real infrastructure.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { limitMock } = vi.hoisted(() => ({
  limitMock: vi.fn(),
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

import { userIsTester } from '../tester';

describe('userIsTester', () => {
  beforeEach(() => {
    limitMock.mockReset();
  });

  it('returns true when the user holds a tester (or admin) role row', async () => {
    limitMock.mockReturnValue([{ id: 42 }]);
    await expect(userIsTester('user-1')).resolves.toBe(true);
  });

  it('returns false when the user has no qualifying role', async () => {
    limitMock.mockReturnValue([]);
    await expect(userIsTester('user-2')).resolves.toBe(false);
  });
});
