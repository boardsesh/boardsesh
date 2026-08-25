/// <reference types="node" />

/**
 * Spike (issue #2202): measure how light the board art is under each selector ring.
 *
 * Usage: vp run spike:hold-lightness
 *
 * The issue suggests CSS's `contrast-color()`, whose whole idea is "pick the
 * foreground that contrasts with whatever is behind it". There is no CSS in a
 * React Native board, and nothing at runtime can sample the composited board
 * photo — so the sampling happens here, offline, and ships as a lookup the
 * renderer can read.
 *
 * For every hold placement it samples the *annulus the ring is actually drawn
 * in* (0.85r to 1.15r), not the hold body: a ring's legibility is decided by
 * what it crosses, and a pale hold with dark gaps around it is a different
 * problem from a pale hold on pale art. Alpha-weighted, so the transparent gaps
 * between holds count as the play field rather than as black.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';
import { getBoardRenderData } from '../src/lib/board-details';
import { SPIKE_BOARDS } from '../src/components/board-spike/spike-boards';

const ROOT_DIR = path.resolve(import.meta.dirname, '../../..');
const IMAGES_DIR = path.join(ROOT_DIR, 'packages/web/public/images');
const OUTPUT_FILE = path.join(ROOT_DIR, 'packages/mobile/src/components/board-spike/spike-hold-lightness.ts');

/** Annulus the selector ring occupies, as fractions of the placement radius. */
const INNER_FRACTION = 0.85;
const OUTER_FRACTION = 1.15;

function srgbToLinear(channel: number): number {
  const normalised = channel / 255;
  return normalised <= 0.04045 ? normalised / 12.92 : ((normalised + 0.055) / 1.055) ** 2.4;
}

function oklabLightness(red: number, green: number, blue: number): number {
  const linearRed = srgbToLinear(red);
  const linearGreen = srgbToLinear(green);
  const linearBlue = srgbToLinear(blue);
  const long = Math.cbrt(0.4122214708 * linearRed + 0.5363325363 * linearGreen + 0.0514459929 * linearBlue);
  const medium = Math.cbrt(0.2119034982 * linearRed + 0.6806995451 * linearGreen + 0.1073969566 * linearBlue);
  const short = Math.cbrt(0.0883024619 * linearRed + 0.2817188376 * linearGreen + 0.6299787005 * linearBlue);
  return 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short;
}

async function measureBoard(
  boardKey: string,
  boardName: string,
  layoutId: number,
  sizeId: number,
  setIds: number[],
): Promise<Map<number, number>> {
  const renderData = getBoardRenderData({ boardName: boardName as never, layoutId, sizeId, setIds });
  if (!renderData) throw new Error(`${boardKey}: no render data`);
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
  if (composite === null) throw new Error(`${boardKey}: no layers`);

  const lightnessByHold = new Map<number, number>();
  for (const placement of holdsData) {
    if (lightnessByHold.has(placement.id)) continue;
    const inner = (placement.r * INNER_FRACTION) ** 2;
    const outer = (placement.r * OUTER_FRACTION) ** 2;
    const bound = Math.ceil(placement.r * OUTER_FRACTION);

    let weighted = 0;
    let weight = 0;
    for (let dy = -bound; dy <= bound; dy += 1) {
      const y = Math.round(placement.cy + dy);
      if (y < 0 || y >= boardHeight) continue;
      for (let dx = -bound; dx <= bound; dx += 1) {
        const distance = dx * dx + dy * dy;
        if (distance < inner || distance > outer) continue;
        const x = Math.round(placement.cx + dx);
        if (x < 0 || x >= boardWidth) continue;
        const offset = (y * boardWidth + x) * 4;
        // Alpha-weighted: a transparent gap is play field, not black art.
        const alpha = composite[offset + 3] / 255;
        if (alpha === 0) continue;
        weighted += oklabLightness(composite[offset], composite[offset + 1], composite[offset + 2]) * alpha;
        weight += alpha;
      }
    }
    // No art in the annulus at all: the ring sits on bare play field.
    lightnessByHold.set(placement.id, weight === 0 ? 0 : Number((weighted / weight).toFixed(3)));
  }

  const values = [...lightnessByHold.values()];
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  console.log(
    `[spike] ${boardKey.padEnd(24)} ${lightnessByHold.size} placements; mean OkLab L under the ring ` +
      `${mean.toFixed(3)}, min ${Math.min(...values).toFixed(3)}, max ${Math.max(...values).toFixed(3)}`,
  );
  return lightnessByHold;
}

async function main(): Promise<number> {
  const perBoard: Array<[string, Map<number, number>]> = [];
  for (const board of SPIKE_BOARDS) {
    perBoard.push([
      board.key,
      await measureBoard(board.key, board.boardName, board.layoutId, board.sizeId, board.setIds),
    ]);
  }

  const body = perBoard
    .map(([boardKey, lightnessByHold]) => {
      const entries = [...lightnessByHold.entries()].sort((a, b) => a[0] - b[0]);
      return `  '${boardKey}': {\n${entries.map(([holdId, lightness]) => `    ${holdId}: ${lightness},`).join('\n')}\n  },`;
    })
    .join('\n');

  writeFileSync(
    OUTPUT_FILE,
    `// Generated by packages/mobile/scripts/spike-hold-lightness.ts — do not edit by hand.\n` +
      `// Mean OkLab lightness of the board art in the annulus each selector ring is drawn in\n` +
      `// (0.85r..1.15r), alpha-weighted, keyed by the board keys in spike-boards.ts.\n` +
      `// Feeds the spike's contrast-casing treatment — see spike-config.ts.\n` +
      `export const SPIKE_HOLD_ART_LIGHTNESS: Record<string, Record<number, number>> = {\n${body}\n};\n`,
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
