import { createRequire } from 'node:module';
import sharp from 'sharp';
import {
  BOKEH_DARK_SURFACE,
  BOKEH_FALLOFF,
  FROST_ALPHA,
  GRAIN_ALPHA,
  buildBokehBlobs,
  type BokehPoint,
  type BokehSize,
} from '@boardsesh/frosted-bokeh';
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, OG_CARD_BOARD_BOX, OG_CARD_COLUMN_GAP } from './headers';
import type { WasmRenderConfig } from './types';

export type OgBokehInput = { points: readonly BokehPoint[]; source: BokehSize };

/** Use the overlay's effective first snapshot and its selected screen palette. */
export function getOgBokehInput(config: WasmRenderConfig): OgBokehInput {
  // Match Rust's frames_parser: callers flatten animated routes before building
  // share URLs; direct requests still draw only the first comma-delimited frame.
  const firstFrame = config.frames.split(',')[0] ?? '';
  const holdsById = new Map(config.holds.map((hold) => [hold.id, hold]));
  const points: BokehPoint[] = [];
  for (const token of firstFrame.split('p')) {
    const match = /^(\d+)r(\d+)$/.exec(token);
    if (!match) continue;
    const hold = holdsById.get(Number(match[1]));
    const color = config.hold_state_map[Number(match[2])]?.color;
    if (!hold || !color) continue;
    const placed = config.mirrored ? (holdsById.get(hold.mirroredHoldId ?? -1) ?? hold) : hold;
    points.push({ x: placed.cx, y: placed.cy, color });
  }
  return { points, source: { w: config.board_width, h: config.board_height } };
}

const require = createRequire(import.meta.url);
let grainTile: Promise<Buffer> | undefined;

function getGrainTile(): Promise<Buffer> {
  grainTile ??= sharp(require.resolve('@boardsesh/frosted-bokeh/grain.png'))
    .toColourspace('srgb')
    .ensureAlpha(GRAIN_ALPHA)
    .png()
    .toBuffer()
    .catch((error: unknown) => {
      grainTile = undefined;
      throw error;
    });
  return grainTile;
}

/** Raster adapter only: geometry, palette-independent falloff and texture are shared with native. */
export async function renderFrostedBokehBuffer({
  points,
  source,
  protectDetails = false,
}: OgBokehInput & { protectDetails?: boolean }): Promise<Buffer> {
  const width = OG_IMAGE_WIDTH;
  const height = OG_IMAGE_HEIGHT;
  const blobs = buildBokehBlobs({
    points,
    source,
    target: { w: width, h: height },
    rotation: 'clockwise',
    effectScale: width / 360,
  });
  const composites: sharp.OverlayOptions[] = blobs.map((blob) => {
    // Rasterise just the visible disc, keeping fifteen layers below a few MB
    // instead of allocating a full 1200×630 plane for every point.
    const left = Math.max(0, Math.floor(blob.x - blob.r));
    const top = Math.max(0, Math.floor(blob.y - blob.r));
    const discWidth = Math.min(width, Math.ceil(blob.x + blob.r)) - left;
    const discHeight = Math.min(height, Math.ceil(blob.y + blob.r)) - top;
    // Only trusted hex colours enter an SVG. Frame role colours are server-owned;
    // the guard also makes this reusable adapter safe for other point sources.
    const color = /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(blob.color) ? blob.color : '#FFFFFF';
    const stops = BOKEH_FALLOFF.map(
      ([offset, share]) => `<stop offset="${offset}" stop-color="${color}" stop-opacity="${blob.peak * share}"/>`,
    ).join('');
    return {
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${discWidth}" height="${discHeight}"><defs><radialGradient id="blob">${stops}</radialGradient></defs><circle cx="${blob.x - left}" cy="${blob.y - top}" r="${blob.r}" fill="url(#blob)"/></svg>`,
      ),
      blend: 'screen',
      left,
      top,
    };
  });
  composites.push({
    input: { create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: FROST_ALPHA } } },
  });
  composites.push({ input: await getGrainTile(), tile: true });
  if (protectDetails) {
    const columnLeft = OG_CARD_BOARD_BOX.left + OG_CARD_BOARD_BOX.width + OG_CARD_COLUMN_GAP;
    composites.push({
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="scrim"><stop offset="0" stop-color="${BOKEH_DARK_SURFACE.base}" stop-opacity="0"/><stop offset="1" stop-color="${BOKEH_DARK_SURFACE.base}" stop-opacity="0.9"/></linearGradient></defs><rect x="${columnLeft - 80}" width="80" height="${height}" fill="url(#scrim)"/><rect x="${columnLeft}" width="${width - columnLeft}" height="${height}" fill="${BOKEH_DARK_SURFACE.base}" fill-opacity="0.9"/></svg>`,
      ),
    });
  }
  return sharp({ create: { width, height, channels: 4, background: BOKEH_DARK_SURFACE.base } })
    .composite(composites)
    .raw()
    .toBuffer();
}
