/**
 * Unit tests for the profile role flags — the single `community_roles` read
 * behind `UserProfile.isTester` and `UserProfile.isAdmin`.
 *
 * Two things are load-bearing here. The rules differ (tester admits `tester` OR
 * `admin`; admin admits only `admin`, at any board scope) but read the same
 * rows, so they must come from ONE query — this rides inside the core `profile`
 * query. And the whole thing fails closed: a role-table error must degrade to
 * "neither flag", never break the You tab for every signed-in user. The db
 * client is mocked so the helper never touches real infrastructure.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { whereMock, loggerErrorMock, selectSpy } = vi.hoisted(() => ({
  whereMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  selectSpy: vi.fn(),
}));

vi.mock('../../../../db/client', () => ({
  db: {
    select: () => {
      selectSpy();
      const chain = {
        from: () => chain,
        where: () => Promise.resolve(whereMock()),
      };
      return chain;
    },
  },
}));

vi.mock('../../../../utils/logger', () => ({
  logger: { error: loggerErrorMock, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { loadProfileRoleFlags, rolesGrantAdmin, rolesGrantTester } from '../role-flags';

describe('rolesGrantTester / rolesGrantAdmin', () => {
  it('admits a tester for the tester flag only', () => {
    const roles = [{ role: 'tester', boardType: null }];
    expect(rolesGrantTester(roles)).toBe(true);
    expect(rolesGrantAdmin(roles)).toBe(false);
  });

  it('admits an admin for both — admins implicitly count as testers', () => {
    const roles = [{ role: 'admin', boardType: null }];
    expect(rolesGrantTester(roles)).toBe(true);
    expect(rolesGrantAdmin(roles)).toBe(true);
  });

  it('admits a board-scoped admin — the flag decides visibility, not reach', () => {
    // The scope is re-checked server-side on every admin operation, so a Kilter
    // admin still gets the entry point and is refused per board.
    const roles = [{ role: 'admin', boardType: 'kilter' }];
    expect(rolesGrantAdmin(roles)).toBe(true);
  });

  it('rejects a community leader and an empty role list for both flags', () => {
    for (const roles of [[{ role: 'community_leader', boardType: null }], []]) {
      expect(rolesGrantTester(roles)).toBe(false);
      expect(rolesGrantAdmin(roles)).toBe(false);
    }
  });
});

describe('loadProfileRoleFlags', () => {
  beforeEach(() => {
    whereMock.mockReset();
    loggerErrorMock.mockReset();
    selectSpy.mockReset();
  });

  it('answers both flags from a single query', async () => {
    whereMock.mockReturnValue([{ role: 'admin', boardType: 'kilter' }]);

    await expect(loadProfileRoleFlags('user-1')).resolves.toEqual({ isTester: true, isAdmin: true });
    // The point of the helper: one round trip, not one per flag.
    expect(selectSpy).toHaveBeenCalledTimes(1);
  });

  it('separates the two rules on the same rows', async () => {
    whereMock.mockReturnValue([{ role: 'tester', boardType: null }]);
    await expect(loadProfileRoleFlags('user-2')).resolves.toEqual({ isTester: true, isAdmin: false });
  });

  it('reports neither flag for an account with no roles', async () => {
    whereMock.mockReturnValue([]);
    await expect(loadProfileRoleFlags('user-3')).resolves.toEqual({ isTester: false, isAdmin: false });
  });

  it('fails closed and logs when the role lookup throws', async () => {
    whereMock.mockImplementation(() => {
      throw new Error('connection terminated unexpectedly');
    });

    await expect(loadProfileRoleFlags('user-4')).resolves.toEqual({ isTester: false, isAdmin: false });
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
  });
});
