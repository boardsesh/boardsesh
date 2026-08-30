import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const previousConcurrency = process.env.BOARD_RENDER_CONCURRENCY;
const previousQueueLimit = process.env.BOARD_RENDER_MAX_QUEUE;
const previousImagesRoot = process.env.BOARD_IMAGES_ROOT;
process.env.BOARD_RENDER_CONCURRENCY = '1';
process.env.BOARD_RENDER_MAX_QUEUE = '1';
process.env.BOARD_IMAGES_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../web/public');

let service: typeof import('../services/board-render');

beforeAll(async () => {
  service = await import('../services/board-render');
});

afterAll(() => {
  if (previousConcurrency === undefined) delete process.env.BOARD_RENDER_CONCURRENCY;
  else process.env.BOARD_RENDER_CONCURRENCY = previousConcurrency;
  if (previousQueueLimit === undefined) delete process.env.BOARD_RENDER_MAX_QUEUE;
  else process.env.BOARD_RENDER_MAX_QUEUE = previousQueueLimit;
  if (previousImagesRoot === undefined) delete process.env.BOARD_IMAGES_ROOT;
  else process.env.BOARD_IMAGES_ROOT = previousImagesRoot;
});

const standardParams = {
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  frames: 'p1080r15p1202r12',
  format: 'webp' as const,
  thumbnail: false,
  includeBackground: true,
  dimBackground: 0,
  isOgVariant: false,
};

describe('board renderer initialization', () => {
  it('promise-locks concurrent initialization and starts one warm-up loop', async () => {
    const statsBefore = service.getBoardRenderRuntimeStats();
    await Promise.all([service.initBoardRenderer(), service.initBoardRenderer(), service.initBoardRenderer()]);
    const statsAfter = service.getBoardRenderRuntimeStats();

    expect(statsAfter.initializationAttempts - statsBefore.initializationAttempts).toBe(1);
    expect(statsAfter.warmupRuns - statsBefore.warmupRuns).toBe(1);
    expect(statsAfter.initializing).toBe(false);
    await service.waitForBoardRenderWarmup();
  }, 30_000);
});

describe('board renderer memory and concurrency core', () => {
  beforeEach(async () => {
    await service.initBoardRenderer();
    await service.waitForBoardRenderWarmup();
    service.resetBoardRenderCaches();
  });

  it('separates every pixel-affecting final-byte key', () => {
    const baseKey = service.buildBoardRenderByteCacheKey(standardParams);
    const variants = [
      { ...standardParams, frames: 'p1096r15p1234r12' },
      { ...standardParams, format: 'png' as const },
      { ...standardParams, thumbnail: true },
      { ...standardParams, includeBackground: false },
      { ...standardParams, dimBackground: 0.18 },
      { ...standardParams, isOgVariant: true },
      { ...standardParams, layoutId: 2 },
      { ...standardParams, sizeId: 9 },
      { ...standardParams, setIds: '1' },
      { ...standardParams, renderMode: 'boardsesh' as const },
      { ...standardParams, renderMode: 'boardsesh' as const, glowFalloff: 'plateau' as const },
      { ...standardParams, colorScheme: 'dark' as const },
    ];

    expect(new Set(variants.map(service.buildBoardRenderByteCacheKey))).not.toContain(baseKey);
    expect(new Set(variants.map(service.buildBoardRenderByteCacheKey)).size).toBe(variants.length);
    const boardseshParams = { ...standardParams, renderMode: 'boardsesh' as const };
    expect(
      new Set(
        [
          boardseshParams,
          { ...boardseshParams, glowFalloff: 'plateau' as const },
          { ...boardseshParams, glyphs: true },
          { ...boardseshParams, fieldColor: '#123456' },
        ].map(service.buildBoardRenderByteCacheKey),
      ).size,
    ).toBe(4);
    expect(standardParams).not.toHaveProperty('v');
    const versionAlias = { ...standardParams, v: '0123456789ab' };
    expect(service.buildBoardRenderByteCacheKey(versionAlias)).toBe(baseKey);
  });

  it('normalizes classic render options and the default light art in the byte key', () => {
    expect(
      service.buildBoardRenderByteCacheKey({
        ...standardParams,
        renderMode: 'classic',
        glowFalloff: 'plateau',
        glyphs: true,
        fieldColor: '#123456',
        colorScheme: 'light',
      }),
    ).toBe(service.buildBoardRenderByteCacheKey(standardParams));
  });

  it('rejects unknown catalog geometry with the public-safe service error', async () => {
    await expect(service.renderBoardImage({ ...standardParams, sizeId: 999 })).rejects.toBeInstanceOf(
      service.InvalidBoardRenderConfigError,
    );
  });

  it('coalesces identical in-flight renders before they enter the semaphore', async () => {
    const first = service.renderBoardImage(standardParams);
    const second = service.renderBoardImage(standardParams);
    const during = service.getBoardRenderRuntimeStats();

    expect(during.active).toBe(1);
    expect(during.pending).toBe(0);
    expect(during.inFlightRenders).toBe(1);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toBe(firstResult);
    expect(service.getBoardRenderRuntimeStats().inFlightRenders).toBe(0);
  }, 30_000);

  it('shares one semaphore across OG and board work, reports queue time, and sheds past the queue limit', async () => {
    const ogRender = service.renderOgClimb({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,20',
      frames: 'p1080r15p1202r12',
      format: 'jpeg',
    });
    const largestBoardRender = service.renderBoardImage({
      ...standardParams,
      layoutId: 5,
      sizeId: 15,
      setIds: '24',
      frames: '',
    });
    const shedRender = service.renderBoardImage({
      ...standardParams,
      frames: 'p1100r15p1240r12',
      // Invalid geometry proves queue shedding happens before prepareRender:
      // this must reject as saturated, not as an invalid board config.
      sizeId: 999,
    });
    const shedAssertion = expect(shedRender).rejects.toBeInstanceOf(service.RenderQueueSaturatedError);

    const queuedStats = service.getBoardRenderRuntimeStats();
    expect(queuedStats.concurrency).toBe(1);
    expect(queuedStats.queueLimit).toBe(1);
    expect(queuedStats.active).toBe(1);
    expect(queuedStats.pending).toBe(1);
    expect(queuedStats.inFlightRenders).toBe(2);

    await shedAssertion;
    const [, boardResult] = await Promise.all([ogRender, largestBoardRender]);
    expect(boardResult.queueMs).toBeGreaterThan(0);

    const metadata = await sharp(boardResult.buffer).metadata();
    expect(metadata.width).toBe(1080);
    expect(metadata.height).toBe(2498);

    const settledStats = service.getBoardRenderRuntimeStats();
    expect(settledStats.active).toBe(0);
    expect(settledStats.pending).toBe(0);
    expect(settledStats.inFlightRenders).toBe(0);
    expect(settledStats.boardBaseBytes).toBeGreaterThan(0);
    expect(settledStats.ogBaseBytes).toBeGreaterThan(0);
    expect(settledStats.byteCacheBytes).toBeGreaterThan(0);
    expect(settledStats.boardBaseBytes).toBeLessThanOrEqual(settledStats.boardBaseMaxBytes);
    expect(settledStats.ogBaseBytes).toBeLessThanOrEqual(settledStats.ogBaseMaxBytes);
    expect(settledStats.byteCacheBytes).toBeLessThanOrEqual(settledStats.byteCacheMaxBytes);
  }, 30_000);
});
