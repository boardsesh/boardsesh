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

describe('prepareRender — what an Aura request actually sends', () => {
  // Kilter Original 12x12: traced (99.1% of placements) and bright enough to
  // take a veil against the dark field. `p1080r15` lights hold 1080.
  const auraParams = { ...standardParams, renderMode: 'aura' as const };

  it('sends the shipped Aura tuning, not the renderer defaults', () => {
    // The regression this guards: the server used to emit only render_mode /
    // glow_falloff / glyphs, so an OG card drew the Rust neutral glow — a
    // flatter light with a hard colour seam between neighbouring roles — while
    // the app drew the tuned one from the same climb.
    const { config } = service.prepareRender(auraParams);
    expect(config.render_mode).toBe('aura');
    expect(config.mark_style).toBe('glow');
    expect(config.glow).toMatchObject({ spread_fraction: 0.91, seam_sharpness: 3, merge_softness: 0.6 });
    expect(config.fill).toEqual({ opacity: 0.55 });
  });

  it('attaches the traced silhouette to the lit holds', () => {
    const { config } = service.prepareRender(auraParams);
    const lit = config.holds.find((hold) => hold.id === 1080);
    expect(lit?.outline?.length).toBeGreaterThan(0);
    // An unlit, un-neighboured hold carries no polygon — the config would
    // otherwise ship all ~500 of the board's outlines on every request.
    expect(config.holds.filter((hold) => hold.outline !== undefined).length).toBeLessThan(config.holds.length);
  });

  it('washes the wall against the dark field and leaves it alone on the light one', () => {
    const { veil } = service.prepareRender({ ...auraParams, fieldColor: '#181225' }).config;
    expect(veil?.color).toBe('#181225');
    expect(veil?.opacity).toBeGreaterThan(0);

    // No field named means the light field, on which every board's wall is
    // darker than the field — nothing to quiet, so no veil at all.
    expect(service.prepareRender(auraParams).config.veil).toBeUndefined();
  });

  it('measures each board its own wall, rather than washing them all alike', () => {
    // The wiring this pins: `prepareRender` keys `getWallLightness` on the board
    // config it is rendering. Get that key wrong and every board would take one
    // board's wash — which looks plausible on the board you happened to open.
    //
    // The three numbers are `veilOpacityFor`'s buckets, not measurements of
    // their own: `veilStrongOpacity` (0.6) above a 0.34 lightness gap,
    // `veilSoftOpacity` (0.3) above 0.175, and none below the coverage floor.
    // So if one of these fails, read it this way: a board moving BETWEEN buckets
    // means its art was re-measured (expected drift — board-art-geometry's
    // veil.test.ts pins the gaps themselves and will say so), while all three
    // moving together, or one going undefined, means the server stopped
    // reaching the measurement at all.
    const veilFor = (boardName: string, layoutId: number, sizeId: number, setIds: string) =>
      service.prepareRender({
        ...standardParams,
        boardName,
        layoutId,
        sizeId,
        setIds,
        frames: '',
        renderMode: 'aura',
        fieldColor: '#181225',
      }).config.veil?.opacity;

    // Tension Board 2 Mirror: the loudest wall in the catalogue, strong bucket.
    expect(veilFor('tension', 10, 6, '12,13')).toBe(0.6);
    // Kilter Original 12x12: over the soft threshold, under the strong one.
    expect(veilFor('kilter', 1, 10, '1,20')).toBe(0.3);
    // MoonBoard 2016 reads only 4 of its 198 placements — under the coverage
    // floor, so there is no wall to quiet and no veil at all.
    expect(veilFor('moonboard', 1, 1, '1')).toBeUndefined();
  });

  it('leaves a classic request byte-identical to what it always was', () => {
    const { config } = service.prepareRender(standardParams);
    expect(config.render_mode).toBeUndefined();
    expect(config.glow).toBeUndefined();
    expect(config.veil).toBeUndefined();
    for (const hold of config.holds) expect(hold.outline).toBeUndefined();
  });
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
      { ...standardParams, renderMode: 'aura' as const },
      { ...standardParams, renderMode: 'aura' as const, glowFalloff: 'plateau' as const },
      { ...standardParams, colorScheme: 'dark' as const },
    ];

    expect(new Set(variants.map(service.buildBoardRenderByteCacheKey))).not.toContain(baseKey);
    expect(new Set(variants.map(service.buildBoardRenderByteCacheKey)).size).toBe(variants.length);
    const auraParams = { ...standardParams, renderMode: 'aura' as const };
    expect(
      new Set(
        [
          auraParams,
          { ...auraParams, glowFalloff: 'plateau' as const },
          { ...auraParams, glyphs: true },
          { ...auraParams, fieldColor: '#123456' },
        ].map(service.buildBoardRenderByteCacheKey),
      ).size,
    ).toBe(4);
    expect(standardParams).not.toHaveProperty('v');
    const versionAlias = { ...standardParams, v: '0123456789ab' };
    expect(service.buildBoardRenderByteCacheKey(versionAlias)).toBe(baseKey);
  });

  it('keys an unnamed field colour the same as an explicit light one', () => {
    // Both draw the same pixels — the light field is what "unset" means — so
    // minting two cache entries for them would be paying twice for one render.
    const auraParams = { ...standardParams, renderMode: 'aura' as const };
    expect(service.buildBoardRenderByteCacheKey({ ...auraParams, fieldColor: '#FFFFFF' })).toBe(
      service.buildBoardRenderByteCacheKey(auraParams),
    );
    // Case is not a third variant either.
    expect(service.buildBoardRenderByteCacheKey({ ...auraParams, fieldColor: '#ffffff' })).toBe(
      service.buildBoardRenderByteCacheKey(auraParams),
    );
    // A real wash still keys apart from no wash.
    expect(service.buildBoardRenderByteCacheKey({ ...auraParams, fieldColor: '#181225' })).not.toBe(
      service.buildBoardRenderByteCacheKey(auraParams),
    );
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
