import { sql, type SQL } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';

/**
 * The listing rule for a spray wall that has never been published.
 *
 * A wall exists the moment it is created, before any photo is published against
 * it: `spray_walls.current_version_id` is NULL until the first
 * `publishSprayWallVersion`. Such a wall has no photo, no holds and no climbs —
 * opening it shows a placeholder — so listing it to anybody but its owner offers
 * a board that cannot be climbed on.
 *
 * That matters because the flag and the photo are set at different moments. A
 * client that creates a wall with `isPublic: true` and photographs it afterwards
 * puts a public, unusable row into `searchBoards` and into every gym's board list
 * for as long as the owner takes to finish. SW-09 changes the app to create walls
 * private and share them after the first publish — but the API is public, and a
 * server rule must not rest on a client convention.
 *
 * ## Why SQL and not the `viewerCanSee*` helpers
 *
 * Those are per-row and async, which is right for a single wall and wrong for a
 * listing: `searchBoards` and `myBoards` each run a COUNT beside the page, and a
 * post-filter in JS would drop rows from the page while the count kept promising
 * them — a "12 results" header over nine rows, and a last page that is empty. The
 * predicate has to be in the WHERE that carries LIMIT/OFFSET *and* in the count,
 * which means one expression both can take.
 *
 * ## Hidden walls
 *
 * A wall an admin has hidden (`spray_walls.hidden_at`, SW-17) reads exactly like
 * a private one for everybody but its owner, so it leaves every listing this
 * predicate carries: `searchBoards`, `gymBoards` (gym editors included — they
 * are not the owner) and a follower's `myBoards`. The owner escape sits OUTSIDE
 * the EXISTS, so the owner still lists their own hidden wall and sees the
 * notice on it. See "What hidden means" in docs/spray-walls.md.
 */
export function listableSprayWallCondition(viewerId: string | null | undefined): SQL {
  // `IS DISTINCT FROM` rather than `<>`: board_type is NOT NULL today, and a
  // three-valued comparison that quietly drops rows if that ever changes is not
  // the failure anybody wants from a visibility filter.
  const ownerEscape = viewerId ? sql`${dbSchema.userBoards.ownerId} = ${viewerId} OR ` : sql``;

  return sql`(
    ${dbSchema.userBoards.boardType} IS DISTINCT FROM 'spray'
    OR ${ownerEscape}EXISTS (
      SELECT 1 FROM spray_walls sw
      WHERE sw.board_uuid = ${dbSchema.userBoards.uuid}
        AND sw.deleted_at IS NULL
        AND sw.current_version_id IS NOT NULL
        AND sw.hidden_at IS NULL
    )
  )`;
}

/**
 * The same rule for a row already loaded from `spray_walls`, where the join has
 * been done and the SQL form would be a second query per row. Mirrors the SQL
 * exactly: the owner, or a published wall that is not admin-hidden.
 */
export function sprayWallIsListable(
  wall: { currentVersionId: number | null; hiddenAt: Date | null },
  board: { ownerId: string },
  viewerId: string | null | undefined,
): boolean {
  if (viewerId != null && board.ownerId === viewerId) return true;
  return wall.currentVersionId != null && wall.hiddenAt == null;
}
