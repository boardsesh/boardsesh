// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearBoardRenderDataCache, getBoardRenderData, getBoardRenderDimensions } from '../board-details';
import { clearCreateBoardHoldsCache, getCreateBoardHolds } from '../create-board-holds';
import {
  clearSprayWallRegistry,
  registerSprayWall,
  setSprayWallLoader,
  unregisterSprayWall,
} from '../spray/spray-wall-registry';
import { useBoardRenderData, useCreateBoardHolds } from '../use-board-render-data';

const runtimeBoard = { boardName: 'quantum' as const, layoutId: 9101, sizeId: 9201, setIds: '1' };
beforeEach(() => {
  clearBoardRenderDataCache();
  clearCreateBoardHoldsCache();
  clearSprayWallRegistry();
});
afterEach(() => {
  cleanup();
  clearSprayWallRegistry();
});

describe('normalized reactive board geometry', () => {
  it('reads fixed Quantum render and editor geometry immediately with stable normalized caches', () => {
    const { result, rerender } = renderHook(() => ({
      render: useBoardRenderData(runtimeBoard),
      editor: useCreateBoardHolds(runtimeBoard),
    }));
    expect(result.current.render?.holdsData).toHaveLength(657);
    expect(result.current.editor?.holdTargets).toHaveLength(657);
    expect(getBoardRenderDimensions(runtimeBoard)).toEqual({
      boardWidth: result.current.render!.boardWidth,
      boardHeight: result.current.render!.boardHeight,
    });
    const firstRender = result.current.render;
    const firstEditor = result.current.editor;
    rerender();
    expect(result.current.render).toBe(firstRender);
    expect(result.current.editor).toBe(firstEditor);
    const numericConfig = { ...runtimeBoard, setIds: [1] };
    expect(getBoardRenderData(numericConfig)).toBe(firstRender);
    expect(getCreateBoardHolds(numericConfig)).toBe(firstEditor);
  });

  it('changes fixed size membership while preserving unrelated bundled geometry identity', () => {
    const { result, rerender } = renderHook(
      ({ sizeId }) => ({
        other: useBoardRenderData({ boardName: 'woods', layoutId: 1, sizeId: 1, setIds: [1] }),
        quantum: useBoardRenderData({ ...runtimeBoard, sizeId }),
      }),
      { initialProps: { sizeId: 9201 } },
    );
    const other = result.current.other;
    const xlIds = new Set(result.current.quantum!.holdsData.map((hold) => hold.id));
    rerender({ sizeId: 9203 });
    expect(result.current.other).toBe(other);
    expect(result.current.quantum?.holdsData).toHaveLength(432);
    expect(result.current.quantum!.holdsData.every((hold) => xlIds.has(hold.id))).toBe(true);
  });

  it('requests personal geometry and stops exposing holds after its withdrawal', async () => {
    const loader = vi.fn(async (layoutId: number) => {
      registerSprayWall(layoutId, {
        wallUuid: 'personal-wall',
        angle: 40,
        version: 1,
        versionId: 1,
        photoWidth: 1200,
        photoHeight: 1600,
        photoUrl: 'https://example.test/wall.webp',
        photoThumbUrl: null,
        photoExpiresAt: '2099-01-01T00:00:00.000Z',
        holds: [{ id: 11, cx: 250, cy: 500, r: 18 }],
      });
    });
    setSprayWallLoader(loader);
    const { result } = renderHook(() =>
      useBoardRenderData({ boardName: 'spray', layoutId: 42, sizeId: 42, setIds: '1' }),
    );
    await waitFor(() => expect(result.current?.holdsData).toHaveLength(1));
    expect(loader).toHaveBeenCalledTimes(1);
    act(() => {
      registerSprayWall(42, {
        wallUuid: 'personal-wall',
        angle: 40,
        version: 2,
        versionId: 2,
        photoWidth: 1200,
        photoHeight: 1600,
        photoUrl: 'https://example.test/reset.webp',
        photoThumbUrl: null,
        photoExpiresAt: '2099-01-01T00:00:00.000Z',
        holds: [{ id: 12, cx: 350, cy: 450, r: 20 }],
      });
    });
    expect(result.current?.holdsData.map((hold) => hold.id)).toEqual([12]);
    act(() => {
      unregisterSprayWall(42);
    });
    expect(result.current).toBeNull();
  });
});
