import { and, eq, isNull, sql } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { SYSTEM_BOARD_OWNER_ID } from '../board-presence/shared';

/**
 * Live boards one account may hold.
 *
 * Until #4174 the `user_boards_unique_owner_config` index was an accidental
 * ceiling — an owner could not have two boards of the same configuration, so the
 * hardware catalog bounded the total. Dropping it was right (the same MoonBoard
 * exists at every gym that owns one), but it left nothing bounding mint volume,
 * and `allowDuplicateConfig` is a flag any client can set on every call.
 *
 * 50 sits well above any real climber or gym — the busiest gyms in the data hold
 * a handful of walls — and in line with the other per-account ceilings
 * (`MAX_AUTO_MINTED_GYMS_PER_OWNER = 25`, `MAX_FOREIGN_GYM_LINKS = 20`).
 */
export const MAX_BOARDS_PER_ACCOUNT = 50;

export function boardLimitReachedError(): GraphQLError {
  return new GraphQLError(
    `You've reached the limit of ${MAX_BOARDS_PER_ACCOUNT} boards on one account. ` +
      `Delete a board you no longer use to add another.`,
    { extensions: { code: 'BOARD_LIMIT_REACHED', maxBoards: MAX_BOARDS_PER_ACCOUNT } },
  );
}

/**
 * Refuse to add another board once the caller is at the cap.
 *
 * Deliberately a plain read outside any transaction, the same posture as the
 * gym mint cap in `gym-matching.ts`: two concurrent creates can both see 49 and
 * both land, so the cap is approximate by design. It exists to stop a runaway,
 * not to hold an invariant — paying for row locks on every create to make it
 * exact would be the wrong trade.
 *
 * Unlike the gym cap, which quietly stops attaching a gym, this one THROWS: a
 * board the user explicitly asked for must not silently not exist.
 *
 * The system catalog owner is exempt — it holds every seeded board there is.
 */
export async function assertBoardCapNotReached(ownerId: string): Promise<void> {
  if (ownerId === SYSTEM_BOARD_OWNER_ID) return;

  const [{ count: ownedBoardCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(dbSchema.userBoards)
    .where(and(eq(dbSchema.userBoards.ownerId, ownerId), isNull(dbSchema.userBoards.deletedAt)));

  if (ownedBoardCount >= MAX_BOARDS_PER_ACCOUNT) {
    throw boardLimitReachedError();
  }
}
