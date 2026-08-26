/// <reference types="node" />

/**
 * Spike (issue #2202): measure how light the board art is under each hold, in
 * the two regions the overlay actually paints.
 *
 * Usage: vp run spike:hold-lightness
 *
 * The issue suggests CSS's `contrast-color()`, whose whole idea is "pick the
 * foreground that contrasts with whatever is behind it". There is no CSS in a
 * React Native board, and nothing at runtime can sample the composited board
 * photo — so the sampling happens here, offline, and ships as a lookup the
 * renderer can read.
 *
 * Two regions, because two treatments sit on two different pieces of art:
 *
 * - The *annulus the ring is drawn in* (0.85r to 1.15r), which is mostly
 *   outside the hold. A ring's legibility is decided by what it crosses, and a
 *   pale hold with dark gaps around it is a different problem from a pale hold
 *   on pale art.
 * - The *inside of the traced silhouette*, which is the art a fill covers. The
 *   hybrid treatment normalises that art toward a common lightness before the
 *   role colour goes on, so it has to be measured over the hold body — reading
 *   the ring's annulus there put white at alpha 0.588 over holds whose art the
 *   annulus never saw (design-review-2 change 4c).
 *
 * Both are alpha-weighted, so the transparent gaps between holds count as the
 * play field rather than as black.
 *
 * The silhouette pass reads its polygons from the committed
 * `spike-hold-outlines.ts`, so re-run this whenever the tracer is re-run.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';
import { getBoardRenderData } from '../src/lib/board-details';
import { SPIKE_BOARDS } from '../src/components/board-spike/spike-boards';
import { SPIKE_HOLD_OUTLINES } from '../src/components/board-spike/spike-hold-outlines';

const ROOT_DIR = path.resolve(import.meta.dirname, '../../..');
const IMAGES_DIR = path.join(ROOT_DIR, 'packages/web/public/images');
const OUTPUT_FILE = path.join(ROOT_DIR, 'packages/mobile/src/components/board-spike/spike-hold-lightness.ts');

/** Annulus the selector ring occupies, as fractions of the placement radius. */
const INNER_FRACTION = 0.85;
const OUTER_FRACTION = 1.15;

/**
 * Sentinel for "this placement has no traced silhouette, so there is no art
 * under it to measure". Negative on purpose: OkLab lightness is 0..1, and 0 is a
 * legitimate reading for genuinely black art. The annulus table's own 0 sentinel
 * is exactly that mistake — `?? target` does not catch it, and the hybrid
 * painted 94 of MoonBoard's 198 holds as if their art were black.
 */
const NO_ART = -1;

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

type BoardArt = {
  pixels: Buffer;
  width: number;
  height: number;
};

type LightnessAccumulator = {
  add: (x: number, y: number) => void;
  /** `null` when nothing opaque was visited at all — the caller picks the sentinel. */
  mean: () => number | null;
};

/** Alpha-weighted mean OkLab lightness over whatever pixels the caller visits. */
function accumulateLightness(art: BoardArt): LightnessAccumulator {
  let weighted = 0;
  let weight = 0;
  return {
    add(x, y) {
      if (x < 0 || y < 0 || x >= art.width || y >= art.height) return;
      const offset = (y * art.width + x) * 4;
      // Alpha-weighted: a transparent gap is play field, not black art.
      const alpha = art.pixels[offset + 3] / 255;
      if (alpha === 0) return;
      weighted += oklabLightness(art.pixels[offset], art.pixels[offset + 1], art.pixels[offset + 2]) * alpha;
      weight += alpha;
    },
    mean: () => (weight === 0 ? null : Number((weighted / weight).toFixed(3))),
  };
}

/**
 * Mean lightness of the art in the ring's annulus. Unchanged: this is what the
 * every-hold casing picks its black-or-white stroke against, and design-review-2
 * "leave alone" item 10 says it is the right measurement for that job.
 */
function measureAnnulus(art: BoardArt, centreX: number, centreY: number, radius: number): number {
  const inner = (radius * INNER_FRACTION) ** 2;
  const outer = (radius * OUTER_FRACTION) ** 2;
  const bound = Math.ceil(radius * OUTER_FRACTION);

  const accumulator = accumulateLightness(art);
  for (let dy = -bound; dy <= bound; dy += 1) {
    for (let dx = -bound; dx <= bound; dx += 1) {
      const distance = dx * dx + dy * dy;
      if (distance < inner || distance > outer) continue;
      accumulator.add(Math.round(centreX + dx), Math.round(centreY + dy));
    }
  }
  // No art in the annulus at all: the ring sits on bare play field.
  return accumulator.mean() ?? 0;
}

/**
 * Mean lightness of the art inside a traced silhouette, by even-odd scanline
 * fill of the polygon.
 *
 * The polygon's coordinates are relative to the *rounded* placement centre —
 * that is the frame `spike-hold-outlines.ts` emits them in — so the anchor here
 * has to round the same way or the mask walks off the hold on half the board.
 */
function measureSilhouette(art: BoardArt, centreX: number, centreY: number, outline: number[]): number {
  const pointCount = outline.length / 2;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let index = 1; index < outline.length; index += 2) {
    minY = Math.min(minY, outline[index]);
    maxY = Math.max(maxY, outline[index]);
  }

  const accumulator = accumulateLightness(art);
  const crossings: number[] = [];
  for (let y = Math.ceil(minY); y <= Math.floor(maxY); y += 1) {
    crossings.length = 0;
    for (let index = 0; index < pointCount; index += 1) {
      const startX = outline[index * 2];
      const startY = outline[index * 2 + 1];
      const endIndex = (index + 1) % pointCount;
      const endX = outline[endIndex * 2];
      const endY = outline[endIndex * 2 + 1];
      // Half-open in y, so a vertex counts once and a horizontal edge drops out.
      const startsAbove = startY <= y;
      const endsAbove = endY <= y;
      if (startsAbove === endsAbove) continue;
      crossings.push(startX + ((y - startY) * (endX - startX)) / (endY - startY));
    }
    crossings.sort((left, right) => left - right);
    for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
      for (let x = Math.ceil(crossings[pair]); x <= Math.floor(crossings[pair + 1]); x += 1) {
        accumulator.add(centreX + x, centreY + y);
      }
    }
  }
  return accumulator.mean() ?? NO_ART;
}

type BoardMeasurements = {
  annulus: Map<number, number>;
  silhouette: Map<number, number>;
};

async function measureBoard(
  boardKey: string,
  boardName: string,
  layoutId: number,
  sizeId: number,
  setIds: number[],
): Promise<BoardMeasurements> {
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

  const art: BoardArt = { pixels: composite, width: boardWidth, height: boardHeight };
  const outlines = SPIKE_HOLD_OUTLINES[boardKey] ?? {};
  const annulus = new Map<number, number>();
  const silhouette = new Map<number, number>();

  for (const placement of holdsData) {
    if (annulus.has(placement.id)) continue;
    annulus.set(placement.id, measureAnnulus(art, placement.cx, placement.cy, placement.r));

    const outline = outlines[placement.id];
    silhouette.set(
      placement.id,
      outline === undefined || outline.length < 6
        ? NO_ART
        : measureSilhouette(art, Math.round(placement.cx), Math.round(placement.cy), outline),
    );
  }

  const annulusValues = [...annulus.values()];
  const annulusMean = annulusValues.reduce((total, value) => total + value, 0) / annulusValues.length;
  const measured = [...silhouette.values()].filter((value) => value !== NO_ART).sort((left, right) => left - right);
  console.log(
    `[spike] ${boardKey.padEnd(24)} ${annulus.size} placements; ring annulus mean OkLab L ` +
      `${annulusMean.toFixed(3)} (${annulusValues.filter((value) => value === 0).length} on bare field); ` +
      `inside the silhouette ${measured.length} measured, ${silhouette.size - measured.length} with no art, ` +
      `p10 ${percentile(measured, 0.1)} p50 ${percentile(measured, 0.5)} p90 ${percentile(measured, 0.9)}`,
  );
  return { annulus, silhouette };
}

/** Nearest-rank percentile of an already-sorted list, printed for the summary only. */
function percentile(sorted: number[], fraction: number): string {
  if (sorted.length === 0) return 'n/a';
  return sorted[Math.min(sorted.length - 1, Math.round(fraction * (sorted.length - 1)))].toFixed(3);
}

function renderTable(perBoard: Array<[string, Map<number, number>]>): string {
  return perBoard
    .map(([boardKey, valueByHold]) => {
      const entries = [...valueByHold.entries()].sort((left, right) => left[0] - right[0]);
      return `  '${boardKey}': {\n${entries.map(([holdId, value]) => `    ${holdId}: ${value},`).join('\n')}\n  },`;
    })
    .join('\n');
}

async function main(): Promise<number> {
  const perBoard: Array<[string, BoardMeasurements]> = [];
  for (const board of SPIKE_BOARDS) {
    perBoard.push([
      board.key,
      await measureBoard(board.key, board.boardName, board.layoutId, board.sizeId, board.setIds),
    ]);
  }

  const annulusBody = renderTable(perBoard.map(([boardKey, measurements]) => [boardKey, measurements.annulus]));
  const silhouetteBody = renderTable(perBoard.map(([boardKey, measurements]) => [boardKey, measurements.silhouette]));

  writeFileSync(
    OUTPUT_FILE,
    `// Generated by packages/mobile/scripts/spike-hold-lightness.ts — do not edit by hand.\n` +
      `//\n` +
      `// Two tables, two regions, two sentinels. Both are the mean OkLab lightness of the\n` +
      `// board art, alpha-weighted so a transparent gap counts as play field rather than as\n` +
      `// black art, keyed by the board keys in spike-boards.ts.\n` +
      `//\n` +
      `// SPIKE_HOLD_ART_LIGHTNESS measures the annulus a selector ring is drawn in\n` +
      `// (0.85r..1.15r), which is mostly *outside* the hold — what the ring crosses, which is\n` +
      `// what decides whether the ring is legible. Its sentinel is 0: no art anywhere in the\n` +
      `// annulus, i.e. the ring sits on bare play field. Read this one for the ring casing.\n` +
      `//\n` +
      `// SPIKE_HOLD_SILHOUETTE_LIGHTNESS measures *inside* the hold's traced silhouette from\n` +
      `// spike-hold-outlines.ts — the art a fill actually covers. Its sentinel is\n` +
      `// SPIKE_SILHOUETTE_LIGHTNESS_NO_ART (${NO_ART}), meaning the placement has no traced outline\n` +
      `// and there is nothing under it to normalise; substitute a target rather than treating\n` +
      `// it as black, and note that \`?? fallback\` will not catch it. Read this one for any\n` +
      `// treatment that fills the hold body. Regenerate whenever the tracer is re-run: the\n` +
      `// polygons it measures are that file's output.\n` +
      `export const SPIKE_SILHOUETTE_LIGHTNESS_NO_ART = ${NO_ART};\n` +
      `export const SPIKE_HOLD_ART_LIGHTNESS: Record<string, Record<number, number>> = {\n${annulusBody}\n};\n` +
      `export const SPIKE_HOLD_SILHOUETTE_LIGHTNESS: Record<string, Record<number, number>> = {\n${silhouetteBody}\n};\n`,
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
