import { and, eq, isNull, ne, notExists, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { mutualFollowListingCondition } from '@boardsesh/db/queries';
import { db } from '../../../db/client';
import { privacyControlsEnabled, resourceAccessCondition } from '../../../services/privacy';

/**
 * A home wall, gym or not: no gym, a gym that is gone, or a gym the board's own
 * owner runs that is not a public listed gym (a home wall that minted a private
 * or unlisted gym). A board at someone else's gym, or at a public listed gym,
 * is found through that gym instead. One primary-key lookup per board.
 */
function homeWallCondition(gymIdColumn: SQLWrapper, ownerIdColumn: SQLWrapper): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM gyms friend_gym
    WHERE friend_gym.id = ${gymIdColumn} AND friend_gym.deleted_at IS NULL
      AND (friend_gym.owner_id <> ${ownerIdColumn} OR (friend_gym.is_public AND friend_gym.is_listed)))`;
}

/**
 * Every rule that puts a `user_boards` row in the viewer's Friends' boards
 * (docs/product/privacy.md, "Friends' boards"), as WHERE conditions on
 * `user_boards`:
 * - the owner and the viewer follow each other (`user_follows` holds approved
 *   follows only). A one-way follow, either way, lists nothing;
 * - a live home board: not deleted or merged away, not a spray wall, and not at
 *   someone else's gym or at a public listed gym (`homeWallCondition`);
 * - not the viewer's own board and not one their Your boards already shows: a
 *   `board_follows` row they can still open, read the way `myBoards` reads it.
 *   A save they can no longer open (the board went Invite-only since) stays
 *   listed, so they can ask for it again;
 * - the follow and audience rule (`mutualFollowListingCondition`). The viewer
 *   follows the owner, so a Followers board always opens; only an opted-in
 *   Invite-only board can be listed without being readable.
 *
 * Shared by Friends' boards (`friendsBoards`) and the Bluetooth request card
 * (`serial-board-reveal.ts`), so a climber nearby is only ever named a board
 * their own Friends' boards would list.
 */
export function friendsBoardListingConditions(viewerId: string): SQL[] {
  const boards = dbSchema.userBoards;
  return [
    isNull(boards.deletedAt),
    isNull(boards.mergedIntoBoardUuid),
    homeWallCondition(boards.gymId, boards.ownerId),
    ne(boards.boardType, 'spray'),
    ne(boards.ownerId, viewerId),
    notExists(
      db
        .select({ id: dbSchema.boardFollows.id })
        .from(dbSchema.boardFollows)
        .where(
          and(
            eq(dbSchema.boardFollows.userId, viewerId),
            eq(dbSchema.boardFollows.boardUuid, boards.uuid),
            // The same access check myBoards puts on a saved board.
            resourceAccessCondition('board', boards.uuid, viewerId),
          ),
        ),
    ),
    // With the controls off the owner cannot reach the switch or answer a
    // request, so the switch reads as off and only openable boards are listed.
    mutualFollowListingCondition(boards.uuid, boards.ownerId, viewerId, {
      honourListedToFollowers: privacyControlsEnabled(),
    }),
  ];
}
