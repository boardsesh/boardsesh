import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// db.select is called twice in resolveBetaLinkTickContext:
//   1. Tick + alias left-join query (.from(boardseshTicks) ...)
//   2. Existing beta-link check     (.from(boardBetaLinks) ...)
//
// The mock dispatches on the table passed to .from() so adding/removing joins
// in the production query doesn't silently break these tests — only an actual
// change in which table is queried would do that.
const { mockDbSelect } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
}));

vi.mock('../db/client', () => ({
  db: {
    select: mockDbSelect,
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../events', () => ({ publishSocialEvent: vi.fn() }));

vi.mock('../graphql/resolvers/sessions/debounced-stats-publisher', () => ({
  publishDebouncedSessionStats: vi.fn(),
}));

vi.mock('../lib/beta-link-thumbnails', async () => {
  const actual = await vi.importActual<typeof import('../lib/beta-link-thumbnails')>('../lib/beta-link-thumbnails');
  return { ...actual, cacheInstagramThumbnail: vi.fn(), isS3Configured: vi.fn(() => false) };
});

vi.mock('../redis/client', () => ({
  redisClientManager: {
    isRedisConnected: () => false,
    getClients: () => ({ publisher: { get: vi.fn(), set: vi.fn(), del: vi.fn() } }),
  },
}));

vi.mock('../graphql/resolvers/shared/helpers', async () => {
  const actual = await vi.importActual<typeof import('../graphql/resolvers/shared/helpers')>(
    '../graphql/resolvers/shared/helpers',
  );
  return { ...actual, applyRateLimit: vi.fn(async () => {}) };
});

import * as dbSchema from '@boardsesh/db/schema';
import { resolveBetaLinkTickContext } from '../graphql/resolvers/ticks/mutations';

type TickRow = {
  uuid: string;
  userId: string;
  boardType: string;
  climbUuid: string;
  canonicalClimbUuid: string | null;
  inputCanonicalClimbUuid: string | null;
  angle: number;
  status: string;
  boardId: number | null;
};

function makeTick(overrides: Partial<TickRow> = {}): TickRow {
  return {
    uuid: 'tick-uuid-1',
    userId: 'user-1',
    boardType: 'kilter',
    climbUuid: 'climb-1',
    canonicalClimbUuid: null,
    inputCanonicalClimbUuid: null,
    angle: 40,
    status: 'send',
    boardId: 42,
    ...overrides,
  };
}

/**
 * Configure the db.select mock to dispatch on the table passed to .from():
 *   boardseshTicks → resolves tickRow (or empty array if null)
 *   boardBetaLinks → resolves [{ link }] if existingLink provided, else []
 *
 * The mock returns a chain stub for whichever table is hit. Any join methods
 * on the tick query are forwarded so the chain terminates correctly regardless
 * of how many joins the production query uses.
 */
function setupDbMocks(tickRow: TickRow | null, existingLink: string | null = null) {
  mockDbSelect.mockImplementation(() => ({
    from: (table: unknown) => {
      if (table === dbSchema.boardseshTicks) {
        const tickResults = tickRow ? [tickRow] : [];
        const chain = {
          leftJoin: () => chain,
          where: () => ({ limit: () => Promise.resolve(tickResults) }),
        };
        return chain;
      }
      if (table === dbSchema.boardBetaLinks) {
        const linkResults = existingLink ? [{ link: existingLink }] : [];
        return {
          where: () => ({ limit: () => Promise.resolve(linkResults) }),
        };
      }
      return { where: () => ({ limit: () => Promise.resolve([]) }) };
    },
  }));
}

describe('resolveBetaLinkTickContext', () => {
  beforeEach(() => {
    mockDbSelect.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns null context immediately when tickUuid is absent, never hitting the DB', async () => {
    const result = await resolveBetaLinkTickContext({ boardType: 'kilter', climbUuid: 'climb-1', angle: 45 }, 'user-1');
    expect(result).toEqual({ tickUuid: null, boardId: null, angle: 45 });
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('returns null context with null angle when neither angle nor tickUuid is provided', async () => {
    const result = await resolveBetaLinkTickContext({ boardType: 'kilter', climbUuid: 'climb-1' }, 'user-1');
    expect(result).toEqual({ tickUuid: null, boardId: null, angle: null });
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('throws TICK_NOT_FOUND when the tick UUID does not exist', async () => {
    setupDbMocks(null);
    await expect(
      resolveBetaLinkTickContext({ boardType: 'kilter', climbUuid: 'climb-1', tickUuid: 'nonexistent-uuid' }, 'user-1'),
    ).rejects.toMatchObject({ extensions: { code: 'TICK_NOT_FOUND' } });
  });

  it('throws FORBIDDEN when the tick belongs to a different user', async () => {
    setupDbMocks(makeTick({ userId: 'other-user' }));
    await expect(
      resolveBetaLinkTickContext({ boardType: 'kilter', climbUuid: 'climb-1', tickUuid: 'tick-uuid-1' }, 'user-1'),
    ).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });

  it('throws BETA_LINK_TICK_NOT_ASCENT when tick status is attempt', async () => {
    setupDbMocks(makeTick({ status: 'attempt' }));
    await expect(
      resolveBetaLinkTickContext({ boardType: 'kilter', climbUuid: 'climb-1', tickUuid: 'tick-uuid-1' }, 'user-1'),
    ).rejects.toMatchObject({ extensions: { code: 'BETA_LINK_TICK_NOT_ASCENT' } });
  });

  it('throws BETA_LINK_TICK_MISMATCH when tick is for a different board type', async () => {
    setupDbMocks(makeTick({ boardType: 'tension' }));
    await expect(
      resolveBetaLinkTickContext({ boardType: 'kilter', climbUuid: 'climb-1', tickUuid: 'tick-uuid-1' }, 'user-1'),
    ).rejects.toMatchObject({ extensions: { code: 'BETA_LINK_TICK_MISMATCH' } });
  });

  it('throws when tick climb UUID does not match the input climb UUID', async () => {
    setupDbMocks(makeTick({ climbUuid: 'climb-other', canonicalClimbUuid: null, inputCanonicalClimbUuid: null }));
    await expect(
      resolveBetaLinkTickContext({ boardType: 'kilter', climbUuid: 'climb-1', tickUuid: 'tick-uuid-1' }, 'user-1'),
    ).rejects.toMatchObject({ extensions: { code: 'BETA_LINK_TICK_MISMATCH' } });
  });

  it('throws BETA_LINK_TICK_MISMATCH when the provided angle differs from the tick angle', async () => {
    setupDbMocks(makeTick({ angle: 40 }));
    await expect(
      resolveBetaLinkTickContext(
        { boardType: 'kilter', climbUuid: 'climb-1', angle: 45, tickUuid: 'tick-uuid-1' },
        'user-1',
      ),
    ).rejects.toMatchObject({ extensions: { code: 'BETA_LINK_TICK_MISMATCH' } });
  });

  it('does not throw for angle check when no input angle is provided', async () => {
    setupDbMocks(makeTick({ angle: 40 }));
    const result = await resolveBetaLinkTickContext(
      { boardType: 'kilter', climbUuid: 'climb-1', tickUuid: 'tick-uuid-1' },
      'user-1',
    );
    expect(result).toMatchObject({ tickUuid: 'tick-uuid-1', angle: 40 });
  });

  it('throws BETA_LINK_TICK_ALREADY_LINKED when the tick already has a different beta video', async () => {
    setupDbMocks(makeTick(), 'https://www.instagram.com/reel/EXISTING/');
    await expect(
      resolveBetaLinkTickContext(
        { boardType: 'kilter', climbUuid: 'climb-1', tickUuid: 'tick-uuid-1', link: 'https://www.instagram.com/reel/DIFFERENT/' },
        'user-1',
      ),
    ).rejects.toMatchObject({ extensions: { code: 'BETA_LINK_TICK_ALREADY_LINKED' } });
  });

  it('throws BETA_LINK_TICK_ALREADY_LINKED when no link is provided and the tick already has a video', async () => {
    setupDbMocks(makeTick(), 'https://www.instagram.com/reel/EXISTING/');
    await expect(
      resolveBetaLinkTickContext({ boardType: 'kilter', climbUuid: 'climb-1', tickUuid: 'tick-uuid-1' }, 'user-1'),
    ).rejects.toMatchObject({ extensions: { code: 'BETA_LINK_TICK_ALREADY_LINKED' } });
  });

  it('returns existing context (idempotent) when the same canonical video is re-submitted for the same tick', async () => {
    // Simulates a mobile retry: the first call succeeded, the tick now has a beta
    // link, and the client retries. Since the video identity matches, succeed silently.
    setupDbMocks(makeTick(), 'https://www.instagram.com/reel/SameId/');
    const result = await resolveBetaLinkTickContext(
      {
        boardType: 'kilter',
        climbUuid: 'climb-1',
        tickUuid: 'tick-uuid-1',
        // Same reel, different tracking params — normalizes to the same identity.
        link: 'https://www.instagram.com/reel/SameId/?igsh=tracking',
      },
      'user-1',
    );
    expect(result).toEqual({ tickUuid: 'tick-uuid-1', boardId: 42, angle: 40 });
  });

  it('returns full tick context on the happy path', async () => {
    setupDbMocks(makeTick());
    const result = await resolveBetaLinkTickContext(
      { boardType: 'kilter', climbUuid: 'climb-1', angle: 40, tickUuid: 'tick-uuid-1' },
      'user-1',
    );
    expect(result).toEqual({ tickUuid: 'tick-uuid-1', boardId: 42, angle: 40 });
  });

  it('accepts both flash and send status ticks', async () => {
    for (const status of ['flash', 'send'] as const) {
      setupDbMocks(makeTick({ status }));
      const result = await resolveBetaLinkTickContext(
        { boardType: 'kilter', climbUuid: 'climb-1', tickUuid: 'tick-uuid-1' },
        'user-1',
      );
      expect(result.tickUuid).toBe('tick-uuid-1');
    }
  });

  it('resolves correctly when both tick and input share the same canonical UUID via aliases', async () => {
    // tick.climbUuid = 'alias-a' → canonical 'canonical-1'
    // input.climbUuid = 'alias-b' → canonical 'canonical-1'
    // Both resolve to the same canonical — should succeed.
    setupDbMocks(
      makeTick({ climbUuid: 'alias-a', canonicalClimbUuid: 'canonical-1', inputCanonicalClimbUuid: 'canonical-1' }),
    );
    const result = await resolveBetaLinkTickContext(
      { boardType: 'kilter', climbUuid: 'alias-b', tickUuid: 'tick-uuid-1' },
      'user-1',
    );
    expect(result.tickUuid).toBe('tick-uuid-1');
  });

  it('returns angle from the tick, not from the input (tick is authoritative)', async () => {
    setupDbMocks(makeTick({ angle: 30 }));
    const result = await resolveBetaLinkTickContext(
      // Matching angle passed — stored angle comes from the tick
      { boardType: 'kilter', climbUuid: 'climb-1', angle: 30, tickUuid: 'tick-uuid-1' },
      'user-1',
    );
    expect(result.angle).toBe(30);
  });
});
