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
import { getHolePlacements, getImageFilename, getProductSize } from '@boardsesh/board-constants/product-sizes';

const ROOT_DIR = path.resolve(import.meta.dirname, '../../..');
const SOURCE_DIR = path.join(ROOT_DIR, 'packages/web/public/images/grasshopper/product_sizes_layouts_sets');
const OUTPUT_FILE = path.join(ROOT_DIR, 'packages/mobile/src/components/board-spike/spike-hold-lightness.ts');

/** Must match SPIKE_BOARD in src/components/board-spike/spike-config.ts. */
const BOARD_NAME = 'grasshopper' as const;
const LAYOUT_ID = 1;
const SIZE_ID = 5;
const SET_IDS = [1, 2, 3, 4, 6];

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

  const xSpacing = width / (edgeRight - edgeLeft);
  const ySpacing = height / (edgeTop - edgeBottom);
  const radius = xSpacing * 4;
  const inner = (radius * INNER_FRACTION) ** 2;
  const outer = (radius * OUTER_FRACTION) ** 2;

  const lightnessByHold = new Map<number, number>();
  for (const [holdId, , gridX, gridY] of placementTuples) {
    if (gridX <= edgeLeft || gridX >= edgeRight || gridY <= edgeBottom || gridY >= edgeTop) continue;
    if (lightnessByHold.has(holdId)) continue;
    const centreX = (gridX - edgeLeft) * xSpacing;
    const centreY = height - (gridY - edgeBottom) * ySpacing;

    let weighted = 0;
    let weight = 0;
    const bound = Math.ceil(radius * OUTER_FRACTION);
    for (let dy = -bound; dy <= bound; dy += 1) {
      const y = Math.round(centreY + dy);
      if (y < 0 || y >= height) continue;
      for (let dx = -bound; dx <= bound; dx += 1) {
        const distance = dx * dx + dy * dy;
        if (distance < inner || distance > outer) continue;
        const x = Math.round(centreX + dx);
        if (x < 0 || x >= width) continue;
        const offset = (y * width + x) * 4;
        // Alpha-weighted: a transparent gap is play field, not black art.
        const alpha = composite[offset + 3] / 255;
        if (alpha === 0) continue;
        weighted += oklabLightness(composite[offset], composite[offset + 1], composite[offset + 2]) * alpha;
        weight += alpha;
      }
    }
    // No art in the annulus at all: the ring sits on bare play field.
    lightnessByHold.set(holdId, weight === 0 ? 0 : Number((weighted / weight).toFixed(3)));
  }

  const entries = [...lightnessByHold.entries()].sort((a, b) => a[0] - b[0]);
  const values = entries.map(([, lightness]) => lightness);
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  console.log(
    `[spike] ${entries.length} placements; mean OkLab L under the ring ${mean.toFixed(3)}, ` +
      `min ${Math.min(...values).toFixed(3)}, max ${Math.max(...values).toFixed(3)}`,
  );

  writeFileSync(
    OUTPUT_FILE,
    `// Generated by packages/mobile/scripts/spike-hold-lightness.ts — do not edit by hand.\n` +
      `// Mean OkLab lightness of the board art in the annulus each selector ring is drawn in\n` +
      `// (0.85r..1.15r), alpha-weighted, for Grasshopper layout 1 / size 5 / sets ${SET_IDS.join(',')}.\n` +
      `// Feeds the spike's contrast-casing treatment — see spike-config.ts.\n` +
      `export const SPIKE_HOLD_ART_LIGHTNESS: Record<number, number> = {\n` +
      entries.map(([holdId, lightness]) => `  ${holdId}: ${lightness},`).join('\n') +
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
