import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { LitUpHoldsMap } from '@boardsesh/shared-schema';
import {
  applyHoldPlacements,
  buildLostHoldGhosts,
  findLostHoldIds,
  isGhostCovered,
  lostHoldPlacements,
  rankReplacementCandidates,
  FALLBACK_REPLACEMENT_CANDIDATES,
} from '../lost-holds';
import { useCreateClimb } from '../use-create-climb';

const START = { state: 'STARTING' as const, color: '#00FF00', displayColor: '#00DD00' };
const HAND = { state: 'HAND' as const, color: '#00FFFF', displayColor: '#00FFFF' };
const FINISH = { state: 'FINISH' as const, color: '#FF00FF', displayColor: '#FF00FF' };

describe('lostHoldPlacements', () => {
  it('lists every frame the hold is in with its role there', () => {
    const frames: LitUpHoldsMap[] = [{ 7: START, 8: HAND }, { 8: HAND }, { 7: FINISH }];
    expect(lostHoldPlacements(frames, 7)).toEqual([
      { frameIndex: 0, state: 'STARTING' },
      { frameIndex: 2, state: 'FINISH' },
    ]);
    expect(lostHoldPlacements(frames, 99)).toEqual([]);
  });
});

describe('findLostHoldIds', () => {
  it('returns the climb holds the wall no longer has, sorted', () => {
    const frames: LitUpHoldsMap[] = [{ 30: HAND, 10: START, 20: FINISH }];
    expect(findLostHoldIds(frames, new Set([20]))).toEqual([10, 30]);
  });
});

describe('buildLostHoldGhosts', () => {
  const frames: LitUpHoldsMap[] = [{ 1: START, 2: HAND, 3: FINISH }];

  it('takes the role and colour from the frame the hold first appears in', () => {
    const ghosts = buildLostHoldGhosts({
      sourceFrames: frames,
      lostHolds: [{ id: 1, cx: 10, cy: 20, r: 5 }],
      liveHoldIds: new Set([2, 3]),
    });
    expect(ghosts).toEqual([
      {
        id: 1,
        cx: 10,
        cy: 20,
        r: 5,
        role: 'STARTING',
        color: '#00DD00',
        placements: [{ frameIndex: 0, state: 'STARTING' }],
      },
    ]);
  });

  it('skips a hold this device still has, and one the climb never used', () => {
    const ghosts = buildLostHoldGhosts({
      sourceFrames: frames,
      lostHolds: [
        { id: 2, cx: 0, cy: 0, r: 5 },
        { id: 50, cx: 0, cy: 0, r: 5 },
      ],
      liveHoldIds: new Set([2, 3]),
    });
    expect(ghosts).toEqual([]);
  });
});

describe('isGhostCovered', () => {
  const ghost = { id: 1, cx: 100, cy: 100, r: 10 };

  it('is covered by a painted hold whose centre is inside the larger radius', () => {
    expect(isGhostCovered(ghost, [{ id: 9, cx: 108, cy: 100, r: 4 }])).toBe(true);
    expect(isGhostCovered(ghost, [{ id: 9, cx: 114, cy: 100, r: 15 }])).toBe(true);
  });

  it('is not covered by a neighbour', () => {
    expect(isGhostCovered(ghost, [{ id: 9, cx: 130, cy: 100, r: 10 }])).toBe(false);
  });
});

describe('rankReplacementCandidates', () => {
  const ghost = { id: 1, cx: 0, cy: 0, r: 10 };

  it('puts the successor first, then the nearest free holds inside the radius', () => {
    const candidates = rankReplacementCandidates({
      ghost,
      liveHolds: [
        { id: 2, cx: 30, cy: 0, r: 10 },
        { id: 3, cx: 60, cy: 0, r: 10, movedFromHoldId: 1 },
        { id: 4, cx: 20, cy: 0, r: 10 },
        { id: 5, cx: 500, cy: 0, r: 10 },
      ],
      paintedHoldIds: new Set(),
    });
    expect(candidates.map((candidate) => candidate.holdId)).toEqual([3, 4, 2]);
    expect(candidates[0].isSuccessor).toBe(true);
  });

  it('treats a server-suggested hold as a successor', () => {
    const candidates = rankReplacementCandidates({
      ghost,
      liveHolds: [
        { id: 2, cx: 20, cy: 0, r: 10 },
        { id: 3, cx: 40, cy: 0, r: 10 },
      ],
      paintedHoldIds: new Set(),
      suggestedHoldIds: [3],
    });
    expect(candidates.map((candidate) => candidate.holdId)).toEqual([3, 2]);
  });

  it('never offers a hold already in the climb', () => {
    const candidates = rankReplacementCandidates({
      ghost,
      liveHolds: [
        { id: 2, cx: 20, cy: 0, r: 10, movedFromHoldId: 1 },
        { id: 3, cx: 25, cy: 0, r: 10 },
      ],
      paintedHoldIds: new Set([2]),
    });
    expect(candidates.map((candidate) => candidate.holdId)).toEqual([3]);
  });

  it('falls back to the closest few when nothing is nearby', () => {
    const liveHolds = [500, 600, 700, 800].map((cx, index) => ({ id: index + 2, cx, cy: 0, r: 10 }));
    const candidates = rankReplacementCandidates({ ghost, liveHolds, paintedHoldIds: new Set() });
    expect(candidates).toHaveLength(FALLBACK_REPLACEMENT_CANDIDATES);
    expect(candidates[0].holdId).toBe(2);
  });

  it('caps the list', () => {
    const liveHolds = Array.from({ length: 10 }, (_, index) => ({ id: index + 2, cx: index + 1, cy: 0, r: 10 }));
    expect(rankReplacementCandidates({ ghost, liveHolds, paintedHoldIds: new Set(), limit: 4 })).toHaveLength(4);
  });
});

describe('applyHoldPlacements', () => {
  it('paints the hold into every listed frame with that frame role', () => {
    const frames: LitUpHoldsMap[] = [{ 2: HAND }, { 2: HAND }];
    const next = applyHoldPlacements(frames, 'spray', 9, [
      { frameIndex: 0, state: 'STARTING' },
      { frameIndex: 1, state: 'HAND' },
    ]);
    expect(next[0][9]?.state).toBe('STARTING');
    expect(next[1][9]?.state).toBe('HAND');
    expect(frames[0][9]).toBeUndefined();
  });

  it('returns the same frames when the role is full or the frame is gone', () => {
    const frames: LitUpHoldsMap[] = [{ 2: START, 3: START }];
    expect(applyHoldPlacements(frames, 'spray', 9, [{ frameIndex: 0, state: 'STARTING' }])).toBe(frames);
    expect(applyHoldPlacements(frames, 'spray', 9, [{ frameIndex: 4, state: 'HAND' }])).toBe(frames);
  });
});

describe('useCreateClimb placeHold', () => {
  it('places the hold across frames as one undoable step', () => {
    const initialFrames: LitUpHoldsMap[] = [{ 2: HAND }, { 2: HAND }];
    const { result } = renderHook(() => useCreateClimb('spray', { initialFrames }));
    let placed = false;
    act(() => {
      placed = result.current.placeHold(9, [
        { frameIndex: 0, state: 'STARTING' },
        { frameIndex: 1, state: 'HAND' },
      ]);
    });
    expect(placed).toBe(true);
    expect(result.current.frames[0][9]?.state).toBe('STARTING');
    expect(result.current.frames[1][9]?.state).toBe('HAND');
    act(() => result.current.undo());
    expect(result.current.frames[0][9]).toBeUndefined();
    expect(result.current.frames[1][9]).toBeUndefined();
  });

  it('reports a refused placement and records no history', () => {
    const { result } = renderHook(() => useCreateClimb('spray', { initialFrames: [{ 2: START, 3: START }] }));
    let placed = true;
    act(() => {
      placed = result.current.placeHold(9, [{ frameIndex: 0, state: 'STARTING' }]);
    });
    expect(placed).toBe(false);
    expect(result.current.canUndo).toBe(false);
  });
});
