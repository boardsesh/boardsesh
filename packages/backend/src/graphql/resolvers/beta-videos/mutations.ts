import { GraphQLError } from 'graphql';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated } from '../shared/helpers';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { invalidateRecentBetaLinksCache } from './queries';

export const betaLinkMutations = {
  deleteBetaLink: async (
    _: unknown,
    { boardType, climbUuid, link }: { boardType: string; climbUuid: string; link: string },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    const userId = ctx.userId!;

    const [row] = await db
      .select({ createdByUserId: dbSchema.boardBetaLinks.createdByUserId })
      .from(dbSchema.boardBetaLinks)
      .where(
        and(
          eq(dbSchema.boardBetaLinks.boardType, boardType),
          eq(dbSchema.boardBetaLinks.climbUuid, climbUuid),
          eq(dbSchema.boardBetaLinks.link, link),
        ),
      )
      .limit(1);

    if (!row || row.createdByUserId !== userId) {
      throw new GraphQLError('You can only delete beta links you attached.', {
        extensions: { code: 'BETA_LINK_NOT_OWNER' },
      });
    }

    await db
      .delete(dbSchema.boardBetaLinks)
      .where(
        and(
          eq(dbSchema.boardBetaLinks.boardType, boardType),
          eq(dbSchema.boardBetaLinks.climbUuid, climbUuid),
          eq(dbSchema.boardBetaLinks.link, link),
        ),
      );

    invalidateRecentBetaLinksCache().catch(() => {});
    return true;
  },
};
