// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ANGLES, MOONBOARD_WIDE_ANGLES } from '@boardsesh/board-config';
import type { BoardName } from '@boardsesh/shared-schema';
import { useBoardAngleState } from '../use-board-angle-state';

const catalogue = vi.hoisted(() => ({
  queries: vi.fn(),
  data: undefined as { angle: number }[] | undefined,
  isSuccess: false,
  isPending: true,
  isFetching: false,
}));
vi.mock('../../lib/graphql/hooks', () => ({
  useAngles: (boardName: string, layoutId: number, enabled: boolean) => {
    catalogue.queries(boardName, layoutId, enabled);
    return catalogue;
  },
}));

beforeEach(() => {
  catalogue.queries.mockClear();
  catalogue.data = undefined;
  catalogue.isSuccess = false;
  catalogue.isPending = true;
  catalogue.isFetching = false;
});

describe('normalized board angle state', () => {
  it('keeps bundled ladders, including real negative angles, without enabling a query', () => {
    const { result } = renderHook(() => useBoardAngleState('grasshopper', { layoutId: 1, currentAngle: -5 }));
    expect(result.current).toMatchObject({
      angles: ANGLES.grasshopper,
      loading: false,
      ready: true,
      fallbackAngle: -5,
    });
    expect(catalogue.queries).toHaveBeenLastCalledWith('grasshopper', 1, false);
  });

  it('offers the usual snap stops only alongside a wider bundled ladder', () => {
    const { result, rerender } = renderHook(
      ({ angles }) => useBoardAngleState('moonboard', { bundledAngles: angles }),
      {
        initialProps: { angles: [...MOONBOARD_WIDE_ANGLES] as number[] },
      },
    );
    expect(result.current.snapAngles).toEqual([25, 40]);
    rerender({ angles: [25, 40] });
    expect(result.current.snapAngles).toEqual([]);
  });

  it('gates catalogue I/O on visible selection and clears angles across model switches', () => {
    const { result, rerender } = renderHook(
      ({ layoutId, enabled }) => useBoardAngleState('quantum', { layoutId, enabled, currentAngle: 40 }),
      {
        initialProps: { layoutId: 9101, enabled: false },
      },
    );
    expect(catalogue.queries).toHaveBeenLastCalledWith('quantum', 9101, false);
    expect(result.current).toMatchObject({ angles: [], ready: false, loading: false });
    rerender({ layoutId: 9101, enabled: true });
    expect(catalogue.queries).toHaveBeenLastCalledWith('quantum', 9101, true);
    expect(result.current.loading).toBe(true);
    catalogue.data = [
      { angle: 50 },
      { angle: 20 },
      { angle: 40 },
      { angle: 20 },
      { angle: -5 },
      { angle: 120 },
      { angle: 22.5 },
    ];
    catalogue.isSuccess = true;
    catalogue.isPending = false;
    rerender({ layoutId: 9101, enabled: true });
    expect(result.current).toMatchObject({ angles: [20, 40, 50], ready: true, loading: false, fallbackAngle: 40 });
    catalogue.data = undefined;
    catalogue.isSuccess = false;
    catalogue.isPending = true;
    rerender({ layoutId: 9102, enabled: true });
    expect(result.current).toMatchObject({ angles: [], ready: false, loading: true });
    expect(catalogue.queries).toHaveBeenLastCalledWith('quantum', 9102, true);
  });

  it('falls back only after a downloaded catalogue resolves, preserving bundled current-angle behavior', () => {
    catalogue.data = [{ angle: 35 }, { angle: 20 }];
    catalogue.isSuccess = true;
    catalogue.isPending = false;
    const { result, rerender } = renderHook(
      ({ boardName }) => useBoardAngleState(boardName, { layoutId: 9101, currentAngle: 37 }),
      {
        initialProps: { boardName: 'quantum' as BoardName },
      },
    );
    expect(result.current.fallbackAngle).toBe(20);
    rerender({ boardName: 'kilter' });
    expect(result.current.angles).toEqual(ANGLES.kilter);
    expect(result.current.fallbackAngle).toBe(37);
    expect(catalogue.queries).toHaveBeenLastCalledWith('kilter', 9101, false);
  });

  it('fails closed when a valid query resolves without angles or no model is selected', () => {
    catalogue.data = [];
    catalogue.isSuccess = true;
    catalogue.isPending = false;
    const { result, rerender } = renderHook(({ layoutId }) => useBoardAngleState('quantum', { layoutId }), {
      initialProps: { layoutId: 9101 as number | null },
    });
    expect(result.current.ready).toBe(false);
    rerender({ layoutId: null });
    expect(catalogue.queries).toHaveBeenLastCalledWith('quantum', 0, false);
    expect(result.current.ready).toBe(false);
  });
});
