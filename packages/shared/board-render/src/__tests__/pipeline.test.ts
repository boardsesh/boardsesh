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

  it('dims by scaling RGB, leaving alpha untouched', async () => {
    filesByRelPath.set(relPathFor('layer-a.png'), await writeLayer('dim.png', { r: 200, g: 100, b: 50 }));

    const base = await composeBoardBaseBuffer({
      boardDetails: boardWithLayers(['layer-a.png']),
      width: SIZE,
      height: SIZE,
      thumbnail: false,
      dimBackground: 0.18,
      resolveImagePath,
    });

    const [red, green, blue, alpha] = readPixel(base as Buffer);
    // Compositing black at 0.18 over an opaque photo is exactly rgb × 0.82.
    expect(Math.abs(red - 200 * 0.82)).toBeLessThanOrEqual(1);
    expect(Math.abs(green - 100 * 0.82)).toBeLessThanOrEqual(1);
    expect(Math.abs(blue - 50 * 0.82)).toBeLessThanOrEqual(1);
    expect(alpha).toBe(255);
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
});
