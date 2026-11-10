import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OG_CARD_COLUMN_LEFT } from '@boardsesh/board-render';
import {
  OG_FAMILY_ICON_PATH,
  OG_FAMILY_WHITE,
  resetOgFamilyIcon,
  type OgFamilyCardContent,
} from '@boardsesh/board-render/og-family';
import { logger } from '../utils/logger';

/**
 * The app icon is a file read. If it ever fails, a card must keep its words and
 * must not be kept anywhere as the final drawing: the climb card's byte cache
 * would otherwise hold the iconless bytes, and its URL is `immutable` for a year.
 */

process.env.BOARD_IMAGES_ROOT ??= resolve(dirname(fileURLToPath(import.meta.url)), '../../../web/public');

let service: typeof import('../services/board-render');

beforeAll(async () => {
  service = await import('../services/board-render');
  await service.initBoardRenderer();
  await service.waitForBoardRenderWarmup();
});

const MISSING_ICON = `${OG_FAMILY_ICON_PATH}.missing`;
const climb = {
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  frames: 'p1080r15p1202r12',
  format: 'jpeg' as const,
};
const card = { name: 'Kiel training 1:4', grade: '7a/V6', setter: 'KilterStudio', angle: 40, fontFamily: 'Noto Sans' };

/** Mean absolute channel difference between two cards over the text column. */
async function textColumnDifference(first: Buffer, second: Buffer): Promise<number> {
  const region = { left: OG_CARD_COLUMN_LEFT, top: 100, width: 1200 - OG_CARD_COLUMN_LEFT - 40, height: 400 };
  const [firstPixels, secondPixels] = await Promise.all(
    [first, second].map((buffer) => sharp(buffer).extract(region).raw().toBuffer()),
  );
  let total = 0;
  for (let index = 0; index < firstPixels.length; index++) total += Math.abs(firstPixels[index] - secondPixels[index]);
  return total / firstPixels.length;
}

describe('a card whose app icon cannot be read', () => {
  beforeEach(() => {
    service.resetBoardRenderCaches();
    resetOgFamilyIcon(MISSING_ICON);
  });
  afterEach(() => {
    resetOgFamilyIcon();
    vi.restoreAllMocks();
  });

  it('keeps the climb card words, caches nothing, and serves the real card once the icon is back', async () => {
    const warn = vi.spyOn(logger, 'warn');

    const first = await service.renderOgClimb({ ...climb, card });
    const second = await service.renderOgClimb({ ...climb, card });

    expect(first.iconMissing).toBe(true);
    expect(second.iconMissing).toBe(true);
    // Not a byte-cache hit: the iconless card was never stored under the key.
    expect(second.cache).not.toBe('hit');
    // The words are still drawn: the text column is not the bare board's.
    const bare = await service.renderOgClimb(climb);
    expect(await textColumnDifference(first.buffer, bare.buffer)).toBeGreaterThan(1);
    // Warned once, not once per card.
    const iconWarnings = warn.mock.calls.filter((call) => JSON.stringify(call).includes('App icon unreadable'));
    expect(iconWarnings).toHaveLength(1);

    resetOgFamilyIcon();
    const recovered = await service.renderOgClimb({ ...climb, card });
    const cached = await service.renderOgClimb({ ...climb, card });

    expect(recovered.iconMissing).toBe(false);
    expect(cached.cache).toBe('hit');
    expect(cached.iconMissing).toBe(false);
  });

  it('keeps a family card out of the byte cache until it has its icon', async () => {
    const content: OgFamilyCardContent = {
      slot: 'none',
      fontFamily: 'Noto Sans',
      hero: { runs: [{ text: 'Pinnacle', color: OG_FAMILY_WHITE }], maxPt: 60, wrap: true },
      rows: [],
    };
    const cacheKey = service.buildOgFamilyByteKey('test', 'icon-missing');

    const first = await service.renderOgFamilyArt({ cacheKey, art: null, content });
    const second = await service.renderOgFamilyArt({ cacheKey, art: null, content });

    expect(first.iconMissing).toBe(true);
    expect(second.cache).not.toBe('hit');

    resetOgFamilyIcon();
    const recovered = await service.renderOgFamilyArt({ cacheKey, art: null, content });
    const cached = await service.renderOgFamilyArt({ cacheKey, art: null, content });

    expect(recovered.iconMissing).toBe(false);
    expect(cached.cache).toBe('hit');
  });
});
