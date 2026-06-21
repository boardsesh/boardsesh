// Auth-gate unit tests for the communityRoles query: admin-only, with the db client mocked.

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const { dbState } = vi.hoisted(() => ({
  dbState: { queue: [] as unknown[][], selectCalls: 0 },
}));

// A minimal Drizzle-style chain: from/where/limit return the chain, and awaiting it
// at any point dequeues the next seeded result set (one entry per db.select call).
vi.mock('../../../../db/client', () => {
  const makeChain = () => {
    const chain = {
      from: () => chain,
      where: () => chain,
      limit: () => chain,
      // Deliberately thenable: emulate Drizzle's lazy builder so the queue is only
      // dequeued when a query is awaited, not when an intermediate link is created.
      // oxlint-disable-next-line unicorn/no-thenable
      then: (onFulfilled: (rows: unknown[]) => unknown) =>
        Promise.resolve(dbState.queue.shift() ?? []).then(onFulfilled),
    };
    return chain;
  };
  return {
    db: {
      select: () => {
        dbState.selectCalls += 1;
        return makeChain();
      },
    },
  };
});

import { socialRoleQueries } from '../roles';

function makeCtx(overrides: Partial<ConnectionContext>): ConnectionContext {
  return { isAuthenticated: false, ...overrides } as unknown as ConnectionContext;
}

describe('communityRoles auth gate', () => {
  beforeEach(() => {
    dbState.queue = [];
    dbState.selectCalls = 0;
  });

  it('rejects an unauthenticated caller before reading any rows', async () => {
    await expect(socialRoleQueries.communityRoles(null, {}, makeCtx({ isAuthenticated: false }))).rejects.toThrow(
      'Authentication required to perform this operation',
    );
    expect(dbState.selectCalls).toBe(0);
  });

  it('rejects an authenticated non-admin caller', async () => {
    dbState.queue = [[]]; // requireAdmin finds no admin row for this user
    await expect(
      socialRoleQueries.communityRoles(null, {}, makeCtx({ isAuthenticated: true, userId: 'user-1' })),
    ).rejects.toThrow('Admin role required for this operation');
  });

  it('returns the enriched role assignments for an admin caller', async () => {
    dbState.queue = [
      [{ role: 'admin', boardType: null }], // requireAdmin: caller is a global admin
      [
        {
          id: 1,
          userId: 'tester-1',
          role: 'tester',
          boardType: null,
          grantedBy: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ], // the role listing
      [{ displayName: 'Tester One', avatarUrl: null }], // enrichRoleAssignment profile lookup
    ];

    const result = await socialRoleQueries.communityRoles(
      null,
      {},
      makeCtx({ isAuthenticated: true, userId: 'admin-1' }),
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ userId: 'tester-1', role: 'tester', userDisplayName: 'Tester One' });
  });

  it('still passes a board-type filter through for an admin caller', async () => {
    dbState.queue = [
      [{ role: 'admin', boardType: null }], // requireAdmin: caller is a global admin
      [
        {
          id: 2,
          userId: 'leader-1',
          role: 'community_leader',
          boardType: 'kilter',
          grantedBy: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ], // the board-scoped listing
      [{ displayName: 'Kilter Leader', avatarUrl: null }], // enrichRoleAssignment profile lookup
    ];

    const result = await socialRoleQueries.communityRoles(
      null,
      { boardType: 'kilter' },
      makeCtx({ isAuthenticated: true, userId: 'admin-1' }),
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ userId: 'leader-1', role: 'community_leader', boardType: 'kilter' });
  });
});
