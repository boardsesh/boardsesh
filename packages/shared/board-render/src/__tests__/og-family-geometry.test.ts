import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { getBoardDetailsForBoard } from '../board-details';
import {
  OG_FAMILY_CROP_LEFT,
  OG_FAMILY_CROP_RIGHT,
  OG_FAMILY_MUTED,
  OG_FAMILY_WHITE,
  ogFamilyArtBounds,
  ogFamilyBoardBox,
  ogFamilyColumnLeft,
  ogFamilyHeroBounds,
  placeOgFamilyBoard,
  renderOgFamilyTextLayers,
  type OgFamilySlot,
} from '../og-family';
import { OG_IMAGE_HEIGHT } from '../headers';
import { listCatalogueEntries } from '../render-version-projection';

/** Render scale for a board in a slot, the same formula `buildRenderConfig` uses. */
function scaledBoard(slot: 'full' | 'narrow', boardWidth: number, boardHeight: number) {
  const box = ogFamilyBoardBox(slot);
  const scale = Math.min(box.width / boardWidth, box.height / boardHeight);
  return { width: Math.max(1, Math.round(boardWidth * scale)), height: Math.max(1, Math.round(boardHeight * scale)) };
}

const measured = listCatalogueEntries().flatMap((entry) => {
  let details;
  try {
    details = getBoardDetailsForBoard({
      board_name: entry.boardName,
      layout_id: entry.layoutId,
      size_id: entry.sizeId,
      set_ids: entry.setIds,
    });
  } catch {
    return [];
  }
  if (!details.boardWidth || !details.boardHeight) return [];
  return [{ label: `${entry.boardName}/${entry.layoutId}-${entry.sizeId}`, details }];
});

const ALL_SLOTS: readonly OgFamilySlot[] = ['full', 'narrow', 'none'];
const ART_SLOTS = ['full', 'narrow'] as const;

describe('family art slots against the whole catalogue', () => {
  it('measures the whole catalogue', () => {
    expect(measured.length).toBeGreaterThan(40);
  });

  it.each(ART_SLOTS)('%s: every board sits inside its slot and off the column', (slot) => {
    const bounds = ogFamilyArtBounds(slot)!;
    for (const { label, details } of measured) {
      const { width, height } = scaledBoard(slot, details.boardWidth, details.boardHeight);
      // Worst-case centroids for a narrow crop: both board edges and the middle.
      for (const centroid of [0, width / 2, width]) {
        const placement = placeOgFamilyBoard(slot, width, height, centroid);
        expect(placement.canvasLeft, label).toBeGreaterThanOrEqual(bounds.left);
        expect(placement.canvasLeft + placement.visibleWidth, label).toBeLessThanOrEqual(bounds.right);
        expect(placement.canvasTop, label).toBeGreaterThanOrEqual(0);
        expect(placement.canvasTop + placement.visibleHeight, label).toBeLessThanOrEqual(OG_IMAGE_HEIGHT);
        expect(placement.sourceLeft, label).toBeGreaterThanOrEqual(0);
        expect(placement.sourceLeft + placement.visibleWidth, label).toBeLessThanOrEqual(width);
      }
    }
  });

  it.each(ART_SLOTS)('%s: the art never reaches the text column', (slot) => {
    expect(ogFamilyArtBounds(slot)!.right).toBeLessThan(ogFamilyColumnLeft(slot));
  });

  it('crops a narrow slice around the lit holds, not the board middle', () => {
    const atLeftEdge = placeOgFamilyBoard('narrow', 1000, 600, 40);
    const atRightEdge = placeOgFamilyBoard('narrow', 1000, 600, 960);

    expect(atLeftEdge.sourceLeft).toBe(0);
    expect(atRightEdge.sourceLeft).toBe(710);
  });

  it('centres a board narrower than the slot', () => {
    const placement = placeOgFamilyBoard('narrow', 200, 600, 100);

    expect(placement.canvasLeft).toBe(45);
    expect(placement.visibleWidth).toBe(200);
  });
});

const heroRuns = (text: string) => [{ text, color: OG_FAMILY_WHITE }];

describe('family hero stays inside the search crop', () => {
  it.each(ALL_SLOTS)('%s: `7c+/V10` fits the crop', async (slot) => {
    const { hero } = await renderOgFamilyTextLayers({
      slot,
      fontFamily: 'Noto Sans',
      hero: { runs: heroRuns('7c+/V10'), maxPt: 96, wrap: false },
      rows: [],
    });

    expect(hero.left).toBeGreaterThanOrEqual(OG_FAMILY_CROP_LEFT);
    expect(hero.left + hero.width).toBeLessThanOrEqual(OG_FAMILY_CROP_RIGHT);
  });

  it.each(ALL_SLOTS)('%s: `V5–V9` fits the crop', async (slot) => {
    const { hero } = await renderOgFamilyTextLayers({
      slot,
      fontFamily: 'Noto Sans',
      hero: {
        runs: [
          { text: 'V5', color: OG_FAMILY_WHITE },
          { text: '–', color: OG_FAMILY_MUTED },
          { text: 'V9', color: OG_FAMILY_WHITE },
        ],
        maxPt: 78,
        wrap: false,
      },
      rows: [],
    });

    expect(hero.left).toBeGreaterThanOrEqual(OG_FAMILY_CROP_LEFT);
    expect(hero.left + hero.width).toBeLessThanOrEqual(OG_FAMILY_CROP_RIGHT);
  });

  it('never cuts the widest band the grade scale can produce', async () => {
    // V10 to V16 on the widest hero the full slot leaves: the grade must shrink, not clip.
    const { hero } = await renderOgFamilyTextLayers({
      slot: 'full',
      fontFamily: 'Noto Sans',
      hero: {
        runs: [
          { text: 'V10', color: OG_FAMILY_WHITE },
          { text: '–', color: OG_FAMILY_MUTED },
          { text: 'V16', color: OG_FAMILY_WHITE },
        ],
        maxPt: 78,
        wrap: false,
      },
      rows: [],
    });

    expect(hero.left + hero.width).toBeLessThanOrEqual(OG_FAMILY_CROP_RIGHT);
  });

  it('never draws text left of the column', async () => {
    for (const slot of ALL_SLOTS) {
      const { layers } = await renderOgFamilyTextLayers({
        slot,
        fontFamily: 'Noto Sans',
        pill: { text: 'JOIN', color: OG_FAMILY_WHITE },
        hero: { runs: heroRuns('A hero'), maxPt: 60, wrap: true },
        rows: [{ runs: heroRuns('A row of text'), sizePt: 20, weight: 500 }],
      });
      const columnLeft = ogFamilyHeroBounds(slot).left;
      // A hero's first-line hook may hang a few pixels past the column edge.
      const allowedHang = 24;
      for (const layer of layers) expect(layer.left).toBeGreaterThanOrEqual(columnLeft - allowedHang);
    }
  });
});

describe('family blocks stay clear of each other', () => {
  const overlaps = (
    first: { left: number; top: number; width: number; height: number },
    second: { left: number; top: number; width: number; height: number },
  ) =>
    first.left < second.left + second.width &&
    second.left < first.left + first.width &&
    first.top < second.top + second.height &&
    second.top < first.top + first.height;

  it('keeps `1.1M sends` inside the crop on the full slot', async () => {
    const { hero } = await renderOgFamilyTextLayers({
      slot: 'full',
      fontFamily: 'Noto Sans',
      identity: { name: 'KilterStudio', avatar: null, sizePt: 34 },
      hero: {
        runs: [
          { text: '1.1M', color: OG_FAMILY_WHITE },
          { text: ' sends', color: OG_FAMILY_WHITE, scale: 0.42 },
        ],
        maxPt: 96,
        wrap: false,
        tight: true,
      },
      rows: [],
    });

    expect(hero.left).toBeGreaterThanOrEqual(OG_FAMILY_CROP_LEFT);
    expect(hero.left + hero.width).toBeLessThanOrEqual(OG_FAMILY_CROP_RIGHT);
  });

  it('keeps a tight grade hero whole under an identity row with a long name', async () => {
    const { hero, blocks } = await renderOgFamilyTextLayers({
      slot: 'full',
      fontFamily: 'Noto Sans',
      identity: { name: 'A very long display name somebody typed', avatar: null, sizePt: 34 },
      hero: { runs: [{ text: '7c+/V10', color: OG_FAMILY_WHITE }], maxPt: 96, wrap: false, tight: true },
      rows: [],
    });

    expect(hero.left + hero.width).toBeLessThanOrEqual(OG_FAMILY_CROP_RIGHT);
    expect(overlaps(hero, blocks.identity!)).toBe(false);
  });

  it('keeps the aside outside the crop and off the hero and name on a narrow card', async () => {
    const { hero, blocks } = await renderOgFamilyTextLayers({
      slot: 'narrow',
      fontFamily: 'Noto Sans',
      identity: { name: 'A very long display name somebody typed', avatar: null, sizePt: 30 },
      hero: { runs: [{ text: '7c+/V10', color: OG_FAMILY_WHITE }], maxPt: 170, wrap: false, tight: true },
      rows: [{ runs: heroRuns('17 sends, all flashed'), sizePt: 34, weight: 800 }],
      aside: {
        eyebrow: 'HARDEST SEND',
        title: 'A really very long climb name somebody typed on their phone',
        lines: ['Flashed by someone', 'Kilter at 40°', '49 min session'],
      },
    });

    expect(hero.left + hero.width).toBeLessThanOrEqual(OG_FAMILY_CROP_RIGHT);
    expect(blocks.aside!.left).toBeGreaterThanOrEqual(OG_FAMILY_CROP_RIGHT);
    expect(overlaps(hero, blocks.aside!)).toBe(false);
    expect(overlaps(blocks.identity!, blocks.aside!)).toBe(false);
    expect(blocks.aside!.top + blocks.aside!.height).toBeLessThan(574);
  });

  it('keeps the dots inside the crop however many there are', async () => {
    for (const count of [1, 10, 11, 17, 40, 60, 200]) {
      const { hero, blocks } = await renderOgFamilyTextLayers({
        slot: 'narrow',
        fontFamily: 'Noto Sans',
        hero: { runs: [{ text: '6a/V3', color: OG_FAMILY_WHITE }], maxPt: 170, wrap: false, tight: true },
        rows: [{ runs: heroRuns('A line'), sizePt: 34, weight: 800 }],
        dots: {
          dots: Array.from({ length: Math.min(count, 60) }, () => ({ color: '#FFD400', filled: true })),
          total: count,
        },
      });

      expect(blocks.dots, `${count}`).toBeDefined();
      expect(blocks.dots!.left + blocks.dots!.width, `${count}`).toBeLessThanOrEqual(OG_FAMILY_CROP_RIGHT);
      expect(overlaps(hero, blocks.dots!)).toBe(false);
    }
  });

  it('keeps the rings and attempt label inside the crop', async () => {
    const { blocks } = await renderOgFamilyTextLayers({
      slot: 'narrow',
      fontFamily: 'Noto Sans',
      hero: { runs: [{ text: '7a+/V7', color: OG_FAMILY_WHITE }], maxPt: 170, wrap: false, tight: true },
      rows: [],
      dots: {
        dots: Array.from({ length: 24 }, () => ({ color: '#FFD400', filled: false })),
        total: 412,
        label: '412 attempts',
      },
    });

    expect(blocks.dots!.left + blocks.dots!.width).toBeLessThanOrEqual(OG_FAMILY_CROP_RIGHT);
  });

  it('draws bars when they are clear of the text and drops them when they are not', async () => {
    const bars = Array.from({ length: 5 }, (_, index) => ({ color: '#FFD400', value: index }));
    const clear = await renderOgFamilyTextLayers({
      slot: 'full',
      fontFamily: 'Noto Sans',
      hero: { runs: heroRuns('7a/V6'), maxPt: 96, wrap: false, tight: true },
      rows: [{ runs: heroRuns('One line'), sizePt: 18, weight: 500 }],
      bars,
    });
    expect(clear.blocks.bars).toBeDefined();
    expect(overlaps(clear.hero, clear.blocks.bars!)).toBe(false);

    const crowded = await renderOgFamilyTextLayers({
      slot: 'full',
      fontFamily: 'Noto Sans',
      identity: { name: 'A name', avatar: { kind: 'monogram', letter: 'A', color: '#FFD400' }, sizePt: 34 },
      hero: { runs: heroRuns('7a/V6'), maxPt: 96, wrap: false, tight: true },
      rows: Array.from({ length: 8 }, () => ({ runs: heroRuns('A long supporting line'), sizePt: 24, weight: 500 })),
      bars,
    });
    expect(crowded.blocks.bars).toBeUndefined();
  });

  it('keeps every drawn bar inside the column and above the wordmark row', async () => {
    const bars = Array.from({ length: 24 }, (_, index) => ({ color: '#FFD400', value: index }));
    const { blocks } = await renderOgFamilyTextLayers({
      slot: 'full',
      fontFamily: 'Noto Sans',
      hero: { runs: heroRuns('7a/V6'), maxPt: 96, wrap: false, tight: true },
      rows: [],
      bars,
    });

    expect(blocks.bars!.left + blocks.bars!.width).toBeLessThanOrEqual(1176);
    expect(blocks.bars!.top + blocks.bars!.height).toBeLessThanOrEqual(556);
  });

  it('does not draw bars for fewer than three grades', async () => {
    const { blocks } = await renderOgFamilyTextLayers({
      slot: 'full',
      fontFamily: 'Noto Sans',
      hero: { runs: heroRuns('7a/V6'), maxPt: 96, wrap: false, tight: true },
      rows: [],
      bars: [{ color: '#FFD400', value: 1 }],
    });

    expect(blocks.bars).toBeUndefined();
  });

  it('draws a monogram for any first character without failing', async () => {
    for (const letter of ['A', 'И', '田', '🧗', 'ש', 'ع']) {
      const { layers, blocks } = await renderOgFamilyTextLayers({
        slot: 'full',
        fontFamily: 'Noto Sans',
        identity: { name: `${letter} name`, avatar: { kind: 'monogram', letter, color: '#FFD400' }, sizePt: 34 },
        hero: { runs: heroRuns('7a/V6'), maxPt: 96, wrap: false, tight: true },
        rows: [],
      });
      expect(blocks.identity).toBeDefined();
      expect(layers.length).toBeGreaterThan(2);
    }
  });
});

describe('a place card eyebrow', () => {
  const eyebrow = (text: string) => ({ runs: [{ text, color: OG_FAMILY_MUTED }], sizePt: 26, weight: 700 });
  const hero = (text: string) => ({ runs: [{ text, color: OG_FAMILY_WHITE }], maxPt: 66, minPt: 28, wrap: true });

  it.each<[string, Exclude<OgFamilySlot, 'narrow'>, string, string]>([
    ['a short name', 'full', 'Kilter 40°', 'Kaserne'],
    ['a three-line name', 'full', 'Kilter + Tension + MoonBoard', 'The Climbing Hangar, Plymouth'],
    ['a very long boards line', 'full', 'Kilter + Tension + MoonBoard + Decoy + Touchstone + Grasshopper', 'Lab'],
    ['a card with no art', 'none', 'Spray wall 40°', 'The Barn'],
  ])('stays above the hero and clear of the art with %s', async (_label, slot, line, name) => {
    const { hero: heroRect, blocks } = await renderOgFamilyTextLayers({
      slot,
      fontFamily: 'Noto Sans',
      eyebrow: eyebrow(line),
      hero: hero(name),
      rows: [],
    });

    const rect = blocks.eyebrow!;
    expect(rect.top + rect.height).toBeLessThanOrEqual(heroRect.top);
    expect(heroRect.left).toBeGreaterThanOrEqual(OG_FAMILY_CROP_LEFT);
    expect(heroRect.left + heroRect.width).toBeLessThanOrEqual(OG_FAMILY_CROP_RIGHT);
    expect(rect.left + rect.width).toBeLessThanOrEqual(1176);
    const art = ogFamilyArtBounds(slot);
    if (art) expect(rect.left).toBeGreaterThanOrEqual(art.right);
  });
});

describe('the icon and wordmark corner stays clear', () => {
  type Rect = { left: number; top: number; width: number; height: number };
  const overlaps = (first: Rect, second: Rect) =>
    first.left < second.left + second.width &&
    second.left < first.left + first.width &&
    first.top < second.top + second.height &&
    second.top < first.top + first.height;
  const muted = (text: string) => [{ text, color: OG_FAMILY_MUTED }];
  const longLine = 'Touchstone · Dungeon Trainer · Full Size Commercial · and then some more words';

  it.each<[string, Parameters<typeof renderOgFamilyTextLayers>[0]]>([
    [
      'grade bars under a profile',
      {
        slot: 'full',
        fontFamily: 'Noto Sans',
        identity: { name: 'A very long display name somebody typed', avatar: null, sizePt: 34 },
        hero: { runs: heroRuns('7c/V9'), maxPt: 96, wrap: false, tight: true },
        rows: [
          { runs: muted('Hardest of 4,612 climbs sent on Kilter, Tension and MoonBoard'), sizePt: 18, weight: 500 },
        ],
        bars: Array.from({ length: 24 }, (_unused, index) => ({ color: '#FFD400', value: index })),
      },
    ],
    [
      'recap dots and a tall aside',
      {
        slot: 'narrow',
        fontFamily: 'Noto Sans',
        identity: { name: 'Sam', avatar: { kind: 'monogram', letter: 'S', color: '#FFD400' }, sizePt: 30 },
        hero: { runs: heroRuns('6a/V3'), maxPt: 170, wrap: false, tight: true },
        rows: [{ runs: heroRuns('212 sends, 117 flashed'), sizePt: 34, weight: 800 }],
        dots: { dots: Array.from({ length: 60 }, () => ({ color: '#FFD400', filled: true })), total: 212 },
        aside: {
          eyebrow: 'HARDEST SEND',
          title: 'A really very long climb name somebody typed on their phone at the crag',
          lines: [longLine, longLine, longLine, longLine],
        },
      },
    ],
    [
      'rows that fill the column to its floor',
      {
        slot: 'full',
        fontFamily: 'Noto Sans',
        hero: { runs: heroRuns('1.1M'), maxPt: 96, wrap: false, tight: true },
        rows: Array.from({ length: 30 }, () => ({ runs: muted(longLine), sizePt: 24, weight: 500, maxLines: 3 })),
      },
    ],
    [
      'a centred card with no art',
      {
        slot: 'none',
        fontFamily: 'Noto Sans',
        eyebrow: { runs: muted('No boards yet'), sizePt: 26, weight: 700 },
        hero: {
          runs: heroRuns('Bergfreunde Kletterzentrum Hamburg Süd und die lange Halle'),
          maxPt: 66,
          minPt: 28,
          wrap: true,
        },
        rows: Array.from({ length: 6 }, () => ({ runs: muted(longLine), sizePt: 24, weight: 500, maxLines: 2 })),
      },
    ],
    [
      'a right-to-left stack',
      {
        slot: 'full',
        fontFamily: 'Noto Sans',
        eyebrow: { runs: muted('Kilter 40°'), sizePt: 26, weight: 700 },
        hero: { runs: heroRuns('מרכז טיפוס הר הכרמל והעמק הגדול'), maxPt: 66, minPt: 28, wrap: true },
        rows: [{ runs: muted('صالة تسلق الجبل الكبيرة جداً'), sizePt: 24, weight: 500, maxLines: 3 }],
      },
    ],
  ])('with %s', async (_label, content) => {
    const { layers, blocks, hero, brand } = await renderOgFamilyTextLayers(content);

    const others: Rect[] = [hero, ...Object.values(blocks)];
    for (const layer of layers.slice(0, -2)) {
      const { width, height } = await sharp(layer.input).metadata();
      others.push({ left: layer.left, top: layer.top, width, height });
    }
    for (const rect of others) expect(overlaps(rect, brand), JSON.stringify(rect)).toBe(false);
    const art = ogFamilyArtBounds(content.slot);
    if (art) expect(brand.left).toBeGreaterThanOrEqual(art.right);
    expect(brand.left + brand.width).toBeLessThanOrEqual(1200);
    expect(brand.top + brand.height).toBeLessThanOrEqual(OG_IMAGE_HEIGHT);
  });
});
