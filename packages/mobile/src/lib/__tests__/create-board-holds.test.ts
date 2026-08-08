import { beforeEach, describe, expect, it, vi } from 'vitest';

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
        setIds: [5, 6],
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

  it('limits MoonBoard paint targets to active sets while preserving renderer cell IDs', () => {
    mockedGetBoardRenderData.mockReturnValue({
      boardWidth: 650,
      boardHeight: 1000,
      edgeLeft: 0,
      edgeRight: 11,
      edgeBottom: 0,
      edgeTop: 18,
      backgroundImageKeys: ['moonboard/moonboard-bg.webp'],
      holdsData: [
        { id: 18, mirroredHoldId: null, cx: 68, cy: 950, r: 12 },
        { id: 26, mirroredHoldId: null, cx: 118, cy: 900, r: 12 },
      ],
    });

    expect(getCreateBoardHolds({ boardName: 'moonboard', layoutId: 2, sizeId: 1, setIds: [2] })?.holdTargets).toEqual([
      { id: 18, cx: 68, cy: 950, r: 12 },
    ]);
  });

  it('keeps cell 26 and rejects a hardware placement id such as 1026', () => {
    mockedGetBoardRenderData.mockReturnValue({
      boardWidth: 650,
      boardHeight: 1000,
      edgeLeft: 0,
      edgeRight: 11,
      edgeBottom: 0,
      edgeTop: 18,
      backgroundImageKeys: ['moonboard/moonboard-bg.webp'],
      holdsData: [
        { id: 26, mirroredHoldId: null, cx: 68, cy: 950, r: 12 },
        { id: 1026, mirroredHoldId: null, cx: 118, cy: 900, r: 12 },
      ],
    });

    expect(getCreateBoardHolds({ boardName: 'moonboard', layoutId: 1, sizeId: 1, setIds: [1] })?.holdTargets).toEqual([
      { id: 26, cx: 68, cy: 950, r: 12 },
    ]);
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
      setIds: [5],
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
