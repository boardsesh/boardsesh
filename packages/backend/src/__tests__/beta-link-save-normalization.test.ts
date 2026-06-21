import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Captures the values written to boardBetaLinks from both save entry points
// (attachBetaLink via db.insert, saveTick via tx.insert inside the transaction)
// so we can assert the stored link/shortcode drop the igsh share-attribution
// param. `betaInsert` is set whenever an inserted row carries a `link` field.
const { betaInsert, selectMock } = vi.hoisted(() => ({
  betaInsert: { current: null as Record<string, unknown> | null },
  // Dedup probe (findBetaLinkIdentityConflict) — return no conflict. It now
  // leftJoins board_climbs for the conflicting climb's name, so the mock chain
  // mirrors from().leftJoin().where().
  selectMock: vi.fn(() => ({
    from: () => ({ leftJoin: () => ({ where: () => Promise.resolve([]) }) }),
  })),
}));

function captureBetaInsert(values: Record<string, unknown>): void {
  if (values && typeof values === 'object' && 'link' in values) {
    betaInsert.current = values;
  }
}

const tx = {
  insert: () => ({
    values: (values: Record<string, unknown>) => {
      captureBetaInsert(values);
      return {
        returning: () => Promise.resolve([values]),
        onConflictDoNothing: () => Promise.resolve(),
      };
    },
  }),
  update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
};

vi.mock('../db/client', () => ({
  db: {
    select: selectMock,
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        captureBetaInsert(values);
        return { onConflictDoNothing: () => Promise.resolve() };
      },
    }),
    transaction: (callback: (txArg: typeof tx) => unknown) => callback(tx),
  },
}));

vi.mock('../events', () => ({ publishSocialEvent: vi.fn() }));
vi.mock('../graphql/resolvers/sessions/debounced-stats-publisher', () => ({
  publishDebouncedSessionStats: vi.fn(),
}));
vi.mock('../graphql/resolvers/ticks/debounced-climb-stats-publisher', () => ({
  queueClimbStatsRecompute: vi.fn(),
}));

vi.mock('../utils/instagram-beta-validation', async () => {
  const actual = await vi.importActual<typeof import('../utils/instagram-beta-validation')>(
    '../utils/instagram-beta-validation',
  );
  return {
    ...actual,
    validateInstagramBetaLink: vi.fn(async () => ({ mediaId: 'DZlVfVhxKJZ', username: 'climber', imageUrl: null })),
  };
});

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

import { tickMutations } from '../graphql/resolvers/ticks/mutations';

const ctx = { userId: 'user-1', isAuthenticated: true } as unknown as Parameters<
  typeof tickMutations.attachBetaLink
>[2];

const REEL_WITH_PARAM = 'https://www.instagram.com/reel/DZlVfVhxKJZ/?igsh=NHB5ZXljZjV3bzB3';
const REEL_CLEAN = 'https://www.instagram.com/reel/DZlVfVhxKJZ/';

describe('save-side Instagram URL normalization', () => {
  beforeEach(() => {
    betaInsert.current = null;
    selectMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('attachBetaLink stores the link and shortcode stripped of the igsh param', async () => {
    const result = await tickMutations.attachBetaLink(
      undefined,
      {
        input: {
          boardType: 'kilter',
          climbUuid: '00000000-0000-0000-0000-000000000000',
          link: REEL_WITH_PARAM,
        },
      },
      ctx,
    );

    expect(result).toBe(true);
    expect(betaInsert.current).toMatchObject({ link: REEL_CLEAN, shortcode: 'DZlVfVhxKJZ' });
  });

  it('saveTick attaches the beta link with the igsh param stripped on a successful ascent', async () => {
    await tickMutations.saveTick(
      undefined,
      {
        input: {
          boardType: 'kilter',
          climbUuid: '00000000-0000-0000-0000-000000000000',
          angle: 40,
          isMirror: false,
          status: 'send',
          attemptCount: 1,
          isBenchmark: false,
          comment: '',
          climbedAt: new Date().toISOString(),
          videoUrl: REEL_WITH_PARAM,
        },
      },
      ctx,
    );

    expect(betaInsert.current).toMatchObject({ link: REEL_CLEAN, shortcode: 'DZlVfVhxKJZ' });
  });
});
