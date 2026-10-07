// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { LitUpHoldsMap } from '@boardsesh/shared-schema';
import type { ClimbLostHoldsState } from '../../../lib/graphql/hooks/use-climb-lost-holds';

/**
 * The remix editor's grey rings: one where each hold the parent climb lost used
 * to be, dismissed by a tap, and nothing when there is nothing to draw.
 */

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

const lostHoldsQuery = vi.hoisted(() => ({
  state: { status: 'idle' } as ClimbLostHoldsState,
  variables: [] as unknown[],
}));
const registry = vi.hoisted(() => ({
  wall: null as null | { homography?: number[]; holds: { id: number; cx: number; cy: number; r: number }[] },
  // The generated look the wall is drawn on, or null for its photo.
  art: null as null | { scale: number; holds: unknown[] },
}));

vi.mock('../../../lib/graphql/hooks/use-climb-lost-holds', () => ({
  useClimbLostHolds: (variables: unknown) => {
    lostHoldsQuery.variables.push(variables);
    return lostHoldsQuery.state;
  },
}));
vi.mock('../../../lib/spray/spray-wall-registry', () => ({
  SPRAY_BOARD_NAME: 'spray',
  getSprayWall: () => registry.wall,
  activeSprayArt: () => registry.art,
}));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: () => {} }));

const { findLostHoldIds, useLostHoldGhosts } = await import('../use-lost-hold-ghosts');

const BOARD = { boardName: 'spray' as const, layoutId: 7, sizeId: 1, setIds: '1', angle: 40 };
// Hold 1 start, hold 2 hand, hold 3 finish. Holds 2 and 4 came off the wall.
const SOURCE_FRAMES = 'p1r1p2r2p3r3p4r2';
const AVAILABLE = new Set([1, 3, 10]);

function setup(parentClimbUuid: string | null = 'climb-1') {
  return renderHook(() =>
    useLostHoldGhosts({
      board: BOARD,
      parentClimbUuid,
      sourceFrames: SOURCE_FRAMES,
      availableHoldIds: AVAILABLE,
      sprayWallToken: 'token',
    }),
  );
}

describe('findLostHoldIds', () => {
  it('names the painted holds the wall no longer has, once each', () => {
    const hold = (state: LitUpHoldsMap[number]['state']) => ({ state, color: '', displayColor: '' });
    const frames: LitUpHoldsMap[] = [
      { 1: hold('STARTING'), 2: hold('HAND') },
      { 2: hold('HAND'), 5: hold('OFF') },
    ];
    expect(findLostHoldIds(frames, new Set([1]))).toEqual([2]);
  });
});

describe('useLostHoldGhosts', () => {
  beforeEach(() => {
    lostHoldsQuery.variables.length = 0;
    registry.art = null;
    lostHoldsQuery.state = {
      status: 'ready',
      lostHolds: [
        { id: 2, cx: 100, cy: 100, r: 10, outline: null },
        { id: 4, cx: 200, cy: 200, r: 12, outline: null },
      ],
    };
    registry.wall = { homography: IDENTITY, holds: [{ id: 1, cx: 0, cy: 0, r: 10 }] };
  });

  it('draws a ring where each lost hold was, as a tap target', () => {
    const { result } = setup();
    expect(result.current.ghosts.map((ghost) => ghost.id)).toEqual([2, 4]);
    expect(result.current.ghostTargets).toEqual([
      { id: 2, cx: 100, cy: 100, r: 10 },
      { id: 4, cx: 200, cy: 200, r: 12 },
    ]);
    expect(lostHoldsQuery.variables.at(-1)).toEqual(expect.objectContaining({ climbUuid: 'climb-1', layoutId: 7 }));
  });

  it('takes a ring away on a tap, and only that one', () => {
    const { result } = setup();
    act(() => result.current.dismissGhost(2));
    expect(result.current.ghosts.map((ghost) => ghost.id)).toEqual([4]);
    act(() => result.current.dismissGhost(4));
    expect(result.current.ghosts).toEqual([]);
    expect(result.current.ghostTargets).toEqual([]);
  });

  it('draws nothing outside a remix (an edit in place, or a new climb)', () => {
    const { result } = setup(null);
    expect(result.current.ghosts).toEqual([]);
    expect(lostHoldsQuery.variables.at(-1)).toBeNull();
  });

  it('draws nothing, so holds nothing back, when the positions cannot be read', () => {
    lostHoldsQuery.state = { status: 'unavailable' };
    expect(setup().result.current.ghosts).toEqual([]);
  });

  // On a generated look the rings are scaled into the art, the way the live
  // holds are, and need no homography at all.
  it('draws the ring on a generated look by its scale', () => {
    registry.wall = { holds: [] };
    registry.art = { scale: 0.5, holds: [] };
    lostHoldsQuery.state = { status: 'ready', lostHolds: [{ id: 2, cx: 100, cy: 100, r: 10, outline: null }] };
    expect(setup().result.current.ghosts).toEqual([expect.objectContaining({ id: 2, cx: 50, cy: 50, r: 5 })]);
  });

  it('draws nothing on a wall registered without a homography', () => {
    registry.wall = { holds: [] };
    expect(setup().result.current.ghosts).toEqual([]);
  });

  it('skips a hold the server lists that this climb never used', () => {
    lostHoldsQuery.state = {
      status: 'ready',
      lostHolds: [
        { id: 2, cx: 100, cy: 100, r: 10, outline: null },
        { id: 99, cx: 5, cy: 5, r: 5, outline: null },
      ],
    };
    expect(setup().result.current.ghosts.map((ghost) => ghost.id)).toEqual([2]);
  });
});
