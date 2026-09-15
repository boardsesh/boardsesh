// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * The three states a wall can be in, from the web page's side.
 *
 * A private wall is the one that matters: it must 404 without the page reading
 * the wall at all, because the round trip itself would confirm to a slug-holder
 * that the wall exists.
 */

const NOT_FOUND_DIGEST = 'NEXT_HTTP_ERROR_FALLBACK;404';

vi.mock('server-only', () => ({}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: NOT_FOUND_DIGEST });
  }),
}));

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({
    t: (key: string) => key,
    locale: 'en-US',
  })),
}));

const getClimb = vi.fn();
vi.mock('@/app/lib/data/queries', () => ({
  getClimb: (...args: unknown[]) => getClimb(...args),
  getClimbStatsForAllAngles: vi.fn(async () => []),
}));

const fetchSprayWallPageData = vi.fn();
vi.mock('@/app/lib/spray/spray-wall-render-data.server', async () => {
  const actual = await vi.importActual<typeof import('@/app/lib/spray/spray-wall-render-data.server')>(
    '@/app/lib/spray/spray-wall-render-data.server',
  );
  return {
    resolveSprayPhotoUrl: actual.resolveSprayPhotoUrl,
    fetchSprayWallPageData: (...args: unknown[]) => fetchSprayWallPageData(...args),
  };
});

const buildSprayOgImageUrl = vi.fn(
  (_layoutId: number, _frames: string) => 'https://ws.boardsesh.com/og/climb?board_name=spray',
);
vi.mock('@/app/components/board-renderer/util', () => ({ buildSprayOgImageUrl }));

vi.mock('@/app/components/spray-wall/spray-climb-front-door', () => ({
  default: () => null,
}));

// Statically imported: `vi.mock` is hoisted above it, and a per-test dynamic
// import made the first test pay the module graph's compile inside its 5 s
// budget.
const { default: SprayViewPage, buildSprayViewMetadata } = await import('../spray-view');

const CLIMB = {
  uuid: 'c0ffee00000000000000000000000001',
  name: 'Crimp Ladder',
  frames: 'p101r1p102r2',
  difficulty: '6c/V5',
  setter_username: 'marco',
  ascensionist_count: 4,
  is_hidden: false,
};

const WALL_DATA = {
  versionNumber: 2,
  boardWidth: 1200,
  boardHeight: 1600,
  photo: { url: 'https://private.example/presigned.jpg?sig=abc', width: 1200, height: 1600 },
  homography: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  holds: [],
  wall: {
    uuid: 'wall-uuid-1',
    layoutId: 900,
    holdCount: 220,
    publicPhotoUrl: 'https://media.example/spray-walls/wall-uuid-1/abc.jpg',
    name: 'Garage Wall',
    angle: 40,
    gymUuid: null,
    gymName: null,
    ownerDisplayName: 'Marco',
  },
};

function boardFor(visibility: 'public' | 'unlisted' | 'private') {
  return {
    uuid: 'wall-uuid-1',
    slug: 'garage-wall',
    boardType: 'spray',
    layoutId: 900,
    sizeId: 900,
    setIds: '1',
    name: 'Garage Wall',
    isPublic: visibility === 'public',
    isUnlisted: visibility === 'unlisted',
    isOwned: false,
    ownerId: 'owner-1',
    angle: 40,
    isAngleAdjustable: false,
  };
}

const PARSED_PARAMS = {
  board_name: 'spray' as const,
  layout_id: 900,
  size_id: 900,
  set_ids: [1],
  angle: 40,
  climb_uuid: CLIMB.uuid,
};

beforeEach(() => {
  vi.clearAllMocks();
  getClimb.mockResolvedValue(CLIMB);
  fetchSprayWallPageData.mockResolvedValue(WALL_DATA);
});

describe('the spray climb page', () => {
  it('renders a public wall from the public photo copy', async () => {
    const element = await SprayViewPage({ board: boardFor('public'), parsedParams: PARSED_PARAMS });

    expect(element.props.photoUrl).toBe(WALL_DATA.wall.publicPhotoUrl);
    expect(fetchSprayWallPageData).toHaveBeenCalledWith('wall-uuid-1');
  });

  it('renders an unlisted wall for a link holder, from the presigned photo', async () => {
    const element = await SprayViewPage({ board: boardFor('unlisted'), parsedParams: PARSED_PARAMS });

    // A stable path, never the presigned URL itself: the page is CDN-cached for
    // a day and the signature lives fifteen minutes.
    expect(element.props.photoUrl).toBe('/api/v1/spray-walls/wall-uuid-1/photo');
  });

  it('404s a private wall, and never reads the wall to decide', async () => {
    await expect(SprayViewPage({ board: boardFor('private'), parsedParams: PARSED_PARAMS })).rejects.toMatchObject({
      digest: NOT_FOUND_DIGEST,
    });
    expect(fetchSprayWallPageData).not.toHaveBeenCalled();
    expect(getClimb).not.toHaveBeenCalled();
  });

  it('404s when the wall is gone but the climb row is still there', async () => {
    // The shape a soft-deleted wall takes after its links went out: the climb
    // row survives (`deleteSprayWall` keeps the climbs) so `getClimb` answers,
    // while the wall read returns null.
    fetchSprayWallPageData.mockResolvedValue(null);

    await expect(SprayViewPage({ board: boardFor('public'), parsedParams: PARSED_PARAMS })).rejects.toMatchObject({
      digest: NOT_FOUND_DIGEST,
    });
  });

  it('404s a climb that is not on the wall', async () => {
    getClimb.mockResolvedValue(null);

    await expect(SprayViewPage({ board: boardFor('public'), parsedParams: PARSED_PARAMS })).rejects.toMatchObject({
      digest: NOT_FOUND_DIGEST,
    });
  });

  it('lets a failed wall read surface as a 5xx rather than a 404', async () => {
    fetchSprayWallPageData.mockRejectedValue(new Error('backend is wedged'));

    await expect(SprayViewPage({ board: boardFor('public'), parsedParams: PARSED_PARAMS })).rejects.toThrow(
      'backend is wedged',
    );
  });
});

describe('the spray climb page metadata', () => {
  it('self-canonicalises a public wall and points at its OG card', async () => {
    const metadata = await buildSprayViewMetadata({
      board: boardFor('public'),
      parsedParams: PARSED_PARAMS,
      boardSlugParam: 'garage-wall',
    });

    expect(metadata.alternates?.canonical).toContain('/b/garage-wall/40/view/crimp-ladder-');
    expect(metadata.robots).toBeUndefined();
    expect(buildSprayOgImageUrl).toHaveBeenCalledWith(900, CLIMB.frames);
  });

  it('noindexes an unlisted wall, with no canonical and no card', async () => {
    const metadata = await buildSprayViewMetadata({
      board: boardFor('unlisted'),
      parsedParams: PARSED_PARAMS,
      boardSlugParam: 'garage-wall',
    });

    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toBeUndefined();
    expect(buildSprayOgImageUrl).not.toHaveBeenCalled();
  });

  it('tells nothing about a private wall, and does not look the climb up', async () => {
    const metadata = await buildSprayViewMetadata({
      board: boardFor('private'),
      parsedParams: PARSED_PARAMS,
      boardSlugParam: 'garage-wall',
    });

    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toBeUndefined();
    expect(getClimb).not.toHaveBeenCalled();
  });

  it('withholds the canonical for a climb the crew hid, on a public wall', async () => {
    getClimb.mockResolvedValue({ ...CLIMB, is_hidden: true });

    const metadata = await buildSprayViewMetadata({
      board: boardFor('public'),
      parsedParams: PARSED_PARAMS,
      boardSlugParam: 'garage-wall',
    });

    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toBeUndefined();
  });
});
