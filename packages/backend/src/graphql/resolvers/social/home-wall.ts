import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/**
 * A home wall, gym or not: no gym, a gym that is gone, or a gym the board's own
 * owner runs that is not a public listed gym (a home wall that minted a private
 * or unlisted gym). A board at someone else's gym, or at a public listed gym,
 * is found through that gym instead. One primary-key lookup per board.
 *
 * Shared by Friends' boards (`friendsBoards`) and the Bluetooth request card
 * (`serial-board-reveal.ts`), so the two can never disagree on what a home
 * board is.
 */
export function homeWallCondition(gymIdColumn: SQLWrapper, ownerIdColumn: SQLWrapper): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM gyms friend_gym
    WHERE friend_gym.id = ${gymIdColumn} AND friend_gym.deleted_at IS NULL
      AND (friend_gym.owner_id <> ${ownerIdColumn} OR (friend_gym.is_public AND friend_gym.is_listed)))`;
}
