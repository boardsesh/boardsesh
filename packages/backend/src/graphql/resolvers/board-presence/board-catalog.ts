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
import { AURORA_BOARDS } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { NumericCsvSchema } from '../../../validation/schemas';

const POSTGRES_INTEGER_MAX = 2_147_483_647;

/** The input field a catalogue refusal is about, so a client can mark that field. */
export type UnknownBoardConfigField = 'boardType' | 'layoutId' | 'sizeId' | 'setIds';

/**
 * `extensions.field` names the first field the catalogue refused, checked in
 * cascade order (board type, layout, size, sets). `invalidSetIds` lists the
 * set ids the layout and size don't have, when the sets were the problem and
 * each id parsed. Both are additive: older clients read only the code.
 */
function throwUnknownBoardConfig(field: UnknownBoardConfigField, invalidSetIds?: number[]): never {
  throw new GraphQLError('Unknown board configuration', {
    extensions: {
      code: 'UNKNOWN_BOARD_CONFIG',
      field,
      ...(invalidSetIds && invalidSetIds.length > 0 ? { invalidSetIds } : {}),
    },
  });
}

function isPostgresInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= POSTGRES_INTEGER_MAX;
}

function validateAndParseSetIds(setIds: string): number[] {
  if (!NumericCsvSchema.safeParse(setIds).success) {
    throwUnknownBoardConfig('setIds');
  }

  const uniqueSetIds = new Set<number>();
  for (const rawSetId of setIds.split(',')) {
    const parsedSetId = Number(rawSetId);
    if (!isPostgresInteger(parsedSetId)) {
      throwUnknownBoardConfig('setIds');
    }
    uniqueSetIds.add(parsedSetId);
  }
  return [...uniqueSetIds];
}

/**
 * On the refusal path only: whether the layout, or the size on that layout,
 * is what the catalogue lacks. Otherwise the sets are the problem. Two
 * one-row probes, run after the main check has already failed, so a valid
 * create never pays for them.
 */
async function firstUnknownAuroraField(
  executor: Pick<typeof db, 'select'>,
  boardType: string,
  layoutId: number,
  productSizeId: number,
): Promise<UnknownBoardConfigField> {
  const associations = dbSchema.boardProductSizesLayoutsSets;
  const [layoutRow] = await executor
    .select({ layoutId: associations.layoutId })
    .from(associations)
    .where(and(eq(associations.boardType, boardType), eq(associations.layoutId, layoutId)))
    .limit(1);
  if (!layoutRow) return 'layoutId';
  const [sizeRow] = await executor
    .select({ layoutId: associations.layoutId })
    .from(associations)
    .where(
      and(
        eq(associations.boardType, boardType),
        eq(associations.layoutId, layoutId),
        eq(associations.productSizeId, productSizeId),
      ),
    )
    .limit(1);
  return sizeRow ? 'setIds' : 'sizeId';
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
  executor: Pick<typeof db, 'select'> = db,
): Promise<void> {
  if (!isPostgresInteger(layoutId)) {
    throwUnknownBoardConfig('layoutId');
  }
  if (!isPostgresInteger(productSizeId)) {
    throwUnknownBoardConfig('sizeId');
  }
  const uniqueSetIds = validateAndParseSetIds(setIds);

  if (boardType === 'moonboard') {
    const layoutEntry = Object.entries(MOONBOARD_LAYOUTS).find(([, layout]) => layout.id === layoutId);
    if (!layoutEntry) {
      throwUnknownBoardConfig('layoutId');
    }
    if (productSizeId !== MOONBOARD_SIZE.id) {
      throwUnknownBoardConfig('sizeId');
    }

    const [layoutKey] = layoutEntry;
    const layoutSetIds = new Set(
      MOONBOARD_SETS[layoutKey as keyof typeof MOONBOARD_SETS].map((boardSet) => boardSet.id),
    );
    const unknownSetIds = uniqueSetIds.filter((setId) => !layoutSetIds.has(setId));
    if (unknownSetIds.length > 0) {
      throwUnknownBoardConfig('setIds', unknownSetIds);
    }
    return;
  }

  if (boardType === 'woods') {
    if (layoutId !== WOODS_LAYOUTS.woods.id) {
      throwUnknownBoardConfig('layoutId');
    }

    const woodsSizeIds = new Set(Object.values(WOODS_SIZES).map((woodsSize) => woodsSize.id));
    if (!woodsSizeIds.has(productSizeId)) {
      throwUnknownBoardConfig('sizeId');
    }

    // Woods ships one synthetic hold set, so the only membership that means
    // anything is that set. Anything else names holds the board doesn't have.
    const woodsSetIds = new Set<number>(WOODS_SETS.map((woodsSet) => woodsSet.id));
    if (uniqueSetIds.length !== woodsSetIds.size || uniqueSetIds.some((setId) => !woodsSetIds.has(setId))) {
      throwUnknownBoardConfig(
        'setIds',
        uniqueSetIds.filter((setId) => !woodsSetIds.has(setId)),
      );
    }
    return;
  }

  if (!(AURORA_BOARDS as readonly string[]).includes(boardType)) {
    throwUnknownBoardConfig('boardType');
  }

  const matchingAssociations = await executor
    .select({ setId: dbSchema.boardProductSizesLayoutsSets.setId })
    .from(dbSchema.boardProductSizesLayoutsSets)
    .where(
      and(
        eq(dbSchema.boardProductSizesLayoutsSets.boardType, boardType),
        eq(dbSchema.boardProductSizesLayoutsSets.layoutId, layoutId),
        eq(dbSchema.boardProductSizesLayoutsSets.productSizeId, productSizeId),
        inArray(dbSchema.boardProductSizesLayoutsSets.setId, uniqueSetIds),
        exists(
          executor
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
    const field = await firstUnknownAuroraField(executor, boardType, layoutId, productSizeId);
    throwUnknownBoardConfig(
      field,
      field === 'setIds' ? uniqueSetIds.filter((setId) => !matchedSetIds.has(setId)) : undefined,
    );
  }
}
