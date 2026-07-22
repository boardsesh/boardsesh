import { and, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { distanceMeters } from '@boardsesh/db/queries';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';
import { AttachBoardToGymInputSchema, UUIDSchema } from '../../../validation/schemas';
import { SYSTEM_BOARD_OWNER_ID } from '../board-presence/shared';
import { requireGymEditAccess } from './gyms';
import { PROXIMITY_MATCH_RADIUS_METERS } from './gym-matching';

// ============================================
// Stray-board discovery for the gym Boards tab
// ============================================
//
// A gym owner wants every board physically in their gym attached to their
// listing. Two ways a board can drift off:
//   (a) it sits on a listing that was merged INTO this gym but never followed
//       the merge (merged_into_gym_id chain resolves here), or
//   (b) it was auto-created at the gym's coordinates under a synced (SYSTEM)
//       listing, or left unlinked, while physically at the gym.
// This finds both and lets the Boards tab attach them one tap at a time.
//
// Proximity mirrors gym-matching's findSimilarGyms: a portable lat/lng
// bounding-box prefilter in SQL (the backend test DB is plain postgres, no
// PostGIS), then an exact Haversine refine in JS. Boards carry their own
// latitude/longitude columns, so the box runs over those.

type GymRow = typeof dbSchema.gyms.$inferSelect;

export type StrayBoardReason = 'MERGED_TWIN' | 'NEARBY';

// The GraphQL StrayBoard payload plus the internal board id the attach mutation
// re-points. `boardId` never leaves this module (stripped before the resolver
// returns), so the internal row id is never exposed over the API.
type StrayBoardCandidate = {
  boardId: number;
  uuid: string;
  name: string;
  currentGymUuid: string | null;
  currentGymName: string | null;
  distanceMeters: number | null;
  reason: StrayBoardReason;
};

export type StrayBoardResult = Omit<StrayBoardCandidate, 'boardId'>;

const STRAY_BOARD_LIMIT = 25;

// A real merge chain is 1–2 hops; the cap is a safety net against a corrupt or
// cyclic pointer so the reverse walk can never spin. Mirrors resolveCanonicalGym.
const MAX_MERGE_HOPS = 10;

// Pads the lat/lng bounding box so it fully contains the target circle despite
// metres-per-degree varying with latitude; the JS Haversine still does the exact
// circle test. Mirrors gym-matching's withinBoundingBox.
const BOUNDING_BOX_SAFETY_FACTOR = 1.02;

/**
 * IDs of every gym whose `merged_into_gym_id` chain resolves to `canonicalGymId`
 * — the reverse of resolveCanonicalGym. Walks children (rows pointing INTO the
 * frontier) breadth-first, bounded to MAX_MERGE_HOPS with a visited guard so a
 * cyclic pointer terminates. The canonical gym itself is excluded.
 */
async function collectMergedTwinGymIds(canonicalGymId: number): Promise<number[]> {
  const twinIds = new Set<number>();
  let frontier: number[] = [canonicalGymId];
  for (let hop = 0; hop < MAX_MERGE_HOPS && frontier.length > 0; hop++) {
    const children = await db
      .select({ id: dbSchema.gyms.id })
      .from(dbSchema.gyms)
      .where(inArray(dbSchema.gyms.mergedIntoGymId, frontier));
    const next: number[] = [];
    for (const { id } of children) {
      if (id === canonicalGymId || twinIds.has(id)) continue;
      twinIds.add(id);
      next.push(id);
    }
    frontier = next;
  }
  return [...twinIds];
}

/** A lat/lng bounding box over the board columns wide enough to contain the radius circle. Portable (no PostGIS). */
function boardWithinBoundingBox(latitude: number, longitude: number, radiusMeters: number): SQL {
  const paddedRadius = radiusMeters * BOUNDING_BOX_SAFETY_FACTOR;
  const latDelta = paddedRadius / 111_320;
  const cosLat = Math.max(Math.cos((latitude * Math.PI) / 180), 1e-6);
  const lngDelta = paddedRadius / (111_320 * cosLat);
  return sql`${dbSchema.userBoards.latitude} IS NOT NULL AND ${dbSchema.userBoards.longitude} IS NOT NULL AND ${dbSchema.userBoards.latitude} BETWEEN ${latitude - latDelta} AND ${latitude + latDelta} AND ${dbSchema.userBoards.longitude} BETWEEN ${longitude - lngDelta} AND ${longitude + lngDelta}`;
}

/** Metres from the gym to a board, or null when either side lacks coordinates. */
function distanceFromGym(
  gym: Pick<GymRow, 'latitude' | 'longitude'>,
  board: { latitude: number | null; longitude: number | null },
): number | null {
  if (gym.latitude == null || gym.longitude == null || board.latitude == null || board.longitude == null) {
    return null;
  }
  return distanceMeters(
    { latitude: gym.latitude, longitude: gym.longitude },
    { latitude: board.latitude, longitude: board.longitude },
  );
}

/**
 * Candidate stray boards for a gym, deduped by board uuid and capped at
 * STRAY_BOARD_LIMIT:
 *   - MERGED_TWIN: boards on a listing whose merged_into chain resolves to this
 *     gym. The admin merge already established they're the same place, so these
 *     are surfaced regardless of visibility and rank first.
 *   - NEARBY: boards within 150 m of the gym that are unlinked or on a SYSTEM
 *     listing at the same spot. Gated to boards the viewer may see (public,
 *     SYSTEM catalog, or their own) and never a hide-location board, so the tab
 *     can't enumerate a stranger's private home wall by proximity.
 *
 * Exported so attachBoardToGym gates on the exact same candidate set the Boards
 * tab shows — a board this wouldn't surface can't be attached.
 */
export async function findStrayBoardCandidates(gym: GymRow, viewerUserId: string): Promise<StrayBoardCandidate[]> {
  const twinGymIds = await collectMergedTwinGymIds(gym.id);

  const twinRows =
    twinGymIds.length > 0
      ? await db
          .select({
            boardId: dbSchema.userBoards.id,
            uuid: dbSchema.userBoards.uuid,
            name: dbSchema.userBoards.name,
            latitude: dbSchema.userBoards.latitude,
            longitude: dbSchema.userBoards.longitude,
            currentGymUuid: dbSchema.gyms.uuid,
            currentGymName: dbSchema.gyms.name,
          })
          .from(dbSchema.userBoards)
          .innerJoin(dbSchema.gyms, eq(dbSchema.userBoards.gymId, dbSchema.gyms.id))
          .where(and(inArray(dbSchema.userBoards.gymId, twinGymIds), isNull(dbSchema.userBoards.deletedAt)))
          .limit(STRAY_BOARD_LIMIT)
      : [];

  const hasGymCoords = gym.latitude != null && gym.longitude != null;
  const nearbyRows = hasGymCoords
    ? await db
        .select({
          boardId: dbSchema.userBoards.id,
          uuid: dbSchema.userBoards.uuid,
          name: dbSchema.userBoards.name,
          latitude: dbSchema.userBoards.latitude,
          longitude: dbSchema.userBoards.longitude,
          currentGymUuid: dbSchema.gyms.uuid,
          currentGymName: dbSchema.gyms.name,
        })
        .from(dbSchema.userBoards)
        .leftJoin(dbSchema.gyms, eq(dbSchema.userBoards.gymId, dbSchema.gyms.id))
        .where(
          and(
            isNull(dbSchema.userBoards.deletedAt),
            // Never reuse a board whose owner asked to hide its location.
            eq(dbSchema.userBoards.hideLocation, false),
            boardWithinBoundingBox(gym.latitude!, gym.longitude!, PROXIMITY_MATCH_RADIUS_METERS),
            // Unlinked, or on a SYSTEM (synced catalog) listing other than this
            // gym. The `ne` handles the edge case of an editor whose target gym
            // is itself SYSTEM-owned — its own boards aren't "strays".
            or(
              isNull(dbSchema.userBoards.gymId),
              and(eq(dbSchema.gyms.ownerId, SYSTEM_BOARD_OWNER_ID), ne(dbSchema.userBoards.gymId, gym.id)),
            )!,
            // Privacy gate: public boards, SYSTEM catalog boards, or the viewer's
            // own — never a stranger's private wall.
            or(
              eq(dbSchema.userBoards.isPublic, true),
              eq(dbSchema.userBoards.ownerId, SYSTEM_BOARD_OWNER_ID),
              eq(dbSchema.userBoards.ownerId, viewerUserId),
            )!,
          ),
        )
        .limit(STRAY_BOARD_LIMIT * 2)
    : [];

  const twinCandidates: StrayBoardCandidate[] = twinRows
    .map((row) => ({
      boardId: row.boardId,
      uuid: row.uuid,
      name: row.name,
      currentGymUuid: row.currentGymUuid ?? null,
      currentGymName: row.currentGymName ?? null,
      distanceMeters: distanceFromGym(gym, row),
      reason: 'MERGED_TWIN' as const,
    }))
    .sort((first, second) => first.name.localeCompare(second.name));

  const seen = new Set(twinCandidates.map((candidate) => candidate.uuid));

  const nearbyCandidates: StrayBoardCandidate[] = [];
  for (const row of nearbyRows) {
    if (seen.has(row.uuid)) continue; // a twin-and-nearby board keeps the twin reason
    const distance = distanceFromGym(gym, row);
    // Exact circle refine — the SQL box is a superset of the 150 m circle.
    if (distance == null || distance > PROXIMITY_MATCH_RADIUS_METERS) continue;
    seen.add(row.uuid);
    nearbyCandidates.push({
      boardId: row.boardId,
      uuid: row.uuid,
      name: row.name,
      currentGymUuid: row.currentGymUuid ?? null,
      currentGymName: row.currentGymName ?? null,
      distanceMeters: distance,
      reason: 'NEARBY',
    });
  }
  nearbyCandidates.sort((first, second) => (first.distanceMeters ?? 0) - (second.distanceMeters ?? 0));

  return [...twinCandidates, ...nearbyCandidates].slice(0, STRAY_BOARD_LIMIT);
}

// ============================================
// Resolvers
// ============================================

export const socialGymStrayBoardQueries = {
  strayBoardsForGym: async (
    _: unknown,
    { gymUuid }: { gymUuid: string },
    ctx: ConnectionContext,
  ): Promise<StrayBoardResult[]> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 30, 'strayBoardsForGym');
    validateInput(UUIDSchema, gymUuid, 'gymUuid');
    const userId = ctx.userId!;

    // Edit access to the gym is the gate; this also resolves a merged twin's uuid
    // to the canonical live row so the discovery runs against the survivor.
    const gym = await requireGymEditAccess(gymUuid, userId);

    const candidates = await findStrayBoardCandidates(gym, userId);
    // Strip the internal board id — the GraphQL StrayBoard type never exposes it.
    return candidates.map(({ boardId: _boardId, ...strayBoard }) => strayBoard);
  },
};

export const socialGymStrayBoardMutations = {
  attachBoardToGym: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'attachBoardToGym');
    const validatedInput = validateInput(AttachBoardToGymInputSchema, input, 'input');
    const userId = ctx.userId!;

    const gym = await requireGymEditAccess(validatedInput.gymUuid, userId);

    // Only a board the Boards tab would surface as a stray can be attached — the
    // exact same candidate set as strayBoardsForGym, so gym-edit access can't be
    // used to pull an arbitrary board off another listing.
    const candidates = await findStrayBoardCandidates(gym, userId);
    const target = candidates.find((candidate) => candidate.uuid === validatedInput.boardUuid);
    if (!target) {
      throw new GraphQLError('This board is not a stray candidate for this gym.', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    await db.update(dbSchema.userBoards).set({ gymId: gym.id }).where(eq(dbSchema.userBoards.id, target.boardId));
    return true;
  },
};
