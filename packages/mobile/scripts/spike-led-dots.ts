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

/** Radius of the sample disc at the placement centre, in board pixels. */
const CENTRE_SAMPLE_RADIUS = 3;
/** A centre this many times brighter than the surrounding hold is a painted LED. */
const BRIGHT_RATIO = 2.5;

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

  const sampleDisc = (centreX: number, centreY: number, outer: number, inner = 0): number | null => {
    let total = 0;
    let count = 0;
    const bound = Math.ceil(outer);
    for (let dy = -bound; dy <= bound; dy += 1) {
      for (let dx = -bound; dx <= bound; dx += 1) {
        const distance = dx * dx + dy * dy;
        if (distance > outer * outer || distance < inner * inner) continue;
        const x = Math.round(centreX + dx);
        const y = Math.round(centreY + dy);
        if (x < 0 || y < 0 || x >= boardWidth || y >= boardHeight) continue;
        const offset = (y * boardWidth + x) * 4;
        if (composite[offset + 3] < 128) continue;
        total += luma(composite[offset], composite[offset + 1], composite[offset + 2]);
        count += 1;
      }
    }
    return count === 0 ? null : total / count;
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
  for (const hold of holdsData) {
    if (isGridLedBoard || ledPlacements[hold.id] !== undefined) hasLed.push(hold.id);
    const centre = sampleDisc(hold.cx, hold.cy, CENTRE_SAMPLE_RADIUS);
    const surround = sampleDisc(hold.cx, hold.cy, hold.r * 0.55, hold.r * 0.3);
    if (centre === null || surround === null) continue;
    if (centre / Math.max(1e-4, surround) > BRIGHT_RATIO) brightInArt.push(hold.id);
  }

  console.log(
    `[spike] ${board.key.padEnd(24)} ${hasLed.length}/${holdsData.length} carry an LED` +
      (ledOffsetY > 0 ? ` (offset ${ledOffsetY.toFixed(1)}px below the hold)` : '') +
      `, ${brightInArt.length} already drawn bright in the art`,
  );
  return { hasLed, brightInArt, ledOffsetY: Number(ledOffsetY.toFixed(2)) };
}

async function main(): Promise<number> {
  const perBoard: Array<[string, { hasLed: number[]; brightInArt: number[]; ledOffsetY: number }]> = [];
  for (const board of SPIKE_BOARDS) perBoard.push([board.key, await measureBoard(board)]);

  const body = perBoard
    .map(
      ([key, value]) =>
        `  '${key}': {\n` +
        `    hasLed: [${value.hasLed.join(',')}],\n` +
        `    brightInArt: [${value.brightInArt.join(',')}],\n` +
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
      `// ledOffsetY: board pixels below the placement centre where the LED sits (0 = central).\n` +
      `export const SPIKE_LED_DOTS: Record<\n` +
      `  string,\n` +
      `  { hasLed: number[]; brightInArt: number[]; ledOffsetY: number }\n` +
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
