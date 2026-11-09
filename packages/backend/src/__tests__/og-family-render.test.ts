import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { OG_FAMILY_WHITE, type OgFamilyCardContent } from '@boardsesh/board-render/og-family';

process.env.BOARD_IMAGES_ROOT ??= resolve(dirname(fileURLToPath(import.meta.url)), '../../../web/public');

let service: typeof import('../services/board-render');

beforeAll(async () => {
  service = await import('../services/board-render');
  await service.initBoardRenderer();
  await service.waitForBoardRenderWarmup();
});

const hero = { runs: [{ text: 'V5', color: OG_FAMILY_WHITE }], maxPt: 60, wrap: false };
const fullContent: OgFamilyCardContent = { slot: 'full', fontFamily: 'Noto Sans', hero, rows: [] };
const noneContent: OgFamilyCardContent = { slot: 'none', fontFamily: 'Noto Sans', hero, rows: [] };
const kilterBoard = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20' };

let cardCounter = 0;
const uniqueKey = () => service.buildOgFamilyByteKey('test', `digest-${(cardCounter += 1)}`);

describe('renderOgFamilyArt', () => {
  it('renders a lit board on the family canvas', async () => {
    const result = await service.renderOgFamilyArt({
      cacheKey: uniqueKey(),
      art: { ...kilterBoard, frames: 'p1080r15p1202r12' },
      content: fullContent,
    });

    expect(result.contentType).toBe('image/jpeg');
    expect(result.cache === 'miss' || result.cache === 'plane-hit').toBe(true);
    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(630);
  });

  it('renders an unlit board without the strict /og/climb frames requirement', async () => {
    const result = await service.renderOgFamilyArt({
      cacheKey: uniqueKey(),
      art: { ...kilterBoard, frames: '' },
      content: fullContent,
    });

    expect((await sharp(result.buffer).metadata()).width).toBe(1200);
  });

  it('renders a card with no art at all', async () => {
    const result = await service.renderOgFamilyArt({
      cacheKey: uniqueKey(),
      art: null,
      content: noneContent,
    });

    expect(result.cache).toBe('none');
    expect((await sharp(result.buffer).metadata()).width).toBe(1200);
  });

  it('serves a repeat from the byte cache', async () => {
    const params = {
      cacheKey: uniqueKey(),
      art: { ...kilterBoard, frames: 'p1080r15' },
      content: fullContent,
    };
    await service.renderOgFamilyArt(params);

    const repeat = await service.renderOgFamilyArt(params);

    expect(repeat.cache).toBe('hit');
  });

  it('coalesces identical renders in flight', async () => {
    const params = {
      cacheKey: uniqueKey(),
      art: { ...kilterBoard, frames: 'p1202r12' },
      content: fullContent,
    };

    const [first, second] = await Promise.all([service.renderOgFamilyArt(params), service.renderOgFamilyArt(params)]);

    expect(first).toBe(second);
  });

  it('keeps a family plane out of the climb base cache', async () => {
    service.resetBoardRenderCaches();
    const before = service.getBoardRenderRuntimeStats();

    await service.renderOgFamilyArt({
      cacheKey: uniqueKey(),
      art: { ...kilterBoard, frames: 'p1080r15' },
      content: fullContent,
    });

    const after = service.getBoardRenderRuntimeStats();
    expect(after.ogFamilyPlaneBytes).toBeGreaterThan(0);
    expect(after.ogBaseBytes).toBe(before.ogBaseBytes);
  });
});
