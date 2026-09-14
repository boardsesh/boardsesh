import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { SPRAY_PRODUCT_ID, SPRAY_SET, spraySizeIdForLayout } from '@boardsesh/board-config';
import { boardLayouts, boardProductSizes, boardProductSizesLayoutsSets } from '../../schema/boards/unified';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** The board type every spray wall row carries. */
const SPRAY_BOARD_TYPE = 'spray';

export type SprayWallCatalogueInput = {
  /** From `allocateWallIds()`. Also the size id and the join-row id. */
  layoutId: number;
  /** The wall's name, so a catalogue row is readable in a psql session. */
  name: string;
  /** The canonical frame, when it is already known (version 1 is uploaded). */
  referenceWidth?: number | null;
  referenceHeight?: number | null;
};

/**
 * Write the three catalogue rows a spray wall needs: its layout, its size, and
 * the join row that binds them to the one synthetic "Holds" set.
 *
 * **Every row is `is_listed = false`, and that is load-bearing privacy rather
 * than cosmetics.** A wall is one climber's home wall or one gym's, and the
 * catalogue tables are read directly by consumers that know nothing about spray:
 * `getPopularConfigs` feeds the www homepage board rail and the mobile Boards
 * tab, and the sitemap shards decide what Google may crawl. Both now also drop
 * `board_type = 'spray'` by name (#5453), but those are backstops — any future
 * reader of `board_layouts` / `board_product_sizes` relies on `is_listed`
 * alone, so a wall seeded listed would be a privacy bug, not a cosmetic one.
 *
 * Call inside the same transaction as the `spray_walls` insert: the layout id
 * comes from a sequence that never rolls back, so a half-written wall leaves a
 * gap in the id space (fine) rather than a catalogue row with no wall (not).
 */
export async function createSprayWallCatalogueRows(db: DrizzleDb, input: SprayWallCatalogueInput): Promise<void> {
  const { layoutId, name, referenceWidth = null, referenceHeight = null } = input;
  const sizeId = spraySizeIdForLayout(layoutId);

  await db.insert(boardLayouts).values({
    boardType: SPRAY_BOARD_TYPE,
    id: layoutId,
    productId: SPRAY_PRODUCT_ID,
    name,
    isMirrored: false,
    isListed: false,
    createdAt: new Date().toISOString(),
  });

  await db.insert(boardProductSizes).values({
    boardType: SPRAY_BOARD_TYPE,
    id: sizeId,
    productId: SPRAY_PRODUCT_ID,
    name,
    // The catalogue's edge box is the canonical frame, so the climb-search edge
    // filter and `compatible_size_ids` behave on a wall exactly as on a board.
    edgeLeft: 0,
    edgeBottom: 0,
    edgeRight: referenceWidth,
    edgeTop: referenceHeight,
    position: 1,
    isListed: false,
  });

  await db.insert(boardProductSizesLayoutsSets).values({
    boardType: SPRAY_BOARD_TYPE,
    // One join row per wall, so it can share the wall's id rather than need a
    // third id space of its own.
    id: layoutId,
    productSizeId: sizeId,
    layoutId,
    setId: SPRAY_SET.id,
    isListed: false,
  });
}
