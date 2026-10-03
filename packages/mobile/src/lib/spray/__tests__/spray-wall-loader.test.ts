import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_BOARDSESH_RENDER_SETTINGS } from '@boardsesh/board-look';

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

const {
  clearSprayWallRegistry,
  getSprayWall,
  registerSprayWall,
  resetSprayWallViewerAccess,
  setSprayWallLoader,
  sprayWallViewerGeneration,
  subscribeToSprayWalls,
} = await import('../spray-wall-registry');
const {
  LOOK_RETRY_AFTER_FAILURE_MS,
  clearSprayWallLooks,
  loadSprayWall,
  primeSprayWallLook,
  refreshSprayWallViewerAccess,
} = await import('../spray-wall-loader');
const sprayOperations = await import('@boardsesh/graphql/operations/spray-walls');

const LAYOUT_ID = 4200;
const WALL_UUID = 'wall-uuid';

/** A query client stand-in: `fetchQuery` just runs the function it is given. */
function fakeQueryClient(): Parameters<typeof loadSprayWall>[0] {
  return {
    fetchQuery: ({ queryFn }: { queryFn: () => Promise<unknown> }) => queryFn(),
    invalidateQueries: invalidateQueriesMock,
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

function existingWall() {
  return {
    wallUuid: WALL_UUID,
    angle: 40,
    version: 1,
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

function lookRequests(): number {
  return requestMock.mock.calls.filter(([operation]) => operation === sprayOperations.GET_SPRAY_WALL_LOOK).length;
}

beforeEach(() => {
  clearSprayWallRegistry();
  clearSprayWallLooks();
  requestMock.mockReset();
  reportHandledErrorMock.mockReset();
  invalidateQueriesMock.mockClear();
});

afterEach(() => {
  clearSprayWallRegistry();
});

describe('loadSprayWall', () => {
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

  it('registers whether the viewer can edit the wall, and only on a literal true', async () => {
    requestMock
      .mockResolvedValueOnce({ sprayWallByLayout: { uuid: WALL_UUID } })
      .mockResolvedValueOnce(
        renderDataPayload({ wall: { uuid: WALL_UUID, board: { angle: 25 }, viewerCanEdit: true } }),
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
        return renderDataPayload({ wall: { uuid: WALL_UUID, board: { angle: 25 }, viewerCanEdit: true } });
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
          return renderDataPayload({ wall: { uuid: WALL_UUID, board: { angle: 25 }, viewerCanEdit: true } });
        }
        return renderDataPayload({ wall: { uuid: WALL_UUID, board: { angle: 25 }, viewerCanEdit: false } });
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
        return renderDataPayload({ wall: { uuid: WALL_UUID, board: { angle: 25 }, viewerCanEdit: true } });
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

  it('registers "cannot edit" for a payload nobody can vouch for', async () => {
    // The wall editor's draft registers render data it fetched itself, with no
    // viewer generation. That draws the wall and says nothing about Edit.
    const { registerRenderData } = await import('../spray-wall-loader');
    const payload = renderDataPayload({ wall: { uuid: WALL_UUID, board: { angle: 25 }, viewerCanEdit: true } });
    registerRenderData(LAYOUT_ID, payload.sprayWallRenderData as never, null);
    expect(getSprayWall(LAYOUT_ID)?.version).toBe(2);
    expect(getSprayWall(LAYOUT_ID)?.viewerCanEdit).toBe(false);
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

  it('never asks for the look inside a query or mutation that loads, creates or draws a wall', () => {
    // The app and the backend ship on different trains. A field the backend does
    // not have yet fails validation for the whole operation: in the shared wall
    // fragment it broke creating, loading and drawing every wall at once.
    for (const [name, operation] of Object.entries(sprayOperations)) {
      if (name === 'GET_SPRAY_WALL_LOOK' || name === 'SET_SPRAY_WALL_RENDER_SETTINGS') continue;
      expect(JSON.stringify(operation) ?? '', name).not.toContain('renderSettings');
    }
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

    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: ['sprayWallRenderData', WALL_UUID] });
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
