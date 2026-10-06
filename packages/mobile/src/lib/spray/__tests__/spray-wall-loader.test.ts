import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { runMigrations } from '@boardsesh/offline-sync';
import { createTestDatabase } from '@boardsesh/offline-sync/testing';
import { DEFAULT_BOARDSESH_RENDER_SETTINGS } from '@boardsesh/board-look';

// The GraphQL client pulls react-native's Flow source at import time, and the
// draft store and error reporter both reach native modules. Mocked so the
// loader's own decisions — which are all about what to register and what to
// withdraw — can be exercised.
const offlineState = vi.hoisted(() => ({ offline: false, subscribers: new Set<() => void>(), localLoad: vi.fn() }));
vi.mock('../../connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: offlineState.offline }),
  subscribeConnectivity: (listener: () => void) => {
    offlineState.subscribers.add(listener);
    return () => offlineState.subscribers.delete(listener);
  },
}));
vi.mock('../spray-wall-local-loader', () => ({ loadLocalSprayWall: offlineState.localLoad }));
const requestMock = vi.hoisted(() => vi.fn());
vi.mock('../../graphql/client', () => ({ getHttpClient: () => ({ request: requestMock }) }));
// The real cleanup also erases files; here it only has to withdraw the wall.
vi.mock('../spray-privacy-cleanup', async () => {
  const { unregisterSprayWall: withdraw } = await import('../spray-wall-registry');
  return { clearSprayWallPrivateCaches: (layoutId: number) => withdraw(layoutId) };
});
vi.mock('../spray-photo-store', () => ({
  SPRAY_PHOTO_STORE_AVAILABLE: true,
  deleteStoredSprayPhoto: () => {},
  pruneStoredSprayPhotos: () => {},
  storeSprayPhoto: async () => null,
}));
vi.mock('../../create-climb-draft-store', () => ({ clearSupersededSprayDrafts: async () => {} }));
const reportHandledErrorMock = vi.hoisted(() => vi.fn());
const invalidateQueriesMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../error-reporting', () => ({ reportHandledError: reportHandledErrorMock }));

const {
  clearSprayWallRegistry,
  ensureSprayWallLoaded,
  getSprayWall,
  registerSprayWall,
  unregisterSprayWall,
  resetSprayWallViewerAccess,
  setSprayWallLoader,
  sprayWallViewerGeneration,
  subscribeToSprayWalls,
  subscribeToSprayWallWithdrawals,
  withdrawAllSprayWalls,
} = await import('../spray-wall-registry');
const {
  LOOK_RETRY_AFTER_FAILURE_MS,
  clearSprayWallArchiveAnswers,
  clearSprayWallLooks,
  dropSprayWallViewerAccess,
  loadSprayWall,
  installSprayWallLoader,
  invalidateSprayWallRenderData,
  primeSprayWallLook,
  refreshSprayWallViewerAccess,
  sprayWallByLayoutQueryKey,
  sprayWallRenderDataQueryKey,
} = await import('../spray-wall-loader');
const { createSprayWallDeletedSink } = await import('../../../offline/spray-photo-sink');
const { clearSprayWallArchives, getRememberedSprayWallArchive } = await import('../../../settings/offline-boards');
const sprayOperations = await import('@boardsesh/graphql/operations/spray-walls');

const LAYOUT_ID = 4200;
const WALL_UUID = 'wall-uuid';

/** A query client stand-in: `fetchQuery` just runs the function it is given. */
function fakeQueryClient(): Parameters<typeof loadSprayWall>[0] {
  return {
    fetchQuery: ({ queryFn }: { queryFn: () => Promise<unknown> }) => queryFn(),
    invalidateQueries: invalidateQueriesMock,
    getQueryCache: () => ({ getAll: () => [] }),
    removeQueries: () => {},
  } as unknown as Parameters<typeof loadSprayWall>[0];
}

function renderDataPayload(overrides: Record<string, unknown> = {}) {
  return {
    sprayWallRenderData: {
      wall: { uuid: WALL_UUID, board: { angle: 25 }, currentVersion: { id: '2', number: 2 } },
      versionNumber: 2,
      boardWidth: 1200,
      boardHeight: 1600,
      homography: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      photo: { url: 'https://private.example/p', thumbUrl: null, width: 1200, height: 1600, expiresAt: 'later' },
      holds: [{ id: 7, cx: 100, cy: 200, r: 18, outline: null }],
      ...overrides,
    },
  };
}

function existingWall() {
  return {
    wallUuid: WALL_UUID,
    angle: 40,
    version: 1,
    versionId: 1,
    photoWidth: 1200,
    photoHeight: 1600,
    photoUrl: 'https://private.example/old',
    photoThumbUrl: null,
    photoExpiresAt: 'later',
    holds: [{ id: 99, cx: 1, cy: 2, r: 3 }],
  };
}

function registerExistingWall() {
  registerSprayWall(LAYOUT_ID, existingWall());
}

/** The look request: answered by the matching operation, so the order of other requests does not matter. */
function answerLook(answer: () => Promise<unknown>) {
  const fallback = requestMock.getMockImplementation();
  requestMock.mockImplementation((operation: unknown, variables: unknown) =>
    operation === sprayOperations.GET_SPRAY_WALL_LOOK ? answer() : fallback?.(operation, variables),
  );
}

/** The archive request, answered by its operation like the look. */
function answerArchive(answer: () => Promise<unknown>) {
  const fallback = requestMock.getMockImplementation();
  requestMock.mockImplementation((operation: unknown, variables: unknown) =>
    operation === sprayOperations.GET_SPRAY_WALL_ARCHIVE ? answer() : fallback?.(operation, variables),
  );
}

function lookRequests(): number {
  return requestMock.mock.calls.filter(([operation]) => operation === sprayOperations.GET_SPRAY_WALL_LOOK).length;
}

function privateQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
}

function deferredResponse() {
  let resolve!: (response: unknown) => void;
  const promise = new Promise<unknown>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  offlineState.offline = false;
  offlineState.subscribers.clear();
  offlineState.localLoad.mockReset();
  clearSprayWallRegistry();
  clearSprayWallLooks();
  clearSprayWallArchiveAnswers();
  clearSprayWallArchives();
  requestMock.mockReset();
  reportHandledErrorMock.mockReset();
  invalidateQueriesMock.mockClear();
});

afterEach(() => {
  clearSprayWallRegistry();
});

describe('withdrawal erases React Query payloads', () => {
  it('continues registry and query withdrawal if another cleanup subscriber fails', () => {
    const unsubscribeBroken = subscribeToSprayWallWithdrawals(() => {
      throw new Error('broken cleanup');
    });
    const queryClient = privateQueryClient();
    const teardown = installSprayWallLoader(queryClient);
    registerExistingWall();
    queryClient.setQueryData(['sprayWallRenderData', WALL_UUID, 'old'], renderDataPayload());
    unregisterSprayWall(LAYOUT_ID);
    expect(getSprayWall(LAYOUT_ID)).toBeNull();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    unsubscribeBroken();
    teardown();
    queryClient.clear();
  });
  it('removes every epoch and known draft/proposal while preserving other walls and catalogue data', () => {
    const queryClient = privateQueryClient();
    const teardown = installSprayWallLoader(queryClient);
    registerExistingWall();
    const wall = { uuid: WALL_UUID, layoutId: LAYOUT_ID, versions: [{ id: 'draft-a' }] };
    const erasedKeys = [
      ['sprayWallByLayout', LAYOUT_ID, 'old'],
      ['sprayWallByLayout', LAYOUT_ID, 'older'],
      ['sprayWallRenderData', WALL_UUID, 'old'],
      ['sprayWallRenderData', WALL_UUID, 3, 'old'],
      ['sprayWallWithVersions', WALL_UUID],
    ];
    for (const key of erasedKeys)
      queryClient.setQueryData(
        key,
        key[0] === 'sprayWallWithVersions' ? { uuid: WALL_UUID, versions: wall.versions } : { sprayWall: wall },
      );
    const preservedKeys = [
      ['sprayWallByLayout', 4300, 'old'],
      ['sprayWallRenderData', 'wall-b', 'old'],
      ['catalogue', 'kilter'],
    ];
    for (const key of preservedKeys) queryClient.setQueryData(key, { secret: 'other payload' });

    unregisterSprayWall(LAYOUT_ID);

    for (const key of erasedKeys) expect(queryClient.getQueryData(key)).toBeUndefined();
    for (const key of preservedKeys) expect(queryClient.getQueryData(key)).toEqual({ secret: 'other payload' });
    teardown();
    queryClient.clear();
  });

  it('erases an unregistered identity discovered only in cached data', () => {
    const queryClient = privateQueryClient();
    const teardown = installSprayWallLoader(queryClient);
    queryClient.setQueryData(['sprayWallWithVersions', WALL_UUID], { uuid: WALL_UUID, layoutId: LAYOUT_ID });
    queryClient.setQueryData(['sprayWallRenderData', WALL_UUID, 'old'], renderDataPayload());
    unregisterSprayWall(LAYOUT_ID);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    teardown();
    queryClient.clear();
  });

  it('global withdrawal erases spray families and retains catalogue queries', () => {
    const queryClient = privateQueryClient();
    const teardown = installSprayWallLoader(queryClient);
    for (const family of ['sprayWallByLayout', 'sprayWallRenderData', 'sprayWallWithVersions']) {
      queryClient.setQueryData([family, 'unknown'], { secret: 'private' });
    }
    queryClient.setQueryData(['catalogue'], { board: 'kilter' });
    withdrawAllSprayWalls();
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey),
    ).toEqual([['catalogue']]);
    teardown();
    queryClient.clear();
  });

  it('destroys a known pending render so a late network completion cannot recache its photograph', async () => {
    const queryClient = privateQueryClient();
    const teardown = installSprayWallLoader(queryClient);
    queryClient.setQueryData(sprayWallByLayoutQueryKey(LAYOUT_ID), {
      sprayWallByLayout: { uuid: WALL_UUID, layoutId: LAYOUT_ID },
    });
    const render = deferredResponse();
    requestMock.mockImplementation((operation) =>
      operation === sprayOperations.GET_SPRAY_WALL_RENDER_DATA ? render.promise : Promise.resolve({ sprayWall: null }),
    );
    const loading = loadSprayWall(queryClient, LAYOUT_ID);
    await vi.waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(sprayOperations.GET_SPRAY_WALL_RENDER_DATA, { uuid: WALL_UUID }),
    );
    const oldKey = sprayWallRenderDataQueryKey(WALL_UUID);
    unregisterSprayWall(LAYOUT_ID);
    render.resolve(renderDataPayload());
    await loading;
    expect(queryClient.getQueryData(oldKey)).toBeUndefined();
    expect(queryClient.getQueryCache().findAll({ queryKey: ['sprayWallRenderData', WALL_UUID] })).toHaveLength(0);
    expect(getSprayWall(LAYOUT_ID)).toBeNull();
    teardown();
    queryClient.clear();
  });

  it('old loader teardown leaves replacement query cleanup installed', () => {
    const previousClient = privateQueryClient();
    const previousTeardown = installSprayWallLoader(previousClient);
    const queryClient = privateQueryClient();
    const teardown = installSprayWallLoader(queryClient);
    previousTeardown();
    queryClient.setQueryData(['sprayWallByLayout', LAYOUT_ID, 'old'], {
      sprayWallByLayout: { uuid: WALL_UUID, layoutId: LAYOUT_ID },
    });
    queryClient.setQueryData(['sprayWallRenderData', WALL_UUID, 'old'], renderDataPayload());
    unregisterSprayWall(LAYOUT_ID);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    teardown();
    queryClient.clear();
    previousClient.clear();
  });
});

describe('loadSprayWall', () => {
  it.each(['sprayWallWithVersions', 'sprayWallRenderData'])(
    'cancels inactive %s requests without clearing another wall',
    async (queryPrefix) => {
      const queryClient = new QueryClient();
      const db = createTestDatabase();
      await runMigrations(db);
      const deletedKey = [queryPrefix, WALL_UUID, 2] as const;
      const otherKey = [queryPrefix, 'other-wall', 2] as const;
      queryClient.setQueryData(otherKey, { versions: [1] });
      let resolveVersions: ((response: { versions: number[] }) => void) | undefined;
      const pending = queryClient
        .fetchQuery({
          queryKey: deletedKey,
          queryFn: () =>
            new Promise<{ versions: number[] }>((resolve) => {
              resolveVersions = resolve;
            }),
        })
        .catch(() => {});

      await createSprayWallDeletedSink(queryClient)({
        tableName: 'spray_walls',
        rows: [{ layout_id: LAYOUT_ID, board_uuid: WALL_UUID, photo_key: null }],
        db,
      });
      resolveVersions?.({ versions: [1, 2] });
      await pending;

      expect(queryClient.getQueryData(deletedKey)).toBeUndefined();
      expect(queryClient.getQueryData(otherKey)).toEqual({ versions: [1] });
      queryClient.clear();
      db.close();
    },
  );

  it.each(['identity', 'render'])(
    'cancels a pending %s query so a later load cannot reuse revoked data',
    async (pendingStage) => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const db = createTestDatabase();
      await runMigrations(db);
      let resolveOld: ((response: unknown) => void) | undefined;
      const oldResponse = new Promise<unknown>((resolve) => {
        resolveOld = resolve;
      });
      let revoked = false;
      requestMock.mockImplementation((operation) => {
        if (operation === sprayOperations.GET_SPRAY_WALL_BY_LAYOUT) {
          if (revoked) return Promise.resolve({ sprayWallByLayout: null });
          if (pendingStage === 'identity') return oldResponse;
          return Promise.resolve({ sprayWallByLayout: { uuid: WALL_UUID } });
        }
        if (operation === sprayOperations.GET_SPRAY_WALL_LOOK) return Promise.resolve({ sprayWall: null });
        return oldResponse;
      });
      registerExistingWall();
      const firstLoad = loadSprayWall(queryClient, LAYOUT_ID).catch(() => {});
      const pendingOperation =
        pendingStage === 'identity'
          ? sprayOperations.GET_SPRAY_WALL_BY_LAYOUT
          : sprayOperations.GET_SPRAY_WALL_RENDER_DATA;
      await vi.waitFor(() =>
        expect(requestMock.mock.calls.some(([operation]) => operation === pendingOperation)).toBe(true),
      );

      revoked = true;
      await createSprayWallDeletedSink(queryClient)({
        tableName: 'spray_walls',
        rows: [{ layout_id: LAYOUT_ID, board_uuid: WALL_UUID, photo_key: null }],
        db,
      });
      resolveOld?.(pendingStage === 'identity' ? { sprayWallByLayout: { uuid: WALL_UUID } } : renderDataPayload());
      await firstLoad;
      await loadSprayWall(queryClient, LAYOUT_ID);

      expect(getSprayWall(LAYOUT_ID)).toBeNull();
      expect(
        requestMock.mock.calls.filter(([operation]) => operation === sprayOperations.GET_SPRAY_WALL_BY_LAYOUT),
      ).toHaveLength(2);
      queryClient.clear();
      db.close();
    },
  );

  it('cannot reregister a revoked wall when an earlier render request completes', async () => {
    registerExistingWall();
    let resolveRender: ((payload: ReturnType<typeof renderDataPayload>) => void) | undefined;
    const renderRequest = new Promise<ReturnType<typeof renderDataPayload>>((resolve) => {
      resolveRender = resolve;
    });
    requestMock.mockImplementation((operation) => {
      if (operation === sprayOperations.GET_SPRAY_WALL_BY_LAYOUT) {
        return Promise.resolve({ sprayWallByLayout: { uuid: WALL_UUID } });
      }
      if (operation === sprayOperations.GET_SPRAY_WALL_LOOK) return Promise.resolve({ sprayWall: null });
      return renderRequest;
    });
    const loading = loadSprayWall(fakeQueryClient(), LAYOUT_ID);
    await vi.waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(sprayOperations.GET_SPRAY_WALL_RENDER_DATA, { uuid: WALL_UUID }),
    );

    unregisterSprayWall(LAYOUT_ID);
    resolveRender?.(renderDataPayload());
    await loading;
    expect(getSprayWall(LAYOUT_ID)).toBeNull();
  });

  it.each(['identity', 'render'] as const)(
    'does not register the %s response completing after sign-out',
    async (stage) => {
      const delayed = deferredResponse();
      const delayedOperation =
        stage === 'identity' ? sprayOperations.GET_SPRAY_WALL_BY_LAYOUT : sprayOperations.GET_SPRAY_WALL_RENDER_DATA;
      requestMock.mockImplementation((operation) => {
        if (operation === delayedOperation) return delayed.promise;
        if (operation === sprayOperations.GET_SPRAY_WALL_BY_LAYOUT)
          return Promise.resolve({ sprayWallByLayout: { uuid: WALL_UUID } });
        return Promise.resolve({ sprayWall: null });
      });
      const loading = loadSprayWall(fakeQueryClient(), LAYOUT_ID);
      await vi.waitFor(() =>
        expect(requestMock.mock.calls.some(([operation]) => operation === delayedOperation)).toBe(true),
      );
      const requestsBeforeSignOut = requestMock.mock.calls.length;
      withdrawAllSprayWalls();
      delayed.resolve(stage === 'identity' ? { sprayWallByLayout: { uuid: WALL_UUID } } : renderDataPayload());
      await loading;
      expect(getSprayWall(LAYOUT_ID)).toBeNull();
      expect(requestMock).toHaveBeenCalledTimes(requestsBeforeSignOut);
    },
  );

  it('teardown rejects a loader already awaiting a render response', async () => {
    const delayed = deferredResponse();
    requestMock.mockImplementation((operation) => {
      if (operation === sprayOperations.GET_SPRAY_WALL_RENDER_DATA) return delayed.promise;
      if (operation === sprayOperations.GET_SPRAY_WALL_BY_LAYOUT)
        return Promise.resolve({ sprayWallByLayout: { uuid: WALL_UUID } });
      return Promise.resolve({ sprayWall: null });
    });
    const teardown = installSprayWallLoader(fakeQueryClient());
    const loading = loadSprayWall(fakeQueryClient(), LAYOUT_ID);
    await vi.waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(sprayOperations.GET_SPRAY_WALL_RENDER_DATA, { uuid: WALL_UUID }),
    );
    teardown();
    delayed.resolve(renderDataPayload());
    await loading;
    expect(getSprayWall(LAYOUT_ID)).toBeNull();
  });

  it('an old teardown cannot detach the replacement loader or clear its registrations', async () => {
    const oldTeardown = installSprayWallLoader(fakeQueryClient());
    installSprayWallLoader(fakeQueryClient());
    registerExistingWall();
    oldTeardown();
    expect(getSprayWall(LAYOUT_ID)).not.toBeNull();
    requestMock
      .mockResolvedValueOnce({ sprayWallByLayout: { uuid: WALL_UUID } })
      .mockResolvedValueOnce(renderDataPayload());
    ensureSprayWallLoaded(LAYOUT_ID + 1);
    await vi.waitFor(() => expect(getSprayWall(LAYOUT_ID + 1)).not.toBeNull());
  });

  it('does not refresh a wall when invalidation completes after sign-out', async () => {
    let completeInvalidation!: () => void;
    invalidateQueriesMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          completeInvalidation = resolve;
        }),
    );
    installSprayWallLoader(fakeQueryClient());
    const invalidating = invalidateSprayWallRenderData(fakeQueryClient(), WALL_UUID, LAYOUT_ID);
    withdrawAllSprayWalls();
    completeInvalidation();
    await invalidating;
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('registers the wall it fetched', async () => {
    requestMock
      .mockResolvedValueOnce({ sprayWallByLayout: { uuid: WALL_UUID } })
      .mockResolvedValueOnce(renderDataPayload());

    await loadSprayWall(fakeQueryClient(), LAYOUT_ID);

    expect(getSprayWall(LAYOUT_ID)).toMatchObject({ version: 2, photoWidth: 1200 });
    expect(getSprayWall(LAYOUT_ID)?.holds.map((hold) => hold.id)).toEqual([7]);
    // The wall's own fixed angle, which is what every climb set on it publishes at
    // (SW-10) — `assertSprayAngleMatchesWall` rejects any other outright.
    expect(getSprayWall(LAYOUT_ID)?.angle).toBe(25);
    // No slug in this payload, so no share link (#5488).
    expect(getSprayWall(LAYOUT_ID)?.share).toBeNull();
  });

  it('keeps the slug and visibility a climb share link needs (#5488)', async () => {
    const payload = renderDataPayload();
    requestMock.mockResolvedValueOnce({ sprayWallByLayout: { uuid: WALL_UUID } }).mockResolvedValueOnce({
      sprayWallRenderData: {
        ...payload.sprayWallRenderData,
        wall: {
          ...payload.sprayWallRenderData.wall,
          board: { angle: 25, slug: 'brewery-spray', isPublic: false, isUnlisted: true },
        },
      },
    });

    await loadSprayWall(fakeQueryClient(), LAYOUT_ID);

    expect(getSprayWall(LAYOUT_ID)?.share).toEqual({ slug: 'brewery-spray', isPublic: false, isUnlisted: true });
  });

  it('withholds the share fields of a wall an admin hid, as if it were private', async () => {
    const payload = renderDataPayload();
    requestMock.mockResolvedValueOnce({ sprayWallByLayout: { uuid: WALL_UUID } }).mockResolvedValueOnce({
      sprayWallRenderData: {
        ...payload.sprayWallRenderData,
        wall: {
          ...payload.sprayWallRenderData.wall,
          hiddenAt: '2026-10-01T00:00:00.000Z',
          board: { angle: 25, slug: 'brewery-spray', isPublic: true, isUnlisted: false },
        },
      },
    });

    await loadSprayWall(fakeQueryClient(), LAYOUT_ID);

    // Still drawn for its owner; just nothing to share.
    expect(getSprayWall(LAYOUT_ID)).not.toBeNull();
    expect(getSprayWall(LAYOUT_ID)?.share).toBeNull();
  });

  it('registers whether the viewer can edit the wall, and only on a literal true', async () => {
    requestMock.mockResolvedValueOnce({ sprayWallByLayout: { uuid: WALL_UUID } }).mockResolvedValueOnce(
      renderDataPayload({
        wall: { uuid: WALL_UUID, board: { angle: 25 }, currentVersion: { id: '2', number: 2 }, viewerCanEdit: true },
      }),
    );
    await loadSprayWall(fakeQueryClient(), LAYOUT_ID);
    expect(getSprayWall(LAYOUT_ID)?.viewerCanEdit).toBe(true);

    // A payload without the field (an older backend) must read as "cannot edit",
    // and must not inherit the previous registration's answer.
    requestMock
      .mockResolvedValueOnce({ sprayWallByLayout: { uuid: WALL_UUID } })
      .mockResolvedValueOnce(renderDataPayload());
    await loadSprayWall(fakeQueryClient(), LAYOUT_ID);
    expect(getSprayWall(LAYOUT_ID)?.viewerCanEdit).toBe(false);
  });

  it('forgets who could edit on an account change, at once', () => {
    registerSprayWall(LAYOUT_ID, {
      ...existingWall(),
      viewerAccess: { canEdit: true, generation: sprayWallViewerGeneration() },
    });
    const before = sprayWallViewerGeneration();

    // Synchronous: by the time the auth provider's call returns, nothing says
    // the viewer can edit.
    refreshSprayWallViewerAccess();

    expect(getSprayWall(LAYOUT_ID)?.viewerCanEdit).toBe(false);
    expect(getSprayWall(LAYOUT_ID)?.version).toBe(1);
    expect(sprayWallViewerGeneration()).toBe(before + 1);
  });

  it('refetches each wall in hand for the new account', async () => {
    registerSprayWall(LAYOUT_ID, {
      ...existingWall(),
      viewerAccess: { canEdit: false, generation: sprayWallViewerGeneration() },
    });
    const queryClient = fakeQueryClient();
    setSprayWallLoader((layoutId, options) => loadSprayWall(queryClient, layoutId, options));
    requestMock.mockImplementation(async (operation: unknown) => {
      if (operation === sprayOperations.GET_SPRAY_WALL_BY_LAYOUT) return { sprayWallByLayout: { uuid: WALL_UUID } };
      if (operation === sprayOperations.GET_SPRAY_WALL_RENDER_DATA) {
        return renderDataPayload({
          wall: { uuid: WALL_UUID, board: { angle: 25 }, currentVersion: { id: '2', number: 2 }, viewerCanEdit: true },
        });
      }
      return { sprayWall: null };
    });

    refreshSprayWallViewerAccess();
    expect(getSprayWall(LAYOUT_ID)?.viewerCanEdit).toBe(false);

    await vi.waitFor(() => expect(getSprayWall(LAYOUT_ID)?.viewerCanEdit).toBe(true));
    expect(getSprayWall(LAYOUT_ID)?.version).toBe(2);
  });

  it('asks again when the account changes while the request is out, and believes only the second answer', async () => {
    // The request leaves under account A. A signs out mid-flight. A's payload
    // says "can edit"; the next viewer's says "cannot".
    let renderDataRequests = 0;
    requestMock.mockImplementation(async (operation: unknown) => {
      if (operation === sprayOperations.GET_SPRAY_WALL_BY_LAYOUT) return { sprayWallByLayout: { uuid: WALL_UUID } };
      if (operation === sprayOperations.GET_SPRAY_WALL_RENDER_DATA) {
        renderDataRequests += 1;
        if (renderDataRequests === 1) {
          resetSprayWallViewerAccess();
          return renderDataPayload({
            wall: {
              uuid: WALL_UUID,
              board: { angle: 25 },
              currentVersion: { id: '2', number: 2 },
              viewerCanEdit: true,
            },
          });
        }
        return renderDataPayload({
          wall: { uuid: WALL_UUID, board: { angle: 25 }, currentVersion: { id: '2', number: 2 }, viewerCanEdit: false },
        });
      }
      return { sprayWall: null };
    });

    await loadSprayWall(fakeQueryClient(), LAYOUT_ID);

    expect(renderDataRequests).toBe(2);
    expect(getSprayWall(LAYOUT_ID)?.viewerCanEdit).toBe(false);
    // Fetched under the account that is here now, so it is fresh, not stale.
    expect(getSprayWall(LAYOUT_ID)?.registeredAtMs).toBeGreaterThan(0);
  });

  it('never registers "can edit" from an answer that keeps losing the race', async () => {
    // The account changes during BOTH requests. The loader stops at two; the
    // registry refuses the stale answer and marks the wall for a refetch.
    requestMock.mockImplementation(async (operation: unknown) => {
      if (operation === sprayOperations.GET_SPRAY_WALL_BY_LAYOUT) return { sprayWallByLayout: { uuid: WALL_UUID } };
      if (operation === sprayOperations.GET_SPRAY_WALL_RENDER_DATA) {
        resetSprayWallViewerAccess();
        return renderDataPayload({
          wall: { uuid: WALL_UUID, board: { angle: 25 }, currentVersion: { id: '2', number: 2 }, viewerCanEdit: true },
        });
      }
      return { sprayWall: null };
    });

    await loadSprayWall(fakeQueryClient(), LAYOUT_ID);

    expect(getSprayWall(LAYOUT_ID)?.version).toBe(2);
    expect(getSprayWall(LAYOUT_ID)?.viewerCanEdit).toBe(false);
    expect(getSprayWall(LAYOUT_ID)?.registeredAtMs).toBe(0);
  });

  it('keys the render payload on the viewer generation, so two accounts never share a request or a cache entry', async () => {
    const keys: unknown[][] = [];
    const queryClient = {
      fetchQuery: ({ queryKey, queryFn }: { queryKey: unknown[]; queryFn: () => Promise<unknown> }) => {
        keys.push(queryKey);
        return queryFn();
      },
      invalidateQueries: invalidateQueriesMock,
    } as unknown as Parameters<typeof loadSprayWall>[0];
    requestMock.mockImplementation(async (operation: unknown) =>
      operation === sprayOperations.GET_SPRAY_WALL_BY_LAYOUT
        ? { sprayWallByLayout: { uuid: WALL_UUID } }
        : operation === sprayOperations.GET_SPRAY_WALL_RENDER_DATA
          ? renderDataPayload()
          : { sprayWall: null },
    );

    await loadSprayWall(queryClient, LAYOUT_ID);
    resetSprayWallViewerAccess();
    await loadSprayWall(queryClient, LAYOUT_ID);

    const renderKeys = keys.filter((key) => key[0] === 'sprayWallRenderData');
    expect(renderKeys).toHaveLength(2);
    expect(renderKeys[0].slice(0, 2)).toEqual(['sprayWallRenderData', WALL_UUID]);
    expect(renderKeys[0]).not.toEqual(renderKeys[1]);
  });

  it('never shares a cache entry with a draft version of the same wall', async () => {
    // The hold editor caches a DRAFT under ['sprayWallRenderData', uuid, versionNumber].
    // A viewer generation is a small integer too. As a bare number, generation 1
    // and draft version 1 were one entry with two query functions: the loader's
    // null overwrote the draft (a first wall read "unavailable" in the editor),
    // or its refetch replaced the draft payload mid-edit.
    const { sprayWallDraftQueryKey } = await import('../use-spray-wall-draft');
    const { sprayWallPublishedRenderDataQueryKey, sprayWallRenderDataQueryKey } = await import('../spray-wall-loader');
    const hash = (key: readonly unknown[]) => JSON.stringify(key);

    for (let generation = 0; generation <= 60; generation += 1) {
      const publishedKey = sprayWallPublishedRenderDataQueryKey(WALL_UUID, generation);
      for (let version = 0; version <= 60; version += 1) {
        expect(hash(publishedKey)).not.toBe(hash(sprayWallDraftQueryKey(WALL_UUID, version)));
      }
      // Structurally distinct, not merely unequal today: where a draft carries
      // its version number the published key carries the privacy generation,
      // which is never a number or a numeric string, and the viewer generation
      // after it is an object.
      expect(Number.isNaN(Number(publishedKey[2]))).toBe(true);
      expect(typeof publishedKey[3]).toBe('object');
      // And the shared prefix still reaches it, which every invalidation uses.
      expect(publishedKey.slice(0, 3)).toEqual([...sprayWallRenderDataQueryKey(WALL_UUID)]);
    }
  });

  it('is the key the loader actually fetches under', async () => {
    const keys: unknown[][] = [];
    const queryClient = {
      fetchQuery: ({ queryKey, queryFn }: { queryKey: unknown[]; queryFn: () => Promise<unknown> }) => {
        keys.push(queryKey);
        return queryFn();
      },
      invalidateQueries: invalidateQueriesMock,
    } as unknown as Parameters<typeof loadSprayWall>[0];
    requestMock.mockImplementation(async (operation: unknown) =>
      operation === sprayOperations.GET_SPRAY_WALL_BY_LAYOUT
        ? { sprayWallByLayout: { uuid: WALL_UUID } }
        : operation === sprayOperations.GET_SPRAY_WALL_RENDER_DATA
          ? renderDataPayload()
          : { sprayWall: null },
    );
    const { sprayWallPublishedRenderDataQueryKey } = await import('../spray-wall-loader');
    resetSprayWallViewerAccess();

    await loadSprayWall(queryClient, LAYOUT_ID);

    expect(keys.find((key) => key[0] === 'sprayWallRenderData')).toEqual([
      ...sprayWallPublishedRenderDataQueryKey(WALL_UUID, sprayWallViewerGeneration()),
    ]);
  });

  it('drops who could edit without fetching or inviting a fetch, when the account just went away', () => {
    // A native keychain that fails for a moment flips the app to signed-out.
    // A request sent now has no token, and a private wall would resolve null
    // and be withdrawn from the live player.
    registerSprayWall(LAYOUT_ID, {
      ...existingWall(),
      viewerAccess: { canEdit: true, generation: sprayWallViewerGeneration() },
    });
    const registeredAt = getSprayWall(LAYOUT_ID)?.registeredAtMs;
    const before = sprayWallViewerGeneration();
    const loader = vi.fn(async () => {});
    setSprayWallLoader(loader);

    dropSprayWallViewerAccess();

    expect(getSprayWall(LAYOUT_ID)?.viewerCanEdit).toBe(false);
    expect(sprayWallViewerGeneration()).toBe(before + 1);
    expect(loader).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
    // Still fresh: a surface that asks for the wall is not sent to the network.
    expect(getSprayWall(LAYOUT_ID)?.registeredAtMs).toBe(registeredAt);
  });

  it('registers "cannot edit" for a payload nobody can vouch for', async () => {
    // The wall editor's draft registers render data it fetched itself, with no
    // viewer generation. That draws the wall and says nothing about Edit.
    const { registerRenderData } = await import('../spray-wall-loader');
    const payload = renderDataPayload({
      wall: { uuid: WALL_UUID, board: { angle: 25 }, currentVersion: { id: '2', number: 2 }, viewerCanEdit: true },
    });
    registerRenderData(LAYOUT_ID, payload.sprayWallRenderData as never, null);
    expect(getSprayWall(LAYOUT_ID)?.version).toBe(2);
    expect(getSprayWall(LAYOUT_ID)?.viewerCanEdit).toBe(false);
  });

  it('keeps the homography and the move links, for drawing lost-hold ghosts (#5493)', async () => {
    const { registerRenderData } = await import('../spray-wall-loader');
    const payload = renderDataPayload({
      homography: [2, 0, 0, 0, 2, 0, 0, 0, 1],
      holds: [
        { id: 7, cx: 100, cy: 200, r: 18, outline: null, movedFromHoldId: 3 },
        { id: 8, cx: 300, cy: 400, r: 18, outline: null, movedFromHoldId: null },
      ],
    });
    registerRenderData(LAYOUT_ID, payload.sprayWallRenderData as never, null);
    const wall = getSprayWall(LAYOUT_ID);
    expect(wall?.homography).toEqual([2, 0, 0, 0, 2, 0, 0, 0, 1]);
    expect(wall?.holds[0]).toMatchObject({ id: 7, cx: 50, cy: 100, movedFromHoldId: 3 });
    // No predecessor, no key: the hold keeps the shape it always had.
    expect(wall?.holds[1]).not.toHaveProperty('movedFromHoldId');
  });

  it('registers a wall whose payload will not say its angle', async () => {
    // Deliberately unlike a photo that will not say its size, which is refused:
    // such a wall draws perfectly well, and blanking the board over a field only
    // the authoring path reads would trade a working wall for a placeholder. Null
    // rather than a fabricated number, so `authoringAngle` falls back to the
    // caller instead of failing every publish on the server's angle check.
    const payload = renderDataPayload();
    requestMock.mockResolvedValueOnce({ sprayWallByLayout: { uuid: WALL_UUID } }).mockResolvedValueOnce({
      sprayWallRenderData: {
        ...payload.sprayWallRenderData,
        wall: { uuid: WALL_UUID, currentVersion: { id: '2', number: 2 } },
      },
    });

    await loadSprayWall(fakeQueryClient(), LAYOUT_ID);

    expect(getSprayWall(LAYOUT_ID)).toMatchObject({ version: 2, angle: null });
  });

  it('never asks for the look inside a query or mutation that loads, creates or draws a wall', () => {
    // The app and the backend ship on different trains. A field the backend does
    // not have yet fails validation for the whole operation: in the shared wall
    // fragment it broke creating, loading and drawing every wall at once.
    for (const [name, operation] of Object.entries(sprayOperations)) {
      if (name === 'GET_SPRAY_WALL_LOOK' || name === 'SET_SPRAY_WALL_RENDER_SETTINGS') continue;
      expect(JSON.stringify(operation) ?? '', name).not.toContain('renderSettings');
    }
  });

  // Merge-order safety: a field the backend does not serve fails the WHOLE
  // operation, so the archive fields live in their own query and nowhere else.
  it('never asks for the archive fields inside a query or mutation that loads, creates or draws a wall', () => {
    for (const [name, operation] of Object.entries(sprayOperations)) {
      if (name === 'GET_SPRAY_WALL_ARCHIVE' || name === 'GET_MY_SPRAY_WALL_LIFECYCLE') continue;
      const text = JSON.stringify(operation) ?? '';
      for (const field of ['archivedAt', 'resetOfWallUuid', 'replacedByWallUuid', 'holdsLocked']) {
        expect(text, `${name}.${field}`).not.toContain(field);
      }
    }
  });

  it('registers and draws the wall when the archive query fails, as live with free holds', async () => {
    answerArchive(async () => {
      throw new Error('Cannot query field "archivedAt" on type "SprayWall".');
    });
    requestMock
      .mockResolvedValueOnce({ sprayWallByLayout: { uuid: WALL_UUID } })
      .mockResolvedValueOnce(renderDataPayload());

    await loadSprayWall(fakeQueryClient(), LAYOUT_ID);

    expect(getSprayWall(LAYOUT_ID)).toMatchObject({
      version: 2,
      archive: { archivedAt: null, replacedByWallUuid: null, holdsLocked: false },
    });
    expect(getRememberedSprayWallArchive(WALL_UUID)).toBeNull();
    expect(reportHandledErrorMock).not.toHaveBeenCalled();
  });

  it('registers an archived wall as archived, and keeps it for the offline loader', async () => {
    answerArchive(async () => ({
      sprayWall: {
        uuid: WALL_UUID,
        archivedAt: '2026-10-01T09:00:00.000Z',
        resetOfWallUuid: null,
        replacedByWallUuid: 'new-wall',
        holdsLocked: true,
      },
    }));
    requestMock
      .mockResolvedValueOnce({ sprayWallByLayout: { uuid: WALL_UUID } })
      .mockResolvedValueOnce(renderDataPayload());

    await loadSprayWall(fakeQueryClient(), LAYOUT_ID);

    expect(getSprayWall(LAYOUT_ID)?.archive).toEqual({
      archivedAt: '2026-10-01T09:00:00.000Z',
      resetOfWallUuid: null,
      replacedByWallUuid: 'new-wall',
      holdsLocked: true,
    });
    expect(getRememberedSprayWallArchive(WALL_UUID)).toEqual({
      archivedAt: '2026-10-01T09:00:00.000Z',
      replacedByWallUuid: 'new-wall',
    });
  });

  // A failed read is "not known", not "live": a wall this session already knew
  // as archived stays archived through a dropped connection.
  it('keeps the archive this session already knew when a later read fails', async () => {
    registerSprayWall(LAYOUT_ID, {
      ...existingWall(),
      archive: {
        archivedAt: '2026-10-01T09:00:00.000Z',
        resetOfWallUuid: null,
        replacedByWallUuid: null,
        holdsLocked: true,
      },
    });
    answerArchive(async () => {
      throw new Error('offline');
    });
    requestMock
      .mockResolvedValueOnce({ sprayWallByLayout: { uuid: WALL_UUID } })
      .mockResolvedValueOnce(renderDataPayload());

    await loadSprayWall(fakeQueryClient(), LAYOUT_ID, { force: true });

    expect(getSprayWall(LAYOUT_ID)).toMatchObject({ version: 2, archive: { archivedAt: '2026-10-01T09:00:00.000Z' } });
  });

  it('registers the wall with its stored look, sanitised, in one registration', async () => {
    // Read alongside the render data, not after it: a wall registered without
    // its look draws once in the viewer's settings and again when the look
    // lands, which doubles a cold list's renders.
    requestMock
      .mockResolvedValueOnce({ sprayWallByLayout: { uuid: WALL_UUID } })
      .mockResolvedValueOnce(renderDataPayload());
    answerLook(async () => ({
      sprayWall: {
        uuid: WALL_UUID,
        renderSettings: { mode: 'aura', boardsesh: { markStyle: 'outline', glowReach: 40 } },
      },
    }));
    let wakes = 0;
    const unsubscribe = subscribeToSprayWalls(() => {
      wakes += 1;
    });

    try {
      await loadSprayWall(fakeQueryClient(), LAYOUT_ID);
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      unsubscribe();
    }

    expect(wakes).toBe(1);
    const look = getSprayWall(LAYOUT_ID)?.renderSettings;
    expect(look?.mode).toBe('aura');
    expect(look?.boardsesh.markStyle).toBe('outline');
    // Clamped like a stored preference: an out-of-range knob off the wire must
    // not reach the renderer as-is.
    expect(look?.boardsesh.glowReach).toBe(2);
  });

  it('registers no look for a wall that never stored one, or stored something unusable', async () => {
    const stored = { mode: 'classic' as const, boardsesh: DEFAULT_BOARDSESH_RENDER_SETTINGS };
    for (const renderSettings of [null, undefined, { mode: 'boardsesh', boardsesh: {} }, 'aura', { mode: 'aura' }]) {
      clearSprayWallRegistry();
      clearSprayWallLooks();
      requestMock.mockReset();
      // Starts WITH a look, so "null" below is the answer applied, not the start.
      registerSprayWall(LAYOUT_ID, { ...existingWall(), renderSettings: stored });
      requestMock
        .mockResolvedValueOnce({ sprayWallByLayout: { uuid: WALL_UUID } })
        .mockResolvedValueOnce(renderDataPayload());
      answerLook(async () => ({ sprayWall: { uuid: WALL_UUID, renderSettings } }));

      await loadSprayWall(fakeQueryClient(), LAYOUT_ID);

      expect(lookRequests()).toBe(1);
      expect(getSprayWall(LAYOUT_ID)).toMatchObject({ version: 2, renderSettings: null });
    }
  });

  it('still draws the wall when the look cannot be read, and retries after a short wait', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      answerLook(async () => {
        throw new Error('Cannot query field "renderSettings" on type "SprayWall".');
      });
      requestMock
        .mockResolvedValueOnce({ sprayWallByLayout: { uuid: WALL_UUID } })
        .mockResolvedValueOnce(renderDataPayload());

      await loadSprayWall(fakeQueryClient(), LAYOUT_ID);

      expect(lookRequests()).toBe(1);
      expect(getSprayWall(LAYOUT_ID)).toMatchObject({ version: 2, renderSettings: null });
      expect(reportHandledErrorMock).not.toHaveBeenCalled();

      // Within the retry wait: answered from the cache.
      requestMock
        .mockResolvedValueOnce({ sprayWallByLayout: { uuid: WALL_UUID } })
        .mockResolvedValueOnce(renderDataPayload());
      await loadSprayWall(fakeQueryClient(), LAYOUT_ID);
      expect(lookRequests()).toBe(1);

      // After it, asked again: usually the connection is back.
      clock.mockReturnValue(1_000_000 + LOOK_RETRY_AFTER_FAILURE_MS);
      requestMock
        .mockResolvedValueOnce({ sprayWallByLayout: { uuid: WALL_UUID } })
        .mockResolvedValueOnce(renderDataPayload());
      await loadSprayWall(fakeQueryClient(), LAYOUT_ID);
      expect(lookRequests()).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps a look this device just stored when an older read answers after it', async () => {
    let answerRead: (value: unknown) => void = () => {};
    answerLook(() => new Promise((resolve) => (answerRead = resolve)));
    requestMock
      .mockResolvedValueOnce({ sprayWallByLayout: { uuid: WALL_UUID } })
      .mockResolvedValueOnce(renderDataPayload());
    registerExistingWall();
    const loading = loadSprayWall(fakeQueryClient(), LAYOUT_ID);
    await vi.waitFor(() => expect(lookRequests()).toBe(1));

    const picked = { mode: 'classic' as const, boardsesh: DEFAULT_BOARDSESH_RENDER_SETTINGS };
    primeSprayWallLook(LAYOUT_ID, WALL_UUID, picked);
    // The read started before the save, so its answer is the look from before it.
    answerRead({ sprayWall: { uuid: WALL_UUID, renderSettings: null } });
    await loading;

    expect(getSprayWall(LAYOUT_ID)).toMatchObject({ version: 2, renderSettings: picked });
  });

  it('draws a look this device just stored without asking again', async () => {
    registerExistingWall();
    const look = { mode: 'classic' as const, boardsesh: DEFAULT_BOARDSESH_RENDER_SETTINGS };
    primeSprayWallLook(LAYOUT_ID, WALL_UUID, look);
    expect(getSprayWall(LAYOUT_ID)?.renderSettings).toEqual(look);

    requestMock
      .mockResolvedValueOnce({ sprayWallByLayout: { uuid: WALL_UUID } })
      .mockResolvedValueOnce(renderDataPayload());
    await loadSprayWall(fakeQueryClient(), LAYOUT_ID);

    expect(lookRequests()).toBe(0);
    expect(getSprayWall(LAYOUT_ID)).toMatchObject({ version: 2, renderSettings: look });
  });

  it('withdraws a held wall when the layout no longer resolves', async () => {
    registerExistingWall();
    requestMock.mockResolvedValueOnce({ sprayWallByLayout: null });

    await loadSprayWall(fakeQueryClient(), LAYOUT_ID);

    expect(getSprayWall(LAYOUT_ID)).toBeNull();
  });

  it('withdraws a held wall when the render payload comes back null', async () => {
    // Deleted between the two reads, visibility revoked, the published photo
    // gone. Keeping the registration would draw stale holds over a cached photo
    // for the rest of the session.
    registerExistingWall();
    requestMock
      .mockResolvedValueOnce({ sprayWallByLayout: { uuid: WALL_UUID } })
      .mockResolvedValueOnce({ sprayWallRenderData: null });

    await loadSprayWall(fakeQueryClient(), LAYOUT_ID);

    expect(getSprayWall(LAYOUT_ID)).toBeNull();
  });

  it('withdraws a held wall whose photo will not say its size', async () => {
    registerExistingWall();
    requestMock.mockResolvedValueOnce({ sprayWallByLayout: { uuid: WALL_UUID } }).mockResolvedValueOnce(
      renderDataPayload({
        photo: { url: 'https://private.example/p', thumbUrl: null, width: null, height: null, expiresAt: 'later' },
      }),
    );

    await loadSprayWall(fakeQueryClient(), LAYOUT_ID);

    // A frame of a different aspect does not stretch the picture, it slides every
    // hold off its hold — so the wall must not be registered, and the previous
    // registration must not survive either.
    expect(getSprayWall(LAYOUT_ID)?.version).not.toBe(2);
  });

  it('does not register a wall whose homography has no inverse', async () => {
    requestMock
      .mockResolvedValueOnce({ sprayWallByLayout: { uuid: WALL_UUID } })
      .mockResolvedValueOnce(renderDataPayload({ homography: [0, 0, 0, 0, 0, 0, 0, 0, 0] }));

    await loadSprayWall(fakeQueryClient(), LAYOUT_ID);

    expect(getSprayWall(LAYOUT_ID)).toBeNull();
  });

  it('drops the stale window on a forced load', async () => {
    const queryClient = fakeQueryClient();
    requestMock
      .mockResolvedValueOnce({ sprayWallByLayout: { uuid: WALL_UUID } })
      .mockResolvedValueOnce(renderDataPayload());

    await loadSprayWall(queryClient, LAYOUT_ID, { force: true });

    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ['sprayWallRenderData', WALL_UUID, expect.any(String)],
    });
  });

  it('reports a wall that lost a material share of its holds', async () => {
    // A near-degenerate homography still renders, so `Board Render Failed` never
    // fires; without this the only symptom is a climber saying holds are missing.
    const holds = Array.from({ length: 20 }, (_unused, index) => ({
      id: index + 1,
      // Half of them sit beyond the map's horizon.
      cx: index < 10 ? 100 : 100_000_000,
      cy: 200,
      r: 18,
      outline: null,
    }));
    requestMock
      .mockResolvedValueOnce({ sprayWallByLayout: { uuid: WALL_UUID } })
      .mockResolvedValueOnce(renderDataPayload({ holds, homography: [1, 0, 0, 0, 1, 0, 1e-6, 0, -1] }));

    await loadSprayWall(fakeQueryClient(), LAYOUT_ID);

    expect(reportHandledErrorMock).toHaveBeenCalled();
    const [, context] = reportHandledErrorMock.mock.calls[0];
    expect(context).toMatchObject({ level: 'warning', extra: { wallUuid: WALL_UUID, expectedHolds: 20 } });
  });

  it('says nothing when every hold mapped', async () => {
    requestMock
      .mockResolvedValueOnce({ sprayWallByLayout: { uuid: WALL_UUID } })
      .mockResolvedValueOnce(renderDataPayload());

    await loadSprayWall(fakeQueryClient(), LAYOUT_ID);

    expect(reportHandledErrorMock).not.toHaveBeenCalled();
  });
});

describe('offline loader selection and reconnect', () => {
  it('hydrates offline without issuing paused React Query network reads', async () => {
    offlineState.offline = true;
    offlineState.localLoad.mockResolvedValue(true);
    await loadSprayWall(fakeQueryClient(), LAYOUT_ID);
    expect(offlineState.localLoad).toHaveBeenCalledOnce();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('falls back on a recognized transport failure without treating auth denial as offline', async () => {
    requestMock.mockRejectedValue(new TypeError('Network request failed'));
    offlineState.localLoad.mockResolvedValue(true);
    await loadSprayWall(fakeQueryClient(), LAYOUT_ID);
    expect(offlineState.localLoad).toHaveBeenCalledOnce();
    offlineState.localLoad.mockClear();
    requestMock.mockRejectedValueOnce({ response: { status: 403 } });
    await expect(loadSprayWall(fakeQueryClient(), LAYOUT_ID)).rejects.toEqual({ response: { status: 403 } });
    expect(offlineState.localLoad).not.toHaveBeenCalled();
  });

  it('does not fall back when the server authoritatively withdraws access', async () => {
    requestMock.mockResolvedValue({ sprayWallByLayout: null });
    await loadSprayWall(fakeQueryClient(), LAYOUT_ID);
    expect(offlineState.localLoad).not.toHaveBeenCalled();
    expect(getSprayWall(LAYOUT_ID)).toBeNull();
  });

  it('reconnect replaces the local registration with server authority', async () => {
    offlineState.offline = true;
    offlineState.localLoad.mockImplementation(async () => {
      registerExistingWall();
      return true;
    });
    const teardown = installSprayWallLoader(fakeQueryClient());
    // Drive the installed registry loader so the requested layout is tracked.
    const { ensureSprayWallLoaded } = await import('../spray-wall-registry');
    ensureSprayWallLoaded(LAYOUT_ID);
    await vi.waitFor(() => expect(getSprayWall(LAYOUT_ID)).not.toBeNull());
    requestMock.mockResolvedValue({ sprayWallByLayout: null });
    offlineState.offline = false;
    for (const notify of offlineState.subscribers) notify();
    await vi.waitFor(() => expect(getSprayWall(LAYOUT_ID)).toBeNull());
    teardown();
    expect(offlineState.subscribers.size).toBe(0);
  });
});

it('revalidates after a reconnect during the local decode in-flight slot', async () => {
  offlineState.offline = true;
  let finishLocal: (() => void) | undefined;
  offlineState.localLoad.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        finishLocal = () => {
          registerExistingWall();
          resolve(true);
        };
      }),
  );
  const teardown = installSprayWallLoader(fakeQueryClient());
  const { ensureSprayWallLoaded } = await import('../spray-wall-registry');
  ensureSprayWallLoaded(LAYOUT_ID);
  await vi.waitFor(() => expect(finishLocal).toBeDefined());
  requestMock.mockResolvedValue({ sprayWallByLayout: null });
  offlineState.offline = false;
  for (const notify of offlineState.subscribers) notify();
  finishLocal?.();
  await vi.waitFor(() => expect(requestMock).toHaveBeenCalled());
  expect(getSprayWall(LAYOUT_ID)).toBeNull();
  teardown();
});

describe('reconnect request ownership', () => {
  it('retains a same-account unavailable local wall for reconnect', async () => {
    offlineState.offline = true;
    offlineState.localLoad.mockResolvedValue(false);
    const teardown = installSprayWallLoader(fakeQueryClient());
    const { ensureSprayWallLoaded, getSprayWallLoadState } = await import('../spray-wall-registry');
    ensureSprayWallLoaded(LAYOUT_ID);
    await vi.waitFor(() => expect(getSprayWallLoadState(LAYOUT_ID)).toBe('unavailable'));
    requestMock.mockResolvedValue({ sprayWallByLayout: null });
    offlineState.offline = false;
    for (const notify of offlineState.subscribers) notify();
    await vi.waitFor(() => expect(requestMock).toHaveBeenCalled());
    teardown();
  });

  it.each(['account transition', 'wall removal'])('prunes unavailable requests after %s', async (transition) => {
    offlineState.offline = true;
    offlineState.localLoad.mockResolvedValue(false);
    const teardown = installSprayWallLoader(fakeQueryClient());
    const { ensureSprayWallLoaded, getSprayWallLoadState } = await import('../spray-wall-registry');
    ensureSprayWallLoaded(LAYOUT_ID);
    await vi.waitFor(() => expect(getSprayWallLoadState(LAYOUT_ID)).toBe('unavailable'));
    if (transition === 'wall removal') unregisterSprayWall(LAYOUT_ID);
    else resetSprayWallViewerAccess();
    offlineState.offline = false;
    for (const notify of offlineState.subscribers) notify();
    expect(invalidateQueriesMock).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
    teardown();
  });
});
