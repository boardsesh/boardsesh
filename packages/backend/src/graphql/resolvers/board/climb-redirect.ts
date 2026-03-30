import { eq, and } from 'drizzle-orm';
import { db } from '../../../db/client';
import * as schema from '@boardsesh/db/schema';
import { validateInput } from '../shared/helpers';
import { BoardNameSchema, ExternalUUIDSchema } from '../../../validation/schemas';

export interface ClimbRedirectResult {
  url: string;
}

export const climbRedirectQuery = {
  climbRedirect: async (
    _: unknown,
    { boardType, climbUuid, proposalUuid }: {
      boardType: string;
      climbUuid: string;
      proposalUuid?: string;
    },
  ): Promise<ClimbRedirectResult | null> => {
    validateInput(BoardNameSchema, boardType, 'boardType');
    validateInput(ExternalUUIDSchema, climbUuid, 'climbUuid');

    // Look up the climb
    const [climb] = await db
      .select({
        layoutId: schema.boardClimbs.layoutId,
        angle: schema.boardClimbs.angle,
      })
      .from(schema.boardClimbs)
      .where(
        and(
          eq(schema.boardClimbs.uuid, climbUuid),
          eq(schema.boardClimbs.boardType, boardType),
        ),
      )
      .limit(1);

    if (!climb) {
      return null;
    }

    const angle = climb.angle ?? 0;

    // Look up a default product size and set for this layout
    const [psls] = await db
      .select({
        productSizeId: schema.boardProductSizesLayoutsSets.productSizeId,
        setId: schema.boardProductSizesLayoutsSets.setId,
      })
      .from(schema.boardProductSizesLayoutsSets)
      .where(
        and(
          eq(schema.boardProductSizesLayoutsSets.boardType, boardType),
          eq(schema.boardProductSizesLayoutsSets.layoutId, climb.layoutId),
        ),
      )
      .limit(1);

    if (!psls || !psls.productSizeId || !psls.setId) {
      return null;
    }

    // Collect all set IDs for this product size + layout combination
    const setRows = await db
      .select({ setId: schema.boardProductSizesLayoutsSets.setId })
      .from(schema.boardProductSizesLayoutsSets)
      .where(
        and(
          eq(schema.boardProductSizesLayoutsSets.boardType, boardType),
          eq(schema.boardProductSizesLayoutsSets.layoutId, climb.layoutId),
          eq(schema.boardProductSizesLayoutsSets.productSizeId, psls.productSizeId),
        ),
      );

    const setIds = setRows
      .map(r => r.setId)
      .filter((id): id is number => id != null)
      .join(',');

    let url = `/${boardType}/${climb.layoutId}/${psls.productSizeId}/${setIds}/${angle}/view/${climbUuid}`;

    if (proposalUuid) {
      url += `?proposalUuid=${encodeURIComponent(proposalUuid)}`;
    }

    return { url };
  },
};
