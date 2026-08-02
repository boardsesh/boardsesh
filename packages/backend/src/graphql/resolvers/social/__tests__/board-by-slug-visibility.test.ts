// Read-visibility gate for the boardBySlug query, with the db client mocked.
//
// Slugs are guessable and this query backs the public /b/{slug} web routes, so a
// board the viewer may not read has to come back as null — the same answer as a
// slug that doesn't exist — rather than handing out its name, description and
// location.

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const { dbState } = vi.hoisted(() => ({
  dbState: { queue: [] as unknown[][], selectCalls: 0 },
}));

// A minimal Drizzle-style chain: from/where/limit/innerJoin return the chain, and
// awaiting it at any point dequeues the next seeded result set (one entry per
// db.select call).
vi.mock('../../../../db/client', () => {
  const makeChain = () => {
    const chain = {
      from: () => chain,
      where: () => chain,
      limit: () => chain,
      innerJoin: () => chain,
      leftJoin: () => chain,
      groupBy: () => chain,
      orderBy: () => chain,
      // Deliberately thenable: emulate Drizzle's lazy builder so the queue is
      // only dequeued when a query is awaited.
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

import { socialBoardQueries } from '../boards';

const SYSTEM_OWNER_ID = '00000000-0000-0000-0000-000000000000';

function makeCtx(overrides: Partial<ConnectionContext>): ConnectionContext {
  return { isAuthenticated: false, ...overrides } as unknown as ConnectionContext;
}

function boardRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    uuid: 'board-uuid',
    slug: 'secret-garage',
    ownerId: 'owner-1',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 7,
    setIds: '1,20',
    name: 'Secret Garage Board',
    description: 'In my garage at 12 Example Street',
    locationName: 'Example Street',
    latitude: null,
    longitude: null,
    isPublic: false,
    isUnlisted: false,
    hideLocation: false,
    isOwned: true,
    angle: 40,
    isAngleAdjustable: true,
    gymId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

async function resolveSlug(ctx: ConnectionContext, slug = 'secret-garage') {
  return socialBoardQueries.boardBySlug(null, { slug }, ctx);
}

describe('boardBySlug read visibility', () => {
  beforeEach(() => {
    dbState.queue = [];
    dbState.selectCalls = 0;
  });

  it('hides a private board from an anonymous caller, and never enriches it', async () => {
    dbState.queue = [[boardRow()]];

    const result = await resolveSlug(makeCtx({ isAuthenticated: false }));

    expect(result).toBeNull();
    // Only the board lookup itself ran: enrichBoard, which is what would read
    // the owner profile and gym, was never reached.
    expect(dbState.selectCalls).toBe(1);
  });

  it('hides a private board from a signed-in stranger', async () => {
    dbState.queue = [[boardRow()]];

    const result = await resolveSlug(makeCtx({ isAuthenticated: true, userId: 'stranger-1' }));

    expect(result).toBeNull();
    expect(dbState.selectCalls).toBe(1);
  });

  it('gives the owner their own private board', async () => {
    dbState.queue = [[boardRow()]];

    const result = await resolveSlug(makeCtx({ isAuthenticated: true, userId: 'owner-1' }));

    expect(result).not.toBeNull();
    expect(result).toMatchObject({ slug: 'secret-garage', name: 'Secret Garage Board', isPublic: false });
  });

  it('gives an anonymous caller a public board', async () => {
    dbState.queue = [[boardRow({ isPublic: true })]];

    const result = await resolveSlug(makeCtx({ isAuthenticated: false }));

    expect(result).toMatchObject({ slug: 'secret-garage', isPublic: true });
  });

  it('keeps the system-owned shared board feeds anonymously readable', async () => {
    // resolveSharedBoardForConfig mints these `isPublic: false` under the system
    // owner, and anonymous viewers are first-class on them — the same carve-out
    // isBoardAnonReadable makes.
    dbState.queue = [[boardRow({ ownerId: SYSTEM_OWNER_ID })]];

    const result = await resolveSlug(makeCtx({ isAuthenticated: false }));

    expect(result).not.toBeNull();
  });

  it('gives the staff of a linked gym the gym’s private board', async () => {
    dbState.queue = [
      [boardRow({ gymId: 5 })], // the board lookup
      [{ id: 5 }], // viewerCanAdminGym: the viewer owns the gym
    ];

    const result = await resolveSlug(makeCtx({ isAuthenticated: true, userId: 'gym-owner-1' }));

    expect(result).not.toBeNull();
  });

  it('still returns null for a slug that does not exist', async () => {
    dbState.queue = [[]];

    const result = await resolveSlug(makeCtx({ isAuthenticated: true, userId: 'owner-1' }));

    expect(result).toBeNull();
  });
});
