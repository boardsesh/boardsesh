import { and, eq, inArray, isNull } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';

/** The location fields a viewer reads for a board. */
export type ProjectedBoardLocation = {
  locationName: string | null;
  latitude: number | null;
  longitude: number | null;
  gymId: number | null;
  gymUuid: string | null;
  gymName: string | null;
  /** Where the place came from: the board's own, its public gym's, or nowhere. */
  source: 'own' | 'gym' | 'hidden';
};

/** The gym columns the projection reads. */
export type ProjectionGym = {
  id: number;
  uuid: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  isPublic: boolean;
  isListed?: boolean;
  deletedAt: Date | null;
};

const HIDDEN: ProjectedBoardLocation = {
  locationName: null,
  latitude: null,
  longitude: null,
  gymId: null,
  gymUuid: null,
  gymName: null,
  source: 'hidden',
};

/**
 * The one rule for where a viewer sees a board.
 *
 * - The viewer may see the board's own location (its owner, or the owner's
 *   location choice admits them): the board's own name, coordinates and gym.
 * - Otherwise, when the board is in a public, live gym: the GYM's name and
 *   coordinates, which the gym already lists to everyone, and the gym link.
 *   The board's own coordinates and typed location name never leave here.
 * - Otherwise nothing.
 *
 * A gym never changes the board's own setting; the owner's hide switch always
 * governs the board's own place. Every surface that returns a board's place,
 * gym link or a distance computed from it goes through this function, either
 * directly or through the `UserBoard` location field resolvers, so a hidden
 * place cannot reach a viewer by another path.
 */
export function projectBoardLocation(
  board: { locationName: string | null; latitude: number | null; longitude: number | null; gymId: number | null },
  gym: ProjectionGym | null | undefined,
  canSeeOwnLocation: boolean,
): ProjectedBoardLocation {
  const liveGym = gym && gym.deletedAt === null && board.gymId === gym.id ? gym : null;
  if (canSeeOwnLocation) {
    return {
      locationName: board.locationName ?? null,
      latitude: board.latitude ?? null,
      longitude: board.longitude ?? null,
      gymId: liveGym ? board.gymId : null,
      gymUuid: liveGym?.uuid ?? null,
      gymName: liveGym?.name ?? null,
      source: 'own',
    };
  }
  if (liveGym?.isPublic) {
    return {
      locationName: liveGym.name,
      latitude: liveGym.latitude,
      longitude: liveGym.longitude,
      gymId: liveGym.id,
      gymUuid: liveGym.uuid,
      gymName: liveGym.name,
      source: 'gym',
    };
  }
  return HIDDEN;
}

/** The gyms behind a batch of boards, by id, live or not (the projection checks). */
export async function loadProjectionGyms(
  gymIds: readonly (number | null | undefined)[],
  executor: Pick<typeof db, 'select'> = db,
): Promise<Map<number, ProjectionGym>> {
  const ids = [...new Set(gymIds.filter((id): id is number => id != null))];
  if (ids.length === 0) return new Map();
  const rows = await executor
    .select({
      id: dbSchema.gyms.id,
      uuid: dbSchema.gyms.uuid,
      name: dbSchema.gyms.name,
      latitude: dbSchema.gyms.latitude,
      longitude: dbSchema.gyms.longitude,
      isPublic: dbSchema.gyms.isPublic,
      isListed: dbSchema.gyms.isListed,
      deletedAt: dbSchema.gyms.deletedAt,
    })
    .from(dbSchema.gyms)
    .where(inArray(dbSchema.gyms.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

/** One board's gym, for single-board surfaces. */
export async function loadProjectionGym(gymId: number | null | undefined): Promise<ProjectionGym | null> {
  if (gymId == null) return null;
  const [gym] = await db
    .select({
      id: dbSchema.gyms.id,
      uuid: dbSchema.gyms.uuid,
      name: dbSchema.gyms.name,
      latitude: dbSchema.gyms.latitude,
      longitude: dbSchema.gyms.longitude,
      isPublic: dbSchema.gyms.isPublic,
      isListed: dbSchema.gyms.isListed,
      deletedAt: dbSchema.gyms.deletedAt,
    })
    .from(dbSchema.gyms)
    .where(and(eq(dbSchema.gyms.id, gymId), isNull(dbSchema.gyms.deletedAt)))
    .limit(1);
  return gym ?? null;
}

/** A live board's gym id, read from the row (never from a client-facing object). */
export async function boardGymId(boardUuid: string): Promise<number | null> {
  const [board] = await db
    .select({ gymId: dbSchema.userBoards.gymId })
    .from(dbSchema.userBoards)
    .where(and(eq(dbSchema.userBoards.uuid, boardUuid), isNull(dbSchema.userBoards.deletedAt)))
    .limit(1);
  return board?.gymId ?? null;
}
