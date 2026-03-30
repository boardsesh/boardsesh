import { eq, and } from 'drizzle-orm';
import { db } from '../../../db/client';
import { UNIFIED_TABLES } from '../../../db/queries/util/table-select';
import { validateInput } from '../shared/helpers';
import { BoardNameSchema, ExternalUUIDSchema } from '../../../validation/schemas';

export interface BetaLink {
  climbUuid: string;
  link: string;
  foreignUsername: string | null;
  angle: number | null;
  thumbnail: string | null;
  isListed: boolean | null;
  createdAt: string | null;
}

export const betaLinksQuery = {
  climbBetaLinks: async (
    _: unknown,
    { boardName, climbUuid }: { boardName: string; climbUuid: string },
  ): Promise<BetaLink[]> => {
    validateInput(BoardNameSchema, boardName, 'boardName');
    validateInput(ExternalUUIDSchema, climbUuid, 'climbUuid');

    const { betaLinks } = UNIFIED_TABLES;

    const results = await db
      .select()
      .from(betaLinks)
      .where(
        and(
          eq(betaLinks.boardType, boardName),
          eq(betaLinks.climbUuid, climbUuid),
        ),
      );

    return results.map(link => ({
      climbUuid: link.climbUuid,
      link: link.link,
      foreignUsername: link.foreignUsername,
      angle: link.angle,
      thumbnail: link.thumbnail,
      isListed: link.isListed,
      createdAt: link.createdAt,
    }));
  },
};
