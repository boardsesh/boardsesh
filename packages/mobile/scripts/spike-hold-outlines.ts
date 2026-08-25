/// <reference types="node" />

/**
 * Spike (issue #2202): trace the actual silhouette of every hold, on every board
 * the spike draws.
 *
 * Usage: vp run spike:hold-outlines
 *
 * The point of a halo, per the issue, is to show the *shape* of the hold so you
 * can find that shape on the wall — and hold sizes on one board range from a
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
 * yields nothing and is simply absent from the table. The second is not an edge
 * case on MoonBoard — its placements are a synthetic 11x18 grid, and most cells
 * genuinely have no hold — so consumers must fall back to a ring.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';
import { getBoardRenderData } from '../src/lib/board-details';
import { SPIKE_BOARDS } from '../src/components/board-spike/spike-boards';

const ROOT_DIR = path.resolve(import.meta.dirname, '../../..');
const IMAGES_DIR = path.join(ROOT_DIR, 'packages/web/public/images');
const OUTPUT_FILE = path.join(ROOT_DIR, 'packages/mobile/src/components/board-spike/spike-hold-outlines.ts');

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

async function traceBoard(boardKey: string, boardName: string, layoutId: number, sizeId: number, setIds: number[]) {
  const renderData = getBoardRenderData({ boardName: boardName as never, layoutId, sizeId, setIds });
  if (!renderData) throw new Error(`${boardKey}: no render data`);
  const { boardWidth, boardHeight, holdsData, backgroundImageKeys } = renderData;
  const rawLayer = { width: boardWidth, height: boardHeight, channels: 4 as const };

  let composite: Buffer | null = null;
  for (const key of backgroundImageKeys) {
    // Board art is authored at assorted sizes; the placement coordinates are in
    // board space, so every layer is resampled to it before compositing.
    const layer = await sharp(path.join(IMAGES_DIR, key))
      .resize(boardWidth, boardHeight, { fit: 'fill' })
      .ensureAlpha()
      .raw()
      .toBuffer();
    composite =
      composite === null
        ? layer
        : await sharp(composite, { raw: rawLayer })
            .composite([{ input: layer, raw: rawLayer, blend: 'over' }])
            .raw()
            .toBuffer();
  }
  if (composite === null) throw new Error(`${boardKey}: no layers`);

  const opaque = new Uint8Array(boardWidth * boardHeight);
  for (let pixel = 0; pixel < boardWidth * boardHeight; pixel += 1) {
    opaque[pixel] = composite[pixel * 4 + 3] >= ALPHA_FLOOR ? 1 : 0;
  }

  const outlines = new Map<number, number[]>();
  let missing = 0;
  let pointTotal = 0;

  for (const placement of holdsData) {
    if (outlines.has(placement.id)) continue;
    const centreX = Math.round(placement.cx);
    const centreY = Math.round(placement.cy);
    const box = Math.round(placement.r * SEARCH_RADII);

    const left = Math.max(0, centreX - box);
    const top = Math.max(0, centreY - box);
    const right = Math.min(boardWidth - 1, centreX + box);
    const bottom = Math.min(boardHeight - 1, centreY + box);
    if (right <= left || bottom <= top) {
      missing += 1;
      continue;
    }
    const localWidth = right - left + 1;
    const localHeight = bottom - top + 1;
    const local = new Uint8Array(localWidth * localHeight);
    for (let y = 0; y < localHeight; y += 1) {
      for (let x = 0; x < localWidth; x += 1) {
        local[y * localWidth + x] = opaque[(top + y) * boardWidth + (left + x)];
      }
    }

    // Seed at the placement centre, or the nearest filled pixel to it — some
    // placements sit on a bolt hole punched out of the art. On MoonBoard most
    // grid cells have no art at all and drop out here.
    let seed: Point | null = null;
    const localCentre: Point = [centreX - left, centreY - top];
    if (
      localCentre[0] >= 0 &&
      localCentre[1] >= 0 &&
      localCentre[0] < localWidth &&
      localCentre[1] < localHeight &&
      local[localCentre[1] * localWidth + localCentre[0]] === 1
    ) {
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
    const flat: number[] = [];
    for (const [x, y] of simplified) {
      flat.push(Math.round(left + x - centreX), Math.round(top + y - centreY));
    }
    outlines.set(placement.id, flat);
    pointTotal += simplified.length;
  }

  console.log(
    `[spike] ${boardKey.padEnd(24)} ${outlines.size}/${holdsData.length} traced ` +
      `(${missing} with no usable art), ${outlines.size > 0 ? (pointTotal / outlines.size).toFixed(1) : '0'} points each`,
  );
  return outlines;
}

async function main(): Promise<number> {
  const perBoard: Array<[string, Map<number, number[]>]> = [];
  for (const board of SPIKE_BOARDS) {
    perBoard.push([
      board.key,
      await traceBoard(board.key, board.boardName, board.layoutId, board.sizeId, board.setIds),
    ]);
  }

  const body = perBoard
    .map(([boardKey, outlines]) => {
      const entries = [...outlines.entries()].sort((a, b) => a[0] - b[0]);
      return `  '${boardKey}': {\n${entries.map(([holdId, flat]) => `    ${holdId}: [${flat.join(',')}],`).join('\n')}\n  },`;
    })
    .join('\n');

  writeFileSync(
    OUTPUT_FILE,
    `// Generated by packages/mobile/scripts/spike-hold-outlines.ts — do not edit by hand.\n` +
      `// Each hold's real silhouette, traced out of the board art's alpha channel, as flat\n` +
      `// [x0, y0, x1, y1, ...] board pixels RELATIVE to the placement centre, keyed by the\n` +
      `// board keys in spike-boards.ts. A placement with no traceable art is absent.\n` +
      `export const SPIKE_HOLD_OUTLINES: Record<string, Record<number, number[]>> = {\n${body}\n};\n`,
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
