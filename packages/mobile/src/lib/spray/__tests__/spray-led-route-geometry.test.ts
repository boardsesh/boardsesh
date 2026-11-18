import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalSprayWall } from '../../../db/queries/get-spray-wall-local';

const fixture = vi.hoisted(() => ({
  offline: true,
  viewerGeneration: 1,
  removalGeneration: 0,
  privacyGeneration: 'current',
  userId: 'viewer' as string | undefined,
  database: {} as object | null,
  registered: null as { wallUuid: string; version: number; versionId: number | string } | null,
  fetch: vi.fn(),
  read: vi.fn(),
  readOwner: vi.fn(),
}));

vi.mock('../../connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: fixture.offline }),
}));
vi.mock('../spray-wall-loader', () => ({
  fetchSprayWallRenderData: fixture.fetch,
  sprayWallPublishedRenderDataQueryKey: (wallUuid: string, viewerGeneration: number) =>
    ['sprayWallRenderData', wallUuid, fixture.privacyGeneration, { viewerGeneration }] as const,
}));
vi.mock('../spray-wall-registry', () => ({
  getSprayWall: () => fixture.registered,
  sprayWallViewerGeneration: () => fixture.viewerGeneration,
  sprayWallRemovalGeneration: () => fixture.removalGeneration,
}));
vi.mock('../spray-privacy-generation', () => ({ sprayPrivacyGeneration: () => fixture.privacyGeneration }));
vi.mock('../../../db', () => ({ getDatabaseHandle: () => fixture.database }));
vi.mock('../../../db/queries/get-spray-wall-local', () => ({ getSprayWallLocal: fixture.read }));
vi.mock('../../local-user-id', () => ({ readLocalUserId: fixture.readOwner }));

import { loadSprayLedRouteGeometry } from '../spray-led-route-geometry';
import { sprayWallPublishedRenderDataQueryKey } from '../spray-wall-loader';

const WALL_UUID = 'wall-uuid';
const LAYOUT_ID = 42;
const PHOTO_UUID = '00000000-0000-4000-8000-000000000001';
const HOMOGRAPHY = [2, 0, 0, 0, 2, 0, 0, 0, 1];
const HOLDS = [{ id: 7, cx: 350, cy: 260, r: 30, outline: null }];

function renderPayload() {
  return {
    wall: { uuid: WALL_UUID, layoutId: LAYOUT_ID, currentVersion: { id: '21', number: 2 } },
    versionNumber: 2,
    boardWidth: 800,
    boardHeight: 600,
    homography: [...HOMOGRAPHY],
    holds: HOLDS.map((hold) => ({ ...hold })),
    photo: { url: 'https://private.example/wall.jpg', width: 1600, height: 1200, expiresAt: 'later' },
  };
}

function localWall(): LocalSprayWall {
  return {
    boardUuid: WALL_UUID,
    layoutId: LAYOUT_ID,
    name: 'Wall',
    referenceWidth: 800,
    referenceHeight: 600,
    version: 2,
    photoKey: `spray-walls/${WALL_UUID}/${PHOTO_UUID}.jpg`,
    homography: [...HOMOGRAPHY],
    holds: HOLDS.map((hold) => ({ ...hold })),
  };
}

const expectedGeometry = { frame: { width: 800, height: 600 }, homography: HOMOGRAPHY, holds: HOLDS };
let queryClient: QueryClient;

beforeEach(() => {
  vi.resetAllMocks();
  fixture.offline = true;
  fixture.viewerGeneration = 1;
  fixture.removalGeneration = 0;
  fixture.privacyGeneration = 'current';
  fixture.userId = 'viewer';
  fixture.database = {};
  fixture.registered = null;
  fixture.fetch.mockResolvedValue(renderPayload());
  fixture.read.mockImplementation(async () => localWall());
  fixture.readOwner.mockImplementation(async () => fixture.userId);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});

afterEach(() => queryClient.clear());

function cachePayload(payload: unknown = renderPayload(), viewerGeneration = fixture.viewerGeneration) {
  queryClient.setQueryData(
    sprayWallPublishedRenderDataQueryKey(WALL_UUID, viewerGeneration),
    { sprayWallRenderData: payload },
    { updatedAt: Date.now() - 11 * 60 * 1000 },
  );
}

describe('spray route geometry without internet', () => {
  it('uses stale cached published geometry offline without a backend or local database read', async () => {
    cachePayload();
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toEqual(expectedGeometry);
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(fixture.read).not.toHaveBeenCalled();
  });

  it('loads a cold-start mirror in canonical coordinates without decoding or projecting a photo', async () => {
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toEqual(expectedGeometry);
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(fixture.read).toHaveBeenCalledWith(fixture.database, LAYOUT_ID, 'viewer');
    expect(fixture.read).toHaveBeenCalledTimes(2);
    expect(fixture.readOwner).toHaveBeenCalledTimes(2);
  });

  it('falls back to cached geometry after a transport failure while nominally online', async () => {
    fixture.offline = false;
    cachePayload();
    fixture.fetch.mockRejectedValue(new TypeError('Network request failed'));
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toEqual(expectedGeometry);
    expect(fixture.fetch).toHaveBeenCalledOnce();
    expect(fixture.read).not.toHaveBeenCalled();
  });

  it('falls back to the owner-gated mirror after a transport failure without a cached payload', async () => {
    fixture.offline = false;
    fixture.fetch.mockRejectedValue(new TypeError('Network request failed'));
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toEqual(expectedGeometry);
    expect(fixture.read).toHaveBeenCalledTimes(2);
  });

  it('prefers a successful server answer to both older sources', async () => {
    fixture.offline = false;
    cachePayload({ ...renderPayload(), boardWidth: 400 });
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toEqual(expectedGeometry);
    expect(fixture.read).not.toHaveBeenCalled();
  });

  it('refuses an online query cache older than the registered published version', async () => {
    fixture.offline = false;
    fixture.registered = { wallUuid: WALL_UUID, version: 3, versionId: '22' };
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toBeNull();
    expect(fixture.read).not.toHaveBeenCalled();
  });

  it.each([0, 3])('refuses an inconsistent published version %s in a successful response', async (number) => {
    fixture.offline = false;
    const payload = renderPayload();
    fixture.fetch.mockResolvedValue({ ...payload, wall: { ...payload.wall, currentVersion: { id: '21', number } } });
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toBeNull();
    expect(fixture.read).not.toHaveBeenCalled();
  });

  it('does not revive cached or mirrored geometry after a fresh server null', async () => {
    fixture.offline = false;
    cachePayload();
    fixture.fetch.mockResolvedValue(null);
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toBeNull();
    expect(fixture.read).not.toHaveBeenCalled();
  });

  it('does not rescue an access refusal with cached or mirrored geometry', async () => {
    fixture.offline = false;
    cachePayload();
    const forbidden = Object.assign(new Error('Forbidden'), { response: { status: 403 } });
    fixture.fetch.mockRejectedValue(forbidden);
    await expect(loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).rejects.toBe(forbidden);
    expect(fixture.read).not.toHaveBeenCalled();
  });

  it('treats an explicit cached null as authority instead of reading a mirror', async () => {
    cachePayload(null);
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toBeNull();
    expect(fixture.read).not.toHaveBeenCalled();
  });

  it.each([
    ['another wall', () => ({ ...renderPayload(), wall: { ...renderPayload().wall, uuid: 'another-wall' } })],
    ['another layout', () => ({ ...renderPayload(), wall: { ...renderPayload().wall, layoutId: 99 } })],
    ['an invalid frame', () => ({ ...renderPayload(), boardWidth: 0 })],
    ['a malformed homography', () => ({ ...renderPayload(), homography: [1, 0, 0] })],
  ])('uses the mirror instead of cached geometry for %s', async (_label, payload) => {
    cachePayload(payload());
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toEqual(expectedGeometry);
    expect(fixture.read).toHaveBeenCalledTimes(2);
  });

  it('uses the mirror when the registered wall is newer than the cached payload', async () => {
    cachePayload({
      ...renderPayload(),
      wall: { ...renderPayload().wall, currentVersion: { id: '20', number: 1 } },
      versionNumber: 1,
    });
    fixture.registered = { wallUuid: WALL_UUID, version: 2, versionId: 21 };
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toEqual(expectedGeometry);
    expect(fixture.read).toHaveBeenCalledTimes(2);
  });

  it('does not consume the previous viewer generation cache entry', async () => {
    cachePayload({ ...renderPayload(), boardWidth: 400 });
    fixture.viewerGeneration++;
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toEqual(expectedGeometry);
    expect(fixture.read).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['another wall', { boardUuid: 'another-wall' }],
    ['another layout', { layoutId: 99 }],
    ['no published version', { version: null }],
    ['an invalid frame', { referenceWidth: 0 }],
    ['non-finite mapping', { homography: [1, 0, 0, 0, 1, 0, 0, 0, NaN] }],
    ['a photo belonging to another wall', { photoKey: `spray-walls/another-wall/${PHOTO_UUID}.jpg` }],
  ])('rejects a local mirror with %s', async (_label, changes) => {
    fixture.read.mockResolvedValue({ ...localWall(), ...changes });
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toBeNull();
  });

  it('requires a signed-in local owner before reading the mirror', async () => {
    fixture.userId = undefined;
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toBeNull();
    expect(fixture.read).not.toHaveBeenCalled();
  });

  it('refuses a mirror that changes during the ownership recheck', async () => {
    fixture.read.mockResolvedValueOnce(localWall()).mockResolvedValueOnce({ ...localWall(), version: 3 });
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toBeNull();
  });

  it.each(['viewer', 'removal', 'privacy', 'owner', 'registered version'] as const)(
    'drops late mirror geometry when %s changes during the read',
    async (change) => {
      fixture.registered = { wallUuid: WALL_UUID, version: 2, versionId: 21 };
      let finishRead!: (wall: LocalSprayWall) => void;
      fixture.read.mockImplementationOnce(
        () =>
          new Promise<LocalSprayWall>((resolve) => {
            finishRead = resolve;
          }),
      );
      const loading = loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID);
      await vi.waitFor(() => expect(finishRead).toBeTypeOf('function'));
      if (change === 'viewer') fixture.viewerGeneration++;
      if (change === 'removal') fixture.removalGeneration++;
      if (change === 'privacy') fixture.privacyGeneration = 'withdrawn';
      if (change === 'owner') fixture.userId = 'another-viewer';
      if (change === 'registered version') fixture.registered = { wallUuid: WALL_UUID, version: 3, versionId: 22 };
      finishRead(localWall());
      expect(await loading).toBeNull();
    },
  );
});
