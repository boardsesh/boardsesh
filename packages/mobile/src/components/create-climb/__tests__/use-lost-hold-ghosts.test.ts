// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { LitUpHoldsMap } from '@boardsesh/shared-schema';
import type { ClimbLostHoldsState } from '../../../lib/graphql/hooks/use-climb-lost-holds';

/**
 * The create editor's lost-hold layer (#5493): which ghosts it draws, the swap,
 * and how a ghost leaves once something stands in for it.
 */

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

const lostHoldsQuery = vi.hoisted(() => ({
  state: { status: 'idle' } as ClimbLostHoldsState,
  variables: [] as unknown[],
}));
const registry = vi.hoisted(() => ({
  wall: null as null | {
    homography?: number[];
    holds: { id: number; cx: number; cy: number; r: number; movedFromHoldId?: number }[];
  },
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
}));
vi.mock('../../../lib/haptics', () => ({
  hapticSelection: () => {},
  hapticSuccess: () => {},
  hapticWarning: () => {},
}));

const { useLostHoldGhosts } = await import('../use-lost-hold-ghosts');

const BOARD = { boardName: 'spray' as const, layoutId: 7, sizeId: 1, setIds: '1', angle: 40 };
// Hold 1 start, hold 2 hand, hold 3 finish. Hold 2 came off the wall.
const SOURCE_FRAMES = 'p1r1p2r2p3r3';
const AVAILABLE = new Set([1, 3, 10, 11, 12]);
const START = { state: 'STARTING' as const, color: '#00FF00', displayColor: '#00DD00' };
const FINISH = { state: 'FINISH' as const, color: '#FF0000', displayColor: '#FF0000' };
const HAND = { state: 'HAND' as const, color: '#0000FF', displayColor: '#4444FF' };
const PAINTED: LitUpHoldsMap[] = [{ 1: START, 3: FINISH }];

function setup(frames: LitUpHoldsMap[] = PAINTED, placed = true) {
  const placeLostHoldReplacement = vi.fn(() => placed);
  const hook = renderHook(
    ({ currentFrames }: { currentFrames: LitUpHoldsMap[] }) =>
      useLostHoldGhosts({
        board: BOARD,
        sourceClimbUuid: 'climb-1',
        sourceFrames: SOURCE_FRAMES,
        availableHoldIds: AVAILABLE,
        frames: currentFrames,
        sprayWallToken: 'token',
        placeLostHoldReplacement,
      }),
    { initialProps: { currentFrames: frames } },
  );
  return { ...hook, placeLostHoldReplacement };
}

describe('useLostHoldGhosts', () => {
  beforeEach(() => {
    lostHoldsQuery.variables.length = 0;
    lostHoldsQuery.state = {
      status: 'ready',
      lostHolds: [{ id: 2, cx: 100, cy: 100, r: 10, outline: null, movedFromHoldId: null, removedVersion: 2 }],
    };
    registry.wall = {
      homography: IDENTITY,
      holds: [
        { id: 1, cx: 0, cy: 0, r: 10 },
        { id: 3, cx: 400, cy: 400, r: 10 },
        { id: 10, cx: 130, cy: 100, r: 10 },
        { id: 11, cx: 160, cy: 100, r: 10, movedFromHoldId: 2 },
        { id: 12, cx: 900, cy: 900, r: 10 },
      ],
    };
  });

  it('draws a ghost where the lost hold was, in its old role', () => {
    const { result } = setup();
    expect(result.current.status).toBe('ready');
    expect(result.current.count).toBe(1);
    expect(result.current.ghosts).toEqual([expect.objectContaining({ id: 2, cx: 100, cy: 100, r: 10, role: 'HAND' })]);
    expect(result.current.ghostTargets).toEqual([{ id: 2, cx: 100, cy: 100, r: 10 }]);
    expect(lostHoldsQuery.variables.at(-1)).toEqual(expect.objectContaining({ climbUuid: 'climb-1', layoutId: 7 }));
  });

  it('offers the successor first, then nearby holds', () => {
    const { result } = setup();
    act(() => result.current.openGhost(2));
    expect(result.current.sheetGhost?.id).toBe(2);
    expect(result.current.sheetCandidates.map((candidate) => candidate.holdId)).toEqual([11, 10]);
  });

  it('swaps a picked hold in with the lost hold placements, and only a highlighted one', () => {
    const { result, placeLostHoldReplacement } = setup();
    act(() => result.current.openGhost(2));
    act(() => result.current.startReplacing());
    expect(result.current.sheetGhost).toBeNull();
    expect(result.current.replacing?.candidateHolds.map((hold) => hold.id)).toEqual([11, 10]);

    // A tap off the highlights is swallowed, never painted.
    let consumed = false;
    act(() => {
      consumed = result.current.interceptPaint(12);
    });
    expect(consumed).toBe(true);
    expect(placeLostHoldReplacement).not.toHaveBeenCalled();

    act(() => {
      consumed = result.current.interceptPaint(10);
    });
    expect(consumed).toBe(true);
    expect(placeLostHoldReplacement).toHaveBeenCalledWith(10, [{ frameIndex: 0, state: 'HAND' }]);
    expect(result.current.replacing).toBeNull();
  });

  it('drops the ghost once its replacement is painted, and brings it back on undo', () => {
    const { result, rerender } = setup();
    act(() => result.current.openGhost(2));
    act(() => result.current.startReplacing());
    act(() => {
      result.current.interceptPaint(10);
    });
    rerender({ currentFrames: [{ ...PAINTED[0], 10: HAND }] });
    expect(result.current.ghosts).toEqual([]);
    expect(result.current.count).toBe(0);
    rerender({ currentFrames: PAINTED });
    expect(result.current.ghosts.map((ghost) => ghost.id)).toEqual([2]);
  });

  it('treats a hold painted on the spot as an answer (a restored autosave)', () => {
    registry.wall?.holds.push({ id: 13, cx: 104, cy: 100, r: 10 });
    const { result } = setup([{ ...PAINTED[0], 13: HAND }]);
    expect(result.current.ghosts).toEqual([]);
  });

  it('says the role is full instead of doing nothing', () => {
    const { result } = setup(PAINTED, false);
    act(() => result.current.openGhost(2));
    act(() => result.current.startReplacing());
    act(() => {
      result.current.interceptPaint(10);
    });
    expect(result.current.roleFull).toBe(true);
    expect(result.current.replacing).not.toBeNull();
  });

  it('keeps the count with no signal', () => {
    lostHoldsQuery.state = { status: 'unavailable' };
    const { result } = setup();
    expect(result.current.status).toBe('unavailable');
    expect(result.current.count).toBe(1);
    expect(result.current.ghosts).toEqual([]);
  });

  it('asks for nothing when the climb lost nothing', () => {
    const { result } = renderHook(() =>
      useLostHoldGhosts({
        board: BOARD,
        sourceClimbUuid: 'climb-1',
        sourceFrames: 'p1r1p3r3',
        availableHoldIds: AVAILABLE,
        frames: PAINTED,
        sprayWallToken: 'token',
        placeLostHoldReplacement: vi.fn(),
      }),
    );
    expect(result.current.status).toBe('none');
    expect(lostHoldsQuery.variables.at(-1)).toBeNull();
  });

  it('forgets an open sheet whose ghost was answered, so an undo does not reopen it', () => {
    registry.wall?.holds.push({ id: 13, cx: 102, cy: 100, r: 10 });
    const { result, rerender } = setup();
    act(() => result.current.openGhost(2));
    expect(result.current.sheetGhost?.id).toBe(2);
    rerender({ currentFrames: [{ ...PAINTED[0], 13: HAND }] });
    expect(result.current.sheetGhost).toBeNull();
    rerender({ currentFrames: PAINTED });
    expect(result.current.ghosts.map((ghost) => ghost.id)).toEqual([2]);
    expect(result.current.sheetGhost).toBeNull();
  });

  it('states only the count when there is no climb to ask about', () => {
    lostHoldsQuery.state = { status: 'idle' };
    const { result } = setup();
    expect(result.current.status).toBe('countOnly');
    expect(result.current.count).toBe(1);
  });

  it('says the positions cannot be shown when the server answered with nothing usable', () => {
    lostHoldsQuery.state = { status: 'ready', lostHolds: [] };
    const { result } = setup();
    expect(result.current.status).toBe('noPositions');
    expect(result.current.count).toBe(1);
  });

  it('keeps the same ghosts array across a paint that leaves them standing', () => {
    const { result, rerender } = setup();
    const ghostsBefore = result.current.ghosts;
    const targetsBefore = result.current.ghostTargets;
    rerender({ currentFrames: [{ ...PAINTED[0], 12: HAND }] });
    expect(result.current.ghosts).toBe(ghostsBefore);
    expect(result.current.ghostTargets).toBe(targetsBefore);
  });

  it('passes taps through outside a pick', () => {
    const { result } = setup();
    expect(result.current.interceptPaint(10)).toBe(false);
  });
});
