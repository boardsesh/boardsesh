import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';

const {
  selectMock,
  recentSelectMock,
  executeMock,
  updateMock,
  fetchInstagramMetaMock,
  fetchTikTokMetaMock,
  cacheInstagramMock,
  cacheTikTokMock,
  isS3ConfiguredMock,
  getPublicUrlMock,
  redisConnectedMock,
  redisGetMock,
  redisSetMock,
  redisDelMock,
} = vi.hoisted(() => ({
  selectMock: vi.fn(),
  recentSelectMock: vi.fn(),
  executeMock: vi.fn(),
  updateMock: vi.fn(),
  fetchInstagramMetaMock: vi.fn(),
  fetchTikTokMetaMock: vi.fn(),
  cacheInstagramMock: vi.fn(),
  cacheTikTokMock: vi.fn(),
  isS3ConfiguredMock: vi.fn(() => true),
  getPublicUrlMock: vi.fn((key: string) => `https://bucket.example.com/${key}`),
  // Default `redisConnectedMock` to false so existing tests run without
  // setting up redis stubs — the cache layer falls through to executeMock
  // (the underlying CTE) and the test ergonomics are unchanged.
  redisConnectedMock: vi.fn(() => false),
  redisGetMock: vi.fn<(key: string) => Promise<string | null>>(),
  redisSetMock: vi.fn(),
  redisDelMock: vi.fn(),
}));

vi.mock('../db/client', () => ({
  db: {
    select: (selection?: Record<string, unknown>) => {
      // Route by the shape of the projection so a future query that doesn't
      // match a known path fails loudly instead of resolving via the wrong
      // mock. Known shapes:
      // - `betaLinks` calls `db.select()` with no projection, then
      //   `.from(...).where(...)`.
      // - `recentBetaLinks` / `userBetaLinks` main join calls
      //   `db.select({ ..., climbName, ... }).from(...).leftJoin(...).where(...).orderBy(...).limit(...)`.
      // - `userBetaLinks` profile lookup calls
      //   `db.select({ instagramUrl }).from(...).where(...).limit(...)`.
      // The two projected paths share a chain shape (no orderBy on the
      // profile lookup is fine — chain methods are idempotent) and FIFO-
      // consume `recentSelectMock` so a single test can stage multiple
      // return values in order.
      if (selection === undefined) {
        return {
          from: () => ({
            where: () => Promise.resolve(selectMock()),
          }),
        };
      }
      if ('climbName' in selection || 'instagramUrl' in selection) {
        const chain = {
          from: () => chain,
          leftJoin: () => chain,
          where: () => chain,
          orderBy: () => chain,
          limit: () => Promise.resolve(recentSelectMock()),
        };
        return chain;
      }
      throw new Error(
        `Unhandled db.select() projection in beta-link-queries test mock: ${JSON.stringify(Object.keys(selection))}`,
      );
    },
    execute: (..._args: unknown[]) => Promise.resolve(executeMock()),
    update: () => ({
      set: () => ({
        where: (...args: unknown[]) => {
          updateMock(...args);
          return Promise.resolve();
        },
      }),
    }),
  },
}));

vi.mock('../lib/instagram-meta', async () => {
  const shared = await vi.importActual<typeof import('@boardsesh/shared-schema')>('@boardsesh/shared-schema');
  return {
    fetchInstagramMeta: fetchInstagramMetaMock,
    isInstagramUrl: shared.isInstagramUrl,
    getInstagramMediaId: shared.getInstagramMediaId,
  };
});

vi.mock('../lib/tiktok-meta', async () => {
  const shared = await vi.importActual<typeof import('@boardsesh/shared-schema')>('@boardsesh/shared-schema');
  return {
    fetchTikTokMeta: fetchTikTokMetaMock,
    isTikTokUrl: shared.isTikTokUrl,
    getTikTokCacheId: (url: string) => shared.getTikTokVideoId(url) ?? null,
  };
});

vi.mock('../storage/s3', () => ({
  isS3Configured: isS3ConfiguredMock,
  getPublicUrl: getPublicUrlMock,
  uploadToS3: vi.fn(),
}));

vi.mock('../redis/client', () => ({
  redisClientManager: {
    isRedisConnected: () => redisConnectedMock(),
    getClients: () => ({
      publisher: { get: redisGetMock, set: redisSetMock, del: redisDelMock },
    }),
  },
}));

vi.mock('../lib/beta-link-thumbnails', async () => {
  const actual = await vi.importActual<typeof import('../lib/beta-link-thumbnails')>('../lib/beta-link-thumbnails');
  return {
    ...actual,
    cacheInstagramThumbnail: cacheInstagramMock,
    cacheTikTokThumbnail: cacheTikTokMock,
    isS3Configured: isS3ConfiguredMock,
  };
});

import {
  betaLinkQueries,
  warmRecentBetaLinksCache,
  invalidateRecentBetaLinksCache,
} from '../graphql/resolvers/beta-videos/queries';

type Row = {
  boardType: string;
  climbUuid: string;
  link: string;
  foreignUsername: string | null;
  angle: number | null;
  thumbnail: string | null;
  isListed: boolean | null;
  createdAt: string | null;
  tickUuid: string | null;
  boardId: number | null;
};

function row(overrides: Partial<Row>): Row {
  return {
    boardType: 'kilter',
    climbUuid: 'climb-1',
    link: 'https://www.instagram.com/p/ABC/',
    foreignUsername: null,
    angle: null,
    thumbnail: null,
    isListed: true,
    createdAt: '2026-04-26T00:00:00Z',
    tickUuid: null,
    boardId: null,
    ...overrides,
  };
}

const OUR_S3_THUMB = 'https://bucket.example.com/beta-link-thumbnails/instagram/ABC.jpg';

describe('betaLinks resolver', () => {
  beforeEach(() => {
    selectMock.mockReset();
    updateMock.mockReset();
    fetchInstagramMetaMock.mockReset();
    fetchTikTokMetaMock.mockReset();
    cacheInstagramMock.mockReset();
    cacheTikTokMock.mockReset();
    isS3ConfiguredMock.mockReset();
    isS3ConfiguredMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('drops KayaClimb rows entirely without enriching', async () => {
    selectMock.mockReturnValueOnce([
      row({ link: 'https://app.kayaclimb.com/share/post?id=1' }),
      row({ link: 'https://app.kayaclimb.com/share/post?id=2' }),
    ]);

    const result = await betaLinkQueries.betaLinks(undefined, { boardType: 'kilter', climbUuid: 'climb-1' });

    expect(result).toEqual([]);
    expect(fetchInstagramMetaMock).not.toHaveBeenCalled();
    expect(fetchTikTokMetaMock).not.toHaveBeenCalled();
  });

  it('drops Instagram rows that come back as gone with no cached thumbnail', async () => {
    selectMock.mockReturnValueOnce([row({ link: 'https://www.instagram.com/p/GONE/' })]);
    fetchInstagramMetaMock.mockResolvedValueOnce({ status: 'gone' });

    const result = await betaLinkQueries.betaLinks(undefined, { boardType: 'kilter', climbUuid: 'climb-1' });
    expect(result).toEqual([]);
  });

  it('short-circuits the live fetch as soon as a cached thumbnail is on our S3 (even without username)', async () => {
    // Once we've cached the thumbnail we have everything the slider needs.
    // Skipping the live fetch keeps us from re-poking IG every read for
    // rows that get stuck on `gone` (false positives during login-wall
    // responses) or `transient_error` (active rate-limiting).
    selectMock.mockReturnValueOnce([
      row({ link: 'https://www.instagram.com/p/ABC/', thumbnail: OUR_S3_THUMB, foreignUsername: null }),
    ]);

    const result = await betaLinkQueries.betaLinks(undefined, { boardType: 'kilter', climbUuid: 'climb-1' });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ thumbnail: OUR_S3_THUMB, foreignUsername: null });
    expect(fetchInstagramMetaMock).not.toHaveBeenCalled();
  });

  it('passes through transient_error rows with no cached thumbnail (keeps them in the slider with thumbnail: null)', async () => {
    selectMock.mockReturnValueOnce([row({ link: 'https://www.instagram.com/p/ABC/', thumbnail: null })]);
    fetchInstagramMetaMock.mockResolvedValueOnce({ status: 'transient_error' });

    const result = await betaLinkQueries.betaLinks(undefined, { boardType: 'kilter', climbUuid: 'climb-1' });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ thumbnail: null });
  });

  it('persists the S3 thumbnail on first read when S3 is configured', async () => {
    selectMock.mockReturnValueOnce([row({ link: 'https://www.instagram.com/p/ABC/', thumbnail: null })]);
    fetchInstagramMetaMock.mockResolvedValueOnce({
      status: 'ok',
      thumbnail: 'https://scontent.cdninstagram.com/raw.jpg',
      username: 'climber',
    });
    cacheInstagramMock.mockResolvedValueOnce(OUR_S3_THUMB);

    const result = await betaLinkQueries.betaLinks(undefined, { boardType: 'kilter', climbUuid: 'climb-1' });
    expect(result[0]).toMatchObject({ thumbnail: OUR_S3_THUMB, foreignUsername: 'climber' });
    expect(cacheInstagramMock).toHaveBeenCalledWith('ABC', 'https://scontent.cdninstagram.com/raw.jpg');
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it('returns the dev proxy URL when S3 is not configured', async () => {
    isS3ConfiguredMock.mockReturnValue(false);
    selectMock.mockReturnValueOnce([row({ link: 'https://www.instagram.com/p/ABC/' })]);
    fetchInstagramMetaMock.mockResolvedValueOnce({
      status: 'ok',
      thumbnail: 'https://scontent.cdninstagram.com/raw.jpg',
      username: 'climber',
    });

    const result = await betaLinkQueries.betaLinks(undefined, { boardType: 'kilter', climbUuid: 'climb-1' });
    expect(result[0]?.thumbnail).toBe(
      `/api/internal/beta-link-thumbnail?url=${encodeURIComponent('https://scontent.cdninstagram.com/raw.jpg')}`,
    );
    expect(cacheInstagramMock).not.toHaveBeenCalled();
  });

  it('short-circuits the live fetch when row is fully enriched', async () => {
    selectMock.mockReturnValueOnce([
      row({
        link: 'https://www.instagram.com/p/ABC/',
        thumbnail: OUR_S3_THUMB,
        foreignUsername: 'climber',
      }),
    ]);

    const result = await betaLinkQueries.betaLinks(undefined, { boardType: 'kilter', climbUuid: 'climb-1' });
    expect(result[0]).toMatchObject({ thumbnail: OUR_S3_THUMB, foreignUsername: 'climber' });
    expect(fetchInstagramMetaMock).not.toHaveBeenCalled();
  });

  it('routes TikTok URLs through the TikTok enricher', async () => {
    const tikUrl = 'https://www.tiktok.com/@climber/video/9999999999';
    selectMock.mockReturnValueOnce([row({ link: tikUrl })]);
    fetchTikTokMetaMock.mockResolvedValueOnce({
      status: 'ok',
      thumbnail: 'https://p16-common-sign.tiktokcdn.com/x.jpg?x-expires=1',
      username: 'climber',
    });
    cacheTikTokMock.mockResolvedValueOnce('https://bucket.example.com/beta-link-thumbnails/tiktok/9999999999.jpg');

    const result = await betaLinkQueries.betaLinks(undefined, { boardType: 'kilter', climbUuid: 'climb-1' });
    expect(result[0]).toMatchObject({
      link: tikUrl,
      foreignUsername: 'climber',
      thumbnail: 'https://bucket.example.com/beta-link-thumbnails/tiktok/9999999999.jpg',
    });
    expect(cacheTikTokMock).toHaveBeenCalledWith(
      '9999999999',
      'https://p16-common-sign.tiktokcdn.com/x.jpg?x-expires=1',
    );
    expect(fetchInstagramMetaMock).not.toHaveBeenCalled();
  });
});

describe('recentBetaLinks resolver', () => {
  beforeEach(() => {
    executeMock.mockReset();
    fetchInstagramMetaMock.mockReset();
    fetchTikTokMetaMock.mockReset();
    redisConnectedMock.mockReset();
    redisGetMock.mockReset();
    redisSetMock.mockReset();
    redisDelMock.mockReset();
    // Default: Redis disconnected so the cache layer falls through to the
    // underlying CTE on every call. Individual tests opt-in to a connected
    // mock when they want to exercise cache hit/miss behaviour.
    redisConnectedMock.mockReturnValue(false);
  });

  // The CTE-based resolver returns flat snake_case rows from `db.execute` and
  // the cap-3 partition+filter happens inside the SQL. The test fixture only
  // has to mimic that shape — we don't try to re-implement the window function
  // here. Tests that assert cap behaviour mock the post-cap result set.
  type CteRow = {
    board_type: string;
    climb_uuid: string;
    link: string;
    foreign_username: string | null;
    angle: number | null;
    thumbnail: string | null;
    is_listed: boolean | null;
    created_at: string | null;
    climb_name: string | null;
    layout_id: number | null;
  };

  function cteRow(overrides: Partial<CteRow> = {}, climbName: string | null = 'Test Climb'): CteRow {
    return {
      board_type: 'kilter',
      climb_uuid: 'climb-1',
      link: 'https://www.instagram.com/p/ABC/',
      foreign_username: null,
      angle: null,
      thumbnail: '/static/beta-link-thumbnails/instagram/ABC.jpg',
      is_listed: true,
      created_at: '2026-04-26T00:00:00Z',
      climb_name: climbName,
      layout_id: 1,
      ...overrides,
    };
  }

  it('returns wrapped rows with the joined climb name and source boardType', async () => {
    executeMock.mockReturnValueOnce([
      cteRow({ link: 'https://www.instagram.com/p/A/' }, 'Crimpy Mantle'),
      cteRow({ link: 'https://www.instagram.com/p/B/', board_type: 'tension' }, 'Steep Compression'),
    ]);

    const result = await betaLinkQueries.recentBetaLinks(undefined, { limit: 20 });

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      climbName: 'Crimpy Mantle',
      boardType: 'kilter',
      betaLink: { link: 'https://www.instagram.com/p/A/' },
    });
    expect(result[1]).toMatchObject({ climbName: 'Steep Compression', boardType: 'tension' });
  });

  it('drops KayaClimb URLs', async () => {
    executeMock.mockReturnValueOnce([
      cteRow({ link: 'https://app.kayaclimb.com/share/post?id=1' }),
      cteRow({ link: 'https://www.instagram.com/p/A/' }, 'Project'),
    ]);

    const result = await betaLinkQueries.recentBetaLinks(undefined, { limit: 20 });

    expect(result).toHaveLength(1);
    expect(result[0]?.climbName).toBe('Project');
  });

  it('tolerates a null climbName (beta link arrived before the climb synced)', async () => {
    executeMock.mockReturnValueOnce([cteRow({}, null)]);

    const result = await betaLinkQueries.recentBetaLinks(undefined, { limit: 20 });

    expect(result).toHaveLength(1);
    expect(result[0]?.climbName).toBeNull();
  });

  it('passes thumbnails through unchanged when they are already on our static prefix', async () => {
    const ourThumb = '/static/beta-link-thumbnails/instagram/ABC.jpg';
    executeMock.mockReturnValueOnce([cteRow({ thumbnail: ourThumb })]);

    const result = await betaLinkQueries.recentBetaLinks(undefined, { limit: 20 });

    expect(result[0]?.betaLink.thumbnail).toBe(ourThumb);
  });

  it('never enriches via the live IG/TikTok APIs', async () => {
    executeMock.mockReturnValueOnce([
      cteRow({ link: 'https://www.instagram.com/p/A/' }),
      cteRow({ link: 'https://www.tiktok.com/@u/video/1' }),
    ]);

    await betaLinkQueries.recentBetaLinks(undefined, { limit: 20 });

    expect(fetchInstagramMetaMock).not.toHaveBeenCalled();
    expect(fetchTikTokMetaMock).not.toHaveBeenCalled();
  });

  it('accepts the boardType filter without throwing', async () => {
    executeMock.mockReturnValueOnce([cteRow({ board_type: 'kilter' })]);

    const result = await betaLinkQueries.recentBetaLinks(undefined, { limit: 20, boardType: 'kilter' });

    expect(result).toHaveLength(1);
    expect(result[0]?.boardType).toBe('kilter');
  });
});

describe('userBetaLinks resolver', () => {
  beforeEach(() => {
    recentSelectMock.mockReset();
    fetchInstagramMetaMock.mockReset();
    fetchTikTokMetaMock.mockReset();
  });

  function joinedRow(overrides: Partial<Row> = {}, climbName: string | null = 'Test Climb') {
    return {
      betaLink: row({
        thumbnail: '/static/beta-link-thumbnails/instagram/ABC.jpg',
        ...overrides,
      }),
      climbName,
      layoutId: 1,
    };
  }

  it("returns the user's beta links and short-circuits when they have no IG handle", async () => {
    // First select: profile lookup → no IG URL set. Second select: the
    // beta-link join. The OR-by-handle branch is unreachable because the
    // handle is null, so the WHERE collapses to created_by_user_id = userId.
    recentSelectMock
      .mockReturnValueOnce([{ instagramUrl: null }])
      .mockReturnValueOnce([
        joinedRow({ link: 'https://www.instagram.com/p/MINE/', foreignUsername: 'someoneelse' }, 'Project'),
      ]);

    const result = await betaLinkQueries.userBetaLinks(undefined, { userId: 'user-1', limit: 50 });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ climbName: 'Project', betaLink: { foreignUsername: 'someoneelse' } });
  });

  it('falls back gracefully when the user has no profile row at all', async () => {
    recentSelectMock
      .mockReturnValueOnce([])
      .mockReturnValueOnce([joinedRow({ link: 'https://www.instagram.com/p/A/' })]);

    const result = await betaLinkQueries.userBetaLinks(undefined, { userId: 'user-1', limit: 50 });
    expect(result).toHaveLength(1);
  });

  it('extracts an IG handle from instagramUrl and merges OR-matched rows', async () => {
    recentSelectMock
      .mockReturnValueOnce([{ instagramUrl: 'https://www.instagram.com/marco/' }])
      .mockReturnValueOnce([joinedRow({ link: 'https://www.instagram.com/p/A/', foreignUsername: 'marco' })]);

    const result = await betaLinkQueries.userBetaLinks(undefined, { userId: 'user-1', limit: 50 });
    expect(result).toHaveLength(1);
    expect(result[0]?.betaLink.foreignUsername).toBe('marco');
  });

  it('drops KayaClimb URLs', async () => {
    recentSelectMock
      .mockReturnValueOnce([{ instagramUrl: null }])
      .mockReturnValueOnce([
        joinedRow({ link: 'https://app.kayaclimb.com/share/post?id=1' }),
        joinedRow({ link: 'https://www.instagram.com/p/A/' }, 'Real'),
      ]);

    const result = await betaLinkQueries.userBetaLinks(undefined, { userId: 'user-1', limit: 50 });
    expect(result).toHaveLength(1);
    expect(result[0]?.climbName).toBe('Real');
  });

  it('never enriches via the live IG/TikTok APIs', async () => {
    recentSelectMock
      .mockReturnValueOnce([{ instagramUrl: null }])
      .mockReturnValueOnce([
        joinedRow({ link: 'https://www.instagram.com/p/A/' }),
        joinedRow({ link: 'https://www.tiktok.com/@u/video/1' }),
      ]);

    await betaLinkQueries.userBetaLinks(undefined, { userId: 'user-1', limit: 50 });

    expect(fetchInstagramMetaMock).not.toHaveBeenCalled();
    expect(fetchTikTokMetaMock).not.toHaveBeenCalled();
  });
});

describe('recentBetaLinks Redis cache', () => {
  // Match the snake_case shape the resolver stores in Redis (and returns from
  // the CTE). Keep this in sync with CachedRecentBetaLinkRow in the resolver.
  type CachedRow = {
    board_type: string;
    climb_uuid: string;
    link: string;
    foreign_username: string | null;
    angle: number | null;
    thumbnail: string | null;
    is_listed: boolean | null;
    created_at: string | null;
    climb_name: string | null;
    layout_id: number | null;
  };

  function cachedRow(overrides: Partial<CachedRow> = {}): CachedRow {
    return {
      board_type: 'kilter',
      climb_uuid: 'climb-1',
      link: 'https://www.instagram.com/p/ABC/',
      foreign_username: null,
      angle: null,
      thumbnail: '/static/beta-link-thumbnails/instagram/ABC.jpg',
      is_listed: true,
      created_at: '2026-04-26T00:00:00Z',
      climb_name: 'Test Climb',
      layout_id: 1,
      ...overrides,
    };
  }

  beforeEach(() => {
    executeMock.mockReset();
    redisConnectedMock.mockReset();
    redisGetMock.mockReset();
    redisSetMock.mockReset();
    redisDelMock.mockReset();
    redisConnectedMock.mockReturnValue(true);
  });

  it('returns cached rows without running the CTE on hit', async () => {
    redisGetMock.mockResolvedValueOnce(JSON.stringify([cachedRow({ link: 'https://www.instagram.com/p/CACHE/' })]));

    const result = await betaLinkQueries.recentBetaLinks(undefined, { limit: 20 });

    expect(result).toHaveLength(1);
    expect(result[0]?.betaLink.link).toBe('https://www.instagram.com/p/CACHE/');
    expect(executeMock).not.toHaveBeenCalled();
    expect(redisSetMock).not.toHaveBeenCalled();
  });

  it('runs the CTE on miss and writes the result back to Redis', async () => {
    redisGetMock.mockResolvedValueOnce(null);
    executeMock.mockReturnValueOnce([cachedRow({ link: 'https://www.instagram.com/p/MISS/' })]);

    const result = await betaLinkQueries.recentBetaLinks(undefined, { limit: 20 });

    expect(result).toHaveLength(1);
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(redisSetMock).toHaveBeenCalledTimes(1);
    // The cached value is JSON-stringified, with TTL set via 'EX' option.
    const [key, json, opt, ttl] = redisSetMock.mock.calls[0];
    expect(key).toBe('boardsesh:recent-beta-links');
    expect(typeof json).toBe('string');
    expect(opt).toBe('EX');
    expect(typeof ttl).toBe('number');
  });

  it('filters cached rows by boardType in JavaScript so one cache key covers all callers', async () => {
    redisGetMock.mockResolvedValueOnce(
      JSON.stringify([
        cachedRow({ board_type: 'kilter', link: 'https://www.instagram.com/p/K1/' }),
        cachedRow({ board_type: 'tension', link: 'https://www.instagram.com/p/T1/' }),
        cachedRow({ board_type: 'kilter', link: 'https://www.instagram.com/p/K2/' }),
      ]),
    );

    const tensionOnly = await betaLinkQueries.recentBetaLinks(undefined, { limit: 20, boardType: 'tension' });

    expect(tensionOnly).toHaveLength(1);
    expect(tensionOnly[0]?.boardType).toBe('tension');
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('falls through to the CTE when Redis is unavailable', async () => {
    redisConnectedMock.mockReturnValue(false);
    executeMock.mockReturnValueOnce([cachedRow({ link: 'https://www.instagram.com/p/NORDB/' })]);

    const result = await betaLinkQueries.recentBetaLinks(undefined, { limit: 20 });

    expect(result).toHaveLength(1);
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(redisGetMock).not.toHaveBeenCalled();
    expect(redisSetMock).not.toHaveBeenCalled();
  });

  it('still serves a result when the Redis read throws', async () => {
    redisGetMock.mockRejectedValueOnce(new Error('redis down mid-flight'));
    executeMock.mockReturnValueOnce([cachedRow({ link: 'https://www.instagram.com/p/REDISFAIL/' })]);

    const result = await betaLinkQueries.recentBetaLinks(undefined, { limit: 20 });

    expect(result).toHaveLength(1);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('warmRecentBetaLinksCache: deletes stale key and re-runs the CTE on lock win', async () => {
    redisSetMock.mockResolvedValueOnce('OK'); // lock acquired
    executeMock.mockReturnValueOnce([cachedRow()]);

    await warmRecentBetaLinksCache();

    // Lock first, then DEL the cache key, then run the CTE and SET the result.
    expect(redisSetMock.mock.calls[0][0]).toBe('boardsesh:recent-beta-links:lock');
    expect(redisDelMock).toHaveBeenCalledWith('boardsesh:recent-beta-links');
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('warmRecentBetaLinksCache: skips the query when another node holds the lock', async () => {
    redisSetMock.mockResolvedValueOnce(null); // lock NOT acquired

    await warmRecentBetaLinksCache();

    expect(redisDelMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('invalidateRecentBetaLinksCache: DELs the key', async () => {
    redisDelMock.mockResolvedValueOnce(1);

    await invalidateRecentBetaLinksCache();

    expect(redisDelMock).toHaveBeenCalledWith('boardsesh:recent-beta-links');
  });

  it('invalidateRecentBetaLinksCache: silent on Redis unavailable', async () => {
    redisConnectedMock.mockReturnValue(false);

    await invalidateRecentBetaLinksCache();

    expect(redisDelMock).not.toHaveBeenCalled();
  });
});

describe('betaLinkPreview resolver', () => {
  // requireAuthenticated + applyRateLimit run for real here (helpers isn't
  // mocked); the redis mock defaults to disconnected so applyRateLimit falls
  // back to the in-memory limiter and never needs a real Redis.
  const ctx = (isAuthenticated: boolean) =>
    ({ isAuthenticated, userId: 'user-1', connectionId: 'conn-1', clientIp: '127.0.0.1' }) as unknown as Parameters<
      typeof betaLinkQueries.betaLinkPreview
    >[2];

  beforeEach(() => {
    fetchInstagramMetaMock.mockReset();
    fetchTikTokMetaMock.mockReset();
    redisConnectedMock.mockReset();
    redisConnectedMock.mockReturnValue(false);
  });

  it('returns thumbnail + caption for an authenticated Instagram preview', async () => {
    fetchInstagramMetaMock.mockResolvedValueOnce({
      status: 'ok',
      thumbnail: 'https://scontent.cdninstagram.com/raw.jpg',
      username: 'climber',
      caption: 'Sent Purple Nurple 🧗',
    });

    const result = await betaLinkQueries.betaLinkPreview(
      undefined,
      { link: 'https://www.instagram.com/reel/ABC123/' },
      ctx(true),
    );

    expect(result).toEqual({
      link: 'https://www.instagram.com/reel/ABC123/',
      thumbnail: 'https://scontent.cdninstagram.com/raw.jpg',
      username: 'climber',
      caption: 'Sent Purple Nurple 🧗',
    });
  });

  it('throws when unauthenticated and never calls out to Instagram', async () => {
    await expect(
      betaLinkQueries.betaLinkPreview(undefined, { link: 'https://www.instagram.com/reel/ABC123/' }, ctx(false)),
    ).rejects.toThrow(/auth/i);
    expect(fetchInstagramMetaMock).not.toHaveBeenCalled();
  });

  it('returns null fields (no error, no outbound call) for a non-IG/TikTok URL', async () => {
    const result = await betaLinkQueries.betaLinkPreview(
      undefined,
      { link: 'https://example.com/whatever' },
      ctx(true),
    );

    expect(result).toEqual({
      link: 'https://example.com/whatever',
      thumbnail: null,
      username: null,
      caption: null,
    });
    expect(fetchInstagramMetaMock).not.toHaveBeenCalled();
    expect(fetchTikTokMetaMock).not.toHaveBeenCalled();
  });

  it('previews TikTok (thumbnail + username; caption stays null)', async () => {
    fetchTikTokMetaMock.mockResolvedValueOnce({
      status: 'ok',
      thumbnail: 'https://p16-common-sign.tiktokcdn.com/x.jpg',
      username: 'climber',
    });
    const url = 'https://www.tiktok.com/@climber/video/9999999999';

    const result = await betaLinkQueries.betaLinkPreview(undefined, { link: url }, ctx(true));

    expect(result).toMatchObject({
      link: url,
      thumbnail: 'https://p16-common-sign.tiktokcdn.com/x.jpg',
      username: 'climber',
      caption: null,
    });
    expect(fetchInstagramMetaMock).not.toHaveBeenCalled();
  });

  it('best-effort: an unavailable IG post yields null media fields, not an error', async () => {
    fetchInstagramMetaMock.mockResolvedValueOnce({ status: 'gone' });

    const result = await betaLinkQueries.betaLinkPreview(
      undefined,
      { link: 'https://www.instagram.com/p/GONE/' },
      ctx(true),
    );

    expect(result).toMatchObject({
      link: 'https://www.instagram.com/p/GONE/',
      thumbnail: null,
      username: null,
      caption: null,
    });
  });
});
