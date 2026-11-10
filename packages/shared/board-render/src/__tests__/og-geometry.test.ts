import { describe, expect, it } from 'vitest';
import { MOONBOARD_GRADES } from '@boardsesh/board-config';
import { BOULDER_GRADES, MOONBOARD_BOULDER_GRADES } from '@boardsesh/board-constants/boulder-grade-mapping';
import { HOLD_STATE_MAP } from '@boardsesh/board-constants/hold-states';
import { getBoardDetailsForBoard } from '../board-details';
import { OG_CARD_ART_LEFT, OG_CARD_ART_RIGHT, OG_CARD_BOARD_BOX, OG_IMAGE_HEIGHT, placeOgBoard } from '../headers';
import { buildOgClimbCardContent } from '../og-card';
import { OG_FAMILY_CROP_LEFT, OG_FAMILY_CROP_RIGHT, renderOgFamilyTextLayers } from '../og-family';
import { buildRenderConfig } from '../render-config';
import { listCatalogueEntries } from '../render-version-projection';

type Measured = { label: string; width: number; height: number };

/**
 * Every catalogue config, sized the way the real render sizes it: through
 * `buildRenderConfig`, whose rounded `output_width` is what the WASM overlay and
 * the cached base are drawn at.
 */
const measured: Measured[] = listCatalogueEntries().flatMap((entry) => {
  try {
    const boardDetails = getBoardDetailsForBoard({
      board_name: entry.boardName,
      layout_id: entry.layoutId,
      size_id: entry.sizeId,
      set_ids: entry.setIds,
    });
    if (!boardDetails.boardWidth || !boardDetails.boardHeight) return [];
    const { outputWidth } = buildRenderConfig({
      boardName: entry.boardName,
      boardDetails,
      frames: '',
      thumbnail: false,
      isOgVariant: true,
      boardStates: HOLD_STATE_MAP[entry.boardName],
    });
    return [
      {
        label: `${entry.boardName}/${entry.layoutId}-${entry.sizeId}`,
        width: outputWidth,
        height: Math.round((outputWidth * boardDetails.boardHeight) / boardDetails.boardWidth),
      },
    ];
  } catch {
    return [];
  }
});

/**
 * The climb card is drawn on the share-card family's `full` slot: the board in
 * x 16-560, the climb's identity from x 590, and the grade as the hero, which a
 * search engine's square crop (x 285-915) must keep whole.
 */
describe('climb card geometry against the whole catalogue', () => {
  it('measures the whole catalogue', () => {
    expect(measured.length).toBeGreaterThan(40);
  });

  it('draws every board inside the art slot', () => {
    for (const board of measured) {
      const { left, top } = placeOgBoard(board.width, board.height);

      expect(board.width, board.label).toBeLessThanOrEqual(OG_CARD_BOARD_BOX.width);
      expect(board.height, board.label).toBeLessThanOrEqual(OG_CARD_BOARD_BOX.height + 1);
      expect(left, board.label).toBeGreaterThanOrEqual(OG_CARD_ART_LEFT);
      expect(left + board.width, board.label).toBeLessThanOrEqual(OG_CARD_ART_RIGHT);
      expect(top, board.label).toBeGreaterThanOrEqual(0);
      expect(top + board.height, board.label).toBeLessThanOrEqual(OG_IMAGE_HEIGHT);
    }
  });

  /**
   * Every grade label a card can be handed: the shared scale, MoonBoard's own
   * conversion and Moon's labels, plus each in capitals, which run wider. The
   * hero's room does not depend on the board, so this walks grades, not boards.
   */
  const distinctGradeLabels = [
    ...new Set([
      ...BOULDER_GRADES.map((grade) => grade.difficulty_name),
      ...MOONBOARD_BOULDER_GRADES.map((grade) => grade.difficulty_name),
      ...MOONBOARD_GRADES.map((grade) => grade.label),
    ]),
  ];
  const realGradeLabels = distinctGradeLabels.flatMap((label) => [label, label.toUpperCase()]);

  it('knows every real grade label', () => {
    // 24 on the shared scale, 4a/V0 to 8c+/V16, plus MoonBoard's own 6a/V2.
    expect(distinctGradeLabels).toHaveLength(25);
    expect(distinctGradeLabels).toContain('8c+/V16');
    expect(distinctGradeLabels).toContain('6a/V2');
  });

  it.each(realGradeLabels)('keeps %s whole inside the search crop, right of the art', async (grade) => {
    const content = buildOgClimbCardContent({
      grade,
      name: 'Twice the Spice is Half as Nice',
      setter: 'connor.kainalu',
      angle: 40,
      boardLine: 'Tension · Original Layout · Short & Narrow',
      fontFamily: 'Noto Sans',
    });
    const { hero } = await renderOgFamilyTextLayers(content!);

    expect(hero.left).toBeGreaterThanOrEqual(OG_FAMILY_CROP_LEFT);
    expect(hero.left).toBeGreaterThan(OG_CARD_ART_RIGHT);
    expect(hero.left + hero.width).toBeLessThanOrEqual(OG_FAMILY_CROP_RIGHT);
  });
});
