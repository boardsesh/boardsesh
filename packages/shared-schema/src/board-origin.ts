/**
 * The account that owns everything Boardsesh imported rather than a climber
 * added: unclaimed synced gyms and the boards public board data put on them.
 *
 * Mirrors `SYSTEM_BOARD_OWNER_ID` in `@boardsesh/db`
 * (`packages/db/src/queries/system-account-constants.ts`). The value is a fixed
 * row id, so the two cannot drift without a migration.
 */
export const SYSTEM_BOARD_OWNER_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Where a board came from, as the screens that manage it say it:
 *
 * - `own`: the viewer added it ("Added by you").
 * - `synced`: public board data put it there ("From public board data").
 * - `climber`: another climber added it, and the server named them ("Added by Sam").
 * - `hidden`: another climber added it, and their privacy keeps their name back
 *   ("Added by a climber"). The server sends no `ownerId` then either.
 */
export type BoardOrigin = 'own' | 'synced' | 'climber' | 'hidden';

export function boardOriginFor(
  board: { ownerId?: string | null; ownerDisplayName?: string | null },
  viewerUserId: string | null | undefined,
): BoardOrigin {
  if (board.ownerId === SYSTEM_BOARD_OWNER_ID) return 'synced';
  if (viewerUserId && board.ownerId === viewerUserId) return 'own';
  return board.ownerId && board.ownerDisplayName ? 'climber' : 'hidden';
}
