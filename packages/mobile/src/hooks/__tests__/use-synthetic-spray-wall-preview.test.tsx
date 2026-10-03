// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { accumulateFramesToMaps } from '@boardsesh/board-constants/hold-states';
import { clearBoardRenderDataCache } from '../../lib/board-details';
import { clearSprayWallRegistry, registerSprayWall, unregisterSprayWall } from '../../lib/spray/spray-wall-registry';
import type { SprayPhotoHold } from '../../lib/spray/spray-hold-geometry';
import { useSyntheticSprayWallPreview } from '../use-synthetic-spray-wall-preview';

const LAYOUT_ID = 4300;

/** Forty holds; a higher id sits HIGHER on the wall (smaller `cy`). */
const HOLDS: SprayPhotoHold[] = Array.from({ length: 40 }, (_, index) => ({
  id: 100 + index,
  cx: 50 + (index % 8) * 100,
  cy: 1500 - index * 30,
  r: 20,
}));

function registerWall(holds: SprayPhotoHold[] = HOLDS, version = 1) {
  registerSprayWall(LAYOUT_ID, {
    wallUuid: 'wall-uuid',
    angle: 40,
    version,
    photoWidth: 1200,
    photoHeight: 1600,
    photoUrl: 'https://private.example/photo',
    photoThumbUrl: null,
    photoExpiresAt: '2099-01-01T00:00:00.000Z',
    holds,
  });
}

afterEach(() => {
  clearSprayWallRegistry();
  clearBoardRenderDataCache();
});

describe('useSyntheticSprayWallPreview', () => {
  it('is loading until the wall is registered, then draws it', () => {
    const { result } = renderHook(() => useSyntheticSprayWallPreview(LAYOUT_ID));
    expect(result.current).toEqual({ status: 'loading', preview: null });

    act(() => registerWall());

    expect(result.current.status).toBe('ready');
    expect(result.current.preview).toMatchObject({
      boardName: 'spray',
      layoutId: LAYOUT_ID,
      sizeId: LAYOUT_ID,
      setIds: '1',
      boardWidth: 1200,
      boardHeight: 1600,
    });
  });

  it('lights twelve of the wall’s own holds, as a climb with every role', () => {
    registerWall();
    const { result } = renderHook(() => useSyntheticSprayWallPreview(LAYOUT_ID));
    const frames = result.current.preview?.frames ?? '';
    const [lit] = accumulateFramesToMaps(frames, 'spray');
    const litIds = Object.keys(lit).map(Number);

    expect(litIds).toHaveLength(12);
    expect(litIds.every((id) => HOLDS.some((hold) => hold.id === id))).toBe(true);
    const states = Object.values(lit).map((hold) => hold.state);
    expect(new Set(states)).toEqual(new Set(['FOOT', 'STARTING', 'HAND', 'FINISH']));

    // Feet lowest, finish highest: in this fixture a higher id is higher up.
    const finishId = litIds.find((id) => lit[id].state === 'FINISH')!;
    const footIds = litIds.filter((id) => lit[id].state === 'FOOT');
    expect(finishId).toBe(Math.max(...litIds));
    expect(Math.max(...footIds)).toBeLessThan(Math.min(...litIds.filter((id) => lit[id].state === 'HAND')));
  });

  it('is the same picture on every render', () => {
    registerWall();
    const first = renderHook(() => useSyntheticSprayWallPreview(LAYOUT_ID)).result.current.preview?.frames;
    const second = renderHook(() => useSyntheticSprayWallPreview(LAYOUT_ID)).result.current.preview?.frames;
    expect(second).toBe(first);
  });

  it('lights every hold of a small wall', () => {
    registerWall(HOLDS.slice(0, 4));
    const { result } = renderHook(() => useSyntheticSprayWallPreview(LAYOUT_ID));
    const [lit] = accumulateFramesToMaps(result.current.preview?.frames ?? '', 'spray');
    expect(Object.keys(lit)).toHaveLength(4);
  });

  it('goes back to loading when the wall is unregistered under it', () => {
    registerWall();
    const { result } = renderHook(() => useSyntheticSprayWallPreview(LAYOUT_ID));
    expect(result.current.status).toBe('ready');

    act(() => unregisterSprayWall(LAYOUT_ID));

    expect(result.current).toEqual({ status: 'loading', preview: null });
  });

  it('has nothing to draw on a wall with no holds, or with no layout', () => {
    registerWall([]);
    expect(renderHook(() => useSyntheticSprayWallPreview(LAYOUT_ID)).result.current.status).toBe('unavailable');
    expect(renderHook(() => useSyntheticSprayWallPreview(null)).result.current.status).toBe('unavailable');
  });
});
