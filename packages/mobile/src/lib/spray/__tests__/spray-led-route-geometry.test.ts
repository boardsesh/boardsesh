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
  request: vi.fn(),
  read: vi.fn(),
  readOwner: vi.fn(),
  preferences: new Map<string, unknown>(),
  readPreference: vi.fn(),
  writePreference: vi.fn(),
  removePreference: vi.fn(),
  settleMiss: vi.fn(),
  recheckAccess: vi.fn(),
}));

vi.mock('../../connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: fixture.offline }),
}));
vi.mock('../spray-wall-loader', () => ({
  fetchSprayWallRenderData: fixture.fetch,
  requestSprayWallRenderData: fixture.request,
  sprayWallPublishedRenderDataQueryKey: (wallUuid: string, viewerGeneration: number) =>
    ['sprayWallRenderData', wallUuid, fixture.privacyGeneration, { viewerGeneration }] as const,
}));
vi.mock('../spray-wall-registry', () => ({
  getSprayWall: () => fixture.registered,
  sprayWallViewerGeneration: () => fixture.viewerGeneration,
  sprayWallRemovalGeneration: () => fixture.removalGeneration,
  settleSprayWallRenderMiss: fixture.settleMiss,
}));
vi.mock('../../preference-store', () => ({
  getPreference: fixture.readPreference,
  setPreference: fixture.writePreference,
  removePreference: fixture.removePreference,
  removePreferencesMatching: vi.fn(),
}));
vi.mock('../spray-wall-led-sync', () => ({ recheckSprayWallLedAccess: fixture.recheckAccess }));
vi.mock('../spray-privacy-generation', () => ({ sprayPrivacyGeneration: () => fixture.privacyGeneration }));
vi.mock('../../../db', () => ({ getDatabaseHandle: () => fixture.database }));
vi.mock('../../../db/queries/get-spray-wall-local', () => ({ getSprayWallLocal: fixture.read }));
vi.mock('../../local-user-id', () => ({ readLocalUserId: fixture.readOwner }));

import { sprayWallPublishedRenderDataQueryKey } from '../spray-wall-loader';

let loadSprayLedRouteGeometry: typeof import('../spray-led-route-geometry').loadSprayLedRouteGeometry;

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

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  fixture.offline = true;
  fixture.viewerGeneration = 1;
  fixture.removalGeneration = 0;
  fixture.privacyGeneration = 'current';
  fixture.userId = 'viewer';
  fixture.database = {};
  fixture.preferences.clear();
  fixture.readPreference.mockImplementation(async (key: string) => fixture.preferences.get(key) ?? null);
  fixture.writePreference.mockImplementation(async (key: string, stored: unknown) => {
    fixture.preferences.set(key, stored);
  });
  fixture.removePreference.mockImplementation(async (key: string) => {
    fixture.preferences.delete(key);
  });
  fixture.registered = null;
  fixture.fetch.mockResolvedValue(renderPayload());
  fixture.request.mockResolvedValue(renderPayload());
  fixture.read.mockImplementation(async () => localWall());
  fixture.readOwner.mockImplementation(async () => fixture.userId);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  ({ loadSprayLedRouteGeometry } = await import('../spray-led-route-geometry'));
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

  it.each([false, true])(
    'persists a denied published wall through a cold offline restart (registered=%s)',
    async (registered) => {
      if (registered) fixture.registered = { wallUuid: WALL_UUID, version: 2, versionId: '21' };
      fixture.offline = false;
      fixture.fetch.mockResolvedValue(null);
      expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toBeNull();
      expect(fixture.settleMiss).toHaveBeenCalledWith(LAYOUT_ID, WALL_UUID);
      expect(fixture.recheckAccess).toHaveBeenCalledWith(WALL_UUID);
      expect([...fixture.preferences.values()]).toEqual([true]);

      queryClient.clear();
      fixture.registered = null;
      fixture.offline = true;
      vi.resetModules();
      const restarted = await import('../spray-led-route-geometry');
      expect(await restarted.loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toBeNull();
      cachePayload();
      expect(await restarted.loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toBeNull();
      expect(fixture.read).not.toHaveBeenCalled();
    },
  );

  it('does not apply one account’s denial to another account’s owned mirror', async () => {
    fixture.offline = false;
    fixture.fetch.mockResolvedValue(null);
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toBeNull();
    fixture.viewerGeneration++;
    fixture.userId = 'another-viewer';
    fixture.offline = true;
    queryClient.clear();
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toEqual(expectedGeometry);
  });

  it('requires fresh valid server evidence to recover a denied wall', async () => {
    fixture.offline = false;
    fixture.fetch.mockResolvedValueOnce(null);
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toBeNull();
    cachePayload();
    const key = sprayWallPublishedRenderDataQueryKey(WALL_UUID, fixture.viewerGeneration);
    fixture.request.mockImplementationOnce(async () => {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
      return renderPayload();
    });
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toEqual(expectedGeometry);
    expect(fixture.preferences.size).toBe(0);
    queryClient.clear();
    fixture.offline = true;
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toEqual(expectedGeometry);
  });

  it('keeps a denial after a transport failure or malformed positive answer', async () => {
    fixture.offline = false;
    fixture.fetch.mockResolvedValueOnce(null);
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toBeNull();
    fixture.request.mockRejectedValueOnce(new TypeError('Network request failed'));
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toBeNull();
    fixture.request.mockResolvedValueOnce({ ...renderPayload(), boardWidth: 0 });
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toBeNull();
    fixture.offline = true;
    queryClient.clear();
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toBeNull();
    expect(fixture.read).not.toHaveBeenCalled();
  });

  it.each(['success', 'failure'] as const)(
    'recovers without cancelling a shared %s read and fences its later cached answer',
    async (outcome) => {
      fixture.offline = false;
      fixture.fetch.mockResolvedValueOnce(null);
      expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toBeNull();
      const queryKey = sprayWallPublishedRenderDataQueryKey(WALL_UUID, fixture.viewerGeneration);
      const stalePayload = { ...renderPayload(), boardWidth: 400 };
      let finishStale!: () => void;
      const stale = queryClient
        .fetchQuery({
          queryKey,
          queryFn: () =>
            new Promise((resolve, reject) => {
              finishStale = () =>
                outcome === 'success' ? resolve(stalePayload) : reject(new TypeError('Network request failed'));
            }),
        })
        .catch((error: unknown) => error);
      await vi.waitFor(() => expect(finishStale).toBeTypeOf('function'));
      expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toEqual(expectedGeometry);
      expect(fixture.request).toHaveBeenCalledOnce();
      expect(fixture.fetch).toHaveBeenCalledOnce();
      expect(queryClient.getQueryState(queryKey)?.fetchStatus).toBe('fetching');
      expect([...fixture.preferences.values()]).toEqual([true]);
      finishStale();
      if (outcome === 'success') expect(await stale).toEqual(stalePayload);
      else expect(await stale).toBeInstanceOf(TypeError);
      expect(fixture.settleMiss).toHaveBeenCalledTimes(1);
      fixture.offline = true;
      expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toBeNull();
      fixture.offline = false;
      expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toEqual(expectedGeometry);
      expect(fixture.preferences.size).toBe(0);
      fixture.offline = true;
      expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toEqual(expectedGeometry);
    },
  );

  it('allows concurrent independent recoveries without cancelling either authority read', async () => {
    fixture.offline = false;
    fixture.fetch.mockResolvedValueOnce(null);
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toBeNull();
    expect(
      await Promise.all([
        loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID),
        loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID),
      ]),
    ).toEqual([expectedGeometry, expectedGeometry]);
    expect(fixture.request).toHaveBeenCalledTimes(2);
    expect(fixture.preferences.size).toBe(0);
  });

  it('keeps the denial until a paused shared query can no longer resume an older read', async () => {
    fixture.offline = false;
    fixture.fetch.mockResolvedValueOnce(null);
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toBeNull();
    const shared = queryClient.getQueryCache().build(queryClient, {
      queryKey: sprayWallPublishedRenderDataQueryKey(WALL_UUID, fixture.viewerGeneration),
    });
    shared.setState({ fetchStatus: 'paused' });
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toEqual(expectedGeometry);
    expect([...fixture.preferences.values()]).toEqual([true]);
    shared.setState({ fetchStatus: 'idle' });
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toEqual(expectedGeometry);
    expect(fixture.preferences.size).toBe(0);
  });

  it('does not let an earlier recovery success remove a newer direct denial', async () => {
    fixture.offline = false;
    fixture.fetch.mockResolvedValueOnce(null);
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toBeNull();
    let finishRead!: (payload: ReturnType<typeof renderPayload>) => void;
    fixture.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    const older = loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID);
    await vi.waitFor(() => expect(finishRead).toBeTypeOf('function'));
    fixture.request.mockResolvedValueOnce(null);
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toBeNull();
    finishRead(renderPayload());
    expect(await older).toBeNull();
    fixture.offline = true;
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toBeNull();
  });

  it('retains the offline fence when a shared read starts and settles during native marker removal', async () => {
    fixture.offline = false;
    fixture.fetch.mockResolvedValueOnce(null);
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toBeNull();
    fixture.removePreference.mockImplementationOnce(async (key: string) => {
      fixture.preferences.delete(key);
      await queryClient.fetchQuery({
        queryKey: sprayWallPublishedRenderDataQueryKey(WALL_UUID, fixture.viewerGeneration),
        queryFn: async () => null,
      });
    });
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toEqual(expectedGeometry);
    expect([...fixture.preferences.values()]).toEqual([true]);
    queryClient.clear();
    fixture.offline = true;
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toBeNull();
  });

  it('does not let an earlier positive response remove a newer cold-wall denial', async () => {
    fixture.offline = false;
    let finishRead!: (payload: ReturnType<typeof renderPayload>) => void;
    fixture.fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    const older = loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID);
    await vi.waitFor(() => expect(finishRead).toBeTypeOf('function'));
    fixture.fetch.mockResolvedValueOnce(null);
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toBeNull();
    finishRead(renderPayload());
    expect(await older).toBeNull();
    fixture.offline = true;
    queryClient.clear();
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toBeNull();
    expect(fixture.read).not.toHaveBeenCalled();
  });

  it('discards a late null from the previous account without withdrawing the current wall', async () => {
    fixture.offline = false;
    let finishRead!: (payload: null) => void;
    fixture.fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    const loading = loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID);
    await vi.waitFor(() => expect(finishRead).toBeTypeOf('function'));
    fixture.viewerGeneration++;
    fixture.userId = 'another-viewer';
    finishRead(null);
    expect(await loading).toBeNull();
    expect(fixture.preferences.size).toBe(0);
    expect(fixture.settleMiss).not.toHaveBeenCalled();
    expect(fixture.recheckAccess).not.toHaveBeenCalled();
  });

  it('fails closed when the persisted denial record cannot be read offline', async () => {
    fixture.readPreference.mockRejectedValueOnce(new Error('Storage unavailable'));
    cachePayload();
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toBeNull();
    expect(fixture.read).not.toHaveBeenCalled();
  });

  it('keeps a denied wall ineligible after a failed denial write and retries persisting it', async () => {
    // Use a distinct identity: module-level evidence deliberately survives cache loss.
    fixture.userId = 'denial-write-failure';
    fixture.offline = false;
    fixture.fetch.mockResolvedValueOnce(null);
    fixture.writePreference.mockRejectedValueOnce(new Error('Storage full'));
    await expect(loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).rejects.toThrow('Storage full');
    expect(fixture.preferences.size).toBe(0);
    queryClient.clear();
    fixture.offline = true;
    expect(await loadSprayLedRouteGeometry(queryClient, WALL_UUID, LAYOUT_ID)).toBeNull();
    expect([...fixture.preferences.values()]).toEqual([true]);
    expect(fixture.writePreference).toHaveBeenCalledTimes(2);
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
