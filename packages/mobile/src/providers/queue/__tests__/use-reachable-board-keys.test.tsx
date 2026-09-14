// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { UserBoard } from '@boardsesh/shared-schema';

const gymBoards = vi.hoisted(() => ({ data: undefined as UserBoard[] | undefined }));
vi.mock('../../../lib/graphql/hooks/use-gym-boards', () => ({ useGymBoards: () => gymBoards }));

import { useReachableBoardKeys } from '../use-reachable-board-keys';

function board(overrides: Partial<UserBoard>): UserBoard {
  return {
    uuid: 'board-1',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    gymUuid: 'gym-1',
    ...overrides,
  } as unknown as UserBoard;
}

const ACTIVE = board({ uuid: 'active' });

describe('useReachableBoardKeys', () => {
  beforeEach(() => {
    gymBoards.data = undefined;
  });

  it('is empty with no board bound', () => {
    const { result } = renderHook(() => useReachableBoardKeys(null));
    expect(result.current.size).toBe(0);
  });

  it('is empty when the gym has only the board you are on', () => {
    gymBoards.data = [ACTIVE];
    const { result } = renderHook(() => useReachableBoardKeys(ACTIVE));
    expect(result.current.size).toBe(0);
  });

  it('holds the model of another board at the gym', () => {
    gymBoards.data = [ACTIVE, board({ uuid: 'tension', boardType: 'tension', layoutId: 8 })];
    const { result } = renderHook(() => useReachableBoardKeys(ACTIVE));
    expect([...result.current]).toEqual(['tension:8']);
  });

  // The most common multi-board gym there is: two Kilters of different sizes on
  // the same layout. configKey has no size, so both walls produce one key — and
  // dropping it for matching the active board sent exactly those climbs back to
  // being skipped behind a blocking scrim.
  it('keeps a sibling that shares the active board model but not its size', () => {
    gymBoards.data = [ACTIVE, board({ uuid: 'bigger', sizeId: 14 })];
    const { result } = renderHook(() => useReachableBoardKeys(ACTIVE));
    expect(result.current.has('kilter:1')).toBe(true);
  });

  it('never counts the board you are on as somewhere to walk to', () => {
    gymBoards.data = [ACTIVE];
    const { result } = renderHook(() => useReachableBoardKeys(ACTIVE));
    expect(result.current.has('kilter:1')).toBe(false);
  });

  it('keeps one identity while the roster is unchanged', () => {
    gymBoards.data = [ACTIVE, board({ uuid: 'tension', boardType: 'tension', layoutId: 8 })];
    const { result, rerender } = renderHook(() => useReachableBoardKeys(ACTIVE));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
