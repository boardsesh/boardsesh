// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

// The loader module reaches the GraphQL client, which pulls react-native's Flow
// source at import time. This suite drives the registry's loader seam directly,
// so the real one is not needed — only its shape.
vi.mock('../spray-wall-loader', () => ({
  installSprayWallLoader: () => () => {},
  sprayWallByLayoutQueryKey: (layoutId: number | null) => ['sprayWallByLayout', layoutId],
  sprayWallRenderDataQueryKey: (wallUuid: string | null) => ['sprayWallRenderData', wallUuid],
  WALL_IDENTITY_STALE_TIME_MS: 60 * 60 * 1000,
  RENDER_DATA_STALE_TIME_MS: 10 * 60 * 1000,
}));

import { clearSprayWallRegistry, registerSprayWall, setSprayWallLoader } from '../spray-wall-registry';
import type { SprayPhotoHold } from '../spray-hold-geometry';
import { useSprayWall } from '../use-spray-wall';

// `useSprayWall` no longer owns a query — the fetching lives in
// `spray-wall-loader.ts` so hook-less resolvers share it — so what is left to
// pin here is the contract a surface reads: it asks for the wall, it reports the
// three states honestly, and it re-renders when the answer lands.

const LAYOUT_ID = 4200;
const HOLDS: SprayPhotoHold[] = [{ id: 7, cx: 100, cy: 200, r: 18 }];

function wallPayload(version: number) {
  return {
    wallUuid: 'wall-uuid',
    angle: 40,
    version,
    photoWidth: 1200,
    photoHeight: 1600,
    photoUrl: `https://private.example/photo?sig=${version}`,
    photoThumbUrl: null,
    photoExpiresAt: '2099-01-01T00:00:00.000Z',
    holds: HOLDS,
  };
}

beforeEach(() => {
  clearSprayWallRegistry();
});

afterEach(() => {
  clearSprayWallRegistry();
});

describe('useSprayWall', () => {
  it('asks for the wall it is given', async () => {
    const loader = vi.fn(async () => {});
    setSprayWallLoader(loader);

    renderHook(() => useSprayWall(LAYOUT_ID));

    await waitFor(() => expect(loader).toHaveBeenCalledWith(LAYOUT_ID));
  });

  it('reports loading, then ready, and re-renders on the way', async () => {
    setSprayWallLoader(async () => {});
    const { result } = renderHook(() => useSprayWall(LAYOUT_ID));
    expect(result.current.isLoading).toBe(true);
    expect(result.current.isUnrenderable).toBe(false);

    act(() => {
      registerSprayWall(LAYOUT_ID, wallPayload(1));
    });

    await waitFor(() => expect(result.current.loadState).toBe('ready'));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isUnrenderable).toBe(false);
  });

  it('reports unrenderable for a wall that resolved to nothing', async () => {
    // Every reason looks the same to a surface: deleted, invisible, nothing
    // published, no readable photo, a photo with no dimensions, or a singular
    // homography — the loader registers in none of them.
    setSprayWallLoader(async () => {});
    const { result } = renderHook(() => useSprayWall(LAYOUT_ID));

    await waitFor(() => expect(result.current.isUnrenderable).toBe(true));
    expect(result.current.isLoading).toBe(false);
  });

  it('reports unrenderable when the holds could not be mapped', async () => {
    // The mapper's `null` (a singular matrix) reaches this hook as "nothing was
    // registered", which is the case the old `renderData == null` check missed.
    setSprayWallLoader(async () => {
      // A loader that resolves without registering is exactly what
      // `registerRenderData` does when the mapping fails.
    });
    const { result } = renderHook(() => useSprayWall(LAYOUT_ID));

    await waitFor(() => expect(result.current.isUnrenderable).toBe(true));
  });

  it('is inert for a null layout id', async () => {
    const loader = vi.fn(async () => {});
    setSprayWallLoader(loader);

    const { result } = renderHook(() => useSprayWall(null));
    expect(result.current.loadState).toBe('idle');

    // The oracle, not a sleep: a hook WITH a layout id must reach the loader, and
    // once it has, a null one that was going to ask would have.
    renderHook(() => useSprayWall(LAYOUT_ID));
    await waitFor(() => expect(loader).toHaveBeenCalledWith(LAYOUT_ID));

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('keeps a registered wall when it unmounts, so other surfaces keep drawing', async () => {
    setSprayWallLoader(async (layoutId: number) => {
      registerSprayWall(layoutId, wallPayload(1));
    });
    const { unmount, result } = renderHook(() => useSprayWall(LAYOUT_ID));
    await waitFor(() => expect(result.current.loadState).toBe('ready'));

    unmount();

    // The registry is session state, not screen state.
    const { result: second } = renderHook(() => useSprayWall(LAYOUT_ID));
    expect(second.current.loadState).toBe('ready');
  });
});
