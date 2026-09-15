// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// The one thing the key-builder unit tests cannot see: whether the hook REACTS
// to a wall arriving or being reset.
//
// `sprayCacheToken` is the only input to `buildCacheKey` / `buildBoardKey` that
// is not a prop — `useSprayWall` writes it into a module-level registry — so
// memoising those keys on their prop inputs alone leaves a board that mounted
// before the wall query landed holding the `-sv0` key it computed at mount. The
// effects never re-run and the wall stays blank; after a reset the same
// staleness shows the previous generation's overlay over the new photograph.

vi.mock('../../providers/theme-provider', () => ({ useAppColorScheme: () => 'light' }));

vi.mock('expo-file-system', () => ({
  Directory: vi.fn(() => ({ exists: false, list: () => [] })),
  File: vi.fn(() => ({ exists: false })),
  Paths: { cache: { uri: 'file:///cache/' } },
}));

type MockBoardRenderData = {
  boardWidth: number;
  boardHeight: number;
  holdsData: { id: number; mirroredHoldId: number | null; cx: number; cy: number; r: number }[];
};

// Deliberately the REAL registry behind a mocked `getBoardRenderData`: the
// registry is what the hook subscribes to, and stubbing it would test the stub.
const { getSprayWall } = await import('../../lib/spray/spray-wall-registry');

const getBoardRenderDataMock = vi.hoisted(() => vi.fn<() => MockBoardRenderData | null>(() => null));
vi.mock('../../lib/board-details', () => ({ getBoardRenderData: getBoardRenderDataMock }));

const ensureBackgroundsCachedMock = vi.hoisted(() =>
  vi.fn(async () => ({ paths: ['file:///photo.jpg'], missingCount: 0 })),
);
vi.mock('../../lib/background-image-cache', () => ({
  tryGetBackgroundPathsSync: vi.fn(() => null),
  ensureBackgroundsCached: ensureBackgroundsCachedMock,
}));

vi.mock('../../lib/error-reporting', () => ({ reportError: vi.fn(), addErrorBreadcrumb: vi.fn() }));

const { useNativeClimbRender, _resetWarmupForTests } = await import('../use-native-climb-render');
const { clearSprayWallRegistry, registerSprayWall } = await import('../../lib/spray/spray-wall-registry');

const LAYOUT_ID = 4200;
const SPRAY_BOARD = {
  boardName: 'spray' as const,
  layoutId: LAYOUT_ID,
  sizeId: LAYOUT_ID,
  setIds: '1',
  frames: 'p7r2',
};

function registerWall(version: number) {
  registerSprayWall(LAYOUT_ID, {
    wallUuid: 'wall-uuid',
    angle: 40,
    version,
    photoWidth: 1200,
    photoHeight: 1600,
    photoUrl: `https://private.example/photo?sig=${version}`,
    photoThumbUrl: null,
    photoExpiresAt: '2099-01-01T00:00:00.000Z',
    holds: [{ id: 7, cx: 100, cy: 200, r: 18 }],
  });
}

/**
 * `getBoardRenderData` for real: null while no wall is registered, and the
 * registered wall's holds once there is one. That is exactly what the production
 * spray branch does, and it is what makes "the hook never re-ran" observable —
 * a hook that does not react keeps calling with the mount-time key and never
 * gets past the null.
 */
function renderDataFromRegistry(): MockBoardRenderData | null {
  const wall = getSprayWall(LAYOUT_ID);
  if (!wall) return null;
  return {
    boardWidth: wall.photoWidth,
    boardHeight: wall.photoHeight,
    holdsData: wall.holds.map((hold) => ({
      id: hold.id,
      mirroredHoldId: null,
      cx: hold.cx,
      cy: hold.cy,
      r: hold.r,
    })),
  };
}

beforeEach(() => {
  clearSprayWallRegistry();
  _resetWarmupForTests();
  getBoardRenderDataMock.mockReset();
  getBoardRenderDataMock.mockImplementation(renderDataFromRegistry);
  ensureBackgroundsCachedMock.mockClear();
});

afterEach(() => {
  clearSprayWallRegistry();
});

describe('useNativeClimbRender reacts to the spray registry', () => {
  it('picks the wall up when it lands after mount', async () => {
    // Mounted with nothing registered: the board key carries `-sv0` and there is
    // no render data behind it.
    const { result } = renderHook(() => useNativeClimbRender(SPRAY_BOARD));
    await waitFor(() => expect(ensureBackgroundsCachedMock).toHaveBeenCalled());
    const callsBeforeWall = ensureBackgroundsCachedMock.mock.calls.length;

    registerWall(1);

    // If `buildBoardKey`'s memo does not depend on the registry, nothing here
    // re-renders and the board stays blank for the life of this hook instance.
    await waitFor(() => expect(ensureBackgroundsCachedMock.mock.calls.length).toBeGreaterThan(callsBeforeWall));
    await waitFor(() => expect(result.current.backgroundPaths).toEqual(['file:///photo.jpg']));
  });

  it('re-runs the background pass on a reset', async () => {
    registerWall(1);
    renderHook(() => useNativeClimbRender(SPRAY_BOARD));
    await waitFor(() => expect(ensureBackgroundsCachedMock).toHaveBeenCalled());
    const callsBeforeReset = ensureBackgroundsCachedMock.mock.calls.length;

    registerWall(2);

    await waitFor(() => expect(ensureBackgroundsCachedMock.mock.calls.length).toBeGreaterThan(callsBeforeReset));
  });

  it('does not re-render a catalogue board when a wall is registered', async () => {
    // A negative assertion needs a positive oracle, not a sleep: a fixed delay
    // either flakes under load or passes vacuously because the work it was meant
    // to wait for had not started yet. So a SPRAY hook is mounted alongside the
    // kilter one, and its reaction is what proves the registration has been fully
    // processed — only then does the kilter count mean anything.
    getBoardRenderDataMock.mockImplementation(renderDataFromRegistry);
    const spray = renderHook(() => useNativeClimbRender(SPRAY_BOARD));

    getBoardRenderDataMock.mockImplementation(() => ({
      boardWidth: 1080,
      boardHeight: 1920,
      holdsData: [{ id: 1, mirroredHoldId: null, cx: 10, cy: 20, r: 5 }],
    }));
    renderHook(() =>
      useNativeClimbRender({ boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '24,25', frames: 'p1r12' }),
    );
    await waitFor(() => expect(ensureBackgroundsCachedMock).toHaveBeenCalled());
    const callsBefore = ensureBackgroundsCachedMock.mock.calls.length;

    // `sprayCacheToken` is `''` for a catalogue board, so its snapshot does not
    // move and the subscription costs it nothing.
    registerWall(1);

    await waitFor(() => expect(spray.result.current.backgroundPaths).toEqual(['file:///photo.jpg']));
    expect(ensureBackgroundsCachedMock.mock.calls.length).toBe(callsBefore + 1);
  });
});
