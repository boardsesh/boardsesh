/// <reference types="node" />

/**
 * Spike (issue #2202): trace the actual silhouette of every hold on a board.
 *
 * Usage: vp run spike:hold-outlines
 *
 * The point of a halo, per the issue, is to show the *shape* of the hold so you
 * can find that shape on the wall — and hold shapes on one board range from a
 * fingernail-sized foot chip to a jug three times its width. A ring at the
 * placement radius says nothing about either. So this traces the real outline
 * out of the art's alpha channel and ships it as paths the renderer can stroke.
 *
 * Per placement: flood-fill the opaque region under the placement centre
 * (bounded to a box around it so a hold that touches its neighbour cannot run
 * away across the board), follow the outer border of that region, then simplify
 * with Douglas-Peucker. Coordinates are emitted as integers relative to the
 * placement centre, so the renderer adds cx/cy and strokes.
 *
 * Known limits, both visible in the output: a hold whose art touches a
 * neighbour's yields the merged blob, and a placement with no art under it
 * (a mounting hole) yields nothing and is simply absent from the table.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';
import { getHolePlacements, getImageFilename, getProductSize } from '@boardsesh/board-constants/product-sizes';

const ROOT_DIR = path.resolve(import.meta.dirname, '../../..');
const SOURCE_DIR = path.join(ROOT_DIR, 'packages/web/public/images/grasshopper/product_sizes_layouts_sets');
const OUTPUT_FILE = path.join(ROOT_DIR, 'packages/mobile/src/components/board-spike/spike-hold-outlines.ts');

/** Must match SPIKE_BOARD in src/components/board-spike/spike-config.ts. */
const BOARD_NAME = 'grasshopper' as const;
const LAYOUT_ID = 1;
const SIZE_ID = 5;
const SET_IDS = [1, 2, 3, 4, 6];

/** A pixel counts as hold if its alpha is at least this. */
const ALPHA_FLOOR = 96;
/** Half-width of the search box around a placement, in placement radii. */
const SEARCH_RADII = 1.25;
/** Douglas-Peucker tolerance in board pixels. Bigger = fewer points, blockier outline. */
const SIMPLIFY_EPSILON = 1.6;
/** Outlines shorter than this many pixels of perimeter are noise, not a hold. */
const MIN_PERIMETER_POINTS = 24;

type Point = [number, number];

/** Moore-neighbour border following, clockwise, from the leftmost-topmost filled pixel. */
function traceBorder(filled: Uint8Array, width: number, height: number, start: Point): Point[] {
  const at = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && filled[y * width + x] === 1;
  // Clockwise neighbourhood, starting west.
  const offsets: Point[] = [
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
  ];
  const border: Point[] = [];
  let current = start;
  let backtrackIndex = 0;
  const maxSteps = width * height * 4;

  for (let step = 0; step < maxSteps; step += 1) {
    border.push(current);
    let moved = false;
    for (let turn = 1; turn <= 8; turn += 1) {
      const index = (backtrackIndex + turn) % 8;
      const candidate: Point = [current[0] + offsets[index][0], current[1] + offsets[index][1]];
      if (!at(candidate[0], candidate[1])) continue;
      // Re-enter from the direction we came, so the next scan starts behind us.
      backtrackIndex = (index + 5) % 8;
      current = candidate;
      moved = true;
      break;
    }
    if (!moved) break;
    if (current[0] === start[0] && current[1] === start[1] && border.length > 2) break;
  }
  return border;
}

function perpendicularDistance(point: Point, lineStart: Point, lineEnd: Point): number {
  const dx = lineEnd[0] - lineStart[0];
  const dy = lineEnd[1] - lineStart[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) return Math.hypot(point[0] - lineStart[0], point[1] - lineStart[1]);
  return Math.abs(dy * point[0] - dx * point[1] + lineEnd[0] * lineStart[1] - lineEnd[1] * lineStart[0]) / length;
}

function simplify(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points;
  let worstIndex = 0;
  let worstDistance = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const distance = perpendicularDistance(points[index], points[0], points[points.length - 1]);
    if (distance > worstDistance) {
      worstDistance = distance;
      worstIndex = index;
    }
  }
  if (worstDistance <= epsilon) return [points[0], points[points.length - 1]];
  return [
    ...simplify(points.slice(0, worstIndex + 1), epsilon).slice(0, -1),
    ...simplify(points.slice(worstIndex), epsilon),
  ];
}

async function main(): Promise<number> {
  const size = getProductSize(BOARD_NAME, SIZE_ID);
  if (!size) throw new Error(`unknown product size ${SIZE_ID}`);
  const { edgeLeft, edgeRight, edgeBottom, edgeTop } = size;

  const layerFiles: string[] = [];
  const placementTuples: Array<[number, number | null, number, number]> = [];
  for (const setId of SET_IDS) {
    const filename = getImageFilename(BOARD_NAME, LAYOUT_ID, SIZE_ID, setId);
    if (!filename) continue;
    layerFiles.push(path.join(SOURCE_DIR, path.basename(filename).replace(/\.png$/, '.webp')));
    placementTuples.push(...getHolePlacements(BOARD_NAME, LAYOUT_ID, setId));
  }

  const { width, height } = await sharp(layerFiles[0]).metadata();
  if (width === undefined || height === undefined) throw new Error('source layer has no dimensions');
  const rawLayer = { width, height, channels: 4 as const };

  let composite: Buffer | null = null;
  for (const file of layerFiles) {
    const layer = await sharp(file).ensureAlpha().raw().toBuffer();
    composite =
      composite === null
        ? layer
        : await sharp(composite, { raw: rawLayer })
            .composite([{ input: layer, raw: rawLayer, blend: 'over' }])
            .raw()
            .toBuffer();
  }
  if (composite === null) throw new Error('no layers composited');

  const opaque = new Uint8Array(width * height);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    opaque[pixel] = composite[pixel * 4 + 3] >= ALPHA_FLOOR ? 1 : 0;
  }

  const xSpacing = width / (edgeRight - edgeLeft);
  const ySpacing = height / (edgeTop - edgeBottom);
  const radius = xSpacing * 4;
  const box = Math.round(radius * SEARCH_RADII);

  const outlines = new Map<number, number[]>();
  let missing = 0;
  let pointTotal = 0;

  for (const [holdId, , gridX, gridY] of placementTuples) {
    if (gridX <= edgeLeft || gridX >= edgeRight || gridY <= edgeBottom || gridY >= edgeTop) continue;
    if (outlines.has(holdId)) continue;
    const centreX = Math.round((gridX - edgeLeft) * xSpacing);
    const centreY = Math.round(height - (gridY - edgeBottom) * ySpacing);

    // Local mask, so a hold touching its neighbour cannot flood the whole board.
    const left = Math.max(0, centreX - box);
    const top = Math.max(0, centreY - box);
    const right = Math.min(width - 1, centreX + box);
    const bottom = Math.min(height - 1, centreY + box);
    const localWidth = right - left + 1;
    const localHeight = bottom - top + 1;
    const local = new Uint8Array(localWidth * localHeight);
    for (let y = 0; y < localHeight; y += 1) {
      for (let x = 0; x < localWidth; x += 1) {
        local[y * localWidth + x] = opaque[(top + y) * width + (left + x)];
      }
    }

    // Seed: the placement centre if it is on the hold, else the nearest filled
    // pixel to it — some placements sit on a bolt hole punched out of the art.
    let seed: Point | null = null;
    const localCentre: Point = [centreX - left, centreY - top];
    if (local[localCentre[1] * localWidth + localCentre[0]] === 1) {
      seed = localCentre;
    } else {
      let bestDistance = Infinity;
      for (let y = 0; y < localHeight; y += 1) {
        for (let x = 0; x < localWidth; x += 1) {
          if (local[y * localWidth + x] !== 1) continue;
          const distance = (x - localCentre[0]) ** 2 + (y - localCentre[1]) ** 2;
          if (distance < bestDistance) {
            bestDistance = distance;
            seed = [x, y];
          }
        }
      }
    }
    if (seed === null) {
      missing += 1;
      continue;
    }

    // Flood-fill the connected region so neighbouring holds inside the box are
    // excluded from the trace.
    const region = new Uint8Array(localWidth * localHeight);
    const stack: number[] = [seed[1] * localWidth + seed[0]];
    region[stack[0]] = 1;
    let topmost = seed;
    while (stack.length > 0) {
      const index = stack.pop() as number;
      const x = index % localWidth;
      const y = (index - x) / localWidth;
      if (y < topmost[1] || (y === topmost[1] && x < topmost[0])) topmost = [x, y];
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as Point[]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= localWidth || ny >= localHeight) continue;
        const neighbour = ny * localWidth + nx;
        if (region[neighbour] === 1 || local[neighbour] !== 1) continue;
        region[neighbour] = 1;
        stack.push(neighbour);
      }
    }

    const border = traceBorder(region, localWidth, localHeight, topmost);
    if (border.length < MIN_PERIMETER_POINTS) {
      missing += 1;
      continue;
    }
    const simplified = simplify(border, SIMPLIFY_EPSILON);
    // Relative to the placement centre in board pixels, so the renderer only
    // has to add cx/cy — the same space the overlay already works in.
    const flat: number[] = [];
    for (const [x, y] of simplified) {
      flat.push(Math.round(left + x - centreX), Math.round(top + y - centreY));
    }
    outlines.set(holdId, flat);
    pointTotal += simplified.length;
  }

  const entries = [...outlines.entries()].sort((a, b) => a[0] - b[0]);
  console.log(
    `[spike] traced ${entries.length} outlines (${missing} placements had no usable art), ` +
      `${(pointTotal / entries.length).toFixed(1)} points each on average`,
  );

  writeFileSync(
    OUTPUT_FILE,
    `// Generated by packages/mobile/scripts/spike-hold-outlines.ts — do not edit by hand.\n` +
      `// Each hold's real silhouette, traced out of the board art's alpha channel, as flat\n` +
      `// [x0, y0, x1, y1, ...] board pixels RELATIVE to the placement centre.\n` +
      `// Grasshopper layout 1 / size 5 / sets ${SET_IDS.join(',')}.\n` +
      `export const SPIKE_HOLD_OUTLINES: Record<number, number[]> = {\n` +
      entries.map(([holdId, flat]) => `  ${holdId}: [${flat.join(',')}],`).join('\n') +
      `\n};\n`,
  );
  console.log(`[spike] wrote ${path.relative(ROOT_DIR, OUTPUT_FILE)}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('[spike] failed:', error);
    process.exit(1);
  });
