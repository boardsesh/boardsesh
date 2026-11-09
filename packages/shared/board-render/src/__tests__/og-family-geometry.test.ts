import { describe, expect, it } from 'vitest';
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
      for (const layer of layers) expect(layer.left).toBeGreaterThanOrEqual(Math.min(columnLeft, 590));
    }
  });
});
