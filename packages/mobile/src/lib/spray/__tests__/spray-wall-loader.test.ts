import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

// The GraphQL client pulls react-native's Flow source at import time, and the
// draft store and error reporter both reach native modules. Mocked so the
// loader's own decisions — which are all about what to register and what to
// withdraw — can be exercised.
const requestMock = vi.hoisted(() => vi.fn());
vi.mock('../../graphql/client', () => ({ getHttpClient: () => ({ request: requestMock }) }));
vi.mock('../../create-climb-draft-store', () => ({ clearSupersededSprayDrafts: async () => {} }));
const reportHandledErrorMock = vi.hoisted(() => vi.fn());
const invalidateQueriesMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../error-reporting', () => ({ reportHandledError: reportHandledErrorMock }));

const { clearSprayWallRegistry, getSprayWall, registerSprayWall, withdrawAllSprayWalls, ensureSprayWallLoaded } =
  await import('../spray-wall-registry');
const { loadSprayWall, installSprayWallLoader, invalidateSprayWallRenderData } = await import('../spray-wall-loader');
const { unregisterSprayWall, subscribeToSprayWallWithdrawals } = await import('../spray-wall-registry');
const { adoptSprayWallFromLink, sprayWallByLayoutQueryKey, sprayWallRenderDataQueryKey } =
  await import('../spray-wall-loader');

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
      wall: { uuid: WALL_UUID, board: { angle: 25 } },
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

function registerExistingWall() {
  registerSprayWall(LAYOUT_ID, {
    wallUuid: WALL_UUID,
    angle: 40,
    version: 1,
    photoWidth: 1200,
    photoHeight: 1600,
    photoUrl: 'https://private.example/old',
    photoThumbUrl: null,
    photoExpiresAt: 'later',
    holds: [{ id: 99, cx: 1, cy: 2, r: 3 }],
  });
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
  clearSprayWallRegistry();
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
      ['sprayWall', WALL_UUID, 'old'],
      ['sprayWallRenderData', WALL_UUID, 'old'],
      ['sprayWallRenderData', WALL_UUID, 3, 'old'],
      ['sprayWallWithVersions', WALL_UUID],
      ['sprayWallResetProposal', 'draft-a', 20],
    ];
    for (const key of erasedKeys)
      queryClient.setQueryData(
        key,
        key[0] === 'sprayWallWithVersions' ? { uuid: WALL_UUID, versions: wall.versions } : { sprayWall: wall },
      );
    const preservedKeys = [
      ['sprayWallByLayout', 4300, 'old'],
      ['sprayWallRenderData', 'wall-b', 'old'],
      ['sprayWallResetProposal', 'draft-b', 20],
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
    queryClient.setQueryData(['sprayWall', WALL_UUID, 'old'], { sprayWall: { uuid: WALL_UUID, layoutId: LAYOUT_ID } });
    queryClient.setQueryData(['sprayWallRenderData', WALL_UUID, 'old'], renderDataPayload());
    unregisterSprayWall(LAYOUT_ID);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    teardown();
    queryClient.clear();
  });

  it('global withdrawal erases spray families and retains catalogue queries', () => {
    const queryClient = privateQueryClient();
    const teardown = installSprayWallLoader(queryClient);
    for (const family of [
      'sprayWallByLayout',
      'sprayWall',
      'sprayWallRenderData',
      'sprayWallWithVersions',
      'sprayWallResetProposal',
    ]) {
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
    requestMock.mockReturnValue(render.promise);
    const loading = loadSprayWall(queryClient, LAYOUT_ID);
    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
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

  it('erases a late link response whose layout was unknown when withdrawn', async () => {
    const queryClient = privateQueryClient();
    const teardown = installSprayWallLoader(queryClient);
    const link = deferredResponse();
    requestMock.mockReturnValue(link.promise);
    const adoption = adoptSprayWallFromLink(queryClient, WALL_UUID);
    unregisterSprayWall(LAYOUT_ID);
    link.resolve({ sprayWall: { uuid: WALL_UUID, layoutId: LAYOUT_ID } });
    expect(await adoption).toBeNull();
    expect(queryClient.getQueryCache().findAll({ queryKey: ['sprayWall', WALL_UUID] })).toHaveLength(0);
    teardown();
    queryClient.clear();
  });

  it('settles a known pending link cancellation without retaining its late response', async () => {
    const queryClient = privateQueryClient();
    const teardown = installSprayWallLoader(queryClient);
    registerExistingWall();
    const link = deferredResponse();
    requestMock.mockReturnValue(link.promise);
    const adoption = adoptSprayWallFromLink(queryClient, WALL_UUID);
    let settled = false;
    void adoption.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    unregisterSprayWall(LAYOUT_ID);
    // Observe cancellation before releasing transport, but always release it
    // before assertions so a deliberately removed guard cannot strand the test.
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    const settledBeforeResponse = settled;
    link.resolve({ sprayWall: { uuid: WALL_UUID, layoutId: LAYOUT_ID } });
    expect(await adoption).toBeNull();
    expect(settledBeforeResponse).toBe(true);
    expect(queryClient.getQueryCache().findAll({ queryKey: ['sprayWall', WALL_UUID] })).toHaveLength(0);
    teardown();
    queryClient.clear();
  });

  it('preserves a genuine link transport failure after unrelated withdrawal', async () => {
    const queryClient = privateQueryClient();
    const teardown = installSprayWallLoader(queryClient);
    const transportError = new Error('link transport failed');
    let reject!: (error: Error) => void;
    requestMock.mockReturnValue(
      new Promise<never>((_resolve, rejectPromise) => {
        reject = rejectPromise;
      }),
    );
    const adoption = adoptSprayWallFromLink(queryClient, WALL_UUID);
    const rejection = expect(adoption).rejects.toBe(transportError);
    unregisterSprayWall(4300);
    reject(transportError);
    await rejection;
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
  it.each(['identity', 'render'] as const)(
    'does not register the %s response completing after sign-out',
    async (stage) => {
      let resolveRequest!: (response: unknown) => void;
      const delayed = new Promise((resolve) => {
        resolveRequest = resolve;
      });
      if (stage === 'identity') requestMock.mockReturnValueOnce(delayed).mockResolvedValue(renderDataPayload());
      else requestMock.mockResolvedValueOnce({ sprayWallByLayout: { uuid: WALL_UUID } }).mockReturnValueOnce(delayed);
      const loading = loadSprayWall(fakeQueryClient(), LAYOUT_ID);
      await vi.waitFor(() => expect(requestMock).toHaveBeenCalledTimes(stage === 'identity' ? 1 : 2));
      withdrawAllSprayWalls();
      resolveRequest(stage === 'identity' ? { sprayWallByLayout: { uuid: WALL_UUID } } : renderDataPayload());
      await loading;
      expect(getSprayWall(LAYOUT_ID)).toBeNull();
      expect(requestMock).toHaveBeenCalledTimes(stage === 'identity' ? 1 : 2);
    },
  );

  it('teardown rejects a loader already awaiting a render response', async () => {
    let resolveRequest!: (response: unknown) => void;
    const delayed = new Promise((resolve) => {
      resolveRequest = resolve;
    });
    requestMock.mockResolvedValueOnce({ sprayWallByLayout: { uuid: WALL_UUID } }).mockReturnValueOnce(delayed);
    const teardown = installSprayWallLoader(fakeQueryClient());
    const loading = loadSprayWall(fakeQueryClient(), LAYOUT_ID);
    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledTimes(2));
    teardown();
    resolveRequest(renderDataPayload());
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
  });

  it('registers a wall whose payload will not say its angle', async () => {
    // Deliberately unlike a photo that will not say its size, which is refused:
    // such a wall draws perfectly well, and blanking the board over a field only
    // the authoring path reads would trade a working wall for a placeholder. Null
    // rather than a fabricated number, so `authoringAngle` falls back to the
    // caller instead of failing every publish on the server's angle check.
    const payload = renderDataPayload();
    requestMock
      .mockResolvedValueOnce({ sprayWallByLayout: { uuid: WALL_UUID } })
      .mockResolvedValueOnce({ sprayWallRenderData: { ...payload.sprayWallRenderData, wall: { uuid: WALL_UUID } } });

    await loadSprayWall(fakeQueryClient(), LAYOUT_ID);

    expect(getSprayWall(LAYOUT_ID)).toMatchObject({ version: 2, angle: null });
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
