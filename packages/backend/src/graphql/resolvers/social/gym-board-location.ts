import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';

/** The place a public gym already lists: its name and coordinates. */
export type PublicGymPlace = { name: string; latitude: number | null; longitude: number | null };

/** Where a board says it is. */
export type BoardPlace = { latitude: number | null; longitude: number | null; locationName: string | null };

/**
 * The public gym a board in `gymId` takes its location rule from, or null.
 *
 * The hidden-location default protects home walls. A public gym already lists
 * its name and coordinates, so hiding a board that sits at exactly that place
 * hides nothing and only takes the board off the gym's page and the map.
 *
 * A private gym does not count. Private gyms are home walls in practice (the
 * auto-gym path mints one from a home board's typed location when its location
 * is hidden, and `requireBoardGymLinkAccess` hides them for that reason), so a
 * board linked to one keeps the location its owner chose. Spray walls keep
 * their own rules too: their visibility only changes through the wall itself.
 */
export async function publicGymPlace(
  executor: Pick<typeof db, 'select'>,
  gymId: number | null,
  boardType: string,
): Promise<PublicGymPlace | null> {
  if (gymId === null || boardType === 'spray') return null;
  const [gym] = await executor
    .select({
      isPublic: dbSchema.gyms.isPublic,
      name: dbSchema.gyms.name,
      latitude: dbSchema.gyms.latitude,
      longitude: dbSchema.gyms.longitude,
    })
    .from(dbSchema.gyms)
    .where(and(eq(dbSchema.gyms.id, gymId), isNull(dbSchema.gyms.deletedAt)))
    .limit(1);
  return gym?.isPublic === true ? { name: gym.name, latitude: gym.latitude, longitude: gym.longitude } : null;
}

/**
 * Whether a board's place is nothing more than its gym's own listing: no
 * coordinates or exactly the gym's, and no location name or exactly the gym's.
 * The board builder stamps both from the gym when a climber picks it.
 *
 * Only then does the gym rule show the location. A board in a public gym that
 * carries anything else (a GPS fix the server matched to a nearby gym, a home
 * the climber moved it to, a typed address) keeps its owner's choice, so the
 * rule can never publish a place the gym does not already list.
 */
export function boardSitsAtGym(board: BoardPlace, gym: PublicGymPlace): boolean {
  const noCoordinates = board.latitude == null && board.longitude == null;
  const gymCoordinates = board.latitude === gym.latitude && board.longitude === gym.longitude;
  const locationName = board.locationName?.trim() ?? '';
  return (noCoordinates || gymCoordinates) && (locationName === '' || locationName === gym.name.trim());
}

/**
 * Whether the gym rule shows this board's location: it is in a public gym and
 * sits at exactly the place the gym lists.
 */
export async function gymSharesBoardLocation(
  executor: Pick<typeof db, 'select'>,
  board: BoardPlace & { gymId: number | null; boardType: string },
): Promise<boolean> {
  const gym = await publicGymPlace(executor, board.gymId, board.boardType);
  return gym !== null && boardSitsAtGym(board, gym);
}

/**
 * What an edit does to a board's location under the gym rule, judged on the
 * place the board will have AFTER the edit, so the rule can never show a place
 * the request itself sent:
 *
 * - `sharesGymLocation`: the board will sit at its public gym's own place, so
 *   its location is shown whatever the request says;
 * - `leavesGymPlace`: it sat there and the edit moves it off (a home, a typed
 *   address), so it goes back to the home default, hidden, whatever the request
 *   says. Its location was shown only by the rule, and showing the new place is
 *   a separate choice.
 *
 * When neither holds, the request's own hideLocation applies.
 */
export async function decideGymBoardLocation(
  executor: Pick<typeof db, 'select'>,
  board: BoardPlace & { gymId: number | null; boardType: string },
  edit: { latitude?: number | null; longitude?: number | null; locationName?: string | null },
): Promise<{ sharesGymLocation: boolean; leavesGymPlace: boolean }> {
  const gym = await publicGymPlace(executor, board.gymId, board.boardType);
  if (gym === null) return { sharesGymLocation: false, leavesGymPlace: false };
  const nextPlace = {
    latitude: edit.latitude !== undefined ? edit.latitude : board.latitude,
    longitude: edit.longitude !== undefined ? edit.longitude : board.longitude,
    locationName: edit.locationName !== undefined ? edit.locationName : board.locationName,
  };
  const sharesGymLocation = boardSitsAtGym(nextPlace, gym);
  return { sharesGymLocation, leavesGymPlace: !sharesGymLocation && boardSitsAtGym(board, gym) };
}

/**
 * Show a gym board's location: clear `hide_location` and widen a stored policy
 * to `public`. Run only for a board that sits at its public gym's own place
 * (`boardSitsAtGym`), when it joins the gym or is edited while there. Widening
 * only, and to a place the gym already lists.
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

/**
 * Hide a board's location again because it left its public gym's place: moved
 * to another place, or taken out of the gym. The gym rule showed it only while
 * it sat there, and whatever it says next (a home, a typed address) is the
 * climber's own: it goes back to the home-wall default, Only me, until the
 * owner chooses to show it. Hiding the gym's own place hides nothing private,
 * and joining a gym at its place shows it again. Narrowing only: a stored
 * policy that is already narrower than public is the owner's and stays.
 */
export async function hideBoardLocationLeavingGym(
  executor: Pick<typeof db, 'update'>,
  board: { id: number; uuid: string },
): Promise<void> {
  await executor
    .update(dbSchema.userBoards)
    .set({ hideLocation: true })
    .where(and(eq(dbSchema.userBoards.id, board.id), eq(dbSchema.userBoards.hideLocation, false)));
  await executor
    .update(dbSchema.resourcePrivacy)
    .set({
      locationAudience: 'only_me',
      updatedAt: new Date(),
      revision: sql`${dbSchema.resourcePrivacy.revision} + 1`,
    })
    .where(
      and(
        eq(dbSchema.resourcePrivacy.kind, 'board'),
        eq(dbSchema.resourcePrivacy.resourceId, board.uuid),
        eq(dbSchema.resourcePrivacy.locationAudience, 'public'),
      ),
    );
}

/**
 * Move a board into `nextGymId`, or out of any gym with null, deciding its
 * location from the board row locked in the same transaction, so a concurrent
 * edit cannot slip a stale place past the rule:
 *
 * - leaving a public gym whose own place the board sat at hides the location
 *   (`hideBoardLocationLeavingGym`), so the order a client sends this and its
 *   `updateBoard` in never matters: a board moved home after leaving is no
 *   longer shown by a gym it is not in;
 * - joining a public gym at its own place shows it (`shareGymBoardLocation`).
 */
export async function moveBoardToGym(
  executor: Pick<typeof db, 'transaction'>,
  boardId: number,
  nextGymId: number | null,
): Promise<void> {
  await executor.transaction(async (tx) => {
    const [board] = await tx
      .select({
        id: dbSchema.userBoards.id,
        uuid: dbSchema.userBoards.uuid,
        boardType: dbSchema.userBoards.boardType,
        gymId: dbSchema.userBoards.gymId,
        latitude: dbSchema.userBoards.latitude,
        longitude: dbSchema.userBoards.longitude,
        locationName: dbSchema.userBoards.locationName,
      })
      .from(dbSchema.userBoards)
      .where(eq(dbSchema.userBoards.id, boardId))
      .for('update');
    if (!board) return;
    if (board.gymId !== nextGymId && (await gymSharesBoardLocation(tx, board))) {
      await hideBoardLocationLeavingGym(tx, board);
    }
    await tx.update(dbSchema.userBoards).set({ gymId: nextGymId }).where(eq(dbSchema.userBoards.id, board.id));
    if (nextGymId !== null && (await gymSharesBoardLocation(tx, { ...board, gymId: nextGymId }))) {
      await shareGymBoardLocation(tx, board);
    }
  });
}

/**
 * Whether the live board `boardUuid` sits at its public gym's own place, so its
 * location is always shown and its owner's location choice is locked.
 */
export async function boardLocationSharedByGym(
  executor: Pick<typeof db, 'select'>,
  boardUuid: string,
): Promise<boolean> {
  const [board] = await executor
    .select({
      gymId: dbSchema.userBoards.gymId,
      boardType: dbSchema.userBoards.boardType,
      latitude: dbSchema.userBoards.latitude,
      longitude: dbSchema.userBoards.longitude,
      locationName: dbSchema.userBoards.locationName,
    })
    .from(dbSchema.userBoards)
    .where(and(eq(dbSchema.userBoards.uuid, boardUuid), isNull(dbSchema.userBoards.deletedAt)))
    .limit(1);
  return board ? gymSharesBoardLocation(executor, board) : false;
}
