import {
  getBoardImageDetailsForBoard,
  getBoardImageDetailsForPlaylist,
  toBoardImageDetails,
} from '@/app/lib/board-image-details';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook } from '@testing-library/react';
import { useBoardDetailsMap } from '../use-board-details-map';
import { resolveBoardDetailsForClimb } from '@/app/lib/board-config-for-playlist';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { Climb, BoardDetails } from '@/app/lib/types';

// Mock dependencies
vi.mock('@/app/lib/board-config-for-playlist', () => ({
  resolveBoardDetailsForClimb: vi.fn(),
}));

vi.mock('@/app/lib/board-image-details', async () => ({
  ...(await vi.importActual<typeof import('@/app/lib/board-image-details')>('@/app/lib/board-image-details')),
  getBoardImageDetailsForBoard: vi.fn(),
  getBoardImageDetailsForPlaylist: vi.fn(),
}));

const mockGetUserBoardDetails = vi.mocked(getBoardImageDetailsForBoard);
const mockGetBoardDetailsForPlaylist = vi.mocked(getBoardImageDetailsForPlaylist);
const mockResolveBoardDetailsForClimb = vi.mocked(resolveBoardDetailsForClimb);

function makeClimb(overrides: Partial<Climb> = {}): Climb {
  return {
    uuid: 'climb-1',
    name: 'Test Climb',
    frames: '',
    angle: 40,
    difficulty: 'V5',
    quality_average: '3',
    setter_username: 'setter1',
    description: '',
    ascensionist_count: 0,
    stars: 3,
    difficulty_error: '0',
    benchmark_difficulty: null,
    boardType: 'kilter',
    layoutId: 1,
    ...overrides,
  };
}

function makeUserBoard(overrides: Partial<UserBoard> = {}): UserBoard {
  return {
    uuid: 'board-1',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,2,3',
    angle: 40,
    ...overrides,
  } as UserBoard;
}

function makeBoardDetails(name: string): BoardDetails {
  return {
    board_name: name,
    layout_id: 1,
    size_id: 10,
    set_ids: [1, 2, 3],
    boardWidth: 100,
    boardHeight: 150,
    holdsData: [],
    images_to_holds: {},
    litUpHoldsGroupSets: [],
    edgeLeft: 0,
    edgeRight: 100,
    edgeBottom: 0,
    edgeTop: 150,
  } as unknown as BoardDetails;
}

describe('useBoardDetailsMap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return empty map when no climbs provided', () => {
    const { result } = renderHook(() => useBoardDetailsMap([], []));

    expect(Object.keys(result.current.boardDetailsByClimb)).toHaveLength(0);
    expect(result.current.unsupportedClimbs.size).toBe(0);
    expect(result.current.upsizedClimbs.size).toBe(0);
  });

  it('should key boardDetailsByClimb by climb uuid', () => {
    const climb = makeClimb({ uuid: 'c1', boardType: 'kilter', layoutId: 1 });
    const details = makeBoardDetails('kilter');
    mockGetBoardDetailsForPlaylist.mockReturnValue(toBoardImageDetails(details));

    const { result } = renderHook(() => useBoardDetailsMap([climb], []));
    expect(mockResolveBoardDetailsForClimb).not.toHaveBeenCalled();

    expect(result.current.boardDetailsByClimb['c1']).toEqual(toBoardImageDetails(details));
  });

  it('should populate upsizedClimbs for climbs that only fit on a bigger size', () => {
    const climb = makeClimb({ uuid: 'c1', boardType: 'kilter', layoutId: 1 });
    const userBoard = makeUserBoard({ boardType: 'kilter' });
    const details = makeBoardDetails('kilter-bigger');
    mockResolveBoardDetailsForClimb.mockReturnValue({ details, status: 'upsized' });

    const { result } = renderHook(() => useBoardDetailsMap([climb], [userBoard], userBoard));

    expect(result.current.upsizedClimbs.has('c1')).toBe(true);
    expect(result.current.unsupportedClimbs.has('c1')).toBe(false);
    expect(result.current.boardDetailsByClimb['c1']).toEqual(toBoardImageDetails(details));
  });

  it('should mark climbs as unsupported when the resolver reports incompatible', () => {
    const climb = makeClimb({ uuid: 'c1', boardType: 'kilter', layoutId: 1 });
    const userBoard = makeUserBoard({ boardType: 'kilter' });
    const details = makeBoardDetails('fallback');
    mockResolveBoardDetailsForClimb.mockReturnValue({ details, status: 'incompatible' });

    const { result } = renderHook(() => useBoardDetailsMap([climb], [userBoard], userBoard));

    expect(result.current.unsupportedClimbs.has('c1')).toBe(true);
    expect(result.current.boardDetailsByClimb['c1']).toEqual(toBoardImageDetails(details));
  });

  it('should mark climbs unsupported when the user owns none of that board type', () => {
    const climb = makeClimb({ uuid: 'c1', boardType: 'tension', layoutId: 2 });
    const kilterBoard = makeUserBoard({ boardType: 'kilter' });
    const details = makeBoardDetails('tension');
    mockResolveBoardDetailsForClimb.mockReturnValue({ details, status: 'exact' });

    const { result } = renderHook(() => useBoardDetailsMap([climb], [kilterBoard]));

    expect(result.current.unsupportedClimbs.has('c1')).toBe(true);
  });

  it('should not mark any climbs as unsupported when the user owns zero boards', () => {
    // Users without any registered boards shouldn't see climbs greyed out —
    // selection auto-activates the climb's own board config downstream.
    const climb1 = makeClimb({ uuid: 'c1', boardType: 'kilter', layoutId: 1 });
    const climb2 = makeClimb({ uuid: 'c2', boardType: 'tension', layoutId: 2 });
    mockResolveBoardDetailsForClimb.mockReturnValue({
      details: makeBoardDetails('kilter'),
      status: 'exact',
    });

    const { result } = renderHook(() => useBoardDetailsMap([climb1, climb2], []));

    expect(result.current.unsupportedClimbs.size).toBe(0);
  });

  it('should return defaultBoardDetails from selectedBoard when provided', () => {
    const selectedBoard = makeUserBoard({ boardType: 'kilter', layoutId: 1 });
    const selectedDetails = makeBoardDetails('kilter-selected');
    mockGetUserBoardDetails.mockReturnValue(toBoardImageDetails(selectedDetails));

    const { result } = renderHook(() => useBoardDetailsMap([], [], selectedBoard));

    expect(result.current.defaultBoardDetails).toEqual(toBoardImageDetails(selectedDetails));
  });

  it('should return defaultBoardDetails from first myBoard as fallback', () => {
    const myBoard = makeUserBoard({ boardType: 'kilter', layoutId: 1 });
    const myBoardDetails = makeBoardDetails('kilter-mine');
    mockGetUserBoardDetails.mockReturnValue(toBoardImageDetails(myBoardDetails));

    const { result } = renderHook(() => useBoardDetailsMap([], [myBoard]));

    expect(result.current.defaultBoardDetails).toEqual(toBoardImageDetails(myBoardDetails));
  });

  it('should use fallbackBoardTypes for default details when no boards available', () => {
    const genericDetails = makeBoardDetails('tension');
    mockGetBoardDetailsForPlaylist.mockReturnValue(toBoardImageDetails(genericDetails));

    const { result } = renderHook(() => useBoardDetailsMap([], [], null, null, ['tension']));

    expect(result.current.defaultBoardDetails).toEqual(toBoardImageDetails(genericDetails));
    expect(mockGetBoardDetailsForPlaylist).toHaveBeenCalledWith('tension', null);
  });

  it('should handle multiple climbs from different board types', () => {
    const climb1 = makeClimb({ uuid: 'c1', boardType: 'kilter', layoutId: 1 });
    const climb2 = makeClimb({ uuid: 'c2', boardType: 'tension', layoutId: 2 });
    const kilterDetails = makeBoardDetails('kilter');
    const tensionDetails = makeBoardDetails('tension');

    mockGetBoardDetailsForPlaylist.mockImplementation((boardType) =>
      toBoardImageDetails(boardType === 'kilter' ? kilterDetails : tensionDetails),
    );

    const { result } = renderHook(() => useBoardDetailsMap([climb1, climb2], []));

    expect(result.current.boardDetailsByClimb['c1']).toEqual(toBoardImageDetails(kilterDetails));
    expect(result.current.boardDetailsByClimb['c2']).toEqual(toBoardImageDetails(tensionDetails));
  });

  it('should skip climbs when the resolver returns null', () => {
    const climb1 = makeClimb({ uuid: 'c1', boardType: undefined, layoutId: 1 });
    mockGetBoardDetailsForPlaylist.mockReturnValue(null);

    const { result } = renderHook(() => useBoardDetailsMap([climb1], []));

    expect(Object.keys(result.current.boardDetailsByClimb)).toHaveLength(0);
  });

  it('should synthesize session config from selectedBoard when no sessionBoard provided', () => {
    const climb = makeClimb({ uuid: 'c1', boardType: 'kilter', layoutId: 1 });
    const selectedBoard = makeUserBoard({
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      // Includes an invalid entry and a zero to exercise the numeric filter.
      setIds: '1,2,abc,0',
    });
    const details = makeBoardDetails('kilter-selected');
    mockGetUserBoardDetails.mockReturnValue(toBoardImageDetails(details));
    mockResolveBoardDetailsForClimb.mockReturnValue({ details, status: 'exact' });

    renderHook(() => useBoardDetailsMap([climb], [selectedBoard], selectedBoard));

    // The resolver should be invoked with the synthesized session config —
    // boardType/layoutId/sizeId from the selected board and numeric set IDs
    // parsed from its comma-separated setIds string.
    expect(mockResolveBoardDetailsForClimb).toHaveBeenCalledWith(climb, {
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: [1, 2],
    });
  });

  it('should synthesize an empty setIds array when selectedBoard.setIds is empty', () => {
    const climb = makeClimb({ uuid: 'c1', boardType: 'kilter', layoutId: 1 });
    const selectedBoard = makeUserBoard({
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '',
    });
    const details = makeBoardDetails('kilter-selected');
    mockResolveBoardDetailsForClimb.mockReturnValue({ details, status: 'exact' });

    renderHook(() => useBoardDetailsMap([climb], [selectedBoard], selectedBoard));

    expect(mockResolveBoardDetailsForClimb).toHaveBeenCalledWith(climb, {
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: [],
    });
  });

  it('should prefer sessionBoard over selectedBoard when both are provided', () => {
    const climb = makeClimb({ uuid: 'c1', boardType: 'kilter', layoutId: 1 });
    const selectedBoard = makeUserBoard({
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
    });
    const sessionBoard = {
      boardType: 'kilter' as const,
      layoutId: 1,
      sizeId: 27,
      setIds: [1, 20],
    };
    const details = makeBoardDetails('kilter');
    mockResolveBoardDetailsForClimb.mockReturnValue({ details, status: 'exact' });

    renderHook(() => useBoardDetailsMap([climb], [selectedBoard], selectedBoard, sessionBoard));

    expect(mockResolveBoardDetailsForClimb).toHaveBeenCalledWith(climb, sessionBoard);
  });
});
