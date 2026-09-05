// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Marco de Jongh

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { BoundedLru } from '../lru';
import { composeBoardBaseBuffer, renderBoardImageBuffer, type OgBaseResult, type ResolveImagePath } from '../pipeline';
import type { RenderableBoardDetails } from '../types';

const SIZE = 8;
const PIXELS = SIZE * SIZE;

const fixtureDir = mkdtempSync(join(tmpdir(), 'board-render-pipeline-'));
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

/** Write a solid-colour PNG the pipeline can decode as a board photo layer. */
function writeLayer(name: string, rgb: { r: number; g: number; b: number }, alpha = 1): Promise<string> {
  const path = join(fixtureDir, name);
  return sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: { ...rgb, alpha } } })
    .png()
    .toFile(path)
    .then(() => path);
}

/**
 * Write a PNG shaped like a real board photo: opaque where the holds are (the
 * left half here), fully transparent everywhere else.
 */
async function writePartlyTransparentLayer(name: string, rgb: { r: number; g: number; b: number }): Promise<string> {
  const path = join(fixtureDir, name);
  const raw = Buffer.alloc(PIXELS * 4, 0);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE / 2; x += 1) {
      const offset = (y * SIZE + x) * 4;
      raw[offset] = rgb.r;
      raw[offset + 1] = rgb.g;
      raw[offset + 2] = rgb.b;
      raw[offset + 3] = 255;
    }
  }
  await sharp(raw, { raw: { width: SIZE, height: SIZE, channels: 4 } })
    .png()
    .toFile(path);
  return path;
}

/** Map board-relative image keys to fixture files; anything unmapped resolves to null. */
let filesByRelPath = new Map<string, string>();
let resolveCalls: string[] = [];
const resolveImagePath: ResolveImagePath = (relPath) => {
  resolveCalls.push(relPath);
  return filesByRelPath.get(relPath) ?? null;
};

beforeEach(() => {
  filesByRelPath = new Map();
  resolveCalls = [];
});

function boardWithLayers(imageKeys: string[]): RenderableBoardDetails {
  return {
    board_name: 'kilter',
    boardWidth: SIZE,
    boardHeight: SIZE,
    holdsData: [],
    images_to_holds: Object.fromEntries(imageKeys.map((key) => [key, []])),
  };
}

/** `getBackgroundRelPaths` turns "layer-a.png" into "images/kilter/layer-a.webp". */
const relPathFor = (imageKey: string) => `images/kilter/${imageKey.replace(/\.png$/, '.webp')}`;

/** A fully transparent overlay: composites without changing the base pixels. */
const transparentOverlay = () => Buffer.alloc(PIXELS * 4, 0);

const readPixel = (raw: Buffer, index = 0) => [
  raw[index * 4],
  raw[index * 4 + 1],
  raw[index * 4 + 2],
  raw[index * 4 + 3],
];

describe('composeBoardBaseBuffer', () => {
  it('returns one raw RGBA plane of exactly width × height × 4 bytes', async () => {
    filesByRelPath.set(relPathFor('layer-a.png'), await writeLayer('a.png', { r: 255, g: 0, b: 0 }));

    const base = await composeBoardBaseBuffer({
      boardDetails: boardWithLayers(['layer-a.png']),
      width: SIZE,
      height: SIZE,
      thumbnail: false,
      dimBackground: 0,
      resolveImagePath,
    });

    expect(base).not.toBeNull();
    expect(base?.length).toBe(PIXELS * 4);
    expect(readPixel(base as Buffer)).toEqual([255, 0, 0, 255]);
  });

  it('folds layers in order, later layers painting over earlier ones', async () => {
    filesByRelPath.set(relPathFor('layer-a.png'), await writeLayer('order-a.png', { r: 255, g: 0, b: 0 }));
    filesByRelPath.set(relPathFor('layer-b.png'), await writeLayer('order-b.png', { r: 0, g: 0, b: 255 }));

    const base = await composeBoardBaseBuffer({
      boardDetails: boardWithLayers(['layer-a.png', 'layer-b.png']),
      width: SIZE,
      height: SIZE,
      thumbnail: false,
      dimBackground: 0,
      resolveImagePath,
    });

    // Opaque blue on top of opaque red: blue wins. Reversed order would be red.
    expect(readPixel(base as Buffer)).toEqual([0, 0, 255, 255]);
    expect(base?.length).toBe(PIXELS * 4);
  });

  it('dims full-bleed: transparent board pixels darken too', async () => {
    // Real board photos are transparent everywhere except the holds, and
    // `dim_background` is a wash over the whole image — the iOS Live Activity
    // widget and mobile's LayeredClimbImage both draw it that way. Scaling RGB
    // by (1 - dim) instead would leave every transparent pixel untouched, so
    // this pins the transparent half explicitly.
    filesByRelPath.set(
      relPathFor('layer-a.png'),
      await writePartlyTransparentLayer('dim-alpha.png', { r: 200, g: 100, b: 50 }),
    );

    const base = await composeBoardBaseBuffer({
      boardDetails: boardWithLayers(['layer-a.png']),
      width: SIZE,
      height: SIZE,
      thumbnail: false,
      dimBackground: 0.18,
      resolveImagePath,
    });

    // A fully transparent source pixel picks up the scrim's own alpha.
    const transparentPixelIndex = SIZE / 2;
    const [dimRed, dimGreen, dimBlue, dimAlpha] = readPixel(base as Buffer, transparentPixelIndex);
    expect(dimAlpha).toBe(Math.round(0.18 * 255));
    expect(dimRed).toBe(0);
    expect(dimGreen).toBe(0);
    expect(dimBlue).toBe(0);

    // An opaque one darkens by (1 - dim) and stays opaque.
    const [red, green, blue, alpha] = readPixel(base as Buffer, 0);
    expect(Math.abs(red - 200 * 0.82)).toBeLessThanOrEqual(1);
    expect(Math.abs(green - 100 * 0.82)).toBeLessThanOrEqual(1);
    expect(Math.abs(blue - 50 * 0.82)).toBeLessThanOrEqual(1);
    expect(alpha).toBe(255);
  });

  it('leaves a transparent pixel alone when dim is off', async () => {
    filesByRelPath.set(
      relPathFor('layer-a.png'),
      await writePartlyTransparentLayer('no-dim-alpha.png', { r: 200, g: 100, b: 50 }),
    );

    const base = await composeBoardBaseBuffer({
      boardDetails: boardWithLayers(['layer-a.png']),
      width: SIZE,
      height: SIZE,
      thumbnail: false,
      dimBackground: 0,
      resolveImagePath,
    });

    expect(readPixel(base as Buffer, SIZE / 2)[3]).toBe(0);
  });

  it('skips a layer that fails to decode and keeps the rest', async () => {
    filesByRelPath.set(relPathFor('good.png'), await writeLayer('good.png', { r: 12, g: 34, b: 56 }));
    const corruptPath = join(fixtureDir, 'corrupt.png');
    writeFileSync(corruptPath, 'this is not an image');
    filesByRelPath.set(relPathFor('bad.png'), corruptPath);

    const base = await composeBoardBaseBuffer({
      boardDetails: boardWithLayers(['good.png', 'bad.png']),
      width: SIZE,
      height: SIZE,
      thumbnail: false,
      dimBackground: 0,
      resolveImagePath,
    });

    expect(base?.length).toBe(PIXELS * 4);
    expect(readPixel(base as Buffer)).toEqual([12, 34, 56, 255]);
  });

  it('returns null when no background image resolves', async () => {
    const base = await composeBoardBaseBuffer({
      boardDetails: boardWithLayers(['missing.png']),
      width: SIZE,
      height: SIZE,
      thumbnail: false,
      dimBackground: 0,
      resolveImagePath,
    });

    expect(base).toBeNull();
    expect(resolveCalls).toEqual([relPathFor('missing.png')]);
  });

  it('returns null when every layer fails to decode', async () => {
    const corruptPath = join(fixtureDir, 'all-bad.png');
    writeFileSync(corruptPath, 'not an image either');
    filesByRelPath.set(relPathFor('bad.png'), corruptPath);

    const base = await composeBoardBaseBuffer({
      boardDetails: boardWithLayers(['bad.png']),
      width: SIZE,
      height: SIZE,
      thumbnail: false,
      dimBackground: 0,
      resolveImagePath,
    });

    expect(base).toBeNull();
  });
});

describe('renderBoardImageBuffer with caches', () => {
  const baseParams = {
    width: SIZE,
    height: SIZE,
    thumbnail: false,
    includeBackground: true,
    dimBackground: 0,
    resolveImagePath,
  };

  it('composes the board base once and serves later renders from the cache', async () => {
    filesByRelPath.set(relPathFor('layer-a.png'), await writeLayer('cached.png', { r: 10, g: 200, b: 30 }));
    const boardBase = new BoundedLru<Buffer>({
      maxEntries: 4,
      maxBytes: 4 * 1024 * 1024,
      sizeOf: (buffer) => buffer.length,
    });
    const params = {
      ...baseParams,
      overlayBuffer: transparentOverlay(),
      isOgVariant: false,
      format: 'webp' as const,
      boardDetails: boardWithLayers(['layer-a.png']),
      caches: { boardBase },
    };

    const first = await renderBoardImageBuffer(params);
    expect(first.cache).toBe('miss');
    expect(resolveCalls).toHaveLength(1);

    const second = await renderBoardImageBuffer(params);
    expect(second.cache).toBe('hit');
    // The cached base means no second trip to the filesystem.
    expect(resolveCalls).toHaveLength(1);
    expect(second.buffer.equals(first.buffer)).toBe(true);
    expect(second.contentType).toBe('image/webp');

    const metadata = await sharp(second.buffer).metadata();
    expect(metadata.width).toBe(SIZE);
    expect(metadata.height).toBe(SIZE);
  });

  it('composes the base once for two concurrent misses on the same board', async () => {
    filesByRelPath.set(relPathFor('layer-a.png'), await writeLayer('coalesced.png', { r: 40, g: 50, b: 60 }));
    const boardBase = new BoundedLru<Buffer>({
      maxEntries: 4,
      maxBytes: 4 * 1024 * 1024,
      sizeOf: (buffer) => buffer.length,
    });
    // Different climbs, same board: one base, two overlays. 0x00 is a fully
    // transparent overlay, 0xff an opaque white one — visibly different output.
    const boardBaseInFlight = new Map<string, Promise<Buffer | null>>();
    const paramsFor = (overlayFill: number) => ({
      ...baseParams,
      overlayBuffer: Buffer.alloc(PIXELS * 4, overlayFill),
      isOgVariant: false,
      format: 'webp' as const,
      boardDetails: boardWithLayers(['layer-a.png']),
      caches: { boardBase, boardBaseInFlight },
    });

    const [first, second] = await Promise.all([
      renderBoardImageBuffer(paramsFor(0x00)),
      renderBoardImageBuffer(paramsFor(0xff)),
    ]);

    // Both raced past the cache, but only one of them composed the base.
    expect(resolveCalls).toHaveLength(1);
    expect(first.buffer.equals(second.buffer)).toBe(false);
    expect(boardBase.size).toBe(1);
    // The entry is dropped once the compose settles — nothing is held alive.
    expect(boardBaseInFlight.size).toBe(0);
  });

  it('composes per render when no in-flight map is supplied', async () => {
    filesByRelPath.set(relPathFor('layer-a.png'), await writeLayer('uncoalesced.png', { r: 7, g: 8, b: 9 }));
    const boardBase = new BoundedLru<Buffer>({
      maxEntries: 4,
      maxBytes: 4 * 1024 * 1024,
      sizeOf: (buffer) => buffer.length,
    });
    const params = {
      ...baseParams,
      overlayBuffer: transparentOverlay(),
      isOgVariant: false,
      format: 'webp' as const,
      boardDetails: boardWithLayers(['layer-a.png']),
      caches: { boardBase },
    };

    await Promise.all([renderBoardImageBuffer(params), renderBoardImageBuffer(params)]);

    // Coalescing is opt-in: without the map both races compose their own base.
    expect(resolveCalls).toHaveLength(2);
  });

  it('reports `none` when no cache is supplied', async () => {
    filesByRelPath.set(relPathFor('layer-a.png'), await writeLayer('uncached.png', { r: 1, g: 2, b: 3 }));

    const result = await renderBoardImageBuffer({
      ...baseParams,
      overlayBuffer: transparentOverlay(),
      isOgVariant: false,
      format: 'webp',
      boardDetails: boardWithLayers(['layer-a.png']),
    });

    expect(result.cache).toBe('none');
    expect(result.contentType).toBe('image/webp');
  });

  it('falls back to an overlay-only render when the board photos are missing', async () => {
    const boardBase = new BoundedLru<Buffer>({
      maxEntries: 4,
      maxBytes: 4 * 1024 * 1024,
      sizeOf: (buffer) => buffer.length,
    });

    const result = await renderBoardImageBuffer({
      ...baseParams,
      overlayBuffer: transparentOverlay(),
      isOgVariant: false,
      format: 'png',
      boardDetails: boardWithLayers(['missing.png']),
      caches: { boardBase },
    });

    expect(result.contentType).toBe('image/png');
    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.width).toBe(SIZE);
    expect(metadata.height).toBe(SIZE);
  });

  it('renders the OG card on the social canvas and reuses its cached base', async () => {
    filesByRelPath.set(relPathFor('layer-a.png'), await writeLayer('og.png', { r: 90, g: 90, b: 90 }));
    const ogBase = new BoundedLru<OgBaseResult>({
      maxEntries: 2,
      maxBytes: 8 * 1024 * 1024,
      sizeOf: (value) => value.base.length,
    });
    const params = {
      ...baseParams,
      overlayBuffer: transparentOverlay(),
      isOgVariant: true,
      format: 'png' as const,
      boardDetails: boardWithLayers(['layer-a.png']),
      caches: { ogBase },
    };

    const first = await renderBoardImageBuffer(params);
    expect(first.cache).toBe('miss');
    const metadata = await sharp(first.buffer).metadata();
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(630);

    const resolveCallsAfterFirst = resolveCalls.length;
    const second = await renderBoardImageBuffer(params);
    expect(second.cache).toBe('hit');
    expect(resolveCalls).toHaveLength(resolveCallsAfterFirst);
    expect(second.buffer.equals(first.buffer)).toBe(true);
  });

  it('keeps light and dark OG board art in separate cache entries', async () => {
    const lightRelPath = relPathFor('layer-a.png');
    const darkRelPath = lightRelPath.replace(/\.webp$/, '.dark.webp');
    filesByRelPath.set(lightRelPath, await writeLayer('og-light.png', { r: 240, g: 240, b: 240 }));
    filesByRelPath.set(darkRelPath, await writeLayer('og-dark.png', { r: 20, g: 20, b: 20 }));
    const ogBase = new BoundedLru<OgBaseResult>({
      maxEntries: 2,
      maxBytes: 8 * 1024 * 1024,
      sizeOf: (value) => value.base.length,
    });
    const params = {
      ...baseParams,
      overlayBuffer: transparentOverlay(),
      isOgVariant: true,
      format: 'png' as const,
      boardDetails: boardWithLayers(['layer-a.png']),
      caches: { ogBase },
    };

    const light = await renderBoardImageBuffer({ ...params, colorScheme: 'light' });
    const dark = await renderBoardImageBuffer({ ...params, colorScheme: 'dark' });

    expect(light.cache).toBe('miss');
    expect(dark.cache).toBe('miss');
    expect(light.buffer.equals(dark.buffer)).toBe(false);
    expect(ogBase.size).toBe(2);
    expect(resolveCalls).toEqual([lightRelPath, darkRelPath]);
  });

  it('coalesces concurrent OG base composition across different overlays', async () => {
    filesByRelPath.set(relPathFor('layer-a.png'), await writeLayer('og-coalesced.png', { r: 80, g: 90, b: 100 }));
    const ogBase = new BoundedLru<OgBaseResult>({
      maxEntries: 2,
      maxBytes: 8 * 1024 * 1024,
      sizeOf: (value) => value.base.length,
    });
    const ogBaseInFlight = new Map<string, Promise<OgBaseResult>>();
    const paramsFor = (overlayFill: number) => ({
      ...baseParams,
      overlayBuffer: Buffer.alloc(PIXELS * 4, overlayFill),
      isOgVariant: true,
      format: 'png' as const,
      boardDetails: boardWithLayers(['layer-a.png']),
      caches: { ogBase, ogBaseInFlight },
    });

    const [first, second] = await Promise.all([
      renderBoardImageBuffer(paramsFor(0x00)),
      renderBoardImageBuffer(paramsFor(0xff)),
    ]);

    expect(resolveCalls).toHaveLength(1);
    expect(new Set([first.cache, second.cache])).toEqual(new Set(['hit', 'miss']));
    expect(first.buffer.equals(second.buffer)).toBe(false);
    expect(ogBase.size).toBe(1);
    expect(ogBaseInFlight.size).toBe(0);
  });
});
