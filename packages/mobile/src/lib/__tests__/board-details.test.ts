import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@boardsesh/board-constants/product-sizes', () => ({
  getImageFilename: vi.fn(),
  getProductSize: vi.fn(),
  getHolePlacements: vi.fn(),
  hasProductSizeEdges: vi.fn(),
}));

// `getWoodsBoardDetails` is deliberately NOT mocked: the Woods cases below assert
// against the real hold tables (485 / 894 calibrated mounting slots) and the real board-art
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
    // Real: the label-art key comes off the real layout geometry, which is what
    // tells the Mini boards' file from the full-size one.
    getMoonBoardGeometryByLayoutId: actual.getMoonBoardGeometryByLayoutId,
    getWoodsBoardDetails: actual.getWoodsBoardDetails,
  };
});

vi.mock('../env', () => ({
  WEB_BASE_URL: 'https://example.com',
}));

import { getImageFilename } from '@boardsesh/board-constants/product-sizes';
import { getQuantumSourceDiodeBindings } from '@boardsesh/board-constants/quantum';
import { BOARD_IMAGE_DIMENSIONS, getMoonBoardDetails } from '@boardsesh/board-config';
import type { MoonBoardLayoutKey } from '@boardsesh/board-config';
import {
  clearBoardRenderDataCache,
  getBoardAspectRatio,
  getBoardRenderData,
  getBoardRenderDimensions,
  moonBoardGridLabelsImageKey,
} from '../board-details';
import { getQuantumGeometry } from '../quantum-geometry-store';

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

  // Woods has no board_images row, so the ratio has to come off the render data.
  // The two sizes are shaped differently — 8x10 is markedly more portrait — so a
  // shared ratio would letterbox one of them.
  it('uses the real Woods board-art dimensions per size', () => {
    expect(getBoardAspectRatio({ boardName: 'woods', layoutId: 1, sizeId: 2, setIds: [1] })).toBeCloseTo(1225 / 1400);
    expect(getBoardAspectRatio({ boardName: 'woods', layoutId: 1, sizeId: 1, setIds: [1] })).toBeCloseTo(720 / 1000);
  });

  it('falls back for a Quantum size from another layout', () => {
    expect(getBoardAspectRatio({ boardName: 'quantum', layoutId: 9104, sizeId: 9201, setIds: [1] })).toBeCloseTo(
      1080 / 1920,
    );
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

    // The label art is not in the stack: full-size boards draw it above the holds
    // overlay instead (issue #6234).
    expect(result).toEqual({
      boardWidth: 650,
      boardHeight: 1000,
      backgroundImageKeys: ['moonboard/moonboard2024/woodenholds.webp'],
      holdsData: [{ id: 1, mirroredHoldId: null, cx: 100, cy: 200, r: 12 }],
    });
  });

  // Against the real MoonBoard config, every layout: the dark-mode veil sits over
  // the whole background stack, so label art left in it would be washed out again.
  it.each([
    [1, 'moonboard/moonboard-bg.webp'],
    [2, 'moonboard/moonboard-bg.webp'],
    [3, 'moonboard/moonboard-bg.webp'],
    [4, 'moonboard/moonboard-bg.webp'],
    [5, 'moonboard/moonboard-bg.webp'],
    [6, 'moonboard/minimoonboard-bg.webp'],
    [7, 'moonboard/minimoonboard-bg.webp'],
  ])('keeps layout %i label art (%s) out of the background stack', async (layoutId, labelsKey) => {
    const actual = await vi.importActual<typeof import('@boardsesh/board-config')>('@boardsesh/board-config');
    mockedGetMoonBoardDetails.mockImplementation(actual.getMoonBoardDetails);
    const [layoutKey, layout] = actual.getLayoutById(layoutId)!;
    const holdSets = actual.getHoldSetsForLayout(layoutKey as MoonBoardLayoutKey);
    const setIds = holdSets.map((holdSet) => holdSet.id);
    // Straight from the layout table, not from `images_to_holds`: every hold
    // set's own art, in set order, and nothing else.
    const holdSetArtKeys = holdSets.map((holdSet) =>
      `moonboard/${layout.folder}/${holdSet.imageFile}`.replace(/\.png$/, '.webp'),
    );

    const result = getBoardRenderData({ boardName: 'moonboard', layoutId, sizeId: 1, setIds });

    expect(moonBoardGridLabelsImageKey(layoutId)).toBe(labelsKey);
    expect(holdSetArtKeys.length).toBeGreaterThan(0);
    expect(result?.backgroundImageKeys).toEqual(holdSetArtKeys);
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

  it.each([
    [9101, 9201, 1964, 1984, 657, 2105, 43.078, 284.95],
    [9101, 9202, 1964, 1692, 549, 2110, 43.035, 494.859],
    [9101, 9203, 1548, 1692, 432, 2020, 101.856, 1142.935],
    [9104, 9204, 1176, 1892, 252, 1090, 89.077, 1140.219],
  ])(
    'keeps Quantum %i/%i hold identities and projects them into cropped artwork pixels',
    (layoutId, sizeId, boardWidth, boardHeight, count, anchorId, observedX, observedY) => {
      const config = { boardName: 'quantum' as const, layoutId, sizeId, setIds: [1] };
      const geometry = getQuantumGeometry(layoutId, sizeId)!;
      const render = getBoardRenderData(config);
      const anchor = getQuantumSourceDiodeBindings(layoutId, sizeId)?.find(({ autocadId }) => autocadId === anchorId);
      const hold = render?.holdsData.find(({ id }) => id === anchor?.placementId);
      if (!render || !hold) throw new Error('Expected a known artwork anchor');

      expect(render.holdsData).toHaveLength(count);
      expect(render.holdsData.map(({ id }) => id)).toEqual(geometry.placements.map(({ placementId }) => placementId));
      const model = sizeId === 9204 ? 's-fitness' : sizeId === 9203 ? 'm' : sizeId === 9202 ? 'l' : 'xl';
      const canvasScale = Math.min(1, 1536 / boardWidth, 2304 / boardHeight);
      expect(render.backgroundImageKeys).toEqual([`quantum/quantum-${model}.webp`]);
      expect(getBoardRenderDimensions(config)).toEqual({
        boardWidth: Math.round(boardWidth * canvasScale),
        boardHeight: Math.round(boardHeight * canvasScale),
      });
      expect(getBoardAspectRatio(config)).toBe(
        Math.round(boardWidth * canvasScale) / Math.round(boardHeight * canvasScale),
      );
      expect(Math.hypot(hold.cx - observedX * canvasScale, hold.cy - observedY * canvasScale)).toBeLessThan(2.3);
    },
  );

  it('rejects an unrelated Quantum set or layout', () => {
    expect(getBoardRenderData({ boardName: 'quantum', layoutId: 9105, sizeId: 9205, setIds: [1] })).toBeNull();
    expect(getBoardRenderData({ boardName: 'quantum', layoutId: 9101, sizeId: 9201, setIds: [2] })).toBeNull();
    expect(getBoardRenderData({ boardName: 'quantum', layoutId: 9104, sizeId: 9201, setIds: [1] })).toBeNull();
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

describe('Woods coordinate parity (#4971)', () => {
  it.each([1, 2])('uses the shared calibrated drawing on size %i', async (sizeId) => {
    const { getWoodsBoardDetails } =
      await vi.importActual<typeof import('@boardsesh/board-config')>('@boardsesh/board-config');
    const shared = getWoodsBoardDetails({ size_id: sizeId });
    const mobile = getBoardRenderData({ boardName: 'woods', layoutId: 1, sizeId, setIds: [1] });
    expect(mobile?.holdsData).toEqual(shared.holdsData);
    expect(mobile?.boardWidth).toBe(shared.boardWidth);
    expect(mobile?.boardHeight).toBe(shared.boardHeight);
    if (sizeId === 2) {
      const start = mobile!.holdsData.find((hold) => hold.id === 807)!;
      expect(Math.abs(start.cx - 1096)).toBeLessThan(1);
      expect(Math.abs(start.cy - 1015)).toBeLessThan(1);
    }
  });
});
