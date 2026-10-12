import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';

/**
 * A board at a public gym always shows where it is.
 *
 * The hidden-location default protects home walls. A public gym already lists
 * its name and coordinates, so hiding the location of a board inside it hides
 * nothing and only takes the board off the gym's page and the map. The
 * post-#6254 builder sends `hideLocation: true` on every create, so the server
 * cannot read that flag as a choice at a gym and decides it here instead.
 *
 * A private gym does not count. Private gyms are home walls in practice (the
 * auto-gym path mints one from a home board's typed location when its location
 * is hidden, and `requireBoardGymLinkAccess` hides them for that reason), so a
 * board linked to one keeps the location its owner chose. Spray walls keep
 * their own rules too: their visibility only changes through the wall itself.
 */
export async function gymSharesBoardLocation(
  executor: Pick<typeof db, 'select'>,
  gymId: number | null,
  boardType: string,
): Promise<boolean> {
  if (gymId === null || boardType === 'spray') return false;
  const [gym] = await executor
    .select({ isPublic: dbSchema.gyms.isPublic })
    .from(dbSchema.gyms)
    .where(and(eq(dbSchema.gyms.id, gymId), isNull(dbSchema.gyms.deletedAt)))
    .limit(1);
  return gym?.isPublic === true;
}

/**
 * Show a gym board's location: clear `hide_location` and widen a stored policy
 * to `public`. Run when a board is linked to a public gym after it was created,
 * or edited while it is in one. Widening only, so it never needs a
 * privacyChanged publish.
 */
export async function shareGymBoardLocation(
  executor: Pick<typeof db, 'update'>,
  board: { id: number; uuid: string },
): Promise<void> {
  await executor
    .update(dbSchema.userBoards)
    .set({ hideLocation: false })
    .where(and(eq(dbSchema.userBoards.id, board.id), eq(dbSchema.userBoards.hideLocation, true)));
  await executor
    .update(dbSchema.resourcePrivacy)
    .set({
      locationAudience: 'public',
      updatedAt: new Date(),
      revision: sql`${dbSchema.resourcePrivacy.revision} + 1`,
    })
    .where(
      and(
        eq(dbSchema.resourcePrivacy.kind, 'board'),
        eq(dbSchema.resourcePrivacy.resourceId, board.uuid),
        ne(dbSchema.resourcePrivacy.locationAudience, 'public'),
      ),
    );
}
