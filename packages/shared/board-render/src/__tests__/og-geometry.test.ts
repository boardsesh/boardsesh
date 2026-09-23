import { describe, expect, it } from 'vitest';
import { getBoardDetailsForBoard } from '../board-details';
import { OG_CARD_BOARD_BOX, OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, placeOgBoard } from '../headers';
import { listCatalogueEntries } from '../render-version-projection';

/** The board box before the identity column existed: 48px padding on all sides. */
const PREVIOUS_BOX = { width: OG_IMAGE_WIDTH - 96, height: OG_IMAGE_HEIGHT - 96 };

/**
 * A search engine crops a 1200×630 card to a square from the centre, so only
 * this horizontal band survives into a SERP thumbnail.
 */
const SQUARE_CROP_LEFT = (OG_IMAGE_WIDTH - OG_IMAGE_HEIGHT) / 2;
const SQUARE_CROP_RIGHT = SQUARE_CROP_LEFT + OG_IMAGE_HEIGHT;

type Measured = {
  label: string;
  width: number;
  height: number;
  previousArea: number;
  area: number;
  cropCoverage: number;
};

const measured: Measured[] = listCatalogueEntries().flatMap((entry) => {
  let boardWidth: number;
  let boardHeight: number;
  try {
    const details = getBoardDetailsForBoard({
      board_name: entry.boardName,
      layout_id: entry.layoutId,
      size_id: entry.sizeId,
      set_ids: entry.setIds,
    });
    boardWidth = details.boardWidth;
    boardHeight = details.boardHeight;
  } catch {
    return [];
  }
  if (!boardWidth || !boardHeight) return [];

  const scale = Math.min(OG_CARD_BOARD_BOX.width / boardWidth, OG_CARD_BOARD_BOX.height / boardHeight);
  const previousScale = Math.min(PREVIOUS_BOX.width / boardWidth, PREVIOUS_BOX.height / boardHeight);
  const width = boardWidth * scale;
  const height = boardHeight * scale;
  const { left } = placeOgBoard(width, height);
  const visible = Math.max(0, Math.min(left + width, SQUARE_CROP_RIGHT) - Math.max(left, SQUARE_CROP_LEFT));

  return [
    {
      label: `${entry.boardName}/${entry.layoutId}-${entry.sizeId}`,
      width,
      height,
      previousArea: boardWidth * previousScale * boardHeight * previousScale,
      area: width * height,
      cropCoverage: visible / width,
    },
  ];
});

/**
 * The card gained a 392px identity column, which narrows the box the board is
 * fitted into. That is only acceptable because the padding shrank further than
 * the column cost — but "acceptable" is a claim about every board in the
 * catalogue, not about the two anyone looked at.
 */
describe('OG card geometry', () => {
  it('measures the whole catalogue', () => {
    expect(measured.length).toBeGreaterThan(40);
  });

  it('never renders a board smaller than the previous full-width layout', () => {
    const shrunk = measured
      .filter((board) => board.area < board.previousArea)
      .map((board) => `${board.label} ${(100 * (board.area / board.previousArea - 1)).toFixed(1)}%`);

    expect(shrunk).toEqual([]);
  });

  it('keeps every board inside its box', () => {
    for (const board of measured) {
      expect(board.width, board.label).toBeLessThanOrEqual(OG_CARD_BOARD_BOX.width + 0.5);
      expect(board.height, board.label).toBeLessThanOrEqual(OG_CARD_BOARD_BOX.height + 0.5);
    }
  });

  it('never overlaps the identity column', () => {
    const columnLeft = OG_CARD_BOARD_BOX.left + OG_CARD_BOARD_BOX.width;
    for (const board of measured) {
      const { left, top } = placeOgBoard(board.width, board.height);

      expect(left, board.label).toBeGreaterThanOrEqual(0);
      expect(left + board.width, board.label).toBeLessThanOrEqual(columnLeft + 0.5);
      expect(top, board.label).toBeGreaterThanOrEqual(0);
      expect(top + board.height, board.label).toBeLessThanOrEqual(OG_IMAGE_HEIGHT);
    }
  });

  it('leaves most of every board inside a square SERP crop', () => {
    // Right-aligning the board is what buys this; centring it drops the worst
    // case into the fifties. Anything under half and the thumbnail stops being
    // a picture of a climb.
    const worst = measured.reduce((lowest, board) => (board.cropCoverage < lowest.cropCoverage ? board : lowest));

    expect(
      worst.cropCoverage,
      `${worst.label} is only ${(worst.cropCoverage * 100).toFixed(0)}% inside the crop`,
    ).toBeGreaterThan(0.6);
  });
});
