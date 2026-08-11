import { and, eq, inArray, isNull, ne, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import {
  computeClusterSignature,
  distanceMeters,
  mergeGymsIntoCanonical,
  type CanonicalGymCandidate,
} from '@boardsesh/db/queries';
import { executeRows } from '@boardsesh/db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { logger } from '../../../utils/logger';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';
import { AttachBoardToGymInputSchema, DetachBoardFromGymInputSchema, UUIDSchema } from '../../../validation/schemas';
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

// The GraphQL StrayBoard payload plus the internal board id + current gym id the
// attach mutation needs. `boardId`/`currentGymId` never leave this module
// (stripped before the resolver returns), so no internal row id is exposed.
type StrayBoardCandidate = {
  boardId: number;
  /** The board's gym_id at the moment it was read — the compare-and-swap guard on attach. */
  currentGymId: number | null;
  uuid: string;
  name: string;
  currentGymUuid: string | null;
  currentGymName: string | null;
  distanceMeters: number | null;
  reason: StrayBoardReason;
  /**
   * True when attaching this board empties the auto-synced listing it sits on,
   * which {@link retireEmptiedSourceGym} then folds into the target gym. False
   * for an unlinked board, and for a listing that never folds — see
   * {@link markLastBoardAtCurrentGym}.
   */
  isLastBoardAtCurrentGym: boolean;
};

export type StrayBoardResult = Omit<StrayBoardCandidate, 'boardId' | 'currentGymId'>;

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
 *     listing at the same spot. Gated to boards it's legitimate to capture —
 *     SYSTEM (synced catalog) or the viewer's own — never a third party's, and
 *     never a hide-location board. A stranger's board (public or private) is
 *     excluded: attaching it would hand the gym owner edit rights over it.
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
            currentGymId: dbSchema.userBoards.gymId,
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
          currentGymId: dbSchema.userBoards.gymId,
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
            // Ownership gate: only a SYSTEM (synced catalog) board or the viewer's
            // own board is a legitimate stray to attach — never a third party's,
            // public or private. Attaching a stranger's board would hand the gym
            // owner/admin edit rights over it (rename, serialNumber/BLE, privacy
            // flags) via requireBoardEditAccess's gym-admin branch. Being public
            // does not make a board safe to capture.
            or(eq(dbSchema.userBoards.ownerId, SYSTEM_BOARD_OWNER_ID), eq(dbSchema.userBoards.ownerId, viewerUserId))!,
          ),
        )
        .limit(STRAY_BOARD_LIMIT * 2)
    : [];

  const twinCandidates: StrayBoardCandidate[] = twinRows
    .map((row) => ({
      boardId: row.boardId,
      currentGymId: row.currentGymId ?? null,
      uuid: row.uuid,
      name: row.name,
      currentGymUuid: row.currentGymUuid ?? null,
      currentGymName: row.currentGymName ?? null,
      distanceMeters: distanceFromGym(gym, row),
      reason: 'MERGED_TWIN' as const,
      isLastBoardAtCurrentGym: false,
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
      currentGymId: row.currentGymId ?? null,
      uuid: row.uuid,
      name: row.name,
      currentGymUuid: row.currentGymUuid ?? null,
      currentGymName: row.currentGymName ?? null,
      distanceMeters: distance,
      reason: 'NEARBY',
      isLastBoardAtCurrentGym: false,
    });
  }
  nearbyCandidates.sort((first, second) => (first.distanceMeters ?? 0) - (second.distanceMeters ?? 0));

  const candidates = [...twinCandidates, ...nearbyCandidates].slice(0, STRAY_BOARD_LIMIT);
  await markLastBoardAtCurrentGym(candidates);
  return candidates;
}

/**
 * Fills in `isLastBoardAtCurrentGym` for every candidate that sits on a listing,
 * with ONE grouped count over the distinct listings involved (never a query per
 * row). Mutates in place — the candidates are freshly built above.
 *
 * The flag is a promise that attaching this board folds its listing away, so it
 * is only ever set for a listing {@link retireEmptiedSourceGym} would actually
 * fold: live, not already merged, and SYSTEM-owned. Without those gates every
 * MERGED_TWIN leftover would be flagged (a twin is already merged, and one
 * leftover board is the usual shape), putting a merge confirm in front of a
 * merge that never runs. The fold's other refusals — a claim, a member or a
 * kiosk on the listing — are deliberately NOT mirrored here: any of them can
 * appear between this read and the tap, and a warning about a fold that then
 * gets refused is cheaper than silence about one that runs.
 */
async function markLastBoardAtCurrentGym(candidates: StrayBoardCandidate[]): Promise<void> {
  const listingIds = [
    ...new Set(
      candidates
        .map((candidate) => candidate.currentGymId)
        .filter((gymId): gymId is number => typeof gymId === 'number'),
    ),
  ];
  if (listingIds.length === 0) return;

  const counts = await db
    .select({ gymId: dbSchema.userBoards.gymId, boardCount: sql<number>`count(*)::int` })
    .from(dbSchema.userBoards)
    .innerJoin(dbSchema.gyms, eq(dbSchema.userBoards.gymId, dbSchema.gyms.id))
    .where(
      and(
        inArray(dbSchema.userBoards.gymId, listingIds),
        isNull(dbSchema.userBoards.deletedAt),
        isNull(dbSchema.gyms.deletedAt),
        isNull(dbSchema.gyms.mergedIntoGymId),
        eq(dbSchema.gyms.ownerId, SYSTEM_BOARD_OWNER_ID),
      ),
    )
    .groupBy(dbSchema.userBoards.gymId);

  const boardCountByGymId = new Map(counts.map((row) => [Number(row.gymId), Number(row.boardCount)]));
  for (const candidate of candidates) {
    if (candidate.currentGymId == null) continue;
    candidate.isLastBoardAtCurrentGym = boardCountByGymId.get(candidate.currentGymId) === 1;
  }
}

// ============================================
// Retiring the listing an attach emptied
// ============================================
//
// Taking the last board off an auto-synced listing used to leave that listing
// live and public with nothing on it, so it kept turning up in gym search as a
// plausible-looking duplicate of the gym the board just moved to (#4188).
//
// Rather than delete anything, the emptied listing is FOLDED into the gym that
// took its board, through the same primitive the admin duplicates queue uses:
// `merged_into_gym_id` + soft-delete, so old uuids/slugs still resolve to the
// survivor, and a `gym_merge_audit` row records what moved. Folding also moves
// the listing's `location_sync_gym_sources` alias to the survivor, which is what
// stops the next location-sync run re-minting the same empty listing.

/** Every gym column the merge primitive needs, plus the gates that decide whether we may fold at all. */
type RetireGateRow = CanonicalGymCandidate & {
  ownerId: string | null;
  /** Claims in a state that means a human is (or has been) staking a title to this listing. */
  openClaimCount: number;
  liveKioskCount: number;
};

type TransactionDb = { execute(query: SQLWrapper | string): PromiseLike<unknown> };

/**
 * Locks the given gym rows (ascending id — the fixed order that keeps two
 * concurrent folds from deadlocking) and returns the ones that are live,
 * un-merged and have coordinates, keyed by id. A gym missing from the result is
 * one we must not fold.
 */
async function loadRetireGateRows(tx: TransactionDb, gymIds: number[]): Promise<Map<number, RetireGateRow>> {
  const rows = await executeRows<RetireGateRow>(
    tx,
    sql`
    WITH locked_gym AS (
      SELECT g.id, g.uuid, g.name, g.address, g.contact_email, g.contact_phone,
             g.description, g.image_url, g.latitude, g.longitude, g.created_at, g.owner_id
        FROM gyms g
       WHERE g.id IN (${sql.join(
         gymIds.map((gymId) => sql`${gymId}`),
         sql`, `,
       )})
         AND g.deleted_at IS NULL
         AND g.merged_into_gym_id IS NULL
         AND g.latitude IS NOT NULL
         AND g.longitude IS NOT NULL
       ORDER BY g.id
         FOR UPDATE
    )
    SELECT
      g.id AS "id",
      g.uuid AS "uuid",
      g.name AS "name",
      g.address AS "address",
      g.contact_email AS "contactEmail",
      g.contact_phone AS "contactPhone",
      g.description AS "description",
      g.image_url AS "imageUrl",
      g.latitude AS "latitude",
      g.longitude AS "longitude",
      g.created_at AS "createdAt",
      g.owner_id AS "ownerId",
      -- Per-gym scalar subqueries rather than grouped joins: at most two gyms are
      -- locked here, so these are index lookups, where a GROUP BY gym_id subquery
      -- would aggregate the whole of user_boards/gym_follows/comments on every
      -- attach — while holding the row locks above.
      (
        SELECT count(*)::int FROM user_boards
         WHERE gym_id = g.id AND deleted_at IS NULL
      ) AS "boardCount",
      (SELECT count(*)::int FROM gym_members WHERE gym_id = g.id) AS "memberCount",
      (SELECT count(*)::int FROM gym_follows WHERE gym_id = g.id) AS "followerCount",
      (
        SELECT count(*)::int FROM comments
         WHERE entity_type = 'gym' AND entity_id = g.uuid AND deleted_at IS NULL
      ) AS "commentCount",
      (
        SELECT count(*)::int FROM gym_claims
         WHERE gym_id = g.id AND status IN ('pending', 'approved')
      ) AS "openClaimCount",
      (
        SELECT count(*)::int FROM gym_kiosks
         WHERE gym_id = g.id AND deleted_at IS NULL
      ) AS "liveKioskCount"
    FROM locked_gym g
  `,
  );
  return new Map(rows.map((row) => [Number(row.id), { ...row, id: Number(row.id) }]));
}

function toMergeCandidate(row: RetireGateRow): CanonicalGymCandidate {
  const { ownerId: _ownerId, openClaimCount: _openClaimCount, liveKioskCount: _liveKioskCount, ...candidate } = row;
  return candidate;
}

/**
 * Folds `sourceGymId` into `targetGym` when the attach that just ran left it
 * with no boards at all.
 *
 * Deliberately narrow: only an auto-synced (SYSTEM-owned) listing that nobody
 * has claimed, staffed or hung a kiosk on can be folded, and only into a gym a
 * real person owns. Anything else is left exactly as it was — a gym editor must
 * never be able to make someone else's listing disappear. Every refusal is a
 * debug log and a plain `return`: the board move has already committed, so a
 * skipped fold is a no-op, not an error.
 */
async function retireEmptiedSourceGym(sourceGymId: number, targetGym: GymRow, actorUserId: string): Promise<void> {
  if (targetGym.ownerId === SYSTEM_BOARD_OWNER_ID) {
    logger.debug('stray attach: not retiring the source listing, the target gym is itself a synced listing', {
      sourceGymId,
      targetGymId: targetGym.id,
    });
    return;
  }

  await db.transaction(async (tx) => {
    const gateRows = await loadRetireGateRows(tx, [sourceGymId, targetGym.id]);
    const source = gateRows.get(sourceGymId);
    const target = gateRows.get(targetGym.id);

    if (!source || !target) {
      logger.debug('stray attach: not retiring the source listing, a gym is merged, deleted or lacks coordinates', {
        sourceGymId,
        targetGymId: targetGym.id,
        sourceEligible: Boolean(source),
        targetEligible: Boolean(target),
      });
      return;
    }
    if (source.ownerId !== SYSTEM_BOARD_OWNER_ID || target.ownerId === SYSTEM_BOARD_OWNER_ID) {
      logger.debug('stray attach: not retiring the source listing, ownership does not allow it', {
        sourceGymId,
        targetGymId: targetGym.id,
      });
      return;
    }
    if (source.boardCount > 0 || source.memberCount > 0 || source.openClaimCount > 0 || source.liveKioskCount > 0) {
      logger.debug('stray attach: not retiring the source listing, it is still in use', {
        sourceGymId,
        boardCount: source.boardCount,
        memberCount: source.memberCount,
        openClaimCount: source.openClaimCount,
        liveKioskCount: source.liveKioskCount,
      });
      return;
    }

    const mergeResult = await mergeGymsIntoCanonical(tx, toMergeCandidate(target), [toMergeCandidate(source)]);

    // Belt and braces: a retired listing must never be refreshed back to life by
    // the location sync, even if its alias is somehow re-pointed at it later.
    await tx.execute(sql`UPDATE gyms SET sync_frozen_at = NOW() WHERE id = ${sourceGymId}`);

    await tx.insert(dbSchema.gymMergeAudit).values({
      action: 'merged',
      canonicalGymId: target.id,
      duplicateGymId: source.id,
      clusterSignature: computeClusterSignature([target.id, source.id]),
      movedCounts: mergeResult.counts,
      movedRows: mergeResult.movedRows,
      warnings: mergeResult.warnings,
      performedBy: actorUserId,
    });

    logger.info('stray attach emptied a synced listing; folded it into the target gym', {
      sourceGymId,
      targetGymId: target.id,
      performedBy: actorUserId,
    });
  });
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
    // Strip the internal ids — the GraphQL StrayBoard type never exposes them.
    return candidates.map(({ boardId: _boardId, currentGymId: _currentGymId, ...strayBoard }) => strayBoard);
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

    // Compare-and-swap: only re-point if the board's gym_id is still what we saw
    // when we vetted it, so a concurrent re-link (the owner moving the board
    // between the check and this write) can't be silently clobbered. `IS NOT
    // DISTINCT FROM` handles the unlinked (NULL) case; the ::bigint cast anchors
    // the bound param's type against the bigint column.
    const updated = await db
      .update(dbSchema.userBoards)
      .set({
        gymId: gym.id,
        // A deliberate human link. Without the freeze the next location-sync run
        // re-points the board straight back to the synced listing it came from
        // (upsert.ts's board upsert is guarded only by
        // `setWhere: isNull(userBoards.syncFrozenAt)`), silently undoing the
        // attach and re-populating the listing we are about to retire. Mirrors
        // updateBoard.
        syncFrozenAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(dbSchema.userBoards.id, target.boardId),
          sql`${dbSchema.userBoards.gymId} IS NOT DISTINCT FROM ${target.currentGymId}::bigint`,
        ),
      )
      .returning({ id: dbSchema.userBoards.id });

    if (updated.length === 0) {
      throw new GraphQLError('This board changed before it could be attached. Refresh and try again.', {
        extensions: { code: 'CONFLICT' },
      });
    }

    // The board has moved and that write is committed. If it was the last board
    // on a synced listing, fold that now-empty listing into this gym so it stops
    // showing up in search as a board-less twin (#4188). A failure here must not
    // turn a successful attach into a GraphQL error.
    if (target.currentGymId != null && target.currentGymId !== gym.id) {
      try {
        await retireEmptiedSourceGym(target.currentGymId, gym, userId);
      } catch (error) {
        logger.error('failed to retire the listing a stray attach emptied', {
          sourceGymId: target.currentGymId,
          targetGymId: gym.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return true;
  },

  /**
   * Remove a board from this gym's listing. The counterbalance to a board owner
   * self-linking to a gym they don't run (`requireBoardGymLinkAccess`): that gate
   * rests on board coordinates the caller supplies, so it can't be the only
   * control. Gym staff need a way to undo a wrong or unwanted link, and until
   * #4166 none existed — `linkBoardToGym`'s unlink branch is board-owner-only and
   * `deleteGym` was the only other thing that cleared `gym_id`.
   *
   * Only clears the link; the board itself is untouched and stays its owner's.
   */
  detachBoardFromGym: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'detachBoardFromGym');
    const validatedInput = validateInput(DetachBoardFromGymInputSchema, input, 'input');
    const userId = ctx.userId!;

    const gym = await requireGymEditAccess(validatedInput.gymUuid, userId);

    const [board] = await db
      .select({ id: dbSchema.userBoards.id, gymId: dbSchema.userBoards.gymId })
      .from(dbSchema.userBoards)
      .where(and(eq(dbSchema.userBoards.uuid, validatedInput.boardUuid), isNull(dbSchema.userBoards.deletedAt)))
      .limit(1);

    if (!board || board.gymId !== gym.id) {
      throw new GraphQLError('This board is not listed at this gym.', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    // Compare-and-swap so a concurrent re-link isn't silently clobbered.
    const updated = await db
      .update(dbSchema.userBoards)
      .set({ gymId: null })
      .where(and(eq(dbSchema.userBoards.id, board.id), eq(dbSchema.userBoards.gymId, gym.id)))
      .returning({ id: dbSchema.userBoards.id });

    if (updated.length === 0) {
      throw new GraphQLError('This board changed before it could be detached. Refresh and try again.', {
        extensions: { code: 'CONFLICT' },
      });
    }
    return true;
  },
};
