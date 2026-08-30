import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@boardsesh/board-constants/product-sizes', () => ({
  getImageFilename: vi.fn(),
  getProductSize: vi.fn(),
  getHolePlacements: vi.fn(),
  hasProductSizeEdges: vi.fn(),
}));

// `getWoodsBoardDetails` is deliberately NOT mocked: the Woods cases below assert
// against the real hold tables (485 / 894 detected centres) and the real board-art
// dimensions, which is what makes them catch a regenerated hold table or a renamed
// background image.
vi.mock('@boardsesh/board-config', async () => {
  const actual = await vi.importActual<typeof import('@boardsesh/board-config')>('@boardsesh/board-config');
  return {
    ...actual,
    BOARD_IMAGE_DIMENSIONS: {
      kilter: {},
      tension: {},
      moonboard: {},
    },
    MOONBOARD_SIZE: { id: 1 },
    WOODS_LAYOUTS: actual.WOODS_LAYOUTS,
    getMoonBoardDetails: vi.fn(),
    getWoodsBoardDetails: actual.getWoodsBoardDetails,
  };
});

vi.mock('../env', () => ({
  WEB_BASE_URL: 'https://example.com',
}));

import { getImageFilename } from '@boardsesh/board-constants/product-sizes';
import { BOARD_IMAGE_DIMENSIONS, getMoonBoardDetails } from '@boardsesh/board-config';
import { clearBoardRenderDataCache, getBoardAspectRatio, getBoardRenderData } from '../board-details';
import { registerQuantumGeometry, unregisterQuantumGeometry } from '../quantum-geometry-store';

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
    unregisterQuantumGeometry(9101, 9201);
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

  // Woods has no board_images row, so the ratio has to come off the render data.
  // The two sizes are shaped differently — 8x10 is markedly more portrait — so a
  // shared ratio would letterbox one of them.
  it('uses the real Woods board-art dimensions per size', () => {
    expect(getBoardAspectRatio({ boardName: 'woods', layoutId: 1, sizeId: 2, setIds: [1] })).toBeCloseTo(1225 / 1400);
    expect(getBoardAspectRatio({ boardName: 'woods', layoutId: 1, sizeId: 1, setIds: [1] })).toBeCloseTo(720 / 1000);
  });

  it('uses the exact neutral Quantum model ratio before geometry hydrates', () => {
    expect(getBoardAspectRatio({ boardName: 'quantum', layoutId: 9101, sizeId: 9201, setIds: [1] })).toBe(1);
    expect(getBoardAspectRatio({ boardName: 'quantum', layoutId: 9102, sizeId: 9202, setIds: [1] })).toBe(15 / 12);
    expect(getBoardAspectRatio({ boardName: 'quantum', layoutId: 9101, sizeId: 9202, setIds: [1] })).toBeCloseTo(
      1080 / 1920,
    );
  });
});

describe('getBoardRenderData', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearBoardRenderDataCache();
    unregisterQuantumGeometry(9101, 9201);
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

  it('renders only an exact hydrated Quantum layout, size, and synthetic set', () => {
    expect(
      registerQuantumGeometry({
        layoutId: 9101,
        sizeId: 9201,
        revision: 'catalog-1',
        edgeLeft: 10_000,
        edgeRight: 20_000,
        edgeBottom: 30_000,
        edgeTop: 40_000,
        placements: [{ placementId: 1_000_000, holeId: 1_000_000, x: 15_000, y: 35_000, ledPosition: 42 }],
      }),
    ).toBe(true);

    expect(getBoardRenderData({ boardName: 'quantum', layoutId: 9101, sizeId: 9201, setIds: [1] })).toEqual({
      boardWidth: 1500,
      boardHeight: 1500,
      edgeLeft: 10_000,
      edgeRight: 20_000,
      edgeBottom: 30_000,
      edgeTop: 40_000,
      backgroundImageKeys: [],
      holdsData: [{ id: 1_000_000, mirroredHoldId: null, cx: 750, cy: 750, r: 18 }],
    });
    expect(getBoardRenderData({ boardName: 'quantum', layoutId: 9101, sizeId: 9201, setIds: [2] })).toBeNull();
    expect(getBoardRenderData({ boardName: 'quantum', layoutId: 9101, sizeId: 9202, setIds: [1] })).toBeNull();
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

  it('builds 12x12 Woods render data with one hold per detected centre', () => {
    const result = getBoardRenderData({ boardName: 'woods', layoutId: 1, sizeId: 2, setIds: [1] });

    expect(result).toMatchObject({
      boardWidth: 1225,
      boardHeight: 1400,
      edgeLeft: 0,
      edgeRight: 33,
      edgeBottom: 0,
      edgeTop: 31,
      backgroundImageKeys: ['woods/woods-12x12-bg.webp'],
    });
    expect(result?.holdsData).toHaveLength(894);
    expect(result?.holdsData.every((hold) => hold.r === 13.5)).toBe(true);
  });

  it('builds 8x10 Woods render data off the smaller board art', () => {
    const result = getBoardRenderData({ boardName: 'woods', layoutId: 1, sizeId: 1, setIds: [1] });

    expect(result).toMatchObject({
      boardWidth: 720,
      boardHeight: 1000,
      edgeRight: 21,
      edgeTop: 25,
      backgroundImageKeys: ['woods/woods-8x10-bg.webp'],
    });
    expect(result?.holdsData).toHaveLength(485);
    expect(result?.holdsData.every((hold) => hold.r === 11.5)).toBe(true);
  });

  // Woods has ONE layout, so any other id means the caller resolved the config
  // against a different board. Rejected up front rather than rendered as the
  // only Woods layout, which would hide the mismatch behind a plausible wall.
  it('warns and returns null for a Woods layout id that is not the Woods layout', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      expect(getBoardRenderData({ boardName: 'woods', layoutId: 8, sizeId: 1, setIds: [1] })).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith('[board-details] Woods render data unavailable:', 'unknown layout id 8');
    } finally {
      warnSpy.mockRestore();
    }
  });

  // The set ids are fixed for Woods, so beyond the layout an unknown SIZE is the
  // only config that can miss — and it must degrade to "no board" rather than
  // throw out of a render.
  it('warns and returns null for an unknown Woods size', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      expect(getBoardRenderData({ boardName: 'woods', layoutId: 1, sizeId: 99, setIds: [1] })).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        '[board-details] Woods render data unavailable:',
        'Woods board size not found: 99',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
