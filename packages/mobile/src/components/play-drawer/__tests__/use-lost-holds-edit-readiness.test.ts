// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Climb } from '@boardsesh/shared-schema';

/**
 * The second gate on the lost-holds banner's Edit button (#6024): the editor
 * drops lost holds by THIS DEVICE's wall, the banner counts them by the
 * SERVER's. Edit is offered only when the two agree and something survives.
 */

const registry = {
  wall: null as { holds: { id: number }[] } | null,
  refreshes: [] as number[],
};

vi.mock('../../../lib/spray/spray-wall-registry', () => ({
  SPRAY_BOARD_NAME: 'spray',
  getSprayWall: () => registry.wall,
  refreshSprayWall: (layoutId: number) => registry.refreshes.push(layoutId),
}));

vi.mock('../../../lib/spray/use-spray-wall-token', () => ({
  useSprayWallToken: () => 'token-1',
}));

const { lostHoldsEditReadiness, useLostHoldsEditReadiness } = await import('../use-lost-holds-edit-readiness');

// Holds 1, 2, 3 and 4.
const FRAMES = 'p1r42p2r43p3r43p4r44';

function climb(missingHoldCount: number): Climb {
  return { uuid: 'climb-1', frames: FRAMES, missingHoldCount } as unknown as Climb;
}

describe('lostHoldsEditReadiness', () => {
  it('is ready when the device wall is missing the same holds the server counts', () => {
    expect(lostHoldsEditReadiness(FRAMES, 2, new Set([1, 4, 99]))).toBe('ready');
  });

  it('is stale when the device wall still has holds the server says are gone', () => {
    // The pre-reset wall: every hold still there, server counts two lost.
    expect(lostHoldsEditReadiness(FRAMES, 2, new Set([1, 2, 3, 4]))).toBe('wall-stale');
    expect(lostHoldsEditReadiness(FRAMES, 2, null)).toBe('wall-stale');
  });

  it('is ready when the device wall is newer than the climb row', () => {
    expect(lostHoldsEditReadiness(FRAMES, 1, new Set([1, 4]))).toBe('ready');
  });

  it('refuses when every hold on the climb came off the wall', () => {
    expect(lostHoldsEditReadiness(FRAMES, 4, new Set([99]))).toBe('nothing-left');
  });
});

describe('useLostHoldsEditReadiness', () => {
  beforeEach(() => {
    registry.wall = null;
    registry.refreshes = [];
  });

  it('forces a wall refresh when the held wall is behind the server', () => {
    registry.wall = { holds: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }] };
    const { result } = renderHook(() => useLostHoldsEditReadiness(climb(2), 'spray', 7));
    expect(result.current).toBe('wall-stale');
    expect(registry.refreshes).toEqual([7]);
  });

  it('does not refresh a wall that agrees', () => {
    registry.wall = { holds: [{ id: 1 }, { id: 4 }] };
    const { result } = renderHook(() => useLostHoldsEditReadiness(climb(2), 'spray', 7));
    expect(result.current).toBe('ready');
    expect(registry.refreshes).toEqual([]);
  });

  it('never offers Edit off spray', () => {
    registry.wall = { holds: [{ id: 1 }, { id: 4 }] };
    const { result } = renderHook(() => useLostHoldsEditReadiness(climb(2), 'kilter', 7));
    expect(result.current).toBe('wall-stale');
    expect(registry.refreshes).toEqual([]);
  });
});
