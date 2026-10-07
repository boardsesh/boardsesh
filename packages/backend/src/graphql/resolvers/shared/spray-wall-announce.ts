import { and, eq, isNull } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';

/**
 * Whether the wall behind a spray climb may ANNOUNCE to the feed: public, and
 * not hidden by an admin (SW-17).
 *
 * This is the epic's standing rule (2026-09-14: private-wall ticks are the
 * owner's logbook alone), already applied by `saveClimb` before it publishes
 * `climb.created` (`SprayClimbTarget.publishesFeedEvents`, in
 * `../climbs/spray-authoring.ts`) and by `publishAscentEvent` before it fans a
 * tick out. A feed event carries the climb's name, setter, layout id and frames
 * to every follower of its actor, and `feed_items` is materialised — so the gate
 * has to sit at the WRITE, or a private wall leaks one announce at a time.
 *
 * The rule is NOT per-viewer. Fan-out writes rows for many recipients at once;
 * what single recipient may SEE their own rows is the read side's job
 * (`activityFeed` folds `sprayReferenceVisibilityCondition` into every page).
 * The writer's question is only "would this wall announce at all", and that is
 * answered by the wall: a private or unlisted wall never announces, even for its
 * owner, because the owner's followers cannot open it.
 *
 * A layout id of null answers false — no wall, nothing to announce. That covers
 * a climb row already hard-deleted (`deleteDraftClimb`, account deletion):
 * reading it as "cannot announce" refuses the fan-out rather than writing rows
 * whose climb details are gone, which is the shape #5981's read-side masking
 * keeps having to clean up.
 *
 * Deliberately unlocked, unlike the write-path variant `sprayWallMayAnnounceUnderLock`
 * (in `../climbs/spray-authoring.ts`): this runs in post-commit event
 * consumers, keyed by a layout id rather than a wall id. The race the locked
 * form closes — a wall flip purging `feed_items` while a climb write is in
 * flight — is backstopped here at read time, which is where the window is
 * actually closed (`activityFeed`, note on `purgeSprayWallFeedItems`). Taking
 * the wall lock in every fan-out would serialise follower-fan-out against wall
 * writes to buy nothing.
 */
export async function sprayWallMayAnnounceByLayout(layoutId: number | null | undefined): Promise<boolean> {
  if (layoutId == null || !Number.isFinite(layoutId)) return false;
  const [row] = await db
    .select({ isPublic: dbSchema.userBoards.isPublic, hiddenAt: dbSchema.sprayWalls.hiddenAt })
    .from(dbSchema.sprayWalls)
    .innerJoin(dbSchema.userBoards, eq(dbSchema.userBoards.uuid, dbSchema.sprayWalls.boardUuid))
    .where(
      and(
        eq(dbSchema.sprayWalls.layoutId, layoutId),
        isNull(dbSchema.sprayWalls.deletedAt),
        isNull(dbSchema.userBoards.deletedAt),
      ),
    )
    .limit(1);
  return row?.isPublic === true && row.hiddenAt == null;
}
