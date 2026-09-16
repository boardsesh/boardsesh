// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { clearSprayWallRegistry, registerSprayWall, setSprayWallLoader } from '../spray-wall-registry';
import type { SprayPhotoHold } from '../spray-hold-geometry';
import { useSprayWallToken } from '../use-spray-wall-token';

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

/**
 * The hook every SYNCHRONOUS board surface calls above its early return.
 *
 * `BoardManageRow` and `AccessoryClimbThumbnail` both gate on
 * `getBoardRenderData() === null` and return before mounting anything that
 * subscribes to the registry, so without this the wall's arrival has nothing to
 * re-render and the surface stays on its placeholder for the session.
 */
describe('useSprayWallToken', () => {
  it('requests a wall the session does not hold', async () => {
    const loader = vi.fn(async () => {});
    setSprayWallLoader(loader);

    renderHook(() => useSprayWallToken('spray', LAYOUT_ID));

    await waitFor(() => expect(loader).toHaveBeenCalledWith(LAYOUT_ID));
  });

  it('re-renders its caller when the wall lands', async () => {
    setSprayWallLoader(async () => {});
    const { result } = renderHook(() => useSprayWallToken('spray', LAYOUT_ID));
    expect(result.current).toBe('-sv0');

    act(() => {
      registerSprayWall(LAYOUT_ID, wallPayload(1));
    });

    await waitFor(() => expect(result.current).toBe('-sv1'));
  });

  it('re-renders on a reset', async () => {
    setSprayWallLoader(async () => {});
    registerSprayWall(LAYOUT_ID, wallPayload(1));
    const { result } = renderHook(() => useSprayWallToken('spray', LAYOUT_ID));
    expect(result.current).toBe('-sv1');

    act(() => {
      registerSprayWall(LAYOUT_ID, wallPayload(2));
    });

    await waitFor(() => expect(result.current).toBe('-sv2'));
  });

  it('asks for nothing and stays empty on a catalogue board', async () => {
    const loader = vi.fn(async () => {});
    setSprayWallLoader(loader);

    const { result } = renderHook(() => useSprayWallToken('kilter', 1));
    expect(result.current).toBe('');

    // The oracle, not a sleep: a spray row mounted right after must reach the
    // loader, and once it has, a kilter row that was going to ask would have.
    renderHook(() => useSprayWallToken('spray', LAYOUT_ID));
    await waitFor(() => expect(loader).toHaveBeenCalledWith(LAYOUT_ID));

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('tolerates a board that has not resolved yet', () => {
    setSprayWallLoader(async () => {});
    const { result } = renderHook(() => useSprayWallToken(undefined, undefined));
    expect(result.current).toBe('');
  });
});
