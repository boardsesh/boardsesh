/**
 * Turning a segmentation model's mask logits into the ring the renderer draws.
 *
 * This exists because the model changed. `candidates.ts` documents why there was
 * no outline before — the detector returned boxes, and the only silhouette on the
 * Python side was a classical in-box guess that stopped at a boolean mask with no
 * tracer to port. A segmentation config (`seg-nano-tiled-1024`, `mask_source:
 * "model"`) emits a third tensor of per-query mask logits, so there is now a real
 * silhouette to carry and a tracer worth writing.
 *
 * Three things here are load-bearing and each one is a way to get a visibly wrong
 * outline:
 *
 * 1. **Interpolate the logits, then threshold.** Not the other way round. This is
 *    what rfdetr's own `_postprocess_masks` does (`F.interpolate(..., mode=
 *    "bilinear") > 0.0`), and the order is not cosmetic: thresholding first at the
 *    mask head's own resolution and upsampling the binary result quantises every
 *    edge into mask-grid steps. Measured on the eval split, the wrong order drops
 *    outlines in the plausible 0.40–0.80 fill band from 96% to 79%.
 * 2. **Take the component under the box's centre**, not the largest one. A mask
 *    can carry a second blob where a neighbouring hold bled in; the query's own
 *    hold is the one its box points at.
 * 3. **The ring is in units of `r`, relative to the centre** — the
 *    `@boardsesh/board-art-geometry` contract that `spray_wall_holds.outline` and
 *    the renderer's rings already speak, so a consumer can swap one for the other
 *    with no conversion.
 */

import type { Box } from './types';

/** Where the mask grid is upsampled to before tracing, as a multiple of its own side. */
export const MASK_UPSAMPLE = 4;

/** Douglas–Peucker tolerance, in upsampled mask pixels. */
export const OUTLINE_SIMPLIFY_TOLERANCE = 1.5;

/** Below this many points a ring is not a shape, and the renderer should use its circle. */
const MIN_RING_POINTS = 3;

export interface MaskGrid {
  /** Row-major logits for ONE query, `height * width` long. Not thresholded. */
  logits: ArrayLike<number>;
  width: number;
  height: number;
}

export interface OutlineOptions {
  /** Multiple of the mask grid to trace at. Higher is smoother and slower. */
  upsample?: number;
  /** Simplification tolerance in upsampled pixels. */
  tolerance?: number;
  /**
   * The tile's real pixel size, when it is not square.
   *
   * The mask grid is square because the model's input is square, but a tile is
   * not: `tile_boxes` cuts `round(W / cols * (1 + overlap))` by the same in the
   * other axis, so a 1024x768 photo tiled 2x2 gives 589x442 tiles that the
   * `stretch` letterbox squashes into 312x312. Boxes survive that because they
   * are multiplied back by the tile's size; a ring would not, because it is
   * normalised by ONE radius while its two axes were scaled differently. On a
   * 4:3 photo that is a 1.33x distortion — every round hold comes out an ellipse.
   *
   * Pass the tile's pixel dimensions and the ring is un-stretched before it is
   * normalised. Omit them for a square tile, where it is a no-op.
   */
  tileWidth?: number;
  tileHeight?: number;
}

/**
 * One query's mask logits plus its box -> a ring in units of the box's
 * equivalent-circle radius, or `undefined` when there is no usable silhouette.
 *
 * `box` is normalised `x0, y0, x1, y1` in the same frame as the mask grid, which
 * is how {@link decodeRfDetr} hands boxes on.
 */
export function maskToOutline(mask: MaskGrid, box: Box, options: OutlineOptions = {}): number[] | undefined {
  const upsample = Math.max(1, Math.floor(options.upsample ?? MASK_UPSAMPLE));
  const tolerance = options.tolerance ?? OUTLINE_SIMPLIFY_TOLERANCE;
  if (mask.width <= 0 || mask.height <= 0) return undefined;

  const width = mask.width * upsample;
  const height = mask.height * upsample;

  // Only the neighbourhood of the box can belong to this query's hold, so the
  // window is cropped before upsampling. Bilinear interpolation is local, so this
  // is the same arithmetic as upsampling the whole grid, minus the work.
  const margin = 2 * upsample;
  const left = clamp(Math.floor(box[0] * width) - margin, 0, width - 1);
  const top = clamp(Math.floor(box[1] * height) - margin, 0, height - 1);
  const right = clamp(Math.ceil(box[2] * width) + margin, left + 1, width);
  const bottom = clamp(Math.ceil(box[3] * height) + margin, top + 1, height);
  const windowWidth = right - left;
  const windowHeight = bottom - top;
  if (windowWidth < 2 || windowHeight < 2) return undefined;

  const filled = new Uint8Array(windowWidth * windowHeight);
  for (let y = 0; y < windowHeight; y += 1) {
    for (let x = 0; x < windowWidth; x += 1) {
      // Threshold AFTER interpolating: sigmoid(v) > 0.5 is exactly v > 0.
      filled[y * windowWidth + x] = sampleBilinear(mask, (left + x) / upsample, (top + y) / upsample) > 0 ? 1 : 0;
    }
  }

  const centreX = Math.round(((box[0] + box[2]) / 2) * width) - left;
  const centreY = Math.round(((box[1] + box[3]) / 2) * height) - top;
  const component = componentAt(filled, windowWidth, windowHeight, centreX, centreY);
  if (!component) return undefined;

  const traced = traceBoundary(component, windowWidth, windowHeight);
  if (traced.length < MIN_RING_POINTS) return undefined;
  const simplified = simplify(traced, tolerance);
  if (simplified.length < MIN_RING_POINTS) return undefined;

  // Out of window pixels, into units of r about the box centre.
  //
  // Everything is converted to TILE pixels first. Doing the normalisation in the
  // square mask frame would divide two differently-scaled axes by one radius,
  // which is the ellipse described on `tileWidth`.
  const scaleX = options.tileWidth && options.tileWidth > 0 ? options.tileWidth / width : 1;
  const scaleY = options.tileHeight && options.tileHeight > 0 ? options.tileHeight / height : 1;

  const boxWidth = Math.max(0, box[2] - box[0]) * width * scaleX;
  const boxHeight = Math.max(0, box[3] - box[1]) * height * scaleY;
  const radius = Math.sqrt((boxWidth * boxHeight) / Math.PI);
  if (!(radius > 0)) return undefined;
  const originX = ((box[0] + box[2]) / 2) * width - left;
  const originY = ((box[1] + box[3]) / 2) * height - top;

  const ring: number[] = [];
  for (const [x, y] of simplified) {
    ring.push(round4(((x - originX) * scaleX) / radius), round4(((y - originY) * scaleY) / radius));
  }
  return ring;
}

/** Bilinear sample of the raw logits at a fractional mask-grid coordinate. */
function sampleBilinear(mask: MaskGrid, x: number, y: number): number {
  const clampedX = clamp(x - 0.5, 0, mask.width - 1);
  const clampedY = clamp(y - 0.5, 0, mask.height - 1);
  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(x0 + 1, mask.width - 1);
  const y1 = Math.min(y0 + 1, mask.height - 1);
  const fx = clampedX - x0;
  const fy = clampedY - y0;

  const topLeft = mask.logits[y0 * mask.width + x0];
  const topRight = mask.logits[y0 * mask.width + x1];
  const bottomLeft = mask.logits[y1 * mask.width + x0];
  const bottomRight = mask.logits[y1 * mask.width + x1];
  return topLeft * (1 - fx) * (1 - fy) + topRight * fx * (1 - fy) + bottomLeft * (1 - fx) * fy + bottomRight * fx * fy;
}

/**
 * The connected component covering (x, y), or the nearest one within the box when
 * the centre itself is not set — a crescent-shaped hold can have a hollow middle.
 */
function componentAt(filled: Uint8Array, width: number, height: number, x: number, y: number): Uint8Array | null {
  let seedX = clamp(x, 0, width - 1);
  let seedY = clamp(y, 0, height - 1);
  if (filled[seedY * width + seedX] !== 1) {
    const found = nearestSet(filled, width, height, seedX, seedY);
    if (!found) return null;
    [seedX, seedY] = found;
  }

  const component = new Uint8Array(filled.length);
  const stack = [seedY * width + seedX];
  component[stack[0]] = 1;
  while (stack.length) {
    const index = stack.pop() as number;
    const cx = index % width;
    const cy = (index - cx) / width;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const neighbour = ny * width + nx;
      if (component[neighbour] === 1 || filled[neighbour] !== 1) continue;
      component[neighbour] = 1;
      stack.push(neighbour);
    }
  }
  return component;
}

/** Spiral out from the centre for the closest set pixel. Bounded by the window. */
function nearestSet(filled: Uint8Array, width: number, height: number, x: number, y: number): [number, number] | null {
  const limit = Math.max(width, height);
  for (let radius = 1; radius < limit; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        if (filled[ny * width + nx] === 1) return [nx, ny];
      }
    }
  }
  return null;
}

/**
 * Moore-neighbourhood boundary following: walk the component's outer edge once,
 * clockwise, and return it as a closed ring of pixel coordinates.
 */
function traceBoundary(component: Uint8Array, width: number, height: number): Array<[number, number]> {
  let startIndex = -1;
  for (let index = 0; index < component.length; index += 1) {
    if (component[index] === 1) {
      startIndex = index;
      break;
    }
  }
  if (startIndex < 0) return [];

  const startX = startIndex % width;
  const startY = (startIndex - startX) / width;
  const neighbours: Array<[number, number]> = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
  ];

  const ring: Array<[number, number]> = [[startX, startY]];
  let currentX = startX;
  let currentY = startY;
  let direction = 0;
  // Each step leaves the boundary at most one pixel further on, so the perimeter
  // bounds the walk; the cap is a backstop against a malformed component.
  const maxSteps = 4 * (width + height) + 16;

  for (let step = 0; step < maxSteps; step += 1) {
    let moved = false;
    // Start looking one step back from where we came, so the walk hugs the edge.
    for (let probe = 0; probe < neighbours.length; probe += 1) {
      const candidate = (direction + 6 + probe) % neighbours.length;
      const [dx, dy] = neighbours[candidate];
      const nx = currentX + dx;
      const ny = currentY + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (component[ny * width + nx] !== 1) continue;
      currentX = nx;
      currentY = ny;
      direction = candidate;
      moved = true;
      break;
    }
    if (!moved) break;
    if (currentX === startX && currentY === startY) break;
    ring.push([currentX, currentY]);
  }
  return ring;
}

/** Douglas–Peucker on a closed ring. */
function simplify(points: Array<[number, number]>, tolerance: number): Array<[number, number]> {
  if (points.length <= MIN_RING_POINTS || tolerance <= 0) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];

  while (stack.length) {
    const [first, last] = stack.pop() as [number, number];
    let furthest = -1;
    let furthestDistance = tolerance;
    for (let index = first + 1; index < last; index += 1) {
      const distance = perpendicularDistance(points[index], points[first], points[last]);
      if (distance > furthestDistance) {
        furthest = index;
        furthestDistance = distance;
      }
    }
    if (furthest >= 0) {
      keep[furthest] = 1;
      stack.push([first, furthest], [furthest, last]);
    }
  }
  return points.filter((_, index) => keep[index] === 1);
}

function perpendicularDistance(point: [number, number], start: [number, number], end: [number, number]): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const t = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared;
  const clamped = Math.max(0, Math.min(1, t));
  return Math.hypot(point[0] - (start[0] + clamped * dx), point[1] - (start[1] + clamped * dy));
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
