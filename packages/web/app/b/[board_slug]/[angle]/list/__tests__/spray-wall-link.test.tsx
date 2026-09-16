// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { SearchRequestPagination } from '@/app/lib/types';

/**
 * `/b/{slug}/{angle}/list` on a spray wall: where its share link lands, and what
 * the `?wall=` capability does and does not open.
 *
 * The route must never reach `getBoardDetailsForBoard` for a wall — there is no
 * catalogue row to resolve and it throws, which would be a 500 on a URL the gym
 * page links to.
 */

const NOT_FOUND_DIGEST = 'NEXT_HTTP_ERROR_FALLBACK;404';

const WALL_UUID = 'ab12cd34ef56ab12cd34ef56ab12cd34';
const OTHER_WALL_UUID = '99998888777766665555444433332222';

vi.mock('server-only', () => ({}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: NOT_FOUND_DIGEST });
  }),
}));

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({ t: (key: string) => key, locale: 'en-US' })),
}));

function boardFor(visibility: 'public' | 'unlisted' | 'private') {
  return {
    uuid: WALL_UUID,
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

const resolveBoardBySlug = vi.fn(async (_slug: string) => boardFor('unlisted'));

vi.mock('@/app/lib/board-slug-utils', () => ({
  resolveBoardBySlug,
  boardToRouteParamsFromAngleSegment: vi.fn(() => ({
    board_name: 'spray',
    layout_id: 900,
    size_id: 900,
    set_ids: [1],
    angle: 40,
  })),
}));

const getBoardDetailsForBoard = vi.fn(() => {
  throw new Error('the catalogue has no size row for a spray wall');
});
vi.mock('@/app/lib/board-utils', () => ({
  getBoardDetailsForBoard: () => getBoardDetailsForBoard(),
}));

const fetchFrontDoorListPage = vi.fn();
vi.mock('@/app/lib/data/list-page-data.server', () => ({
  fetchFrontDoorListPage: (...args: unknown[]) => fetchFrontDoorListPage(...args),
}));

const WALL_DATA = {
  versionNumber: 2,
  boardWidth: 1200,
  boardHeight: 1600,
  photo: { url: 'https://private.example/presigned.jpg?sig=abc', width: 1200, height: 1600 },
  homography: null,
  holds: [],
  wall: {
    uuid: WALL_UUID,
    layoutId: 900,
    holdCount: 220,
    publicPhotoUrl: 'https://media.example/spray-walls/wall/abc.jpg',
    name: 'Garage Wall',
    angle: 40,
    gymUuid: null,
    gymName: null,
    ownerDisplayName: 'Marco',
  },
};

const fetchSprayWallPageData = vi.fn(async (_wallUuid: string): Promise<typeof WALL_DATA | null> => WALL_DATA);
// Stubbed rather than `importActual`'d: the real module reaches the GraphQL
// client, and which photograph a wall shows is pinned next door in
// `spray-view.test.tsx`. What this file is about is who gets to see the page.
const resolveSprayPhotoUrl = vi.fn(() => 'https://media.example/photo.jpg');
vi.mock('@/app/lib/spray/spray-wall-render-data.server', () => ({ resolveSprayPhotoUrl, fetchSprayWallPageData }));

vi.mock('@/app/components/climb-front-door/static-list-front-door', () => ({ default: () => null }));
vi.mock('@/app/components/spray-wall/spray-wall-front-door', () => ({ default: () => null }));

const { default: BoardSlugListPage, generateMetadata } = await import('../page');
const { default: SprayWallListPage, resolveSprayWallAccess } = await import('../spray-wall-view');

type ListSearchParams = SearchRequestPagination & { wall?: string | string[] };

function propsWith(wall?: string) {
  return {
    params: Promise.resolve({ board_slug: 'garage-wall', angle: '40' }),
    searchParams: Promise.resolve((wall === undefined ? {} : { wall }) as ListSearchParams),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchSprayWallPageData.mockResolvedValue(WALL_DATA);
});

describe('resolveSprayWallAccess', () => {
  it('opens an unlisted wall only for the matching uuid', () => {
    const unlisted = boardFor('unlisted');
    expect(resolveSprayWallAccess(unlisted, WALL_UUID)).toBe('render');
    expect(resolveSprayWallAccess(unlisted, undefined)).toBe('refuse');
    expect(resolveSprayWallAccess(unlisted, OTHER_WALL_UUID)).toBe('refuse');
  });

  it('opens a public wall with or without the param, since it needs no capability', () => {
    const publicWall = boardFor('public');
    expect(resolveSprayWallAccess(publicWall, undefined)).toBe('render');
    expect(resolveSprayWallAccess(publicWall, WALL_UUID)).toBe('render');
    expect(resolveSprayWallAccess(publicWall, OTHER_WALL_UUID)).toBe('refuse');
  });

  it('refuses a private wall whatever the param says', () => {
    const privateWall = boardFor('private');
    expect(resolveSprayWallAccess(privateWall, undefined)).toBe('refuse');
    expect(resolveSprayWallAccess(privateWall, WALL_UUID)).toBe('refuse');
  });
});

describe('the /b/{slug}/{angle}/list route on a spray wall', () => {
  it('hands the wall branch the capability, and never touches the catalogue', async () => {
    resolveBoardBySlug.mockResolvedValue(boardFor('unlisted'));

    // The route returns the wall component as an ELEMENT — React invokes it, not
    // the page — so the assertions here are about routing, and the cases below
    // call the branch itself.
    const element = await BoardSlugListPage(propsWith(WALL_UUID));

    expect(element.type).toBe(SprayWallListPage);
    expect(element.props).toEqual({ board: boardFor('unlisted'), wallParam: WALL_UUID });
    expect(getBoardDetailsForBoard).not.toHaveBeenCalled();
    expect(fetchFrontDoorListPage).not.toHaveBeenCalled();
  });

  it('asks for no indexation, and emits no canonical for a capability URL', async () => {
    resolveBoardBySlug.mockResolvedValue(boardFor('unlisted'));

    const metadata = await generateMetadata(propsWith(WALL_UUID));

    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toBeUndefined();
  });
});

describe('the wall branch itself', () => {
  it('renders an unlisted wall for a link holder', async () => {
    await SprayWallListPage({ board: boardFor('unlisted'), wallParam: WALL_UUID });

    expect(fetchSprayWallPageData).toHaveBeenCalledWith(WALL_UUID);
  });

  it('404s an unlisted wall reached without the capability, and reads nothing', async () => {
    await expect(SprayWallListPage({ board: boardFor('unlisted'), wallParam: undefined })).rejects.toMatchObject({
      digest: NOT_FOUND_DIGEST,
    });
    expect(fetchSprayWallPageData).not.toHaveBeenCalled();
  });

  it('404s a private wall even when the link carries its uuid', async () => {
    await expect(SprayWallListPage({ board: boardFor('private'), wallParam: WALL_UUID })).rejects.toMatchObject({
      digest: NOT_FOUND_DIGEST,
    });
    expect(fetchSprayWallPageData).not.toHaveBeenCalled();
  });

  it('renders a public wall on its clean URL, which is the link it is shared with', async () => {
    await SprayWallListPage({ board: boardFor('public'), wallParam: undefined });

    expect(fetchSprayWallPageData).toHaveBeenCalledWith(WALL_UUID);
    // The public copy, never the presigned one: this page is shared and cached.
    expect(resolveSprayPhotoUrl).toHaveBeenCalledWith(WALL_DATA, true);
  });

  it('404s a wall the backend will not hand over', async () => {
    fetchSprayWallPageData.mockResolvedValue(null);

    await expect(SprayWallListPage({ board: boardFor('public'), wallParam: undefined })).rejects.toMatchObject({
      digest: NOT_FOUND_DIGEST,
    });
  });
});
