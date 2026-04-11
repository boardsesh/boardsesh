import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDefaultBoardSelection } from './use-default-board-selection';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { BoardDetails } from '@/app/lib/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createBoard(overrides?: Partial<UserBoard>): UserBoard {
  return {
    uuid: 'board-1',
    slug: 'my-kilter',
    ownerId: 'user-1',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,2',
    name: 'My Kilter',
    isPublic: true,
    isUnlisted: false,
    hideLocation: false,
    isOwned: true,
    angle: 40,
    isAngleAdjustable: true,
    createdAt: '2024-01-01T00:00:00Z',
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
    ...overrides,
  } as UserBoard;
}

function createBoardDetails(overrides?: Partial<BoardDetails>): BoardDetails {
  return {
    board_name: 'kilter',
    layout_id: 1,
    size_id: 10,
    set_ids: '1,2',
    images_to_holds: {},
    holdsData: {},
    edge_left: 0,
    edge_right: 100,
    edge_bottom: 0,
    edge_top: 100,
    boardHeight: 100,
    boardWidth: 100,
    layout_name: 'Original',
    size_name: '12x12',
    size_description: 'Full Size',
    set_names: ['Standard', 'Extended'],
    ...overrides,
  } as BoardDetails;
}

const boardA = createBoard({ uuid: 'a', slug: 'kilter-a', boardType: 'kilter', layoutId: 1, sizeId: 10 });
const boardB = createBoard({ uuid: 'b', slug: 'tension-b', boardType: 'tension', layoutId: 2, sizeId: 20 });
const allBoards = [boardA, boardB];

type HookParams = Parameters<typeof useDefaultBoardSelection>[0];

function defaultParams(overrides?: Partial<HookParams>): HookParams {
  return {
    initialBoard: null,
    myBoards: [],
    boardsLoading: false,
    boardSlug: undefined,
    boardConfig: undefined,
    currentBoardDetails: null,
    isQueueHydrated: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useDefaultBoardSelection', () => {
  it('starts as null when no initial board or matching route context', () => {
    const { result } = renderHook(() => useDefaultBoardSelection(defaultParams()));
    expect(result.current[0]).toBeNull();
  });

  it('applies initialBoard immediately without waiting for effects', () => {
    const { result } = renderHook(() =>
      useDefaultBoardSelection(defaultParams({ initialBoard: boardA })),
    );
    expect(result.current[0]).toBe(boardA);
  });

  it('does not override initialBoard when boards subsequently load', () => {
    const { result, rerender } = renderHook((p: HookParams) => useDefaultBoardSelection(p), {
      initialProps: defaultParams({ initialBoard: boardA, myBoards: [] }),
    });
    expect(result.current[0]).toBe(boardA);

    rerender(defaultParams({ initialBoard: boardA, myBoards: allBoards, isQueueHydrated: true }));
    expect(result.current[0]).toBe(boardA);
  });

  it('does not select while boards are still loading', () => {
    const { result } = renderHook(() =>
      useDefaultBoardSelection(defaultParams({ myBoards: allBoards, boardsLoading: true, boardSlug: 'kilter-a' })),
    );
    expect(result.current[0]).toBeNull();
  });

  it('does not select when myBoards is empty', () => {
    const { result } = renderHook(() =>
      useDefaultBoardSelection(defaultParams({ myBoards: [], boardsLoading: false, boardSlug: 'kilter-a' })),
    );
    expect(result.current[0]).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Route-provided context (boardSlug / boardConfig)
  // -------------------------------------------------------------------------

  describe('route-provided boardSlug/boardConfig', () => {
    it('selects board matching slug once myBoards loads', () => {
      const { result } = renderHook(() =>
        useDefaultBoardSelection(defaultParams({ myBoards: allBoards, boardSlug: 'kilter-a' })),
      );
      expect(result.current[0]).toBe(boardA);
    });

    it('selects board matching config once myBoards loads', () => {
      const { result } = renderHook(() =>
        useDefaultBoardSelection(
          defaultParams({ myBoards: allBoards, boardConfig: { boardType: 'tension', layoutId: 2, sizeId: 20 } }),
        ),
      );
      expect(result.current[0]).toBe(boardB);
    });

    it('does not wait for isQueueHydrated when boardSlug is provided', () => {
      // isQueueHydrated=false should not block slug-based selection
      const { result } = renderHook(() =>
        useDefaultBoardSelection(
          defaultParams({ myBoards: allBoards, boardSlug: 'kilter-a', isQueueHydrated: false }),
        ),
      );
      expect(result.current[0]).toBe(boardA);
    });

    it('stays null when slug has no match', () => {
      const { result } = renderHook(() =>
        useDefaultBoardSelection(defaultParams({ myBoards: allBoards, boardSlug: 'nonexistent' })),
      );
      expect(result.current[0]).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Queue-based fallback (isQueueHydrated guard)
  // -------------------------------------------------------------------------

  describe('queue-based fallback', () => {
    it('waits for isQueueHydrated before committing when no route context', () => {
      const { result } = renderHook(() =>
        useDefaultBoardSelection(
          defaultParams({ myBoards: allBoards, currentBoardDetails: createBoardDetails(), isQueueHydrated: false }),
        ),
      );
      // Should stay null — hydration not complete yet
      expect(result.current[0]).toBeNull();
    });

    it('selects matching board once queue hydrates and board details are present', () => {
      const details = createBoardDetails({ board_name: 'kilter', layout_id: 1, size_id: 10 });

      const { result, rerender } = renderHook((p: HookParams) => useDefaultBoardSelection(p), {
        initialProps: defaultParams({ myBoards: allBoards, currentBoardDetails: details, isQueueHydrated: false }),
      });

      expect(result.current[0]).toBeNull();

      rerender(defaultParams({ myBoards: allBoards, currentBoardDetails: details, isQueueHydrated: true }));

      expect(result.current[0]).toBe(boardA);
    });

    it('commits with null (All Boards) when queue hydrates but no board details', () => {
      const { result, rerender } = renderHook((p: HookParams) => useDefaultBoardSelection(p), {
        initialProps: defaultParams({ myBoards: allBoards, currentBoardDetails: null, isQueueHydrated: false }),
      });

      expect(result.current[0]).toBeNull();

      rerender(defaultParams({ myBoards: allBoards, currentBoardDetails: null, isQueueHydrated: true }));

      // No match found — null is correct ("All Boards")
      expect(result.current[0]).toBeNull();
    });

    it('stays null (All Boards) after committing when no match is found, even if boards change', () => {
      const { result, rerender } = renderHook((p: HookParams) => useDefaultBoardSelection(p), {
        initialProps: defaultParams({ myBoards: allBoards, currentBoardDetails: null, isQueueHydrated: true }),
      });

      expect(result.current[0]).toBeNull();

      // Re-render with fresh boards array reference (simulates SWR refresh)
      rerender(defaultParams({ myBoards: [...allBoards], currentBoardDetails: null, isQueueHydrated: true }));

      expect(result.current[0]).toBeNull();
    });

    it('does not re-apply selection after the user manually changes it', () => {
      const details = createBoardDetails({ board_name: 'kilter', layout_id: 1, size_id: 10 });

      const { result, rerender } = renderHook((p: HookParams) => useDefaultBoardSelection(p), {
        initialProps: defaultParams({ myBoards: allBoards, currentBoardDetails: details, isQueueHydrated: true }),
      });

      // Initial auto-selection picks boardA
      expect(result.current[0]).toBe(boardA);

      // User picks boardB
      act(() => {
        result.current[1](boardB);
      });

      expect(result.current[0]).toBe(boardB);

      // SWR refresh — should not revert user's choice
      rerender(defaultParams({ myBoards: [...allBoards], currentBoardDetails: details, isQueueHydrated: true }));

      expect(result.current[0]).toBe(boardB);
    });
  });
});
