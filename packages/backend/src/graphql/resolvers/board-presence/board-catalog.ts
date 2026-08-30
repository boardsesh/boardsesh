import { and, eq, exists, inArray } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import {
  MOONBOARD_LAYOUTS,
  MOONBOARD_SETS,
  MOONBOARD_SIZE,
  WOODS_LAYOUTS,
  WOODS_SETS,
  WOODS_SIZES,
} from '@boardsesh/board-config';
import { QUANTUM_MODELS, QUANTUM_SET_ID } from '@boardsesh/board-constants';
import { AURORA_BOARDS } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { NumericCsvSchema } from '../../../validation/schemas';

const POSTGRES_INTEGER_MAX = 2_147_483_647;

function throwUnknownBoardConfig(): never {
  throw new GraphQLError('Unknown board configuration', {
    extensions: { code: 'UNKNOWN_BOARD_CONFIG' },
  });
}

function isPostgresInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= POSTGRES_INTEGER_MAX;
}

function validateAndParseSetIds(setIds: string): number[] {
  if (!NumericCsvSchema.safeParse(setIds).success) {
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
 * valid for the exact layout and product size. Aurora placements are
 * layout-and-set specific (not size specific), so each membership must also
 * have a physical placement on that layout.
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
  const uniqueSetIds = validateAndParseSetIds(setIds);

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

  if (boardType === 'woods') {
    if (layoutId !== WOODS_LAYOUTS.woods.id) {
      throwUnknownBoardConfig();
    }

    const woodsSizeIds = new Set(Object.values(WOODS_SIZES).map((woodsSize) => woodsSize.id));
    if (!woodsSizeIds.has(productSizeId)) {
      throwUnknownBoardConfig();
    }

    // Woods ships one synthetic hold set, so the only membership that means
    // anything is that set. Anything else names holds the board doesn't have.
    const woodsSetIds = new Set<number>(WOODS_SETS.map((woodsSet) => woodsSet.id));
    if (uniqueSetIds.length !== woodsSetIds.size || uniqueSetIds.some((setId) => !woodsSetIds.has(setId))) {
      throwUnknownBoardConfig();
    }
    return;
  }

  if (boardType === 'quantum') {
    const isExactModel = Object.values(QUANTUM_MODELS).some(
      (model) => model.layoutId === layoutId && model.sizeId === productSizeId,
    );
    if (!isExactModel || uniqueSetIds.length !== 1 || uniqueSetIds[0] !== QUANTUM_SET_ID) {
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
        exists(
          db
            .select({ id: dbSchema.boardPlacements.id })
            .from(dbSchema.boardPlacements)
            .where(
              and(
                eq(dbSchema.boardPlacements.boardType, dbSchema.boardProductSizesLayoutsSets.boardType),
                eq(dbSchema.boardPlacements.layoutId, dbSchema.boardProductSizesLayoutsSets.layoutId),
                eq(dbSchema.boardPlacements.setId, dbSchema.boardProductSizesLayoutsSets.setId),
              ),
            ),
        ),
      ),
    );

  const matchedSetIds = new Set(matchingAssociations.flatMap(({ setId }) => (setId === null ? [] : [setId])));
  if (matchedSetIds.size !== uniqueSetIds.length) {
    throwUnknownBoardConfig();
  }
}
