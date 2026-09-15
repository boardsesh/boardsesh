// The units the parity test exercises end to end, pinned one at a time so a
// failure says WHICH step drifted rather than "44 boxes became 49".
import { describe, expect, it } from 'vite-plus/test';
import { toHoldCandidates } from '../candidates';
import { decodeRfDetr } from '../decode';
import { IMAGENET_MEAN, IMAGENET_STD, letterbox, unLetterbox } from '../letterbox';
import { boxIou, mergeTiles, nms } from '../nms';
import { DEFAULT_TILE_PLAN, planTiles, roundHalfToEven, tileWindows } from '../tiles';
import type { Box, Detection, RgbaImage, TileRect } from '../types';

/** A flat grey photo, so a resample's output is exactly its input. */
function greyImage(width: number, height: number, level = 128): RgbaImage {
  const rgba = new Uint8ClampedArray(width * height * 4);
  rgba.fill(level);
  for (let index = 3; index < rgba.length; index += 4) rgba[index] = 255;
  return { width, height, rgba };
}

function detection(box: Box, score: number, tileIndex = 0): Detection {
  return { box, score, tileIndex };
}

describe('tileWindows', () => {
  it('returns the whole image for a 1x1 grid', () => {
    expect(tileWindows(800, 600, { rows: 1, cols: 1, overlap: 0 })).toEqual([{ x0: 0, y0: 0, x1: 800, y1: 600 }]);
  });

  it('reproduces common.py for the nano-tiled 2x2 grid', () => {
    // Hand-computed from `tile_boxes`: tile = round(768/2 * 1.15) = 442 wide,
    // round(1024/2 * 1.15) = 589 high; step = (768-442)//1 = 326, (1024-589)//1 = 435.
    expect(tileWindows(768, 1024, { rows: 2, cols: 2, overlap: 0.15 })).toEqual([
      { x0: 0, y0: 0, x1: 442, y1: 589 },
      { x0: 326, y0: 0, x1: 768, y1: 589 },
      { x0: 0, y0: 435, x1: 442, y1: 1024 },
      { x0: 326, y0: 435, x1: 768, y1: 1024 },
    ]);
  });

  it('rounds tile sizes the way Python does, ties to even', () => {
    // 1020 / 2 * 1.15 is exactly 586.5 in float64. Python's `round` gives 586 and
    // `Math.round` gives 587, and one pixel of tile width moves the window, the
    // un-letterbox mapping and every box that came out of that tile.
    expect((1020 / 2) * 1.15).toBe(586.5);
    expect(tileWindows(1020, 1020, { rows: 2, cols: 2, overlap: 0.15 })[0]).toEqual({
      x0: 0,
      y0: 0,
      x1: 586,
      y1: 586,
    });
    // The plain half-up case, where nothing is at a tie.
    expect((1021 / 2) * 1.0).toBe(510.5);
    expect(tileWindows(1021, 1021, { rows: 2, cols: 2, overlap: 0 })[0].x1).toBe(510);
  });

  it('covers the image exactly, with neighbours overlapping', () => {
    const windows = tileWindows(1000, 700, { rows: 2, cols: 3, overlap: 0.2 });
    expect(windows).toHaveLength(6);
    expect(Math.min(...windows.map((window) => window.x0))).toBe(0);
    expect(Math.max(...windows.map((window) => window.x1))).toBe(1000);
    expect(Math.max(...windows.map((window) => window.y1))).toBe(700);
    // A hold on the seam is whole in at least one tile only if they overlap.
    expect(windows[1].x0).toBeLessThan(windows[0].x1);
  });
});

describe('planTiles', () => {
  it('defaults to one full-frame pass', () => {
    // SW-01 measured 2x2 tiling making the small model WORSE on ~800 px photos,
    // so the default must stay a single pass; a change here is a product change.
    expect(DEFAULT_TILE_PLAN.rows).toBe(1);
    expect(DEFAULT_TILE_PLAN.cols).toBe(1);
    const plan = planTiles(1600, 1200);
    expect(plan.tiles).toEqual([{ x0: 0, y0: 0, x1: 1600, y1: 1200 }]);
  });

  it('expresses the windows in photo pixels, not the resized frame', () => {
    const plan = planTiles(2048, 1536, { longSide: 1024, rows: 2, cols: 2, overlap: 0.15 });
    expect(plan.scale).toBeCloseTo(0.5, 12);
    expect(plan.workingWidth).toBe(1024);
    expect(plan.workingHeight).toBe(768);
    // Every window doubles back into the source frame.
    plan.tiles.forEach((rect) => {
      expect(rect.x1).toBeLessThanOrEqual(2048 + 1e-9);
      expect(rect.y1).toBeLessThanOrEqual(1536 + 1e-9);
    });
    expect(plan.tiles[0]).toEqual({ x0: 0, y0: 0, x1: 589 / 0.5, y1: 442 / 0.5 });
  });

  it('rounds the working size ties-to-even as well', () => {
    // `eval.py` sizes the long-side resize with Python's `round` too: a 5 px side
    // at scale 0.5 is 2.5, which is 2 there and would be 3 under Math.round.
    expect(planTiles(10, 5, { longSide: 5 }).workingHeight).toBe(2);
    expect(planTiles(10, 7, { longSide: 5 }).workingHeight).toBe(4);
  });

  it('refuses a non-positive size rather than planning zero tiles', () => {
    expect(() => planTiles(0, 100)).toThrow(/positive image size/);
    expect(() => planTiles(100, Number.NaN)).toThrow(/positive image size/);
  });
});

describe('roundHalfToEven', () => {
  it('sends a tie to the even neighbour and leaves everything else alone', () => {
    expect([0.5, 1.5, 2.5, 3.5, -0.5, -1.5, -2.5].map(roundHalfToEven)).toEqual([0, 2, 2, 4, 0, -2, -2]);
    expect([0.4, 0.6, 2.49, 2.51, -0.4, -0.6, 7].map(roundHalfToEven)).toEqual([0, 1, 2, 3, -0, -1, 7]);
  });
});

describe('letterbox', () => {
  it('produces an NCHW float32 tensor normalised with the ImageNet statistics', () => {
    const image = greyImage(64, 64, 128);
    const { tensor } = letterbox(image, { x0: 0, y0: 0, x1: 64, y1: 64 }, { size: 32 });
    expect(tensor).toHaveLength(3 * 32 * 32);
    for (let channel = 0; channel < 3; channel += 1) {
      const expected = (128 / 255 - IMAGENET_MEAN[channel]) / IMAGENET_STD[channel];
      expect(tensor[channel * 32 * 32]).toBeCloseTo(expected, 5);
      expect(tensor[channel * 32 * 32 + 32 * 32 - 1]).toBeCloseTo(expected, 5);
    }
  });

  it('keeps the channels apart', () => {
    // A red image must not come back as three identical planes; getting NCHW and
    // NHWC the wrong way round is the classic way to feed a model noise.
    const image = greyImage(8, 8, 0);
    for (let index = 0; index < image.rgba.length; index += 4) image.rgba[index] = 255;
    const { tensor } = letterbox(image, { x0: 0, y0: 0, x1: 8, y1: 8 }, { size: 4 });
    const plane = 4 * 4;
    expect(tensor[0]).toBeCloseTo((1 - IMAGENET_MEAN[0]) / IMAGENET_STD[0], 5);
    expect(tensor[plane]).toBeCloseTo(-IMAGENET_MEAN[1] / IMAGENET_STD[1], 5);
    expect(tensor[2 * plane]).toBeCloseTo(-IMAGENET_MEAN[2] / IMAGENET_STD[2], 5);
  });

  it('averages a downscale instead of point-sampling it', () => {
    // Every other column white: a two-tap bilinear read would alias to a stripe
    // pattern, an area-weighted one to uniform mid-grey. Aliasing away the small
    // holds on a wall is exactly the failure this filter exists to prevent.
    const image = greyImage(64, 64, 0);
    for (let y = 0; y < 64; y += 1) {
      for (let x = 0; x < 64; x += 2) {
        const offset = (y * 64 + x) * 4;
        image.rgba[offset] = 255;
        image.rgba[offset + 1] = 255;
        image.rgba[offset + 2] = 255;
      }
    }
    const { tensor } = letterbox(image, { x0: 0, y0: 0, x1: 64, y1: 64 }, { size: 8 });
    for (let column = 0; column < 8; column += 1) {
      // Back out of the ImageNet normalisation so the claim reads in 0..1.
      const level = tensor[column] * IMAGENET_STD[0] + IMAGENET_MEAN[0];
      // Point-sampling at an 8x reduction lands on an even column every time and
      // would return 1.0 across the whole row.
      expect(Math.abs(level - 0.5)).toBeLessThan(0.05);
    }
  });

  it('round-trips a normalised box through unLetterbox, stretched', () => {
    const image = greyImage(400, 300);
    const rect: TileRect = { x0: 100, y0: 50, x1: 300, y1: 250 };
    const { mapping } = letterbox(image, rect, { size: 64 });
    expect(unLetterbox([0, 0, 1, 1], mapping)).toEqual([100, 50, 300, 250]);
    expect(unLetterbox([0.5, 0.5, 0.5, 0.5], mapping)).toEqual([200, 150, 200, 150]);
  });

  it('round-trips through the padded fit too', () => {
    const image = greyImage(400, 200);
    const rect: TileRect = { x0: 0, y0: 0, x1: 400, y1: 200 };
    const { mapping } = letterbox(image, rect, { size: 64, fit: 'contain' });
    // A 2:1 crop fills the width and is letterboxed top and bottom.
    expect(mapping.content).toEqual({ x: 0, y: 16, width: 64, height: 32 });
    const [x0, y0, x1, y1] = unLetterbox([0, 16 / 64, 1, 48 / 64], mapping);
    expect([x0, y0, x1, y1]).toEqual([0, 0, 400, 200]);
  });

  it('clips a tile that runs off the photo', () => {
    const image = greyImage(50, 50);
    const { mapping } = letterbox(image, { x0: 40, y0: 40, x1: 90, y1: 90 }, { size: 8 });
    expect(mapping.rect).toEqual({ x0: 40, y0: 40, x1: 50, y1: 50 });
  });
});

describe('decodeRfDetr', () => {
  const outputs = {
    boxes: [0.5, 0.5, 0.2, 0.4, 0.25, 0.75, 0.1, 0.1],
    boxesShape: [1, 2, 4],
    // Query 0 scores sigmoid(2) = 0.881 on its best class; query 1 sigmoid(-4) = 0.018.
    logits: [-3, 2, -4, -9],
    logitsShape: [1, 2, 2],
  };

  it('takes the max over classes through a sigmoid, not a softmax', () => {
    const decoded = decodeRfDetr(outputs, { scoreThreshold: 0 });
    expect(decoded).toHaveLength(2);
    expect(decoded[0].score).toBeCloseTo(1 / (1 + Math.exp(-2)), 9);
    expect(decoded[1].score).toBeCloseTo(1 / (1 + Math.exp(4)), 9);
    // A softmax over [-3, 2] would give 0.993 — close enough to look right and
    // wrong enough to move every threshold decision.
    expect(decoded[0].score).not.toBeCloseTo(Math.exp(2) / (Math.exp(-3) + Math.exp(2)), 3);
  });

  it('converts cxcywh to xyxy', () => {
    const [first] = decodeRfDetr(outputs, { scoreThreshold: 0 });
    expect(first.box).toEqual([0.4, 0.3, 0.6, 0.7]);
  });

  it('drops everything below the threshold', () => {
    expect(decodeRfDetr(outputs, { scoreThreshold: 0.5 })).toHaveLength(1);
    expect(decodeRfDetr(outputs, { scoreThreshold: 0.95 })).toHaveLength(0);
  });

  it('stamps the tile it came from', () => {
    expect(decodeRfDetr(outputs, { scoreThreshold: 0, tileIndex: 3 })[0].tileIndex).toBe(3);
  });

  it('refuses a flattened shape rather than decoding zero queries', () => {
    // `length - 2` on a 1-D shape is -1, the lookup is undefined, and the decode
    // loop runs zero times — a runtime that flattened its outputs would read as
    // "the model found no holds".
    expect(() => decodeRfDetr({ ...outputs, boxesShape: [8] }, { scoreThreshold: 0 })).toThrow(/at least 2-D/);
    expect(() => decodeRfDetr({ ...outputs, logitsShape: [4] }, { scoreThreshold: 0 })).toThrow(/at least 2-D/);
  });

  it('refuses tensors that are not the RF-DETR pair', () => {
    expect(() => decodeRfDetr({ ...outputs, boxesShape: [1, 2, 5] }, { scoreThreshold: 0 })).toThrow(/end in 4/);
    expect(() => decodeRfDetr({ ...outputs, logitsShape: [1, 3, 2] }, { scoreThreshold: 0 })).toThrow(
      /disagree on the query count/,
    );
  });
});

describe('boxIou', () => {
  it('is 1 for a box against itself and 0 for disjoint boxes', () => {
    expect(boxIou([0, 0, 10, 10], [0, 0, 10, 10])).toBe(1);
    expect(boxIou([0, 0, 10, 10], [20, 20, 30, 30])).toBe(0);
  });

  it('measures a half overlap', () => {
    // Two 10x10 boxes sharing a 5x10 strip: 50 / (100 + 100 - 50).
    expect(boxIou([0, 0, 10, 10], [5, 0, 15, 10])).toBeCloseTo(50 / 150, 9);
  });

  it('treats a box that touches along an edge as disjoint', () => {
    expect(boxIou([0, 0, 10, 10], [10, 0, 20, 10])).toBe(0);
  });
});

describe('nms and mergeTiles', () => {
  it('keeps the higher-scoring box of an overlapping pair', () => {
    const kept = nms(
      [
        [0, 0, 10, 10],
        [1, 1, 11, 11],
      ],
      [0.4, 0.9],
      0.5,
    );
    expect(kept).toEqual([1]);
  });

  it('keeps a pair exactly AT the threshold, matching common.py', () => {
    // common.py survives on `ious <= iou_threshold`, so the boundary case is a
    // keep. Getting this backwards silently thins every seam.
    const boxes: Box[] = [
      [0, 0, 10, 10],
      [0, 0, 10, 100 / 3],
    ];
    expect(boxIou(boxes[0], boxes[1])).toBeCloseTo(0.3, 9);
    expect(nms(boxes, [0.9, 0.4], 0.3)).toEqual([0, 1]);
    expect(nms(boxes, [0.9, 0.4], 0.29)).toEqual([0]);
  });

  it('is class-agnostic and works across tiles', () => {
    const merged = mergeTiles([
      [detection([0, 0, 10, 10], 0.4, 0)],
      [detection([1, 1, 11, 11], 0.9, 1), detection([50, 50, 60, 60], 0.2, 1)],
    ]);
    expect(merged.map((item) => item.score)).toEqual([0.9, 0.2]);
    expect(merged[0].tileIndex).toBe(1);
  });

  it('passes a single detection straight through', () => {
    const single = [detection([0, 0, 1, 1], 0.5)];
    expect(mergeTiles([single])).toEqual(single);
    expect(mergeTiles([[], []])).toEqual([]);
  });
});

describe('toHoldCandidates', () => {
  it('uses the equal-area radius, so aspect does not change the size', () => {
    const [square, rail] = toHoldCandidates([
      detection([0, 0, 40, 40], 0.5),
      // Same area, laid on its side.
      detection([0, 0, 80, 20], 0.5),
    ]);
    expect(square.r).toBeCloseTo(rail.r, 9);
    expect(square.r).toBeCloseTo(Math.sqrt(1600 / Math.PI), 9);
  });

  it('centres the circle on the box and carries the score', () => {
    const [candidate] = toHoldCandidates([detection([10, 20, 30, 60], 0.42)]);
    expect(candidate.cx).toBe(20);
    expect(candidate.cy).toBe(40);
    expect(candidate.score).toBe(0.42);
  });

  it('leaves the outline undefined, because the model returns boxes', () => {
    expect(toHoldCandidates([detection([0, 0, 10, 10], 0.5)])[0].outline).toBeUndefined();
  });
});
