import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { resolveBoardDetailsForClimb, type SessionBoardConfig } from '../board-config-for-playlist';
import { getBoardDetails, getSizesForLayoutId, getSetsForLayoutAndSize } from '@/app/lib/board-constants';
import { getMoonBoardDetails } from '@/app/lib/moonboard-config';
import { canAddClimbToBoard } from '@/app/lib/board-compatibility';
import type { Climb, BoardDetails } from '@/app/lib/types';

vi.mock('@/app/lib/board-constants', () => ({
  getBoardDetails: vi.fn(),
  getSizesForLayoutId: vi.fn(),
  getSetsForLayoutAndSize: vi.fn(),
  hasProductSizeEdges: vi.fn(() => true),
  LAYOUTS: { kilter: { 1: {} }, tension: { 2: {} } },
}));

vi.mock('@/app/lib/moonboard-config', () => ({
  getMoonBoardDetails: vi.fn(),
  MOONBOARD_LAYOUTS: { 'moonboard-2024': { id: 100 } },
  MOONBOARD_SETS: { 'moonboard-2024': [{ id: 1, name: 's1', imageFile: '' }] },
}));

vi.mock('@/app/lib/board-compatibility', () => ({
  canAddClimbToBoard: vi.fn(),
}));

const mockGetBoardDetails = vi.mocked(getBoardDetails);
const mockGetSizes = vi.mocked(getSizesForLayoutId);
const mockGetSets = vi.mocked(getSetsForLayoutAndSize);
const mockGetMoonBoardDetails = vi.mocked(getMoonBoardDetails);
const mockCanAdd = vi.mocked(canAddClimbToBoard);

function makeClimb(overrides: Partial<Climb> = {}): Climb {
  return {
    uuid: 'c1',
    name: 'Test Climb',
    frames: '',
    angle: 40,
    difficulty: 'V5',
    quality_average: '3',
    setter_username: 'setter',
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

/**
 * Build a BoardDetails stub. Edges default to a 100x100 box so callers
 * can adjust the area by overriding edge_right/edge_top.
 */
function makeDetails(overrides: Partial<BoardDetails> = {}): BoardDetails {
  return {
    board_name: 'kilter',
    layout_id: 1,
    size_id: 10,
    set_ids: [1, 2],
    edge_left: 0,
    edge_right: 100,
    edge_bottom: 0,
    edge_top: 100,
    holdsData: [],
    images_to_holds: {},
    boardHeight: 1000,
    boardWidth: 1000,
    ...overrides,
  } as unknown as BoardDetails;
}

/** Stub a `{ edgeLeft, edgeRight, edgeBottom, edgeTop }` size entry. */
function makeSize(id: number, width: number, height: number) {
  return {
    id,
    name: `size-${id}`,
    description: '',
    productId: 1,
    edgeLeft: 0,
    edgeRight: width,
    edgeBottom: 0,
    edgeTop: height,
  };
}

function makeSet(id: number) {
  return { id, name: `set-${id}`, imageFile: '' };
}

const KILTER_SESSION: SessionBoardConfig = {
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: [1, 2],
};

describe('resolveBoardDetailsForClimb', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('no session board', () => {
    it('returns the generic playlist details with exact status when one is available', () => {
      const playlistDetails = makeDetails({ size_id: 20 });
      // getBoardDetailsForPlaylist chain: sizes → sets → getBoardDetails.
      mockGetSizes.mockReturnValue([makeSize(20, 120, 100)]);
      mockGetSets.mockReturnValue([makeSet(1), makeSet(2)]);
      mockGetBoardDetails.mockReturnValue(playlistDetails);

      const climb = makeClimb({ boardType: 'kilter', layoutId: 1 });
      const result = resolveBoardDetailsForClimb(climb, null);

      expect(result).toEqual({ details: playlistDetails, status: 'exact' });
      expect(mockCanAdd).not.toHaveBeenCalled();
    });

    it('returns null when no generic details can be built', () => {
      mockGetSizes.mockReturnValue([]);

      const climb = makeClimb({ boardType: 'kilter', layoutId: 1 });
      const result = resolveBoardDetailsForClimb(climb, null);

      expect(result).toBeNull();
    });
  });

  describe('layout / board-type mismatches', () => {
    it('falls back to generic playlist details with incompatible status when the board types differ', () => {
      const playlistDetails = makeDetails({ board_name: 'tension' });
      mockGetSizes.mockReturnValue([makeSize(50, 140, 120)]);
      mockGetSets.mockReturnValue([makeSet(1)]);
      mockGetBoardDetails.mockReturnValue(playlistDetails);

      const climb = makeClimb({ boardType: 'tension', layoutId: 2 });
      const result = resolveBoardDetailsForClimb(climb, KILTER_SESSION);

      expect(result).toEqual({ details: playlistDetails, status: 'incompatible' });
      expect(mockCanAdd).not.toHaveBeenCalled();
    });

    it('marks incompatible when the layout differs but board type matches', () => {
      const playlistDetails = makeDetails({ layout_id: 2 });
      mockGetSizes.mockReturnValue([makeSize(30, 120, 120)]);
      mockGetSets.mockReturnValue([makeSet(1)]);
      mockGetBoardDetails.mockReturnValue(playlistDetails);

      const climb = makeClimb({ boardType: 'kilter', layoutId: 2 });
      const result = resolveBoardDetailsForClimb(climb, KILTER_SESSION);

      expect(result?.status).toBe('incompatible');
      expect(mockCanAdd).not.toHaveBeenCalled();
    });

    it('treats a climb without a boardType as incompatible', () => {
      const playlistDetails = makeDetails();
      mockGetSizes.mockReturnValue([makeSize(10, 100, 100)]);
      mockGetSets.mockReturnValue([makeSet(1)]);
      mockGetBoardDetails.mockReturnValue(playlistDetails);

      const climb = makeClimb({ boardType: undefined, layoutId: 1 });
      const result = resolveBoardDetailsForClimb(climb, KILTER_SESSION);

      expect(result?.status).toBe('incompatible');
    });
  });

  describe('session fit (same layout + board type)', () => {
    it('returns the session details with exact status when the climb fits', () => {
      const sessionDetails = makeDetails({ size_id: 10, edge_right: 100, edge_top: 100 });
      mockGetBoardDetails.mockReturnValue(sessionDetails);
      mockCanAdd.mockReturnValue({ ok: true });

      const climb = makeClimb();
      const result = resolveBoardDetailsForClimb(climb, KILTER_SESSION);

      expect(result).toEqual({ details: sessionDetails, status: 'exact' });
      expect(mockGetBoardDetails).toHaveBeenCalledWith({
        board_name: 'kilter',
        layout_id: 1,
        size_id: 10,
        set_ids: [1, 2],
      });
    });

    it('walks larger sizes and returns the smallest one that fits as upsized', () => {
      const sessionDetails = makeDetails({ size_id: 10, edge_right: 100, edge_top: 100 });
      const smallerDetails = makeDetails({ size_id: 11, edge_right: 90, edge_top: 90 });
      const midDetails = makeDetails({ size_id: 12, edge_right: 110, edge_top: 110 });
      const largeDetails = makeDetails({ size_id: 13, edge_right: 140, edge_top: 140 });

      // Exact session → fails fit. Smaller size is filtered out by area.
      // Mid-size is the first larger candidate and wins.
      mockGetBoardDetails.mockImplementation(({ size_id }) => {
        if (size_id === 10) return sessionDetails;
        if (size_id === 11) return smallerDetails;
        if (size_id === 12) return midDetails;
        return largeDetails;
      });

      mockGetSizes.mockReturnValue([
        makeSize(10, 100, 100),
        makeSize(11, 90, 90),
        makeSize(12, 110, 110),
        makeSize(13, 140, 140),
      ]);
      // Mid-size publishes the session sets, so the resolver should prefer them.
      mockGetSets.mockImplementation((_board, _layout, sizeId) => {
        if (sizeId === 12) return [makeSet(1), makeSet(2)];
        if (sizeId === 13) return [makeSet(1), makeSet(2), makeSet(3)];
        return [makeSet(1)];
      });

      // Session board fails, mid-size board passes.
      mockCanAdd.mockImplementation((_climb, target) => {
        if (target === midDetails) return { ok: true };
        return { ok: false, reason: 'holds_out_of_range' };
      });

      const climb = makeClimb();
      const result = resolveBoardDetailsForClimb(climb, KILTER_SESSION);

      expect(result).toEqual({ details: midDetails, status: 'upsized' });
      // Never attempts the smaller size.
      expect(mockGetBoardDetails).not.toHaveBeenCalledWith(expect.objectContaining({ size_id: 11 }));
      // Mid-size was built with the preferred (session) set IDs.
      expect(mockGetBoardDetails).toHaveBeenCalledWith({
        board_name: 'kilter',
        layout_id: 1,
        size_id: 12,
        set_ids: [1, 2],
      });
    });

    it('falls back to all published sets when the larger size lacks the session sets', () => {
      const sessionDetails = makeDetails({ size_id: 10, edge_right: 100, edge_top: 100 });
      const biggerDetails = makeDetails({ size_id: 20, edge_right: 140, edge_top: 140 });

      mockGetBoardDetails.mockImplementation(({ size_id, set_ids }) => {
        if (size_id === 10) return sessionDetails;
        // Expect all published sets on the bigger size, not the session ones.
        expect(set_ids).toEqual([9, 10, 11]);
        return biggerDetails;
      });

      mockGetSizes.mockReturnValue([makeSize(10, 100, 100), makeSize(20, 140, 140)]);
      mockGetSets.mockImplementation((_board, _layout, sizeId) => {
        if (sizeId === 20) return [makeSet(9), makeSet(10), makeSet(11)];
        return [makeSet(1), makeSet(2)];
      });

      mockCanAdd.mockImplementation((_climb, target) => {
        if (target === biggerDetails) return { ok: true };
        return { ok: false, reason: 'holds_out_of_range' };
      });

      const climb = makeClimb();
      const result = resolveBoardDetailsForClimb(climb, KILTER_SESSION);

      expect(result).toEqual({ details: biggerDetails, status: 'upsized' });
    });

    it('returns incompatible fallback (skipping the upsize walk) when the session details fail to build', () => {
      // First call is the session build — throw. Second call is the fallback
      // via getBoardDetailsForPlaylist — succeed.
      const fallbackDetails = makeDetails({ size_id: 99 });
      let callCount = 0;
      mockGetBoardDetails.mockImplementation(() => {
        callCount += 1;
        if (callCount === 1) {
          throw new Error('boom');
        }
        return fallbackDetails;
      });

      // For the playlist fallback chain we still need sizes/sets.
      mockGetSizes.mockReturnValue([makeSize(99, 200, 200)]);
      mockGetSets.mockReturnValue([makeSet(1), makeSet(2)]);

      const climb = makeClimb();
      const result = resolveBoardDetailsForClimb(climb, KILTER_SESSION);

      expect(result).toEqual({ details: fallbackDetails, status: 'incompatible' });
      // canAddClimbToBoard should never run — no usable session board to compare against.
      expect(mockCanAdd).not.toHaveBeenCalled();
      // Only two getBoardDetails calls: session (threw) + fallback.
      expect(mockGetBoardDetails).toHaveBeenCalledTimes(2);
    });

    it('returns incompatible fallback when no larger size fits', () => {
      const sessionDetails = makeDetails({ size_id: 10, edge_right: 100, edge_top: 100 });
      const biggerDetails = makeDetails({ size_id: 11, edge_right: 140, edge_top: 140 });

      mockGetBoardDetails.mockImplementation(({ size_id }) => {
        if (size_id === 10) return sessionDetails;
        return biggerDetails;
      });

      mockGetSizes.mockReturnValue([makeSize(10, 100, 100), makeSize(11, 140, 140)]);
      mockGetSets.mockReturnValue([makeSet(1), makeSet(2)]);
      mockCanAdd.mockReturnValue({ ok: false, reason: 'holds_out_of_range' });

      const climb = makeClimb();
      const result = resolveBoardDetailsForClimb(climb, KILTER_SESSION);

      // Nothing fit → final call is getBoardDetailsForPlaylist, which picks
      // the largest size on the layout (size 11) and returns those details.
      expect(result).toEqual({ details: biggerDetails, status: 'incompatible' });
      // canAddClimbToBoard was invoked twice: session + the one larger candidate.
      expect(mockCanAdd).toHaveBeenCalledTimes(2);
    });
  });

  describe('moonboard session', () => {
    const MOONBOARD_SESSION: SessionBoardConfig = {
      boardType: 'moonboard',
      layoutId: 100,
      sizeId: 1,
      setIds: [1],
    };

    it('returns exact when the climb fits the moonboard session', () => {
      const details = makeDetails({ board_name: 'moonboard', layout_id: 100 });
      mockGetMoonBoardDetails.mockReturnValue(details as unknown as ReturnType<typeof getMoonBoardDetails>);
      mockCanAdd.mockReturnValue({ ok: true });

      const climb = makeClimb({ boardType: 'moonboard', layoutId: 100 });
      const result = resolveBoardDetailsForClimb(climb, MOONBOARD_SESSION);

      expect(result).toEqual({ details, status: 'exact' });
    });

    it('skips the upsize walk and falls back to incompatible when the climb does not fit moonboard', () => {
      const sessionDetails = makeDetails({ board_name: 'moonboard', layout_id: 100 });
      const fallbackDetails = makeDetails({
        board_name: 'moonboard',
        layout_id: 100,
        size_id: 999,
      });

      let moonCalls = 0;
      mockGetMoonBoardDetails.mockImplementation(() => {
        moonCalls += 1;
        // First call is the session build, second is the playlist fallback.
        return (moonCalls === 1 ? sessionDetails : fallbackDetails) as unknown as ReturnType<
          typeof getMoonBoardDetails
        >;
      });
      mockCanAdd.mockReturnValue({ ok: false, reason: 'holds_out_of_range' });

      const climb = makeClimb({ boardType: 'moonboard', layoutId: 100 });
      const result = resolveBoardDetailsForClimb(climb, MOONBOARD_SESSION);

      expect(result).toEqual({ details: fallbackDetails, status: 'incompatible' });
      // getSizesForLayoutId should never be consulted for moonboard — no upsize walk.
      expect(mockGetSizes).not.toHaveBeenCalled();
    });
  });
});
