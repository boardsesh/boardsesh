import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WOODS_OCCUPIED_HOLD_IDS } from '@boardsesh/board-constants/woods';

vi.mock('../board-details', () => ({
  getBoardRenderData: vi.fn(),
}));

import { getBoardRenderData } from '../board-details';
import {
  clearCreateBoardHoldsCache,
  getCreateBoardHolds,
  parseSetIdsParam,
  prewarmCreateBoardHolds,
} from '../create-board-holds';

const mockedGetBoardRenderData = vi.mocked(getBoardRenderData);

describe('getCreateBoardHolds', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearCreateBoardHoldsCache();
  });

  it('returns MoonBoard hold targets and family from render data', () => {
    mockedGetBoardRenderData.mockReturnValue({
      boardWidth: 650,
      boardHeight: 1000,
      edgeLeft: 0,
      edgeRight: 11,
      edgeBottom: 0,
      edgeTop: 18,
      backgroundImageKeys: ['moonboard/moonboard-bg.webp'],
      holdsData: [
        { id: 1, mirroredHoldId: null, cx: 68, cy: 950, r: 12 },
        { id: 198, mirroredHoldId: null, cx: 618, cy: 50, r: 12 },
      ],
    });

    expect(
      getCreateBoardHolds({
        boardName: 'moonboard',
        layoutId: 3,
        sizeId: 1,
        setIds: [8],
      }),
    ).toEqual({
      holdTargets: [
        { id: 1, cx: 68, cy: 950, r: 12 },
        { id: 198, cx: 618, cy: 50, r: 12 },
      ],
      boardWidth: 650,
      boardHeight: 1000,
      edgeLeft: 0,
      edgeRight: 11,
      edgeBottom: 0,
      edgeTop: 18,
      family: 'moonboard',
    });
  });

  // A Woods hold id is a mounting slot, and 106 of the 8x10's 485 and 169 of the
  // 12x12's 894 carry no hold. Only the occupied ones may become tap targets or
  // discoverability dots (#5185).
  it.each([
    { sizeId: 1, dimension: '8x10' as const, slots: 485, width: 720, height: 1000 },
    { sizeId: 2, dimension: '12x12' as const, slots: 894, width: 1225, height: 1400 },
  ])(
    'uses real Woods geometry for size $sizeId, occupied slots only, including hold zero',
    async ({ sizeId, dimension, slots, width, height }) => {
      const actual = await vi.importActual<typeof import('../board-details')>('../board-details');
      mockedGetBoardRenderData.mockImplementation(actual.getBoardRenderData);
      const occupied = WOODS_OCCUPIED_HOLD_IDS[dimension];

      const result = getCreateBoardHolds({ boardName: 'woods', layoutId: 1, sizeId, setIds: [1] });

      expect(result).toMatchObject({ family: 'woods', boardWidth: width, boardHeight: height });
      expect(result?.holdTargets).toHaveLength(occupied.length);
      expect(occupied.length).toBeLessThan(slots);
      expect(result?.holdTargets.map((hold) => hold.id)).toEqual([...occupied]);
      expect(result?.holdTargets.some((hold) => hold.id === 0)).toBe(true);
      expect(
        result?.holdTargets.every((hold) => Number.isFinite(hold.cx) && Number.isFinite(hold.cy) && hold.r > 0),
      ).toBe(true);
    },
  );

  it('drops the empty 12x12 mounting slot beside the rail and keeps its neighbours', () => {
    mockedGetBoardRenderData.mockReturnValue({
      boardWidth: 1225,
      boardHeight: 1400,
      edgeLeft: 0,
      edgeRight: 33,
      edgeBottom: 0,
      edgeTop: 31,
      backgroundImageKeys: ['woods/woods-12x12-bg.webp'],
      holdsData: [
        { id: 807, mirroredHoldId: null, cx: 1106, cy: 1026, r: 13.5 },
        { id: 808, mirroredHoldId: null, cx: 1123, cy: 1026, r: 13.5 },
        { id: 809, mirroredHoldId: null, cx: 1140, cy: 1020, r: 13.5 },
      ],
    });

    expect(
      getCreateBoardHolds({ boardName: 'woods', layoutId: 1, sizeId: 2, setIds: [1] })?.holdTargets.map(
        (hold) => hold.id,
      ),
    ).toEqual([807, 809]);
  });

  it('keeps 8x10 holds the catalog never uses', () => {
    mockedGetBoardRenderData.mockReturnValue({
      boardWidth: 720,
      boardHeight: 1000,
      edgeLeft: 0,
      edgeRight: 21,
      edgeBottom: 0,
      edgeTop: 25,
      backgroundImageKeys: ['woods/woods-8x10-bg.webp'],
      holdsData: [25, 112, 131, 12].map((id) => ({ id, mirroredHoldId: null, cx: id, cy: id, r: 11.5 })),
    });

    expect(
      getCreateBoardHolds({ boardName: 'woods', layoutId: 1, sizeId: 1, setIds: [1] })?.holdTargets.map(
        (hold) => hold.id,
      ),
    ).toEqual([25, 112, 131]);
  });

  it('reports no Woods holds for a size id that is not a Woods board', () => {
    mockedGetBoardRenderData.mockReturnValue({
      boardWidth: 1225,
      boardHeight: 1400,
      edgeLeft: 0,
      edgeRight: 33,
      edgeBottom: 0,
      edgeTop: 31,
      backgroundImageKeys: ['woods/woods-12x12-bg.webp'],
      holdsData: [{ id: 807, mirroredHoldId: null, cx: 1106, cy: 1026, r: 13.5 }],
    });

    expect(getCreateBoardHolds({ boardName: 'woods', layoutId: 1, sizeId: 27, setIds: [1] })).toBeNull();
  });

  it('returns null when render data is unavailable', () => {
    mockedGetBoardRenderData.mockReturnValue(null);

    expect(
      getCreateBoardHolds({
        boardName: 'moonboard',
        layoutId: 999,
        sizeId: 1,
        setIds: [8],
      }),
    ).toBeNull();
  });

  it('reuses cached hold targets for a board config', () => {
    mockedGetBoardRenderData.mockReturnValue({
      boardWidth: 650,
      boardHeight: 1000,
      edgeLeft: 0,
      edgeRight: 11,
      edgeBottom: 0,
      edgeTop: 18,
      backgroundImageKeys: ['moonboard/moonboard-bg.webp'],
      holdsData: [{ id: 1, mirroredHoldId: null, cx: 68, cy: 950, r: 12 }],
    });

    const config = {
      boardName: 'moonboard' as const,
      layoutId: 3,
      sizeId: 1,
      setIds: [8],
    };

    prewarmCreateBoardHolds(config);
    expect(getCreateBoardHolds(config)?.holdTargets).toEqual([{ id: 1, cx: 68, cy: 950, r: 12 }]);
    expect(mockedGetBoardRenderData).toHaveBeenCalledTimes(1);
  });

  it('promotes reused configs before evicting old cache entries', () => {
    mockedGetBoardRenderData.mockReturnValue({
      boardWidth: 650,
      boardHeight: 1000,
      edgeLeft: 0,
      edgeRight: 11,
      edgeBottom: 0,
      edgeTop: 18,
      backgroundImageKeys: ['moonboard/moonboard-bg.webp'],
      holdsData: [{ id: 1, mirroredHoldId: null, cx: 68, cy: 950, r: 12 }],
    });

    const configs = Array.from({ length: 17 }, (_, index) => ({
      boardName: 'moonboard' as const,
      layoutId: index,
      sizeId: 1,
      setIds: [8],
    }));

    for (const config of configs.slice(0, 16)) getCreateBoardHolds(config);
    expect(mockedGetBoardRenderData).toHaveBeenCalledTimes(16);

    getCreateBoardHolds(configs[0]);
    expect(mockedGetBoardRenderData).toHaveBeenCalledTimes(16);

    getCreateBoardHolds(configs[16]);
    expect(mockedGetBoardRenderData).toHaveBeenCalledTimes(17);

    getCreateBoardHolds(configs[0]);
    expect(mockedGetBoardRenderData).toHaveBeenCalledTimes(17);

    getCreateBoardHolds(configs[1]);
    expect(mockedGetBoardRenderData).toHaveBeenCalledTimes(18);
  });

  it('throws when the test-only cache clearer runs outside dev mode', () => {
    vi.stubGlobal('__DEV__', false);
    try {
      expect(() => clearCreateBoardHoldsCache()).toThrow('test-only');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('parseSetIdsParam', () => {
  it('returns an empty array for an empty string (not [0])', () => {
    expect(parseSetIdsParam('')).toEqual([]);
  });

  it('parses a comma-separated list of set ids', () => {
    expect(parseSetIdsParam('24,25')).toEqual([24, 25]);
  });

  it('drops zero and blank tokens', () => {
    expect(parseSetIdsParam('0,24,,25')).toEqual([24, 25]);
  });
});
