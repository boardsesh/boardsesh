import type { TileRect } from './types';

/**
 * How one photo is cut up before it reaches the detector.
 *
 * The default is ONE full-frame pass, which is not what the spike's
 * `nano-tiled-1024` config does. That is deliberate: SW-01 measured 2x2 tiling
 * at 1024 px making the small model 4.9 F1 points WORSE on real wall photos
 * (`ml/holds/README.md`, "The two configs moved in opposite directions"). Photos
 * around 800 px on the long side cut into ~330 px tiles that are then upscaled,
 * so every hold gets bigger and the surrounding wall — which is what says "hold"
 * rather than "smudge" — leaves the frame. Tiling stays available because a
 * 4000 px photo of a dense wall is the case it was meant for.
 */
export interface TileGrid {
  rows: number;
  cols: number;
  /** Fraction of a tile side that neighbouring tiles share. */
  overlap: number;
}

export interface TilePlanOptions {
  /** The side the photo is resized to before tiling. */
  longSide?: number;
  rows?: number;
  cols?: number;
  overlap?: number;
}

export interface TilePlan {
  /** `longSide / max(width, height)` — what photo pixels were multiplied by. */
  scale: number;
  workingWidth: number;
  workingHeight: number;
  /** Crop windows in SOURCE photo pixels. */
  tiles: TileRect[];
}

/** The single full-frame pass, at the resolution SW-01's best config used. */
export const DEFAULT_TILE_PLAN: Required<TilePlanOptions> = {
  longSide: 1280,
  rows: 1,
  cols: 1,
  overlap: 0,
};

/**
 * Verbatim port of `tile_boxes` in `ml/holds/common.py`, integer working pixels.
 *
 * Tiles overlap by `grid.overlap` of a tile side so a hold on a seam is whole in
 * at least one tile, and the last row/column is clamped to the image edge, so
 * the windows cover the image exactly with no padding. The integer rounding is
 * part of the contract, not an accident: the Python expectations in
 * `ml/holds/fixtures/expected-detections.json` were produced through these exact
 * `int(round(...))` / floor-division steps.
 */
export function tileWindows(width: number, height: number, grid: TileGrid): TileRect[] {
  if (grid.rows === 1 && grid.cols === 1) return [{ x0: 0, y0: 0, x1: width, y1: height }];

  const tileWidth = Math.round((width / grid.cols) * (1 + grid.overlap));
  const tileHeight = Math.round((height / grid.rows) * (1 + grid.overlap));
  const stepX = grid.cols > 1 ? Math.max(1, Math.floor((width - tileWidth) / Math.max(1, grid.cols - 1))) : width;
  const stepY = grid.rows > 1 ? Math.max(1, Math.floor((height - tileHeight) / Math.max(1, grid.rows - 1))) : height;

  const windows: TileRect[] = [];
  for (let row = 0; row < grid.rows; row += 1) {
    for (let col = 0; col < grid.cols; col += 1) {
      const x0 = Math.min(col * stepX, Math.max(0, width - tileWidth));
      const y0 = Math.min(row * stepY, Math.max(0, height - tileHeight));
      windows.push({ x0, y0, x1: Math.min(x0 + tileWidth, width), y1: Math.min(y0 + tileHeight, height) });
    }
  }
  return windows;
}

/**
 * Plan the passes for one photo: resize to `longSide`, cut the grid, and hand
 * the windows back in the photo's own pixels.
 *
 * `eval.py` resizes first and divides the finished boxes by the scale at the
 * end; expressing the windows in source pixels here is the same arithmetic with
 * the round trip taken out, so nothing downstream has to remember the scale.
 */
export function planTiles(width: number, height: number, options: TilePlanOptions = {}): TilePlan {
  const { longSide, rows, cols, overlap } = { ...DEFAULT_TILE_PLAN, ...options };
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`planTiles needs a positive image size, got ${width}x${height}`);
  }

  const scale = longSide / Math.max(width, height);
  const workingWidth = Math.max(1, Math.round(width * scale));
  const workingHeight = Math.max(1, Math.round(height * scale));

  return {
    scale,
    workingWidth,
    workingHeight,
    tiles: tileWindows(workingWidth, workingHeight, { rows, cols, overlap }).map((window) => ({
      x0: window.x0 / scale,
      y0: window.y0 / scale,
      x1: window.x1 / scale,
      y1: window.y1 / scale,
    })),
  };
}
