import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_BOARDSESH_RENDER_SETTINGS } from '@boardsesh/board-look';

// Same seams as `spray-wall-loader.test.ts`: the GraphQL client, connectivity
// and the native file cache are stood in for, so what is under test is the
// decision of which picture a wall is drawn on and which holds go with it.
const offline = vi.hoisted(() => ({ offline: false }));
vi.mock('../../connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: offline.offline }),
  subscribeConnectivity: () => () => {},
}));
vi.mock('../spray-wall-local-loader', () => ({ loadLocalSprayWall: vi.fn(async () => false) }));
const requestMock = vi.hoisted(() => vi.fn());
vi.mock('../../graphql/client', () => ({ getHttpClient: () => ({ request: requestMock }) }));
vi.mock('../spray-privacy-cleanup', async () => {
  const { unregisterSprayWall: withdraw } = await import('../spray-wall-registry');
  return { clearSprayWallPrivateCaches: (layoutId: number) => withdraw(layoutId) };
});
vi.mock('../../create-climb-draft-store', () => ({ clearSupersededSprayDrafts: async () => {} }));
vi.mock('../../error-reporting', () => ({ reportHandledError: vi.fn() }));
const downloads = vi.hoisted(() => ({
  ensure: vi.fn(async (..._args: unknown[]): Promise<string | null> => '/cache/art'),
}));
vi.mock('../spray-photo-cache', () => ({ ensureSprayPhotoCached: downloads.ensure }));

const registry = await import('../spray-wall-registry');
const loader = await import('../spray-wall-loader');
const { getBoardRenderData, clearBoardRenderDataCache } = await import('../../board-details');
const keys = await import('../spray-photo-keys');
const sprayOperations = await import('@boardsesh/graphql/operations/spray-walls');

const LAYOUT_ID = 4300;
const WALL_UUID = 'wall-art';
const LOOK = { mode: 'aura' as const, boardsesh: DEFAULT_BOARDSESH_RENDER_SETTINGS };
// A photo twice the canonical frame's size: its homography maps photo pixels
// down by half, so photo-mode holds land at twice their canonical coordinates.
const HALVING = [0.5, 0, 0, 0, 0.5, 0, 0, 0, 1];

function renderData() {
  return {
    wall: { uuid: WALL_UUID, layoutId: LAYOUT_ID, board: { angle: 30 }, currentVersion: { id: '21', number: 3 } },
    versionNumber: 3,
    boardWidth: 1000,
    boardHeight: 1500,
    homography: HALVING,
    photo: { url: 'https://private.example/photo', thumbUrl: null, width: 2000, height: 3000, expiresAt: 'later' },
    holds: [{ id: 7, cx: 100, cy: 200, r: 20, outline: null }],
  };
}

function artAnswer(status: string, overrides: Record<string, unknown> = {}) {
  return {
    versionNumber: 3,
    recipe: 1,
    status,
    width: 800,
    height: 1200,
    quality: { stretch: 1.3, verdict: 'GOOD', reason: 'ok', frameShortEdge: 1000 },
    crop:
      status === 'READY'
        ? { url: 'https://private.example/crop', thumbUrl: null, width: 800, height: 1200, expiresAt: 'later' }
        : null,
    cutout:
      status === 'READY'
        ? { url: 'https://private.example/cut', thumbUrl: null, width: 800, height: 1200, expiresAt: 'later' }
        : null,
    ...overrides,
  };
}

/** Answers every operation the loader sends; `art` is the sprayWallArt answer, or a function that throws. */
function answer({ background, art }: { background?: string; art: unknown }) {
  requestMock.mockImplementation(async (operation: unknown) => {
    if (operation === sprayOperations.GET_SPRAY_WALL_BY_LAYOUT) return { sprayWallByLayout: { uuid: WALL_UUID } };
    if (operation === sprayOperations.GET_SPRAY_WALL_RENDER_DATA) return { sprayWallRenderData: renderData() };
    if (operation === sprayOperations.GET_SPRAY_WALL_LOOK)
      return { sprayWall: { uuid: WALL_UUID, renderSettings: background ? { ...LOOK, background } : LOOK } };
    if (operation === sprayOperations.GET_SPRAY_WALL_ART) {
      if (typeof art === 'function') return (art as () => unknown)();
      return { sprayWallArt: art };
    }
    throw new Error('unexpected operation');
  });
}

function fakeQueryClient(): Parameters<typeof loader.loadSprayWall>[0] {
  return {
    fetchQuery: ({ queryFn }: { queryFn: () => Promise<unknown> }) => queryFn(),
    invalidateQueries: async () => {},
    getQueryCache: () => ({ getAll: () => [] }),
    removeQueries: () => {},
  } as unknown as Parameters<typeof loader.loadSprayWall>[0];
}

function artRequests(): number {
  return requestMock.mock.calls.filter(([operation]) => operation === sprayOperations.GET_SPRAY_WALL_ART).length;
}

function drawn() {
  return getBoardRenderData({ boardName: 'spray', layoutId: LAYOUT_ID, sizeId: LAYOUT_ID, setIds: [LAYOUT_ID] });
}

beforeEach(() => {
  offline.offline = false;
  registry.clearSprayWallRegistry();
  loader.clearSprayWallLooks();
  clearBoardRenderDataCache();
  requestMock.mockReset();
  downloads.ensure.mockReset();
  downloads.ensure.mockImplementation(async () => '/cache/art');
});

describe('spray art cache keys', () => {
  it('names each variant apart from the photo and from each other', () => {
    const names = new Set([
      keys.sprayPhotoFileName({ layoutId: 1, versionId: 5 }),
      keys.sprayPhotoFileName({ layoutId: 1, versionId: 5, variant: 'crop' }),
      keys.sprayPhotoFileName({ layoutId: 1, versionId: 5, variant: 'cutout' }),
    ]);
    expect([...names]).toEqual(['1-v5.jpg', '1-v5-crop.jpg', '1-v5-cutout.webp']);
    const backgroundKeys = new Set([
      keys.sprayBackgroundKey(1, 5),
      keys.sprayBackgroundKey(1, 5, 'crop'),
      keys.sprayBackgroundKey(1, 5, 'cutout'),
    ]);
    expect(backgroundKeys.size).toBe(3);
  });

  it('keeps the photo key byte-identical to before art existed', () => {
    expect(keys.sprayBackgroundKey(12, 34)).toBe('spray/12/v34.jpg');
  });

  it('parses every key it writes back to the same identity', () => {
    for (const variant of [undefined, 'crop', 'cutout'] as const) {
      const key = keys.sprayBackgroundKey(12, 34, variant);
      expect(keys.parseSprayBackgroundKey(key)).toEqual(
        variant ? { layoutId: 12, versionId: 34, variant } : { layoutId: 12, versionId: 34 },
      );
    }
  });

  it('refuses a generated look on a local mirror, which has none', () => {
    const local = 'local-0a1b2c3d-0000-4000-8000-000000000000-2';
    expect(keys.parseSprayBackgroundKey(`spray/12/v${local}.jpg`)).toEqual({ layoutId: 12, versionId: local });
    expect(keys.parseSprayBackgroundKey(`spray/12/v${local}-crop.jpg`)).toBeNull();
  });
});

describe('loading a wall drawn on a generated look', () => {
  it('registers the art and its holds together once the file is on disk', async () => {
    answer({ background: 'wall-crop', art: artAnswer('READY') });
    await loader.loadSprayWall(fakeQueryClient(), LAYOUT_ID);

    const data = drawn();
    expect(data?.boardWidth).toBe(800);
    expect(data?.boardHeight).toBe(1200);
    // Canonical (100, 200, r 20) scaled by 800 / 1000, no homography.
    expect(data?.holdsData[0]).toMatchObject({ id: 7, cx: 80, cy: 160, r: 16 });
    expect(data?.backgroundImageKeys).toEqual([keys.sprayBackgroundKey(LAYOUT_ID, 21, 'crop')]);
    expect(downloads.ensure).toHaveBeenCalledWith(
      { layoutId: LAYOUT_ID, versionId: 21, variant: 'crop' },
      { url: 'https://private.example/crop', expiresAt: 'later' },
    );
    expect(registry.sprayCacheToken('spray', LAYOUT_ID)).toMatch(/-bgcrop$/);
    // The persisted-draft token never moves with the picture.
    expect(registry.sprayVersionToken('spray', LAYOUT_ID)).toBe('-svid21');
  });

  it('draws Holds only from the cutout file', async () => {
    answer({ background: 'hold-cutouts', art: artAnswer('READY') });
    await loader.loadSprayWall(fakeQueryClient(), LAYOUT_ID);
    expect(drawn()?.backgroundImageKeys).toEqual([keys.sprayBackgroundKey(LAYOUT_ID, 21, 'cutout')]);
    expect(registry.sprayCacheToken('spray', LAYOUT_ID)).toMatch(/-bgcutout$/);
  });

  it.each([
    ['still generating', { art: artAnswer('PENDING') }],
    ['failed', { art: artAnswer('FAILED') }],
    ['refused', { art: artAnswer('REFUSED') }],
    ['for another version', { art: artAnswer('READY', { versionNumber: 2 }) }],
    ['the wrong shape for the frame', { art: artAnswer('READY', { width: 800, height: 800 }) }],
    [
      'unreadable (an older backend)',
      {
        art: () => {
          throw new Error('Cannot query field "sprayWallArt"');
        },
      },
    ],
  ])('draws the photo when the art is %s', async (_label, { art }) => {
    answer({ background: 'wall-crop', art });
    await loader.loadSprayWall(fakeQueryClient(), LAYOUT_ID);

    const data = drawn();
    expect(data?.boardWidth).toBe(2000);
    // Canonical (100, 200, r 20) through the inverse of the halving map.
    expect(data?.holdsData[0]).toMatchObject({ id: 7, cx: 200, cy: 400, r: 40 });
    expect(data?.backgroundImageKeys).toEqual([keys.sprayBackgroundKey(LAYOUT_ID, 21)]);
    expect(registry.sprayCacheToken('spray', LAYOUT_ID)).not.toMatch(/-bg/);
  });

  it('draws the photo when the art will not download', async () => {
    downloads.ensure.mockImplementation(async () => null);
    answer({ background: 'wall-crop', art: artAnswer('READY') });
    await loader.loadSprayWall(fakeQueryClient(), LAYOUT_ID);
    expect(drawn()?.boardWidth).toBe(2000);
  });

  it('never asks for art for a wall drawn on its photo', async () => {
    answer({ art: artAnswer('READY') });
    await loader.loadSprayWall(fakeQueryClient(), LAYOUT_ID);
    expect(artRequests()).toBe(0);
    expect(drawn()?.boardWidth).toBe(2000);
  });

  it('keeps the art it holds through a failed revalidation of the same version', async () => {
    answer({ background: 'wall-crop', art: artAnswer('READY') });
    await loader.loadSprayWall(fakeQueryClient(), LAYOUT_ID);
    answer({
      background: 'wall-crop',
      art: () => {
        throw new TypeError('Network request failed');
      },
    });
    await loader.loadSprayWall(fakeQueryClient(), LAYOUT_ID, { force: true });
    expect(drawn()?.boardWidth).toBe(800);
  });
});

describe('switching back to the photo', () => {
  it('moves the image, the holds and the token together, at once', async () => {
    answer({ background: 'wall-crop', art: artAnswer('READY') });
    await loader.loadSprayWall(fakeQueryClient(), LAYOUT_ID);
    expect(drawn()?.boardWidth).toBe(800);

    loader.primeSprayWallLook(LAYOUT_ID, WALL_UUID, LOOK);

    const data = drawn();
    expect(data?.boardWidth).toBe(2000);
    expect(data?.holdsData[0]).toMatchObject({ cx: 200, cy: 400 });
    expect(data?.backgroundImageKeys).toEqual([keys.sprayBackgroundKey(LAYOUT_ID, 21)]);
    expect(registry.sprayCacheToken('spray', LAYOUT_ID)).not.toMatch(/-bg/);
    // And straight back: the art is still held for this version.
    loader.primeSprayWallLook(LAYOUT_ID, WALL_UUID, { ...LOOK, background: 'wall-crop' });
    expect(drawn()?.boardWidth).toBe(800);
  });

  it('never draws art made for another version', () => {
    registry.registerSprayWall(LAYOUT_ID, {
      wallUuid: WALL_UUID,
      angle: 30,
      version: 4,
      versionId: 22,
      photoWidth: 2000,
      photoHeight: 3000,
      photoUrl: 'https://private.example/photo',
      photoThumbUrl: null,
      photoExpiresAt: 'later',
      holds: [],
      background: 'wall-crop',
      art: {
        variant: 'crop',
        versionId: 21,
        width: 800,
        height: 1200,
        scale: 0.8,
        url: 'https://private.example/crop',
        expiresAt: 'later',
        holds: [],
      },
    });
    expect(registry.activeSprayArt(registry.getSprayWall(LAYOUT_ID))).toBeNull();
    expect(drawn()?.boardWidth).toBe(2000);
  });
});
