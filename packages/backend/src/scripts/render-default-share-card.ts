/**
 * Renders the site's default share card through the real card pipeline and writes
 * it next to the Next.js routes that serve it.
 *
 * Run from the repo root on a machine with Noto Sans installed, the family the
 * backend image ships:
 *
 *   vp exec tsx packages/backend/src/scripts/render-default-share-card.ts
 *
 * The X is decoration, not a climb: real holds picked by where they sit on the
 * board, with no climb, name or grade behind them. See docs/og-climb.md.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBoardDetailsForBoard } from '@boardsesh/board-render';
import { OG_FAMILY_MUTED, OG_FAMILY_PLACE_ACCENT, OG_FAMILY_WHITE } from '@boardsesh/board-render/og-family';
import {
  buildOgFamilyByteKey,
  initBoardRenderer,
  renderOgFamilyArt,
  waitForBoardRenderWarmup,
} from '../services/board-render';
import { logger } from '../utils/logger';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
process.env.BOARD_IMAGES_ROOT ??= resolve(SCRIPT_DIR, '../../../web/public');

const OUTPUT_PATH =
  process.env.DEFAULT_SHARE_CARD_OUT ?? resolve(SCRIPT_DIR, '../../../web/app/default-share-card.jpg');

const BOARD = { board_name: 'kilter', layout_id: 1, size_id: 10, set_ids: [1, 20] } as const;
/** Half-thickness of each stroke of the X, in units of half the board. */
const STROKE_HALF_WIDTH = 0.1;
/** Keeps the X off the very edge of the board. */
const EDGE_MARGIN = 0.92;
/** One LED colour per arm of the X. */
const ROLE_TOP_LEFT = 14;
const ROLE_TOP_RIGHT = 13;
const ROLE_BOTTOM_LEFT = 15;
const ROLE_BOTTOM_RIGHT = 12;

function buildXFrames(): string {
  const { holdsData, boardWidth, boardHeight } = getBoardDetailsForBoard({ ...BOARD, set_ids: [...BOARD.set_ids] });
  const halfWidth = boardWidth / 2;
  const halfHeight = boardHeight / 2;
  return holdsData
    .flatMap((hold) => {
      const normalizedX = (hold.cx - halfWidth) / halfWidth;
      const normalizedY = (halfHeight - hold.cy) / halfHeight;
      const distanceToStroke = Math.min(
        Math.abs(normalizedY - normalizedX) / Math.SQRT2,
        Math.abs(normalizedY + normalizedX) / Math.SQRT2,
      );
      if (Math.max(Math.abs(normalizedX), Math.abs(normalizedY)) >= EDGE_MARGIN) return [];
      if (distanceToStroke >= STROKE_HALF_WIDTH) return [];
      const role =
        normalizedY > 0
          ? normalizedX < 0
            ? ROLE_TOP_LEFT
            : ROLE_TOP_RIGHT
          : normalizedX < 0
            ? ROLE_BOTTOM_LEFT
            : ROLE_BOTTOM_RIGHT;
      return [{ id: hold.id, role }];
    })
    .sort((first, second) => first.id - second.id)
    .map(({ id, role }) => `p${id}r${role}`)
    .join('');
}

async function main(): Promise<void> {
  await initBoardRenderer();
  await waitForBoardRenderWarmup();
  const { buffer } = await renderOgFamilyArt({
    cacheKey: buildOgFamilyByteKey('site-default', 'static'),
    art: {
      boardName: BOARD.board_name,
      layoutId: BOARD.layout_id,
      sizeId: BOARD.size_id,
      setIds: BOARD.set_ids.join(','),
      frames: buildXFrames(),
    },
    content: {
      slot: 'full',
      fontFamily: 'Noto Sans',
      hideWordmark: true,
      eyebrow: {
        runs: [{ text: 'One app for your boards', color: OG_FAMILY_PLACE_ACCENT }],
        sizePt: 26,
        weight: 700,
        gapBelow: 8,
      },
      hero: { runs: [{ text: 'Boardsesh', color: OG_FAMILY_WHITE }], maxPt: 66, minPt: 34, wrap: true },
      rows: [
        {
          runs: [{ text: 'Works with Kilter, Tension, MoonBoard and more', color: OG_FAMILY_MUTED }],
          sizePt: 22,
          weight: 500,
          maxLines: 3,
        },
      ],
    },
  });
  writeFileSync(OUTPUT_PATH, buffer);
  logger.info(`Wrote ${OUTPUT_PATH} (${buffer.length} bytes)`);
}

main().catch((error: unknown) => {
  logger.error('Could not render the default share card', error);
  process.exitCode = 1;
});
