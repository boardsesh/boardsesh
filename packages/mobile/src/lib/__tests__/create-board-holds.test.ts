import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../board-details', () => ({
  getBoardRenderData: vi.fn(),
}));

import { getBoardRenderData } from '../board-details';
import { getCreateBoardHolds, parseSetIdsParam } from '../create-board-holds';

const mockedGetBoardRenderData = vi.mocked(getBoardRenderData);

describe('getCreateBoardHolds', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns MoonBoard hold targets and family from render data', () => {
    mockedGetBoardRenderData.mockReturnValue({
      boardWidth: 650,
      boardHeight: 1000,
      edgeLeft: 0,
      edgeRight: 11,
      edgeBottom: 0,
      edgeTop: 18,
      imageUrls: ['https://example.com/images/moonboard/moonboard-bg.png'],
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
