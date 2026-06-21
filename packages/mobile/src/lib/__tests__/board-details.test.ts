import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@boardsesh/board-constants/product-sizes', () => ({
  getImageFilename: vi.fn(),
  getProductSize: vi.fn(),
  getHolePlacements: vi.fn(),
}));

vi.mock('@boardsesh/board-config', () => ({
  BOARD_IMAGE_DIMENSIONS: {
    kilter: {},
    tension: {},
    moonboard: {},
  },
  MOONBOARD_SIZE: { id: 1 },
  getMoonBoardDetails: vi.fn(),
}));

vi.mock('../env', () => ({
  WEB_BASE_URL: 'https://example.com',
}));

import { getImageFilename } from '@boardsesh/board-constants/product-sizes';
import { BOARD_IMAGE_DIMENSIONS, getMoonBoardDetails } from '@boardsesh/board-config';
import { clearBoardRenderDataCache, getBoardAspectRatio, getBoardRenderData } from '../board-details';

const mockedGetImageFilename = vi.mocked(getImageFilename);
const mockedGetMoonBoardDetails = vi.mocked(getMoonBoardDetails);

const baseParams = {
  boardName: 'kilter' as const,
  layoutId: 1,
  sizeId: 10,
};

describe('getBoardAspectRatio', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearBoardRenderDataCache();
    BOARD_IMAGE_DIMENSIONS.kilter = {};
  });

  it('returns the fallback ratio when setIds is empty', () => {
    const result = getBoardAspectRatio({ ...baseParams, setIds: [] });
    expect(result).toBeCloseTo(1080 / 1920);
  });

  it('returns the fallback ratio when getImageFilename returns null for all setIds', () => {
    mockedGetImageFilename.mockReturnValue(null);
    const result = getBoardAspectRatio({ ...baseParams, setIds: [1, 2] });
    expect(result).toBeCloseTo(1080 / 1920);
  });

  it('returns the fallback ratio when the image filename has no dimension entry', () => {
    mockedGetImageFilename.mockReturnValue('no-match.png');
    const result = getBoardAspectRatio({ ...baseParams, setIds: [1] });
    expect(result).toBeCloseTo(1080 / 1920);
  });

  it('returns width/height when dimensions are found', () => {
    mockedGetImageFilename.mockReturnValue('board.png');
    BOARD_IMAGE_DIMENSIONS.kilter = { 'board.png': { width: 1200, height: 800 } };
    const result = getBoardAspectRatio({ ...baseParams, setIds: [1] });
    expect(result).toBeCloseTo(1200 / 800);
  });

  it('uses MoonBoard render details for the MoonBoard aspect ratio', () => {
    mockedGetMoonBoardDetails.mockReturnValue({
      boardWidth: 650,
      boardHeight: 1000,
      backgroundImageKeys: [],
      holdsData: [],
      images_to_holds: { 'moonboard-bg.png': [] },
    } as unknown as ReturnType<typeof getMoonBoardDetails>);

    const result = getBoardAspectRatio({
      boardName: 'moonboard',
      layoutId: 3,
      sizeId: 1,
      setIds: [8],
    });

    expect(result).toBeCloseTo(650 / 1000);
  });
});

describe('getBoardRenderData', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearBoardRenderDataCache();
  });

  it('builds MoonBoard render data from the shared MoonBoard config', () => {
    mockedGetMoonBoardDetails.mockReturnValue({
      boardWidth: 650,
      boardHeight: 1000,
      backgroundImageKeys: [],
      holdsData: [{ id: 1, mirroredHoldId: null, cx: 100, cy: 200, r: 12 }],
      images_to_holds: {
        'moonboard-bg.png': [],
        'moonboard2024/woodenholds.png': [],
      },
    } as unknown as ReturnType<typeof getMoonBoardDetails>);

    const result = getBoardRenderData({
      boardName: 'moonboard',
      layoutId: 3,
      sizeId: 1,
      setIds: [8],
    });

    expect(result).toEqual({
      boardWidth: 650,
      boardHeight: 1000,
      backgroundImageKeys: ['moonboard/moonboard-bg.webp', 'moonboard/moonboard2024/woodenholds.webp'],
      holdsData: [{ id: 1, mirroredHoldId: null, cx: 100, cy: 200, r: 12 }],
    });
  });

  it('returns null for an invalid MoonBoard size', () => {
    const result = getBoardRenderData({
      boardName: 'moonboard',
      layoutId: 3,
      sizeId: 999,
      setIds: [8],
    });

    expect(result).toBeNull();
    expect(mockedGetMoonBoardDetails).not.toHaveBeenCalled();
  });

  it('warns and returns null when MoonBoard details cannot be resolved', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockedGetMoonBoardDetails.mockImplementation(() => {
      throw new Error('layout missing');
    });

    try {
      expect(
        getBoardRenderData({
          boardName: 'moonboard',
          layoutId: 999,
          sizeId: 1,
          setIds: [8],
        }),
      ).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith('[board-details] MoonBoard render data unavailable:', 'layout missing');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
