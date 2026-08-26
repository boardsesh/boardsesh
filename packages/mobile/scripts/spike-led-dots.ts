/// <reference types="node" />

/**
 * Spike (issue #2202): which holds have an LED, and where the board art already
 * draws one.
 *
 * Usage: vp run spike:led-dots
 *
 * The white dots at the centre of Grasshopper's holds are not bolt holes, they
 * are LED locations painted into the art — and they are painted inconsistently.
 * Measured over the composited stack, 234 of 305 sampled Grasshopper placements
 * have a centre more than 2.5x brighter than the surrounding hold (median 10.2x),
 * while Tension Original draws the same location *darker* than the hold (median
 * 0.29x) and Kilter draws a dark bolt hole (0.42x).
 *
 * That inconsistency is a problem for every treatment here: an unlit white LED
 * dot competes with a lit mark, and a lit hold whose LED is drawn dark does not
 * look lit. So the renderer takes the LED over from the art — role colour where
 * the hold is lit, dark where it is not — and to do that it needs to know both
 * which placements carry an LED and which ones the art has already brightened.
 *
 * Taking a painted LED over means covering it, and the painter did not put it on
 * the placement: on Grasshopper the bright blob's centroid sits a median 2.2
 * board px away, which is why a dot drawn at the placement centre leaves a bright
 * crescent on 190 of 316 unlit holds. So each flagged placement also carries the
 * offset from the drawn dot to the blob it has to cover.
 *
 * Physically the LED sits centrally on Grasshopper, Tension and Woods; Kilter
 * lights the translucent hold base so the rim glows (its centre is the bolt
 * hole, which is the location to light there); and MoonBoard puts its LED in the
 * gap below the hold.
 *
 * MoonBoard has no LED table in `@boardsesh/board-constants`, but it does not
 * need one: its holds and LEDs are both on a regular grid, with the LED grid
 * offset down by half a row so an LED sits halfway between each vertically
 * adjacent pair of holds — no LEDs above the top row, one below the bottom row,
 * so every hold maps to the LED half a cell below it. That offset is derived
 * here from the placement spacing rather than hardcoded.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';
import { getLedPlacements } from '@boardsesh/board-constants/led-placements';
import { getBoardRenderData } from '../src/lib/board-details';
import { SPIKE_BOARDS } from '../src/components/board-spike/spike-boards';

const ROOT_DIR = path.resolve(import.meta.dirname, '../../..');
const IMAGES_DIR = path.join(ROOT_DIR, 'packages/web/public/images');
const OUTPUT_FILE = path.join(ROOT_DIR, 'packages/mobile/src/components/board-spike/spike-led-dots.ts');

/** Radius of the sample disc at the LED, in board pixels. */
const CENTRE_SAMPLE_RADIUS = 3;
/** A centre this many times brighter than the surrounding hold is a painted LED. */
const BRIGHT_RATIO = 2.5;
/**
 * And bright in absolute terms, not only relative to its own hold. On the ratio
 * alone Kilter Original flags ten mid-grey bolt holes whose ratios (2.52-3.41)
 * sit on a continuum with the unflagged ones (2.38-2.44) — a dark hole in a
 * darker hold, which the takeover has nothing to cover. Measured on the blob,
 * those ten reach 0.44 linear luma at best while all 234 of Grasshopper's
 * painted LEDs are 0.967 and up, so anywhere in that gap separates them.
 */
const BRIGHT_LUMA_FLOOR = 0.6;
/** How far from the LED to look for the blob's brightest pixel, in board pixels. */
const BLOB_SEED_RADIUS = 4;
/** Pixels this bright and up are part of the painted blob. */
const BLOB_LUMA_THRESHOLD = 0.5;
/**
 * Hard stop on the flood, in board pixels from its seed. Grasshopper's blobs run
 * about 4.2 px in radius (p90 4.33), so three times that reaches all of one and
 * still keeps a hold whose whole face is near-white from dragging the centroid
 * off the LED.
 */
const BLOB_MAX_RADIUS = 12;
/** 4-connected neighbours, the steps the flood walks. */
const NEIGHBOUR_STEPS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const srgbToLinear = (channel: number): number =>
  channel / 255 <= 0.04045 ? channel / 255 / 12.92 : ((channel / 255 + 0.055) / 1.055) ** 2.4;

const luma = (red: number, green: number, blue: number): number =>
  0.2126 * srgbToLinear(red) + 0.7152 * srgbToLinear(green) + 0.0722 * srgbToLinear(blue);

async function measureBoard(board: (typeof SPIKE_BOARDS)[number]) {
  const renderData = getBoardRenderData({
    boardName: board.boardName,
    layoutId: board.layoutId,
    sizeId: board.sizeId,
    setIds: [...board.setIds],
  });
  if (!renderData) throw new Error(`${board.key}: no render data`);
  const { boardWidth, boardHeight, holdsData, backgroundImageKeys } = renderData;
  const rawLayer = { width: boardWidth, height: boardHeight, channels: 4 as const };

  let composite: Buffer | null = null;
  for (const key of backgroundImageKeys) {
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
  if (composite === null) throw new Error(`${board.key}: no layers`);

  let ledPlacements: Record<number, number> = {};
  try {
    ledPlacements = getLedPlacements(board.boardName, board.layoutId, board.sizeId);
  } catch {
    ledPlacements = {};
  }

  /** Linear luma of one board pixel; null off the board or where the art is transparent. */
  const lumaAt = (x: number, y: number): number | null => {
    if (x < 0 || y < 0 || x >= boardWidth || y >= boardHeight) return null;
    const offset = (y * boardWidth + x) * 4;
    if (composite[offset + 3] < 128) return null;
    return luma(composite[offset], composite[offset + 1], composite[offset + 2]);
  };

  const sampleDisc = (centreX: number, centreY: number, outer: number, inner = 0): number | null => {
    let total = 0;
    let count = 0;
    const bound = Math.ceil(outer);
    for (let dy = -bound; dy <= bound; dy += 1) {
      for (let dx = -bound; dx <= bound; dx += 1) {
        const distance = dx * dx + dy * dy;
        if (distance > outer * outer || distance < inner * inner) continue;
        const value = lumaAt(Math.round(centreX + dx), Math.round(centreY + dy));
        if (value === null) continue;
        total += value;
        count += 1;
      }
    }
    return count === 0 ? null : total / count;
  };

  /**
   * The painted blob at the dot: where it sits relative to the dot, and how
   * bright it is where it sits.
   *
   * Both have to be measured on the blob rather than at the dot. On Grasshopper
   * the blob is a median 2.15 board px off (p90 3.69, max 6.20) — far enough
   * that a disc sampled at the dot is half dark hold, and 35 of the 234 read
   * below the floor there while every one of them is above 0.96 on the blob.
   * Seeded on the brightest pixel near the dot for the same reason: the dot is
   * as likely to sit on the blob's edge as inside it.
   */
  const findLedBlob = (ledX: number, ledY: number): { offset: [number, number]; luma: number } | null => {
    const anchorX = Math.round(ledX);
    const anchorY = Math.round(ledY);
    let seedX = -1;
    let seedY = -1;
    let seedLuma = BLOB_LUMA_THRESHOLD;
    for (let dy = -BLOB_SEED_RADIUS; dy <= BLOB_SEED_RADIUS; dy += 1) {
      for (let dx = -BLOB_SEED_RADIUS; dx <= BLOB_SEED_RADIUS; dx += 1) {
        if (dx * dx + dy * dy > BLOB_SEED_RADIUS * BLOB_SEED_RADIUS) continue;
        const value = lumaAt(anchorX + dx, anchorY + dy);
        if (value === null || value < seedLuma) continue;
        seedLuma = value;
        seedX = anchorX + dx;
        seedY = anchorY + dy;
      }
    }
    if (seedX < 0) return null;

    const seedIndex = seedY * boardWidth + seedX;
    const visited = new Set<number>([seedIndex]);
    const pending = [seedIndex];
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    while (pending.length > 0) {
      const index = pending.pop();
      if (index === undefined) break;
      const x = index % boardWidth;
      const y = (index - x) / boardWidth;
      sumX += x;
      sumY += y;
      count += 1;
      for (const [stepX, stepY] of NEIGHBOUR_STEPS) {
        const nextX = x + stepX;
        const nextY = y + stepY;
        if (Math.abs(nextX - seedX) > BLOB_MAX_RADIUS || Math.abs(nextY - seedY) > BLOB_MAX_RADIUS) continue;
        const nextIndex = nextY * boardWidth + nextX;
        if (visited.has(nextIndex)) continue;
        const value = lumaAt(nextX, nextY);
        if (value === null || value < BLOB_LUMA_THRESHOLD) continue;
        visited.add(nextIndex);
        pending.push(nextIndex);
      }
    }
    if (count === 0) return null;
    const blobX = sumX / count;
    const blobY = sumY / count;
    return {
      offset: [Number((blobX - ledX).toFixed(2)), Number((blobY - ledY).toFixed(2))],
      luma: sampleDisc(blobX, blobY, CENTRE_SAMPLE_RADIUS) ?? 0,
    };
  };

  // MoonBoard: every hold has an LED, sitting half a row below it.
  const isGridLedBoard = board.boardName === 'moonboard';
  let ledOffsetY = 0;
  if (isGridLedBoard) {
    const rows = [...new Set(holdsData.map((hold) => Math.round(hold.cy)))].sort((a, b) => a - b);
    const gaps = rows.slice(1).map((row, index) => row - rows[index]);
    gaps.sort((a, b) => a - b);
    const rowSpacing = gaps[Math.floor(gaps.length / 2)] ?? 0;
    ledOffsetY = rowSpacing / 2;
  }

  const hasLed: number[] = [];
  const brightInArt: number[] = [];
  const brightOffsets: Record<number, [number, number]> = {};
  for (const hold of holdsData) {
    if (isGridLedBoard || ledPlacements[hold.id] !== undefined) hasLed.push(hold.id);
    // Measure where the dot is drawn, not where the placement is. On MoonBoard
    // those are 25 board px apart and the art at the dot is bare play field.
    const ledY = hold.cy + ledOffsetY;
    const centre = sampleDisc(hold.cx, ledY, CENTRE_SAMPLE_RADIUS);
    const surround = sampleDisc(hold.cx, ledY, hold.r * 0.55, hold.r * 0.3);
    if (centre === null || surround === null) continue;
    if (centre / Math.max(1e-4, surround) <= BRIGHT_RATIO) continue;
    const blob = findLedBlob(hold.cx, ledY);
    if (blob === null || blob.luma < BRIGHT_LUMA_FLOOR) continue;
    brightInArt.push(hold.id);
    brightOffsets[hold.id] = blob.offset;
  }

  const offsetDistances = Object.values(brightOffsets)
    .map(([dx, dy]) => Math.hypot(dx, dy))
    .sort((a, b) => a - b);
  const medianOffset = offsetDistances[Math.floor(offsetDistances.length / 2)] ?? 0;

  console.log(
    `[spike] ${board.key.padEnd(24)} ${hasLed.length}/${holdsData.length} carry an LED` +
      (ledOffsetY > 0 ? ` (offset ${ledOffsetY.toFixed(1)}px below the hold)` : '') +
      `, ${brightInArt.length} already drawn bright in the art` +
      (offsetDistances.length > 0 ? `, blob a median ${medianOffset.toFixed(2)}px off the dot` : ''),
  );
  return { hasLed, brightInArt, brightOffsets, ledOffsetY: Number(ledOffsetY.toFixed(2)) };
}

type BoardLedDots = {
  hasLed: number[];
  brightInArt: number[];
  brightOffsets: Record<number, [number, number]>;
  ledOffsetY: number;
};

async function main(): Promise<number> {
  const perBoard: Array<[string, BoardLedDots]> = [];
  for (const board of SPIKE_BOARDS) perBoard.push([board.key, await measureBoard(board)]);

  const body = perBoard
    .map(
      ([key, value]) =>
        `  '${key}': {\n` +
        `    hasLed: [${value.hasLed.join(',')}],\n` +
        `    brightInArt: [${value.brightInArt.join(',')}],\n` +
        `    brightOffsets: {${Object.entries(value.brightOffsets)
          .map(([id, [dx, dy]]) => `${id}:[${dx},${dy}]`)
          .join(',')}},\n` +
        `    ledOffsetY: ${value.ledOffsetY},\n` +
        `  },`,
    )
    .join('\n');

  writeFileSync(
    OUTPUT_FILE,
    `// Generated by packages/mobile/scripts/spike-led-dots.ts — do not edit by hand.\n` +
      `// hasLed: placements with an LED — from @boardsesh/board-constants on Aurora boards,\n` +
      `//   and every hold on MoonBoard, whose LEDs sit on a regular grid half a row below.\n` +
      `// brightInArt: placements whose LED location the board art already paints bright.\n` +
      `// brightOffsets: for those placements, [dx, dy] board pixels from the point the dot is\n` +
      `//   drawn at — (cx, cy + ledOffsetY) — to the centroid of the bright blob it has to cover.\n` +
      `// ledOffsetY: board pixels below the placement centre where the LED sits (0 = central).\n` +
      `export const SPIKE_LED_DOTS: Record<\n` +
      `  string,\n` +
      `  {\n` +
      `    hasLed: number[];\n` +
      `    brightInArt: number[];\n` +
      `    brightOffsets: Partial<Record<number, [number, number]>>;\n` +
      `    ledOffsetY: number;\n` +
      `  }\n` +
      `> = {\n` +
      `${body}\n};\n`,
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
