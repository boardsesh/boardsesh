import { and, eq, inArray } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { MOONBOARD_LAYOUTS, MOONBOARD_SETS, MOONBOARD_SIZE } from '@boardsesh/board-config';
import { AURORA_BOARDS } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const NUMERIC_CSV_PATTERN = /^\d+(,\d+)*$/;

function throwUnknownBoardConfig(): never {
  throw new GraphQLError('Unknown board configuration', {
    extensions: { code: 'UNKNOWN_BOARD_CONFIG' },
  });
}

function isPostgresInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= POSTGRES_INTEGER_MAX;
}

function parseUniqueSetIds(setIds: string): number[] {
  if (!NUMERIC_CSV_PATTERN.test(setIds)) {
    throwUnknownBoardConfig();
  }

  const uniqueSetIds = new Set<number>();
  for (const rawSetId of setIds.split(',')) {
    const parsedSetId = Number(rawSetId);
    if (!isPostgresInteger(parsedSetId)) {
      throwUnknownBoardConfig();
    }
    uniqueSetIds.add(parsedSetId);
  }
  return [...uniqueSetIds];
}

/**
 * Assert that a board configuration is represented by the authoritative
 * hardware catalog. The helper never rewrites the caller's setIds: duplicate
 * and differently ordered IDs are accepted when every unique membership is
 * valid for the exact layout and product size.
 */
export async function assertKnownBoardConfig(
  boardType: string,
  layoutId: number,
  productSizeId: number,
  setIds: string,
): Promise<void> {
  if (!isPostgresInteger(layoutId) || !isPostgresInteger(productSizeId)) {
    throwUnknownBoardConfig();
  }
  const uniqueSetIds = parseUniqueSetIds(setIds);

  if (boardType === 'moonboard') {
    if (productSizeId !== MOONBOARD_SIZE.id) {
      throwUnknownBoardConfig();
    }

    const layoutEntry = Object.entries(MOONBOARD_LAYOUTS).find(([, layout]) => layout.id === layoutId);
    if (!layoutEntry) {
      throwUnknownBoardConfig();
    }

    const [layoutKey] = layoutEntry;
    const layoutSetIds = new Set(
      MOONBOARD_SETS[layoutKey as keyof typeof MOONBOARD_SETS].map((boardSet) => boardSet.id),
    );
    if (uniqueSetIds.some((setId) => !layoutSetIds.has(setId))) {
      throwUnknownBoardConfig();
    }
    return;
  }

  if (!(AURORA_BOARDS as readonly string[]).includes(boardType)) {
    throwUnknownBoardConfig();
  }

  const matchingAssociations = await db
    .select({ setId: dbSchema.boardProductSizesLayoutsSets.setId })
    .from(dbSchema.boardProductSizesLayoutsSets)
    .where(
      and(
        eq(dbSchema.boardProductSizesLayoutsSets.boardType, boardType),
        eq(dbSchema.boardProductSizesLayoutsSets.layoutId, layoutId),
        eq(dbSchema.boardProductSizesLayoutsSets.productSizeId, productSizeId),
        inArray(dbSchema.boardProductSizesLayoutsSets.setId, uniqueSetIds),
      ),
    );

  const matchedSetIds = new Set(matchingAssociations.flatMap(({ setId }) => (setId === null ? [] : [setId])));
  if (matchedSetIds.size !== uniqueSetIds.length) {
    throwUnknownBoardConfig();
  }
}
