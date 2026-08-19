import { v4 as uuidv4 } from 'uuid';
import { eq, ne, and, count, isNull, isNotNull, sql, ilike, or, asc, desc, inArray, like } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { normaliseSetIds } from '@boardsesh/board-config';
import { rowsFromResult } from '@boardsesh/db/client';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';
import { consensusDifficultyExpr } from '../shared/sql-expressions';
import {
  CreateBoardInputSchema,
  UpdateBoardInputSchema,
  BoardLeaderboardInputSchema,
  MyBoardsInputSchema,
  FollowBoardInputSchema,
  SearchBoardsInputSchema,
  PopularBoardConfigsInputSchema,
  SerialNumberLookupSchema,
  RecordBoardSerialInputSchema,
  UUIDSchema,
  BOARD_ANGLE_VALIDATION_MESSAGE,
  isBoardAngleSupported,
} from '../../../validation/schemas';
import { generateUniqueGymSlug, requireBoardGymLinkAccess, userCanEditGym } from './gyms';
import { resolveAutoGymForBoard } from './gym-matching';
import { findBlockingDuplicate, type BoardLocation } from './board-duplicates';
import { assertBoardCapNotReached } from './board-limits';
import { syncLocationGeography } from './location-geography';
import { getUserCommunityRoles, hasAdminOrLeader, rolesGrantAdminOrLeader } from './roles';
import {
  SYSTEM_BOARD_OWNER_ID,
  followBoardMergeChain,
  isRowAnonReadable,
  requireAnonReadableBoard,
} from '../board-presence/shared';
import { assertKnownBoardConfig } from '../board-presence/board-catalog';
import { publishBoardQueuePreviewTombstoneForBoard } from '../../../services/board-queue-preview';
import { logger } from '../../../utils/logger';
import { redisClientManager } from '../../../redis/client';
import { isUniqueViolation } from '../../../utils/postgres-errors';
import { REDISLESS_FALLBACK_TTL_MS, singleFlight } from '../../../utils/single-flight';
import { lockAndAssertBoardSerialAvailable } from '../board-serial-write-lock';

// ============================================
// Helpers
// ============================================

function throwIfBoardSerialConflict(error: unknown): void {
  if (isUniqueViolation(error, 'user_boards_unique_owner_serial')) {
    throw new GraphQLError('You already have another board linked to that serial', {
      extensions: { code: 'BOARD_SERIAL_ALREADY_LINKED' },
    });
  }
}

/**
 * Generate a unique slug from a board name.
 * Uses a single query to fetch all existing slugs that share the same prefix,
 * then picks the next available suffix in-memory — no sequential DB loop.
 */
export async function generateUniqueSlug(name: string): Promise<string> {
  const baseSlug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 100) || 'board';

  // Fetch the base slug and all numeric-suffix variants in one query.
  // e.g. for "my-board" we match "my-board" and "my-board-2", "my-board-10", etc.
  const existing = await db
    .select({ slug: dbSchema.userBoards.slug })
    .from(dbSchema.userBoards)
    .where(
      and(
        or(eq(dbSchema.userBoards.slug, baseSlug), like(dbSchema.userBoards.slug, `${baseSlug}-%`)),
        isNull(dbSchema.userBoards.deletedAt),
      ),
    );

  if (existing.length === 0) {
    return baseSlug;
  }

  const taken = new Set(existing.map((r) => r.slug));

  if (!taken.has(baseSlug)) {
    return baseSlug;
  }

  for (let i = 2; i <= 100; i++) {
    const candidate = `${baseSlug}-${i}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }

  // Fallback: append UUID fragment
  return `${baseSlug}-${uuidv4().slice(0, 8)}`;
}

type DuplicateBoardCandidate = {
  uuid: string;
  slug: string;
  name: string;
  setIds: string;
  angle: number;
  latitude: number | null;
  longitude: number | null;
  locationName: string | null;
};

/**
 * The owner's other live board that a create/edit would collide with, or
 * undefined.
 *
 * SQL narrows to owner + type + layout + size only; set-id equality and the
 * place comparison are settled in JS by `findBlockingDuplicate`, because the
 * stored set-id order is whatever the board was created with ('25,26,27,24' and
 * '24,25,26,27' are the same wall but not the same string).
 *
 * `excludeBoardId` is the row being edited — a board must never block itself.
 */
async function findOwnedBlockingDuplicate(opts: {
  ownerId: string;
  boardType: string;
  layoutId: number;
  sizeId: number;
  incoming: BoardLocation & { setIds: string };
  excludeBoardId?: number;
}): Promise<DuplicateBoardCandidate | undefined> {
  const ownedWithConfig = await db
    .select({
      uuid: dbSchema.userBoards.uuid,
      slug: dbSchema.userBoards.slug,
      name: dbSchema.userBoards.name,
      setIds: dbSchema.userBoards.setIds,
      angle: dbSchema.userBoards.angle,
      latitude: dbSchema.userBoards.latitude,
      longitude: dbSchema.userBoards.longitude,
      locationName: dbSchema.userBoards.locationName,
    })
    .from(dbSchema.userBoards)
    .where(
      and(
        eq(dbSchema.userBoards.ownerId, opts.ownerId),
        eq(dbSchema.userBoards.boardType, opts.boardType),
        eq(dbSchema.userBoards.layoutId, opts.layoutId),
        eq(dbSchema.userBoards.sizeId, opts.sizeId),
        isNull(dbSchema.userBoards.deletedAt),
        opts.excludeBoardId != null ? ne(dbSchema.userBoards.id, opts.excludeBoardId) : undefined,
      ),
    )
    // Already narrowed to one owner's boards of one exact type/layout/size,
    // so this is a handful of rows; the cap is just a safety net against a
    // pathological account.
    .limit(100);

  return findBlockingDuplicate(ownedWithConfig, opts.incoming);
}

/**
 * The rejection both createBoard and updateBoard raise when the owner already
 * has this wall at this place. The existing board travels with the error so the
 * client can offer "use that one" without scanning its paginated myBoards cache
 * — which defaults to 20 and so can't find a match for a user with more boards.
 *
 * `includeIdentity` is false whenever the caller is not the board's owner. The
 * probe keys on the OWNER's boards, but updateBoard is reachable by gym admins
 * and community moderators, so attaching the colliding board's name, slug and
 * location would hand a non-owner the identity of a board they may not be able
 * to see at all — a private home wall, or one whose location `enrichBoard`
 * masks behind `hideLocation`. Same leak class as the private-gym probe finding
 * in the #4174 round: an error's extensions are a read channel, and they have
 * to respect the same visibility rules the read resolvers do.
 */
function duplicateBoardConfigError(
  existing: DuplicateBoardCandidate,
  { includeIdentity }: { includeIdentity: boolean },
): GraphQLError {
  return new GraphQLError('You already have this board at this location', {
    extensions: includeIdentity
      ? {
          code: 'BOARD_DUPLICATE_CONFIG',
          existingBoardUuid: existing.uuid,
          existingBoardSlug: existing.slug,
          existingBoardName: existing.name,
          existingBoardLocationName: existing.locationName,
          // Web's "go to your board" links to /b/<slug>/<angle>; without the
          // board's own angle it would land on the board type's default.
          existingBoardAngle: existing.angle,
        }
      : { code: 'BOARD_DUPLICATE_CONFIG' },
  });
}

/**
 * Resolve a board ID from user + board config. Used by tick logging on the
 * legacy `/[board_name]/[layout_id]/...` route, which names a configuration
 * rather than a board entity.
 *
 * Set-id equality is settled in JS, not SQL. The stored value keeps the order
 * the board was created with, so a SQL `eq()` called '25,26,27,24' and
 * '24,25,26,27' different boards and the tick was recorded with no board at all.
 *
 * Since #4174 an owner may hold several boards of one configuration, so the pick
 * has to be stable: `asc(id)` means the same tick always lands on the same
 * board, and a climber's history for that wall doesn't split across siblings.
 * Preferring the board the user most recently ticked was considered and left
 * out — it can flip the moment they tick a sibling through the boardUuid route,
 * which is less stable, not more. The session rung in saveTick is the signal
 * that actually knows which wall the climber is on.
 */
export async function resolveBoardFromPath(
  userId: string,
  boardType: string,
  layoutId: number,
  sizeId: number,
  setIds: string,
): Promise<number | null> {
  const candidates = await db
    .select({ id: dbSchema.userBoards.id, setIds: dbSchema.userBoards.setIds })
    .from(dbSchema.userBoards)
    .where(
      and(
        eq(dbSchema.userBoards.ownerId, userId),
        eq(dbSchema.userBoards.boardType, boardType),
        eq(dbSchema.userBoards.layoutId, layoutId),
        eq(dbSchema.userBoards.sizeId, sizeId),
        isNull(dbSchema.userBoards.deletedAt),
      ),
    )
    .orderBy(asc(dbSchema.userBoards.id))
    // One owner's boards of one exact type/layout/size — a handful of rows; the
    // cap is a safety net against a pathological account.
    .limit(100);

  const targetSetIds = normaliseSetIds(setIds);
  return candidates.find((candidate) => normaliseSetIds(candidate.setIds) === targetSetIds)?.id ?? null;
}

/**
 * Whether a user owns or is an admin member of a gym. Used to authorize editing
 * a board through its linked gym (gym owners/admins may fix the gym's boards).
 */
async function viewerCanAdminGym(gymId: number, userId: string): Promise<boolean> {
  const [ownedGym] = await db
    .select({ id: dbSchema.gyms.id })
    .from(dbSchema.gyms)
    .where(and(eq(dbSchema.gyms.id, gymId), eq(dbSchema.gyms.ownerId, userId), isNull(dbSchema.gyms.deletedAt)))
    .limit(1);

  if (ownedGym) return true;

  const [adminMembership] = await db
    .select({ role: dbSchema.gymMembers.role })
    .from(dbSchema.gymMembers)
    .innerJoin(dbSchema.gyms, eq(dbSchema.gyms.id, dbSchema.gymMembers.gymId))
    .where(
      and(
        eq(dbSchema.gymMembers.gymId, gymId),
        eq(dbSchema.gymMembers.userId, userId),
        eq(dbSchema.gymMembers.role, 'admin'),
        isNull(dbSchema.gyms.deletedAt),
      ),
    )
    .limit(1);

  return !!adminMembership;
}

/**
 * A community admin/leader's edit reach covers public listings and the seeded
 * system catalog — the boards this moderation exists to fix. A stranger's
 * PRIVATE board stays owner-only (and gym-admin-only), so a role can't rewrite
 * someone's private location/serial or flip their privacy flags.
 */
function boardIsRoleEditable(board: { isPublic: boolean; ownerId: string }): boolean {
  return board.isPublic || board.ownerId === SYSTEM_BOARD_OWNER_ID;
}

/**
 * Authorize editing a board: the caller must be the board owner, a community
 * admin/leader for the board's type (public/catalog boards only), or the
 * owner/admin of the board's linked gym. Throws when none apply.
 */
async function requireBoardEditAccess(
  ctx: ConnectionContext,
  board: typeof dbSchema.userBoards.$inferSelect,
): Promise<void> {
  const userId = ctx.userId!;

  if (board.ownerId === userId) return;
  if (boardIsRoleEditable(board) && (await hasAdminOrLeader(userId, board.boardType))) return;
  if (board.gymId != null && (await viewerCanAdminGym(board.gymId, userId))) return;

  throw new Error('Not authorized to update this board');
}

/**
 * The single gate for exposing a board's numeric presence-channel id
 * (userBoards.id, the `UserBoard.boardId` field feeding boardNowPlaying):
 * public boards expose it to everyone; private boards only to viewers with
 * board-level edit access. Every surface returning a UserBoard MUST use this —
 * a diverging inline computation could leak a private board's live channel.
 */
function boardPresenceChannelId(board: { id: number; isPublic: boolean }, canEdit: boolean): number | null {
  return board.isPublic || canEdit ? board.id : null;
}

/**
 * Follow a merge tombstone to the surviving canonical board.
 *
 * The serial-board dedupe soft-deletes duplicate rows for the same physical
 * wall, stamping the loser's `mergedIntoBoardUuid` with the survivor's uuid.
 * When a lookup lands on such a loser we chase that pointer (≤3 hops, bounded
 * so a cyclic or broken chain can't spin) to the first ACTIVE board and return
 * it, so stale links/bindings resolve to the survivor.
 *
 * An active row is returned unchanged. A plain soft-delete (tombstone null)
 * returns null — ordinary deletions must NOT be resurrected.
 */
async function resolveBoardFollowingMerges(
  boardRow: typeof dbSchema.userBoards.$inferSelect,
): Promise<typeof dbSchema.userBoards.$inferSelect | null> {
  if (!boardRow.deletedAt) return boardRow;
  if (!boardRow.mergedIntoBoardUuid) return null;
  return (await followBoardMergeChain(boardRow.mergedIntoBoardUuid)) ?? null;
}

/**
 * Enrich a board row with computed fields (counts, names, follow status).
 */
async function enrichBoard(
  board: typeof dbSchema.userBoards.$inferSelect,
  authenticatedUserId?: string,
  distanceMeters?: number | null,
) {
  // Run all independent queries in parallel to avoid N+1 per board
  const [
    ownerResult,
    tickStatsResult,
    followerStatsResult,
    commentStatsResult,
    followCheckResult,
    gymInfoResult,
    canEditByRole,
    canEditByGym,
  ] = await Promise.all([
    // Get owner profile
    db
      .select({
        name: dbSchema.users.name,
        image: dbSchema.users.image,
        displayName: dbSchema.userProfiles.displayName,
        avatarUrl: dbSchema.userProfiles.avatarUrl,
      })
      .from(dbSchema.users)
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
      .where(eq(dbSchema.users.id, board.ownerId))
      .limit(1),

    // Count total ascents and unique climbers
    db
      .select({
        totalAscents: count(),
        uniqueClimbers: sql<number>`COUNT(DISTINCT ${dbSchema.boardseshTicks.userId})`,
      })
      .from(dbSchema.boardseshTicks)
      .where(
        and(
          eq(dbSchema.boardseshTicks.boardId, board.id),
          or(eq(dbSchema.boardseshTicks.status, 'flash'), eq(dbSchema.boardseshTicks.status, 'send')),
        ),
      ),

    // Count followers
    db.select({ count: count() }).from(dbSchema.boardFollows).where(eq(dbSchema.boardFollows.boardUuid, board.uuid)),

    // Count comments
    db
      .select({ count: count() })
      .from(dbSchema.comments)
      .where(
        and(
          eq(dbSchema.comments.entityType, 'board'),
          eq(dbSchema.comments.entityId, board.uuid),
          isNull(dbSchema.comments.deletedAt),
        ),
      ),

    // Check if authenticated user follows this board
    authenticatedUserId
      ? db
          .select({ count: count() })
          .from(dbSchema.boardFollows)
          .where(
            and(eq(dbSchema.boardFollows.userId, authenticatedUserId), eq(dbSchema.boardFollows.boardUuid, board.uuid)),
          )
      : Promise.resolve([]),

    // Get gym info if board is linked to a gym
    board.gymId
      ? db
          .select({ uuid: dbSchema.gyms.uuid, name: dbSchema.gyms.name })
          .from(dbSchema.gyms)
          .where(and(eq(dbSchema.gyms.id, board.gymId), isNull(dbSchema.gyms.deletedAt)))
          .limit(1)
      : Promise.resolve([]),

    // Whether the viewer is a community admin/leader for this board type
    authenticatedUserId ? hasAdminOrLeader(authenticatedUserId, board.boardType) : Promise.resolve(false),

    // Whether the viewer owns/admins the board's linked gym
    authenticatedUserId && board.gymId != null
      ? viewerCanAdminGym(board.gymId, authenticatedUserId)
      : Promise.resolve(false),
  ]);

  const ownerInfo = ownerResult[0];
  const tickStats = tickStatsResult[0];
  const followerStats = followerStatsResult[0];
  const commentStats = commentStatsResult[0];
  const isFollowedByMe = Number(followCheckResult[0]?.count || 0) > 0;
  const gymInfo = (gymInfoResult as Array<{ uuid: string; name: string }>)[0];
  const canEdit = authenticatedUserId
    ? board.ownerId === authenticatedUserId || (canEditByRole && boardIsRoleEditable(board)) || canEditByGym
    : false;

  return {
    uuid: board.uuid,
    slug: board.slug,
    ownerId: board.ownerId,
    ownerDisplayName: ownerInfo?.displayName || ownerInfo?.name || undefined,
    ownerAvatarUrl: ownerInfo?.avatarUrl || ownerInfo?.image || undefined,
    boardType: board.boardType,
    layoutId: Number(board.layoutId),
    sizeId: Number(board.sizeId),
    setIds: board.setIds,
    name: board.name,
    description: board.description,
    locationName: board.locationName,
    latitude: board.latitude,
    longitude: board.longitude,
    isPublic: board.isPublic,
    isUnlisted: board.isUnlisted,
    hideLocation: board.hideLocation,
    isOwned: board.isOwned,
    angle: Number(board.angle),
    isAngleAdjustable: board.isAngleAdjustable,
    createdAt: board.createdAt.toISOString(),
    // Computed name fields (TODO: resolve from board-specific layout/size/set tables if needed)
    layoutName: null,
    sizeName: null,
    sizeDescription: null,
    setNames: null,
    totalAscents: Number(tickStats?.totalAscents || 0),
    uniqueClimbers: Number(tickStats?.uniqueClimbers || 0),
    followerCount: Number(followerStats?.count || 0),
    commentCount: Number(commentStats?.count || 0),
    isFollowedByMe,
    gymId: board.gymId ?? null,
    boardId: boardPresenceChannelId(board, canEdit),
    gymUuid: gymInfo?.uuid ?? null,
    gymName: gymInfo?.name ?? null,
    distanceMeters: distanceMeters ?? null,
    serialNumber: board.serialNumber ?? null,
    timerName: board.timerName ?? null,
    canEdit,
  };
}

/**
 * Batch-enrich multiple boards with computed fields using 6 total queries
 * instead of 6 per board. Used by list endpoints to avoid N+1. Exported so the
 * kiosk resolver resolves slot boards through the exact same `boardId` gate as
 * every other board read (public or viewer-can-edit → id, else null).
 */
export async function enrichBoards(
  boards: Array<{ board: typeof dbSchema.userBoards.$inferSelect; distanceMeters?: number | null }>,
  authenticatedUserId?: string,
) {
  if (boards.length === 0) return [];

  const boardIds = boards.map((b) => b.board.id);
  const boardUuids = boards.map((b) => b.board.uuid);
  const ownerIds = [...new Set(boards.map((b) => b.board.ownerId))];
  const gymIds = [...new Set(boards.map((b) => b.board.gymId).filter((id): id is number => id != null))];

  const [ownerRows, tickRows, followerRows, commentRows, followRows, gymRows, viewerRoles, ownedGymRows, adminGymRows] =
    await Promise.all([
      // Batch owner profiles
      db
        .select({
          userId: dbSchema.users.id,
          name: dbSchema.users.name,
          image: dbSchema.users.image,
          displayName: dbSchema.userProfiles.displayName,
          avatarUrl: dbSchema.userProfiles.avatarUrl,
        })
        .from(dbSchema.users)
        .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
        .where(inArray(dbSchema.users.id, ownerIds)),

      // Batch tick stats per board
      db
        .select({
          boardId: dbSchema.boardseshTicks.boardId,
          totalAscents: count(),
          uniqueClimbers: sql<number>`COUNT(DISTINCT ${dbSchema.boardseshTicks.userId})`,
        })
        .from(dbSchema.boardseshTicks)
        .where(
          and(
            inArray(dbSchema.boardseshTicks.boardId, boardIds),
            or(eq(dbSchema.boardseshTicks.status, 'flash'), eq(dbSchema.boardseshTicks.status, 'send')),
          ),
        )
        .groupBy(dbSchema.boardseshTicks.boardId),

      // Batch follower counts per board
      db
        .select({
          boardUuid: dbSchema.boardFollows.boardUuid,
          count: count(),
        })
        .from(dbSchema.boardFollows)
        .where(inArray(dbSchema.boardFollows.boardUuid, boardUuids))
        .groupBy(dbSchema.boardFollows.boardUuid),

      // Batch comment counts per board
      db
        .select({
          entityId: dbSchema.comments.entityId,
          count: count(),
        })
        .from(dbSchema.comments)
        .where(
          and(
            eq(dbSchema.comments.entityType, 'board'),
            inArray(dbSchema.comments.entityId, boardUuids),
            isNull(dbSchema.comments.deletedAt),
          ),
        )
        .groupBy(dbSchema.comments.entityId),

      // Batch follow status for authenticated user
      authenticatedUserId
        ? db
            .select({ boardUuid: dbSchema.boardFollows.boardUuid })
            .from(dbSchema.boardFollows)
            .where(
              and(
                eq(dbSchema.boardFollows.userId, authenticatedUserId),
                inArray(dbSchema.boardFollows.boardUuid, boardUuids),
              ),
            )
        : Promise.resolve([]),

      // Batch gym info
      gymIds.length > 0
        ? db
            .select({ id: dbSchema.gyms.id, uuid: dbSchema.gyms.uuid, name: dbSchema.gyms.name })
            .from(dbSchema.gyms)
            .where(and(inArray(dbSchema.gyms.id, gymIds), isNull(dbSchema.gyms.deletedAt)))
        : Promise.resolve([]),

      // Viewer's community roles — fetched once, applied per board by board type
      authenticatedUserId ? getUserCommunityRoles(authenticatedUserId) : Promise.resolve([]),

      // Gyms (among the referenced ones) the viewer owns — grants edit on their boards
      authenticatedUserId && gymIds.length > 0
        ? db
            .select({ id: dbSchema.gyms.id })
            .from(dbSchema.gyms)
            .where(
              and(
                inArray(dbSchema.gyms.id, gymIds),
                eq(dbSchema.gyms.ownerId, authenticatedUserId),
                isNull(dbSchema.gyms.deletedAt),
              ),
            )
        : Promise.resolve([]),

      // Gyms (among the referenced ones) the viewer is an admin member of
      authenticatedUserId && gymIds.length > 0
        ? db
            .select({ gymId: dbSchema.gymMembers.gymId })
            .from(dbSchema.gymMembers)
            .innerJoin(dbSchema.gyms, eq(dbSchema.gyms.id, dbSchema.gymMembers.gymId))
            .where(
              and(
                inArray(dbSchema.gymMembers.gymId, gymIds),
                eq(dbSchema.gymMembers.userId, authenticatedUserId),
                eq(dbSchema.gymMembers.role, 'admin'),
                isNull(dbSchema.gyms.deletedAt),
              ),
            )
        : Promise.resolve([]),
    ]);

  // Index results for O(1) lookups
  const ownerMap = new Map(ownerRows.map((r) => [r.userId, r]));
  const tickMap = new Map(tickRows.map((r) => [r.boardId, r]));
  const followerMap = new Map(followerRows.map((r) => [r.boardUuid, Number(r.count)]));
  const commentMap = new Map(commentRows.map((r) => [r.entityId, Number(r.count)]));
  const followedSet = new Set(followRows.map((r) => r.boardUuid));
  const gymMap = new Map(gymRows.map((r) => [r.id, r]));
  // Gym ids the viewer can edit boards through (owns the gym OR is an admin member)
  const editableGymIds = new Set<number>([
    ...(ownedGymRows as Array<{ id: number }>).map((row) => row.id),
    ...(adminGymRows as Array<{ gymId: number }>).map((row) => row.gymId),
  ]);

  return boards.map(({ board, distanceMeters }) => {
    const owner = ownerMap.get(board.ownerId);
    const ticks = tickMap.get(board.id);
    const gym = board.gymId ? gymMap.get(board.gymId) : undefined;
    const canEdit = authenticatedUserId
      ? board.ownerId === authenticatedUserId ||
        (rolesGrantAdminOrLeader(viewerRoles, board.boardType) && boardIsRoleEditable(board)) ||
        (board.gymId != null && editableGymIds.has(board.gymId))
      : false;

    return {
      uuid: board.uuid,
      slug: board.slug,
      ownerId: board.ownerId,
      ownerDisplayName: owner?.displayName || owner?.name || undefined,
      ownerAvatarUrl: owner?.avatarUrl || owner?.image || undefined,
      boardType: board.boardType,
      layoutId: Number(board.layoutId),
      sizeId: Number(board.sizeId),
      setIds: board.setIds,
      name: board.name,
      description: board.description,
      locationName: board.locationName,
      latitude: board.latitude,
      longitude: board.longitude,
      isPublic: board.isPublic,
      isUnlisted: board.isUnlisted,
      hideLocation: board.hideLocation,
      isOwned: board.isOwned,
      angle: Number(board.angle),
      isAngleAdjustable: board.isAngleAdjustable,
      createdAt: board.createdAt.toISOString(),
      layoutName: null,
      sizeName: null,
      sizeDescription: null,
      setNames: null,
      totalAscents: Number(ticks?.totalAscents || 0),
      uniqueClimbers: Number(ticks?.uniqueClimbers || 0),
      followerCount: followerMap.get(board.uuid) || 0,
      commentCount: commentMap.get(board.uuid) || 0,
      isFollowedByMe: followedSet.has(board.uuid),
      gymId: board.gymId ?? null,
      boardId: boardPresenceChannelId(board, canEdit),
      gymUuid: gym?.uuid ?? null,
      gymName: gym?.name ?? null,
      distanceMeters: distanceMeters ?? null,
      serialNumber: board.serialNumber ?? null,
      timerName: board.timerName ?? null,
      canEdit,
    };
  });
}

// ============================================
// Popular Board Config Cache (Redis-backed)
// ============================================

export type CachedPopularConfig = {
  boardType: string;
  layoutId: number;
  layoutName: string | null;
  sizeId: number;
  sizeName: string | null;
  sizeDescription: string | null;
  setIds: number[];
  setNames: string[];
  climbCount: number;
  totalAscents: number;
  boardCount: number;
  displayName: string;
  // Optional, not just nullable: a legacy Redis row cached before this field
  // existed has no key for it at all, and JSON.parse of that row produces
  // `undefined` here, not `null` — the cache-legacy-row test pins that. A
  // non-optional type would be a lie about what call sites actually see.
  lastClimbAt?: string | null;
};

/**
 * Normalise a `board_climbs.created_at` value into a proper ISO-8601 UTC
 * timestamp string.
 *
 * The column is `text`, not `timestamptz`, and carries at least two naive
 * (zone-less) formats depending on the importer: Aurora/PowerSync writes a
 * space-separated form (`'2024-03-11 09:00:00.123456'`) and MoonBoard writes
 * ISO-T (`'2023-11-23T18:00:15.227'`). Neither carries a timezone offset, so
 * a plain `new Date(raw)` would read both as *local* time — timezone-dependent
 * and wrong. This is a pure string transform (not a `Date` round-trip) so the
 * behaviour is identical in every runner timezone: parse the pieces, rebuild
 * with an explicit `Z`, then validate.
 *
 * Returns `null` for anything unparseable, and for a timestamp in the future
 * (a corrupt row must never leak a fabricated future `<lastmod>`).
 *
 * The fractional-seconds group is explicitly truncated to exactly 3 digits
 * (padded on the right when shorter) before hitting `Date.parse`. ECMA-262
 * only specifies millisecond precision (`.sss`) for the extended ISO format;
 * Aurora's microsecond-precision `created_at` (6 digits) parsing correctly is
 * a V8 leniency, not a spec guarantee — truncate explicitly rather than lean
 * on that.
 */
export function normalizeCatalogTimestamp(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }

  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(raw);
  if (!match) {
    return null;
  }

  const [, datePart, timePart, fractionPart, zonePart] = match;
  // fractionPart includes its leading dot (e.g. ".123456" or ".5"). Keep up to
  // 3 digits after the dot and right-pad shorter fractions with zeros — ".5"
  // means 0.5s = 500ms, so the pad is on the right, not the left.
  const millis = fractionPart ? `.${fractionPart.slice(1, 4).padEnd(3, '0')}` : '';
  const rebuilt = `${datePart}T${timePart}${millis}${zonePart ?? 'Z'}`;
  const parsedMs = Date.parse(rebuilt);
  if (!Number.isFinite(parsedMs)) {
    return null;
  }
  if (parsedMs > Date.now()) {
    return null;
  }

  return new Date(parsedMs).toISOString();
}

const BOARD_TYPE_LABELS: Record<string, string> = {
  kilter: 'Kilter',
  tension: 'Tension',
  moonboard: 'MoonBoard',
  decoy: 'Decoy',
  touchstone: 'Touchstone',
  grasshopper: 'Grasshopper',
  soill: 'So iLL',
  woods: 'Woods',
};

const GENERIC_SETS = new Set(['bolt ons', 'screw ons', 'foot set', 'plastic', 'wood']);

function formatDisplayName(
  boardType: string,
  layoutName: string | null,
  sizeName: string | null,
  setNames: string[],
): string {
  const boardLabel = BOARD_TYPE_LABELS[boardType] || boardType;

  // Shorten layout name: strip board type, "Board", abbreviations
  const shortLayout = (layoutName || '')
    .replace(new RegExp(`\\b${boardLabel}\\b\\s*`, 'gi'), '')
    .replace(/\bBoard\b\s*/gi, '')
    .replace(/\bHomewall\b/gi, 'HW')
    .replace(/\bOriginal\b/gi, 'OG')
    .replace(/\bLayout\b/gi, '')
    .replace(/^2\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Compact size name: strip "high"/"wide", collapse whitespace around "x"
  const shortSize = (sizeName || '')
    .replace(/\s*high\s*/gi, '')
    .replace(/\s*wide\s*/gi, '')
    .replace(/\s*x\s*/g, 'x')
    .replace(/\s+/g, ' ')
    .trim();

  // Detect distinctive sets (Mainline/Auxiliary vs generic Bolt Ons/Screw Ons)
  const distinctiveSets = setNames.filter((s) => !GENERIC_SETS.has(s.toLowerCase()));
  const hasMainline = distinctiveSets.some((s) => /mainline/i.test(s) && !/kickboard/i.test(s));
  const hasAux = distinctiveSets.some((s) => /auxiliary/i.test(s) && !/kickboard/i.test(s));
  let setLabel = '';
  if (hasMainline && hasAux) {
    setLabel = ' Full Ride';
  } else if (distinctiveSets.length > 0) {
    setLabel = ` ${distinctiveSets.map((s) => s.replace(/\bKickboard\b/gi, 'KB')).join(' + ')}`;
  }

  return `${shortLayout} ${shortSize}${setLabel}`.trim();
}

// v2: added `lastClimbAt`. Bump this suffix whenever the cached payload shape
// changes so new code can never read a pre-shape row back out of Redis — the
// old key is simply orphaned and expires under its own TTL. Do NOT bump this
// per deploy, only per payload-shape change.
const REDIS_CACHE_KEY = 'boardsesh:popular-board-configs:v2';
const REDIS_CACHE_TTL_SECONDS = 365 * 24 * 60 * 60; // 1 year
const REDIS_LOCK_KEY = 'boardsesh:popular-board-configs:lock';
const REDIS_LOCK_TTL_SECONDS = 120; // 2 min lock to prevent duplicate queries across nodes

/**
 * Key for the in-process single-flight. The statement below is the heaviest
 * read in the app — one LATERAL with a nested NOT EXISTS per listed config,
 * 51 of them today — and it is the resolver behind the home page, so a cold
 * cache used to mean one copy per concurrent visitor, each holding a pool
 * connection until it finished. See utils/single-flight.ts for what that did
 * to every other query in the process.
 */
const POPULAR_CONFIGS_FLIGHT_KEY = 'popular-board-configs';

/**
 * Last-resort cache for deployments with no Redis (local dev, the e2e CI
 * stack). With a shared cache there is nothing to fall back to and this is
 * never read or written, so production behaviour — including the deliberate
 * cache DELETE in `warmPopularConfigsCache` on every deploy — is unchanged.
 * Without one, single-flight alone would still re-run the statement for the
 * first caller after each completion, forever.
 */
let localFallbackConfigs: { configs: CachedPopularConfig[]; expiresAt: number } | null = null;

/**
 * Bumped on every drop. The statement runs for tens of seconds, so a deploy
 * warm-up can easily land while an earlier copy is still executing — and
 * without this that copy would repopulate the fallback with pre-deploy data
 * *after* the drop, which is the one thing the warm-up exists to prevent. A
 * flight captures the counter before it starts and declines to cache its
 * result if the number moved underneath it.
 */
let fallbackGeneration = 0;

/**
 * The Redis-less twin of deleting REDIS_CACHE_KEY: force the next read to
 * re-query. Called by the deploy warm-up, and by tests so one case cannot
 * answer the next from the previous one's fixture.
 */
export function dropPopularConfigsFallback(): void {
  localFallbackConfigs = null;
  fallbackGeneration += 1;
}

export async function getPopularConfigs(): Promise<CachedPopularConfig[]> {
  // Try Redis cache first
  if (redisClientManager.isRedisConnected()) {
    try {
      const { publisher } = redisClientManager.getClients();
      const cached = await publisher.get(REDIS_CACHE_KEY);
      if (cached) {
        return JSON.parse(cached) as CachedPopularConfig[];
      }
    } catch (err) {
      logger.error('[PopularConfigs] Redis read failed:', err);
    }
  } else if (localFallbackConfigs && localFallbackConfigs.expiresAt > Date.now()) {
    return localFallbackConfigs.configs;
  }

  return singleFlight(POPULAR_CONFIGS_FLIGHT_KEY, runPopularConfigsQuery);
}

async function runPopularConfigsQuery(): Promise<CachedPopularConfig[]> {
  const generationAtStart = fallbackGeneration;

  // Query all per-size configs with climb counts filtered by size edges AND set membership.
  // A climb counts for a config only if ALL its holds belong to placements in that config's sets.
  // board_climb_holds.hold_id = board_placements.id (placement ID).
  //
  // Cached in Redis for 1 year (deliberately re-run on deploy). Cost, measured
  // 2026-08-22 against the dev-db image (51 listed configs, 648k board_climbs,
  // idle 10-core box): 82 s for one execution. The header on this block used to
  // read "~31 configs, ~750ms worst case per LATERAL" — that is long stale, and
  // the gap is why an uncached window mattered so much (#4463).
  //
  // Production is faster than the dev image but not fast: the only production
  // observation on record is ~10 s cold, measured through the sitemap's copy of
  // this same read (`packages/web/app/lib/server-popular-configs.ts`, which
  // wraps it in an in-process TTL + single-flight for exactly this reason —
  // prior art for what happens below). Ten seconds × one connection per
  // concurrent visitor is still a pool.
  //
  // Making this statement cheap is its own piece of work; what is fixed here is
  // that a cold window can no longer run more than one copy of it at a time.
  const result = await db.execute(sql`
    SELECT
      configs.board_type,
      configs.layout_id,
      bl.name AS layout_name,
      configs.size_id,
      bps.name AS size_name,
      bps.description AS size_description,
      configs.set_ids,
      configs.set_names,
      COALESCE(cc.climb_count, 0) AS climb_count,
      COALESCE(cc.total_ascents, 0) AS total_ascents,
      COALESCE(ub_counts.board_count, 0) AS board_count,
      cc.last_climb_at
    FROM (
      SELECT
        psls.board_type,
        psls.layout_id,
        psls.product_size_id AS size_id,
        array_agg(DISTINCT psls.set_id ORDER BY psls.set_id) AS set_ids,
        array_agg(DISTINCT bs.name ORDER BY bs.name) AS set_names
      FROM board_product_sizes_layouts_sets psls
      JOIN board_sets bs ON bs.board_type = psls.board_type AND bs.id = psls.set_id
      WHERE psls.is_listed = true
      GROUP BY psls.board_type, psls.layout_id, psls.product_size_id
    ) configs
    JOIN board_layouts bl ON bl.board_type = configs.board_type AND bl.id = configs.layout_id
    JOIN board_product_sizes bps ON bps.board_type = configs.board_type AND bps.id = configs.size_id
    LEFT JOIN (
      SELECT
        ub.board_type,
        ub.layout_id,
        ub.size_id,
        COUNT(*)::int AS board_count
      FROM user_boards ub
      WHERE ub.deleted_at IS NULL
      GROUP BY ub.board_type, ub.layout_id, ub.size_id
    ) ub_counts
      ON ub_counts.board_type = configs.board_type
      AND ub_counts.layout_id = configs.layout_id
      AND ub_counts.size_id = configs.size_id
    LEFT JOIN LATERAL (
      SELECT
        COUNT(DISTINCT bc.uuid)::int AS climb_count,
        COALESCE(SUM(bcs.ascensionist_count), 0)::int AS total_ascents,
        -- created_at is text, not timestamptz, and carries two naive-UTC
        -- separator styles (Aurora writes a space, MoonBoard writes 'T').
        -- REPLACE canonicalises the separator before the text MAX so the
        -- comparison is chronological rather than lexicographic (raw 'T'
        -- (0x54) sorts after ' ' (0x20), which would silently pick the wrong
        -- row on a shared calendar day). The LIKE mask drops anything that
        -- doesn't start with a YYYY-MM-DD date -- Postgres has no try_cast,
        -- so this must stay a text filter, never a ::timestamp cast, or one
        -- unparseable legacy row would 500 the whole query.
        MAX(REPLACE(bc.created_at, ' ', 'T')) FILTER (WHERE bc.created_at LIKE '____-__-__%') AS last_climb_at
      FROM board_climbs bc
      LEFT JOIN board_climb_stats bcs
        ON bcs.board_type = bc.board_type AND bcs.climb_uuid = bc.uuid
      WHERE bc.board_type = configs.board_type
        AND bc.layout_id = configs.layout_id
        AND bc.is_listed = true
        AND bc.is_draft = false
        AND bc.edge_left > bps.edge_left
        AND bc.edge_right < bps.edge_right
        AND bc.edge_bottom > bps.edge_bottom
        AND bc.edge_top < bps.edge_top
        AND NOT EXISTS (
          SELECT 1 FROM board_climb_holds bch
          WHERE bch.climb_uuid = bc.uuid
            AND bch.board_type = bc.board_type
            AND NOT EXISTS (
              SELECT 1 FROM board_placements bp
              WHERE bp.board_type = bch.board_type
                AND bp.layout_id = bc.layout_id
                AND bp.id = bch.hold_id
                AND bp.set_id = ANY(configs.set_ids)
            )
        )
    ) cc ON true
    WHERE bl.is_listed = true
      AND bps.is_listed = true
    ORDER BY board_count DESC, total_ascents DESC, configs.board_type, bl.name
  `);

  const rows = rowsFromResult<Record<string, unknown>>(result);

  const configs: CachedPopularConfig[] = rows.map((row) => {
    const boardType = row.board_type as string;
    const layoutName = (row.layout_name as string) ?? null;
    const sizeName = (row.size_name as string) ?? null;
    const setNames = row.set_names as string[];
    return {
      boardType,
      layoutId: Number(row.layout_id),
      layoutName,
      sizeId: Number(row.size_id),
      sizeName,
      sizeDescription: (row.size_description as string) ?? null,
      setIds: (row.set_ids as number[]).map(Number),
      setNames,
      climbCount: Number(row.climb_count),
      totalAscents: Number(row.total_ascents),
      boardCount: Number(row.board_count),
      displayName: formatDisplayName(boardType, layoutName, sizeName, setNames),
      lastClimbAt: normalizeCatalogTimestamp(row.last_climb_at),
    };
  });

  // Store in Redis
  if (redisClientManager.isRedisConnected()) {
    try {
      const { publisher } = redisClientManager.getClients();
      await publisher.set(REDIS_CACHE_KEY, JSON.stringify(configs), 'EX', REDIS_CACHE_TTL_SECONDS);
    } catch (err) {
      logger.error('[PopularConfigs] Redis write failed:', err);
    }
  } else if (fallbackGeneration === generationAtStart) {
    localFallbackConfigs = { configs, expiresAt: Date.now() + REDISLESS_FALLBACK_TTL_MS };
  }
  return configs;
}

/**
 * Refresh the popular configs Redis cache on server startup.
 * Always re-runs the query on deploy (data may have changed via Aurora sync).
 * Uses a Redis lock so only one node across the cluster runs the expensive query;
 * other nodes skip — they'll read from Redis when the resolver executes.
 */
export async function warmPopularConfigsCache(): Promise<void> {
  // Mirrors the cache DELETE below for a deployment with no Redis: the warm-up
  // exists to re-run the query on deploy, so it must not be answered by the
  // copy the previous run left behind.
  dropPopularConfigsFallback();

  if (redisClientManager.isRedisConnected()) {
    try {
      const { publisher } = redisClientManager.getClients();

      // Try to acquire lock — only the winning node runs the query
      const lockAcquired = await publisher.set(REDIS_LOCK_KEY, '1', 'EX', REDIS_LOCK_TTL_SECONDS, 'NX');
      if (!lockAcquired) {
        logger.info('[PopularConfigs] Another node is refreshing the cache, skipping');
        return;
      }
      // Winning node: delete stale cache so getPopularConfigs() runs the SQL query
      await publisher.del(REDIS_CACHE_KEY);
    } catch (err) {
      logger.error('[PopularConfigs] Redis lock failed:', err);
    }
  }

  logger.info('[PopularConfigs] Refreshing cache...');
  try {
    const configs = await getPopularConfigs();
    logger.info(`[PopularConfigs] Cache warmed with ${configs.length} configs`);
  } catch (err) {
    logger.error('[PopularConfigs] Cache warm-up failed:', err);
  }
}

// ============================================
// Queries
// ============================================

export const socialBoardQueries = {
  /**
   * Get a board by UUID.
   *
   * Anonymous callers only reach boards that pass `isRowAnonReadable` (public,
   * or system-owned). A private board reads as `null` — the exact same response
   * as a board that doesn't exist, so a uuid holder can't confirm one exists.
   * That closes the kiosk dereference: a kiosk's `layout` JSON deliberately
   * carries slot boardUuids, and those must not resolve to a private board's
   * name.
   *
   * Deliberately ANON-ONLY, unlike the gym reads. A logged-in caller keeps
   * membership-free access to any active board, matching
   * `requireAnonReadableBoard` and the rest of the board-presence family.
   * Authenticated non-owner access is load-bearing: a climber connecting to a
   * gym's private board over BLE resolves it by uuid through here, and
   * `boardsBySerialNumbers` already serves private boards to any signed-in
   * caller.
   */
  board: async (_: unknown, { boardUuid }: { boardUuid: string }, ctx: ConnectionContext) => {
    validateInput(UUIDSchema, boardUuid, 'boardUuid');

    // Look up WITHOUT the deletedAt filter so a merged-away loser is still
    // visible here — we then follow its tombstone to the survivor. A plain
    // soft-delete (no tombstone) resolves to null, as before.
    const [board] = await db.select().from(dbSchema.userBoards).where(eq(dbSchema.userBoards.uuid, boardUuid)).limit(1);

    if (!board) return null;
    const canonical = board.deletedAt ? await resolveBoardFollowingMerges(board) : board;
    if (!canonical) return null;
    const viewerId = ctx.isAuthenticated ? ctx.userId : undefined;
    // Gate before enrichment so a masked anonymous read never runs the
    // owner/count/follow lookups for a board it isn't allowed to see.
    if (!viewerId && !isRowAnonReadable(canonical)) return null;
    return enrichBoard(canonical, viewerId);
  },

  /**
   * Get a board by slug (for URL routing).
   *
   * This follows the same anonymous-only mask as `board(boardUuid)`: direct
   * private-board links keep working for signed-in climbers, while anonymous
   * requests cannot disclose a private board through the shared web cache.
   */
  boardBySlug: async (_: unknown, { slug }: { slug: string }, ctx: ConnectionContext) => {
    // Validate slug format: lowercase alphanumeric with hyphens, max 120 chars
    if (!slug || slug.length > 120 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) {
      return null;
    }

    const viewerId = ctx.isAuthenticated ? ctx.userId : undefined;

    // The slug unique index is partial on active rows, so at most one active
    // board holds a given slug — keep that as the indexed fast path (this
    // resolver backs every board page view).
    const [active] = await db
      .select()
      .from(dbSchema.userBoards)
      .where(and(eq(dbSchema.userBoards.slug, slug), isNull(dbSchema.userBoards.deletedAt)))
      .limit(1);
    if (active) {
      // Gate before enrichment so a masked anonymous read never runs the
      // owner/count/follow lookups for a board it isn't allowed to see.
      if (!viewerId && !isRowAnonReadable(active)) return null;
      return enrichBoard(active, viewerId);
    }

    // No active board holds the slug. A merged-away loser keeps its old slug,
    // so follow its tombstone to the survivor (the canonical board carries its
    // own real slug/uuid, so clients detect the change and redirect). A reused
    // slug can leave several merged losers behind — prefer the most recently
    // deleted one so the pick is deterministic and tracks the latest holder.
    // deletedAt IS NOT NULL is redundant with the active-row fast path above
    // (which already claims any row with this slug that has deletedAt IS NULL,
    // merged or not) — stated explicitly anyway so this query's own invariant
    // doesn't rely on that ordering, and a corrupted row (mergedIntoBoardUuid
    // set, deletedAt NULL) can't be mistaken for a tombstone here.
    const [merged] = await db
      .select()
      .from(dbSchema.userBoards)
      .where(
        and(
          eq(dbSchema.userBoards.slug, slug),
          isNotNull(dbSchema.userBoards.mergedIntoBoardUuid),
          isNotNull(dbSchema.userBoards.deletedAt),
        ),
      )
      .orderBy(desc(dbSchema.userBoards.deletedAt))
      .limit(1);
    if (!merged) return null;

    const canonical = await resolveBoardFollowingMerges(merged);
    if (!canonical) return null;
    // Same anonymous mask as the active path and `board(boardUuid)`: following a
    // tombstone must not disclose a private survivor to an anonymous caller.
    if (!viewerId && !isRowAnonReadable(canonical)) return null;
    return enrichBoard(canonical, viewerId);
  },

  /**
   * A gym's linked, non-deleted boards, viewer-scoped. Editors of the gym (owner,
   * gym admin/editor, or a covering community admin/leader) see every linked
   * board; everyone else — including anonymous callers — sees only publicly
   * listed boards (isPublic AND NOT isUnlisted, matching searchBoards' discovery
   * convention: unlisted = link-only, never enumerated). A missing gym, or a
   * private gym seen by a non-editor, is masked as NOT_FOUND. Auth-optional and
   * rate-limited like the other anon board reads; the leaderboard embed reuses
   * it without any auth. Boards are ordered by name. Populates each board's
   * `boardId` (presence channel) via the shared enrichBoards visibility rule.
   */
  gymBoards: async (_: unknown, { gymUuid }: { gymUuid: string }, ctx: ConnectionContext) => {
    // 30/min matches the board-presence anon family this query feeds
    // (boardNowPlaying/boardPresenceStats/boardConnection) — several kiosk
    // displays behind one gym NAT re-enumerating after a network blip share
    // one anonymous IP bucket.
    await applyRateLimit(ctx, 30, 'gymBoards');
    validateInput(UUIDSchema, gymUuid, 'gymUuid');

    const viewerId = ctx.isAuthenticated ? ctx.userId : undefined;

    const [gym] = await db
      .select()
      .from(dbSchema.gyms)
      .where(and(eq(dbSchema.gyms.uuid, gymUuid), isNull(dbSchema.gyms.deletedAt)))
      .limit(1);

    const canEdit = gym && viewerId ? await userCanEditGym(gym, viewerId) : false;

    // Mask a missing gym, and a private gym from anyone who can't edit it, behind
    // the shared NOT_FOUND convention. `gym(gymUuid)`/`gymBySlug` now apply the
    // same `userCanEditGym` rule (#3648); they express it as `null` rather than a
    // thrown NOT_FOUND because their SDL types are nullable, so `null` IS their
    // missing-entity response. This query's `[UserBoard!]!` type leaves throwing
    // as its only option. The embed depends on this one being safe to call
    // anonymously against any uuid.
    if (!gym || (!gym.isPublic && !canEdit)) {
      throw new GraphQLError('Gym not found', { extensions: { code: 'NOT_FOUND' } });
    }

    const conditions = [eq(dbSchema.userBoards.gymId, gym.id), isNull(dbSchema.userBoards.deletedAt)];
    // Non-editors (including anonymous) only see the gym's publicly LISTED
    // boards — isPublic AND NOT isUnlisted, mirroring searchBoards (unlisted =
    // reachable by direct link only, never enumerated). The leaderboard embed
    // relies on this to enumerate boards without auth.
    if (!canEdit) {
      conditions.push(eq(dbSchema.userBoards.isPublic, true));
      conditions.push(eq(dbSchema.userBoards.isUnlisted, false));
    }

    const boards = await db
      .select()
      .from(dbSchema.userBoards)
      .where(and(...conditions))
      .orderBy(asc(dbSchema.userBoards.name));

    return enrichBoards(
      boards.map((board) => ({ board })),
      viewerId,
    );
  },

  /**
   * Look up boards by controller serial numbers.
   * Searches all boards (including unlisted/non-public) so BLE device
   * discovery can resolve any board regardless of visibility.
   * No auth required (BLE scan-before-login), but rate-limited.
   * Unauthenticated callers receive stripped responses (no GPS/owner data).
   */
  boardsBySerialNumbers: async (
    _: unknown,
    { serialNumbers, boardType }: { serialNumbers: string[]; boardType?: string | null },
    ctx: ConnectionContext,
  ) => {
    await applyRateLimit(ctx, 20, 'boardsBySerialNumbers');

    // Behaviour change: this used to silently `.slice(0, 20)` on overflow, now
    // it throws via Zod (`SerialNumberLookupSchema.max(20)`). Callers MUST cap
    // before sending — `resolveSerialNumbers` (the only first-party caller) does
    // this via `MAX_SERIALS_PER_REQUEST`. Throwing surfaces accidental breakage
    // in any future caller instead of silently dropping serials.
    const validated = validateInput(
      SerialNumberLookupSchema,
      { serialNumbers, boardType: boardType ?? undefined },
      'serialNumbers',
    );
    const cleaned = validated.serialNumbers.filter((s) => s.length > 0);
    if (cleaned.length === 0) return [];

    // A serial identifies a controller only WITHIN a board type — Aurora runs a
    // separate sequence per board app. Without this filter a Tension controller
    // resolves onto whichever Kilter board happens to share its serial. Clients
    // that predate the fix omit `boardType` and keep the old wide lookup.
    const boards = await db
      .select()
      .from(dbSchema.userBoards)
      .where(
        and(
          inArray(dbSchema.userBoards.serialNumber, cleaned),
          isNull(dbSchema.userBoards.deletedAt),
          validated.boardType ? eq(dbSchema.userBoards.boardType, validated.boardType) : undefined,
        ),
      );

    // Unauthenticated callers get an allowlisted response built directly from
    // the DB rows — skip enrichBoards entirely (no owner/stats/follow queries).
    // Public boards include UGC fields; non-public boards get config only.
    if (!ctx.isAuthenticated) {
      return boards.map((board) => {
        return {
          uuid: board.uuid,
          slug: board.slug,
          ownerId: '',
          ownerDisplayName: null,
          ownerAvatarUrl: null,
          boardType: board.boardType,
          layoutId: Number(board.layoutId),
          sizeId: Number(board.sizeId),
          setIds: board.setIds,
          name: board.isPublic ? board.name : board.boardType,
          description: board.isPublic ? board.description : null,
          locationName: board.isPublic ? board.locationName : null,
          latitude: null,
          longitude: null,
          isPublic: board.isPublic,
          isUnlisted: board.isUnlisted,
          hideLocation: board.hideLocation,
          isOwned: false,
          angle: Number(board.angle),
          isAngleAdjustable: board.isAngleAdjustable,
          createdAt: board.createdAt.toISOString(),
          layoutName: null,
          sizeName: null,
          sizeDescription: null,
          setNames: null,
          totalAscents: 0,
          uniqueClimbers: 0,
          followerCount: 0,
          commentCount: 0,
          isFollowedByMe: false,
          gymId: null,
          // Anonymous caller: no edit access, so only public boards expose it.
          boardId: boardPresenceChannelId(board, false),
          gymUuid: null,
          gymName: null,
          distanceMeters: null,
          serialNumber: board.serialNumber ?? null,
          timerName: board.timerName ?? null,
          canEdit: false,
        };
      });
    }

    const enriched = await enrichBoards(
      boards.map((board) => ({ board })),
      ctx.userId,
    );

    return enriched;
  },

  /**
   * Auto-recorded serial→config rows for the current user, optionally joined
   * to the saved board they're linked to. Used as a fallback in serial lookups
   * and for detecting connect-time config mismatches.
   */
  myBoardSerialConfigs: async (_: unknown, { serialNumbers }: { serialNumbers: string[] }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'myBoardSerialConfigs');

    const validated = validateInput(SerialNumberLookupSchema, { serialNumbers }, 'serialNumbers');
    const cleaned = validated.serialNumbers.filter((s) => s.length > 0);
    if (cleaned.length === 0) return [];

    // requireAuthenticated only checks the isAuthenticated flag; explicitly
    // guard userId so a malformed context can't slip undefined into the query.
    const { userId } = ctx;
    if (!userId) {
      throw new Error('Authentication required to perform this operation');
    }

    const rows = await db
      .select({
        serialNumber: dbSchema.userBoardSerials.serialNumber,
        boardName: dbSchema.userBoardSerials.boardName,
        layoutId: dbSchema.userBoardSerials.layoutId,
        sizeId: dbSchema.userBoardSerials.sizeId,
        setIds: dbSchema.userBoardSerials.setIds,
        apiLevel: dbSchema.userBoardSerials.apiLevel,
        updatedAt: dbSchema.userBoardSerials.updatedAt,
        boardUuid: dbSchema.userBoardSerials.boardUuid,
        boardSlug: dbSchema.userBoards.slug,
      })
      .from(dbSchema.userBoardSerials)
      .leftJoin(
        dbSchema.userBoards,
        and(eq(dbSchema.userBoards.uuid, dbSchema.userBoardSerials.boardUuid), isNull(dbSchema.userBoards.deletedAt)),
      )
      .where(
        and(eq(dbSchema.userBoardSerials.userId, userId), inArray(dbSchema.userBoardSerials.serialNumber, cleaned)),
      );

    return rows.map((row) => ({
      serialNumber: row.serialNumber,
      boardName: row.boardName,
      layoutId: Number(row.layoutId),
      sizeId: Number(row.sizeId),
      setIds: row.setIds,
      apiLevel: row.apiLevel,
      updatedAt: row.updatedAt.toISOString(),
      boardUuid: row.boardUuid,
      boardSlug: row.boardSlug,
    }));
  },

  /**
   * Get current user's boards (owned + followed)
   */
  myBoards: async (_: unknown, { input }: { input?: { limit?: number; offset?: number } }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    const validatedInput = validateInput(MyBoardsInputSchema, input || {}, 'input');
    const userId = ctx.userId!;
    const limit = validatedInput.limit ?? 20;
    const offset = validatedInput.offset ?? 0;

    // Get UUIDs of boards the user follows
    const followedBoardUuids = await db
      .select({ boardUuid: dbSchema.boardFollows.boardUuid })
      .from(dbSchema.boardFollows)
      .where(eq(dbSchema.boardFollows.userId, userId));

    const followedUuids = followedBoardUuids.map((f) => f.boardUuid);

    // Build WHERE: owned OR followed, and not deleted
    const ownerCondition = eq(dbSchema.userBoards.ownerId, userId);
    const followedCondition = followedUuids.length > 0 ? inArray(dbSchema.userBoards.uuid, followedUuids) : undefined;
    const matchCondition = followedCondition ? or(ownerCondition, followedCondition)! : ownerCondition;
    const whereClause = and(matchCondition, isNull(dbSchema.userBoards.deletedAt));

    const [countResult] = await db.select({ count: count() }).from(dbSchema.userBoards).where(whereClause);

    const totalCount = Number(countResult?.count || 0);

    const boards = await db
      .select()
      .from(dbSchema.userBoards)
      .where(whereClause)
      .orderBy(desc(dbSchema.userBoards.isOwned), desc(dbSchema.userBoards.createdAt))
      .limit(limit)
      .offset(offset);

    const enrichedBoards = await enrichBoards(
      boards.map((b) => ({ board: b })),
      userId,
    );

    return {
      boards: enrichedBoards,
      totalCount,
      hasMore: offset + boards.length < totalCount,
    };
  },

  /**
   * Search public boards
   */
  searchBoards: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    await applyRateLimit(ctx, 20, 'searchBoards');
    const validatedInput = validateInput(SearchBoardsInputSchema, input, 'input');
    const { query, boardType, boardTypes, layoutIds, sizeIds, latitude, longitude, radiusKm } = validatedInput;
    const limit = validatedInput.limit ?? 20;
    const offset = validatedInput.offset ?? 0;
    const useProximity = latitude !== undefined && longitude !== undefined;

    if (useProximity) {
      // PostGIS proximity search path using Drizzle query builder
      const radiusMeters = (radiusKm ?? 1) * 1000;
      const lon = Number(longitude);
      const lat = Number(latitude);

      const userPoint = sql`ST_MakePoint(${lon}, ${lat})::geography`;
      // "location" is a PostGIS geography column added via raw migration, not in the Drizzle schema
      const locationCol = sql`${dbSchema.userBoards}.location`;
      const distanceMeters = sql<number>`ST_Distance(${locationCol}, ${userPoint})`.as('distance_meters');

      // Build shared WHERE conditions
      const conditions = [
        eq(dbSchema.userBoards.isPublic, true),
        eq(dbSchema.userBoards.isUnlisted, false),
        isNull(dbSchema.userBoards.deletedAt),
        sql`${locationCol} IS NOT NULL`,
        sql`ST_DWithin(${locationCol}, ${userPoint}, ${radiusMeters})`,
        // Hide boards with hideLocation=true unless the board owner follows the searching user
        sql`(${dbSchema.userBoards.hideLocation} = false${
          ctx.isAuthenticated
            ? sql` OR EXISTS (
                SELECT 1 FROM user_follows
                WHERE follower_id = ${dbSchema.userBoards.ownerId}
                AND following_id = ${ctx.userId}
              )`
            : sql``
        })`,
      ];

      if (boardType) {
        conditions.push(eq(dbSchema.userBoards.boardType, boardType));
      }
      if (boardTypes && boardTypes.length > 0) {
        conditions.push(inArray(dbSchema.userBoards.boardType, boardTypes));
      }
      if (layoutIds && layoutIds.length > 0) {
        conditions.push(inArray(dbSchema.userBoards.layoutId, layoutIds));
      }
      if (sizeIds && sizeIds.length > 0) {
        conditions.push(inArray(dbSchema.userBoards.sizeId, sizeIds));
      }
      if (query) {
        const escapedQuery = query.replace(/[%_\\]/g, '\\$&');
        conditions.push(
          or(
            ilike(dbSchema.userBoards.name, `%${escapedQuery}%`),
            ilike(dbSchema.userBoards.locationName, `%${escapedQuery}%`),
          )!,
        );
      }

      const whereClause = and(...conditions);

      const [countResult] = await db.select({ count: count() }).from(dbSchema.userBoards).where(whereClause);

      const totalCount = Number(countResult?.count || 0);

      const boards = await db
        .select({
          board: dbSchema.userBoards,
          distanceMeters,
        })
        .from(dbSchema.userBoards)
        .where(whereClause)
        .orderBy(sql`distance_meters ASC`)
        .limit(limit)
        .offset(offset);

      const enrichedBoards = await enrichBoards(
        boards.map(({ board, distanceMeters: dist }) => ({ board, distanceMeters: dist })),
        ctx.isAuthenticated ? ctx.userId : undefined,
      );

      return {
        boards: enrichedBoards,
        totalCount,
        hasMore: offset + enrichedBoards.length < totalCount,
      };
    }

    // Text-only search path (no proximity)
    const conditions = [
      eq(dbSchema.userBoards.isPublic, true),
      eq(dbSchema.userBoards.isUnlisted, false),
      isNull(dbSchema.userBoards.deletedAt),
    ];

    if (boardType) {
      conditions.push(eq(dbSchema.userBoards.boardType, boardType));
    }

    if (boardTypes && boardTypes.length > 0) {
      conditions.push(inArray(dbSchema.userBoards.boardType, boardTypes));
    }

    if (layoutIds && layoutIds.length > 0) {
      conditions.push(inArray(dbSchema.userBoards.layoutId, layoutIds));
    }

    if (sizeIds && sizeIds.length > 0) {
      conditions.push(inArray(dbSchema.userBoards.sizeId, sizeIds));
    }

    if (query) {
      // Escape SQL LIKE wildcards to prevent wildcard injection
      const escapedQuery = query.replace(/[%_\\]/g, '\\$&');
      conditions.push(
        or(
          ilike(dbSchema.userBoards.name, `%${escapedQuery}%`),
          ilike(dbSchema.userBoards.locationName, `%${escapedQuery}%`),
        )!,
      );
    }

    const whereClause = and(...conditions);

    const [countResult] = await db.select({ count: count() }).from(dbSchema.userBoards).where(whereClause);

    const totalCount = Number(countResult?.count || 0);

    const boards = await db
      .select()
      .from(dbSchema.userBoards)
      .where(whereClause)
      .orderBy(desc(dbSchema.userBoards.createdAt))
      .limit(limit)
      .offset(offset);

    const enrichedBoards = await enrichBoards(
      boards.map((b) => ({ board: b })),
      ctx.isAuthenticated ? ctx.userId : undefined,
    );

    return {
      boards: enrichedBoards,
      totalCount,
      hasMore: offset + boards.length < totalCount,
    };
  },

  /**
   * Get popular board configurations ranked by climb count
   */
  popularBoardConfigs: async (_: unknown, { input }: { input?: unknown }, _ctx: ConnectionContext) => {
    const validatedInput = validateInput(PopularBoardConfigsInputSchema, input || {}, 'input');
    const { boardType, limit, offset } = validatedInput;

    const allConfigs = await getPopularConfigs();

    // Apply optional board type filter
    const filtered = boardType ? allConfigs.filter((c) => c.boardType === boardType) : allConfigs;

    const totalCount = filtered.length;
    const paginated = filtered.slice(offset, offset + limit);

    return {
      configs: paginated,
      totalCount,
      hasMore: offset + paginated.length < totalCount,
    };
  },

  /**
   * Get leaderboard for a board.
   *
   * Auth-optional: same shared, leaderboard-style data as `boardHistory` /
   * `boardPresenceStats`, so anonymous callers may read a public / system-shared
   * board's leaderboard (`requireAnonReadableBoard`); a private board is masked
   * as NOT_FOUND for them, same as a nonexistent board. This gate + the rate
   * limit were previously missing entirely (any caller could query any board's
   * leaderboard unbounded) — both are added here alongside the anon-read work.
   */
  boardLeaderboard: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    await applyRateLimit(ctx, 60, 'boardLeaderboard');
    const validatedInput = validateInput(BoardLeaderboardInputSchema, input, 'input');
    const { boardUuid, period } = validatedInput;
    const limit = validatedInput.limit ?? 20;
    const offset = validatedInput.offset ?? 0;

    // Get the board
    const [board] = await db
      .select({ id: dbSchema.userBoards.id })
      .from(dbSchema.userBoards)
      .where(and(eq(dbSchema.userBoards.uuid, boardUuid), isNull(dbSchema.userBoards.deletedAt)))
      .limit(1);

    if (!board) {
      // GraphQLError with NOT_FOUND (not a plain Error, which the HTTP layer
      // masks to a generic INTERNAL_SERVER_ERROR) so a missing board and a
      // private board (masked by requireAnonReadableBoard below) are
      // indistinguishable on the wire — a plain Error here would let an
      // anonymous caller use the error shape as an existence oracle.
      throw new GraphQLError('Board not found', { extensions: { code: 'NOT_FOUND' } });
    }

    // Anonymous callers only read public / system-shared boards' leaderboards.
    await requireAnonReadableBoard(board.id, ctx.userId);

    // Build time filter
    let timeFilter;
    let periodLabel = 'All Time';
    if (period === 'day') {
      timeFilter = sql`${dbSchema.boardseshTicks.climbedAt} >= NOW() - INTERVAL '1 day'`;
      periodLabel = 'Today';
    } else if (period === 'week') {
      timeFilter = sql`${dbSchema.boardseshTicks.climbedAt} >= NOW() - INTERVAL '7 days'`;
      periodLabel = 'This Week';
    } else if (period === 'month') {
      timeFilter = sql`${dbSchema.boardseshTicks.climbedAt} >= NOW() - INTERVAL '30 days'`;
      periodLabel = 'This Month';
    } else if (period === 'year') {
      timeFilter = sql`${dbSchema.boardseshTicks.climbedAt} >= NOW() - INTERVAL '365 days'`;
      periodLabel = 'This Year';
    }

    const conditions = [
      eq(dbSchema.boardseshTicks.boardId, board.id),
      or(eq(dbSchema.boardseshTicks.status, 'flash'), eq(dbSchema.boardseshTicks.status, 'send'))!,
    ];

    if (timeFilter) {
      conditions.push(timeFilter);
    }

    const whereClause = and(...conditions);

    // Get total distinct users
    const [countResult] = await db
      .select({ count: sql<number>`COUNT(DISTINCT ${dbSchema.boardseshTicks.userId})` })
      .from(dbSchema.boardseshTicks)
      .where(whereClause);

    const totalCount = Number(countResult?.count || 0);

    // Get leaderboard entries. `hardestGrade` falls back to the climb's
    // consensus grade when the user didn't attach a personal override (NULL
    // difficulty means "use consensus" — see docs/ascents-and-attempts.md).
    // board_climb_stats joined on its PK so the join doesn't multiply rows.
    const entries = await db
      .select({
        userId: dbSchema.boardseshTicks.userId,
        totalSends: count(),
        totalFlashes: sql<number>`SUM(CASE WHEN ${dbSchema.boardseshTicks.status} = 'flash' THEN 1 ELSE 0 END)`,
        hardestGrade: sql<
          number | null
        >`MAX(COALESCE(${dbSchema.boardseshTicks.difficulty}, ${consensusDifficultyExpr}))`,
        totalSessions: sql<number>`COUNT(DISTINCT DATE(${dbSchema.boardseshTicks.climbedAt}))`,
      })
      .from(dbSchema.boardseshTicks)
      .leftJoin(
        dbSchema.boardClimbStats,
        and(
          eq(dbSchema.boardseshTicks.climbUuid, dbSchema.boardClimbStats.climbUuid),
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardClimbStats.boardType),
          eq(dbSchema.boardseshTicks.angle, dbSchema.boardClimbStats.angle),
        ),
      )
      .where(whereClause)
      .groupBy(dbSchema.boardseshTicks.userId)
      .orderBy(sql`COUNT(*) DESC`)
      .limit(limit)
      .offset(offset);

    // Batch fetch user profiles
    const userIds = entries.map((e) => e.userId);
    const userMap = new Map<string, { displayName?: string; avatarUrl?: string }>();

    if (userIds.length > 0) {
      const users = await db
        .select({
          id: dbSchema.users.id,
          name: dbSchema.users.name,
          image: dbSchema.users.image,
          displayName: dbSchema.userProfiles.displayName,
          avatarUrl: dbSchema.userProfiles.avatarUrl,
        })
        .from(dbSchema.users)
        .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
        .where(inArray(dbSchema.users.id, userIds));

      for (const u of users) {
        userMap.set(u.id, {
          displayName: u.displayName || u.name || undefined,
          avatarUrl: u.avatarUrl || u.image || undefined,
        });
      }
    }

    const enrichedEntries = entries.map((entry, idx) => {
      const userInfo = userMap.get(entry.userId);
      return {
        userId: entry.userId,
        userDisplayName: userInfo?.displayName,
        userAvatarUrl: userInfo?.avatarUrl,
        rank: offset + idx + 1,
        totalSends: Number(entry.totalSends),
        totalFlashes: Number(entry.totalFlashes),
        hardestGrade: entry.hardestGrade ? Number(entry.hardestGrade) : null,
        hardestGradeName: null, // TODO: resolve grade name from board-specific grade tables
        totalSessions: Number(entry.totalSessions),
      };
    });

    return {
      boardUuid,
      entries: enrichedEntries,
      totalCount,
      hasMore: offset + entries.length < totalCount,
      periodLabel,
    };
  },

  /**
   * Get the user's default board
   */
  defaultBoard: async (_: unknown, _args: unknown, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    const userId = ctx.userId!;

    // First: try to find an owned board
    const [ownedBoard] = await db
      .select()
      .from(dbSchema.userBoards)
      .where(
        and(
          eq(dbSchema.userBoards.ownerId, userId),
          eq(dbSchema.userBoards.isOwned, true),
          isNull(dbSchema.userBoards.deletedAt),
        ),
      )
      .orderBy(desc(dbSchema.userBoards.createdAt))
      .limit(1);

    if (ownedBoard) {
      return enrichBoard(ownedBoard, userId);
    }

    // Fallback: any board owned by user
    const [anyBoard] = await db
      .select()
      .from(dbSchema.userBoards)
      .where(and(eq(dbSchema.userBoards.ownerId, userId), isNull(dbSchema.userBoards.deletedAt)))
      .orderBy(desc(dbSchema.userBoards.createdAt))
      .limit(1);

    if (anyBoard) {
      return enrichBoard(anyBoard, userId);
    }

    return null;
  },
};

// ============================================
// Mutations
// ============================================

export const socialBoardMutations = {
  /**
   * Record the (serial, board config) the current user was on when connecting
   * to a controller over BLE. Replaces the deleted REST route
   * POST /api/internal/board-serials. Upserts into userBoardSerials keyed by
   * (userId, serialNumber), capturing the API level advertised after the `@` in
   * the device name. Returns the stored recording, or null when the user already
   * has a saved board whose config matches the connect (nothing to record).
   */
  recordBoardSerial: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    // Dedicated `recordBoardSerial` namespace so this 30/min budget is isolated
    // from the shared 'default' bucket. requireAuthenticated already rejects
    // anonymous callers before any DB work, so an unauthenticated flood never
    // reaches here — the per-user limit (in-memory + Redis, keyed on the
    // validated token's userId) replaces the deleted REST route's IP guard,
    // which only existed to throttle that pre-auth path.
    await applyRateLimit(ctx, 30, 'recordBoardSerial');

    const validatedInput = validateInput(RecordBoardSerialInputSchema, input, 'input');
    const userId = ctx.userId!;
    const { serialNumber, boardName, layoutId, sizeId, setIds, apiLevel, boardUuid } = validatedInput;

    // If the user already has a saved board for this controller AND its config
    // matches, the recording adds nothing — skip the write and return null. The
    // saved board stays authoritative for serial→board lookups; recordings only
    // exist to provide a fallback and to detect drift when the configs differ.
    const [savedMatch] = await db
      .select({
        boardType: dbSchema.userBoards.boardType,
        layoutId: dbSchema.userBoards.layoutId,
        sizeId: dbSchema.userBoards.sizeId,
        setIds: dbSchema.userBoards.setIds,
      })
      .from(dbSchema.userBoards)
      .where(
        and(
          eq(dbSchema.userBoards.ownerId, userId),
          // Scoped to the board type this connect reported. The owner may hold
          // both a Kilter and a Tension board on this serial, and an unscoped
          // `.limit(1)` would pick between them arbitrarily — half the time
          // reading the other controller's board, failing the config comparison
          // below and recording a row that adds nothing.
          eq(dbSchema.userBoards.boardType, boardName),
          eq(dbSchema.userBoards.serialNumber, serialNumber),
          isNull(dbSchema.userBoards.deletedAt),
        ),
      )
      .limit(1);

    if (
      savedMatch &&
      savedMatch.boardType === boardName &&
      Number(savedMatch.layoutId) === layoutId &&
      Number(savedMatch.sizeId) === sizeId &&
      normaliseSetIds(savedMatch.setIds) === normaliseSetIds(setIds)
    ) {
      return null;
    }

    // Validate boardUuid before linking: only persist the link if the user can
    // legitimately reach the board (owner or public). A forged/unauthorised uuid
    // is silently dropped to null so it can't attach the controller to someone
    // else's private board.
    let linkedBoardUuid: string | null = null;
    if (boardUuid) {
      const [allowed] = await db
        .select({ uuid: dbSchema.userBoards.uuid })
        .from(dbSchema.userBoards)
        .where(
          and(
            eq(dbSchema.userBoards.uuid, boardUuid),
            isNull(dbSchema.userBoards.deletedAt),
            or(eq(dbSchema.userBoards.ownerId, userId), eq(dbSchema.userBoards.isPublic, true)),
          ),
        )
        .limit(1);
      if (allowed) {
        linkedBoardUuid = boardUuid;
      }
    }

    // Coalesce to an explicit null rather than letting `undefined` fall through.
    // On the insert path the two are equivalent, but in the onConflictDoUpdate
    // `set` below Drizzle omits `undefined` columns from the UPDATE — which would
    // preserve a stale api_level from a previous connect instead of recording
    // what *this* connect observed. The explicit null keeps the row honest.
    const apiLevelValue = apiLevel ?? null;

    // Board row first, pointer row second — the order every other serial-pointer
    // writer follows (pointer healing, serial resolution, the explicit choice,
    // the dedupe merge). Left bare, this upsert takes the (userId, serialNumber)
    // row lock first and only then, in the end-of-statement referential-integrity
    // check on `board_uuid`, asks for FOR KEY SHARE on the referenced user_boards
    // row. Those writers hold that board row FOR UPDATE (which conflicts with KEY
    // SHARE) before they touch the same pointer row, so the two orders close a
    // deadlock cycle and PostgreSQL kills one of them — for the dedupe script,
    // that aborts the whole cluster transaction.
    //
    // Taking the FK's KEY SHARE lock up front puts this path in the shared order.
    // It must NOT instead take the per-serial advisory lock: acquiring the serial
    // before waiting on the board row is the same inversion, just one hop further
    // out. A null `board_uuid` runs no RI check, so it needs no board lock.
    await db.transaction(async (tx) => {
      if (linkedBoardUuid) {
        await tx
          .select({ uuid: dbSchema.userBoards.uuid })
          .from(dbSchema.userBoards)
          .where(eq(dbSchema.userBoards.uuid, linkedBoardUuid))
          .for('key share');
      }

      await tx
        .insert(dbSchema.userBoardSerials)
        .values({
          userId,
          serialNumber,
          boardName,
          layoutId,
          sizeId,
          setIds,
          apiLevel: apiLevelValue,
          boardUuid: linkedBoardUuid,
        })
        .onConflictDoUpdate({
          // Matches `user_board_serials_unique_user_serial`, which carries
          // `board_name`: Aurora reuses a serial across board apps, so a Kilter
          // `#12345` and a Tension `#12345` are separate recordings. Drop the
          // board name here and the upsert stops matching the index — every
          // connect would insert instead of updating.
          target: [
            dbSchema.userBoardSerials.userId,
            dbSchema.userBoardSerials.boardName,
            dbSchema.userBoardSerials.serialNumber,
          ],
          set: {
            boardName,
            layoutId,
            sizeId,
            setIds,
            apiLevel: apiLevelValue,
            boardUuid: linkedBoardUuid,
            updatedAt: new Date(),
          },
        });
    });

    const [row] = await db
      .select({
        serialNumber: dbSchema.userBoardSerials.serialNumber,
        boardName: dbSchema.userBoardSerials.boardName,
        layoutId: dbSchema.userBoardSerials.layoutId,
        sizeId: dbSchema.userBoardSerials.sizeId,
        setIds: dbSchema.userBoardSerials.setIds,
        apiLevel: dbSchema.userBoardSerials.apiLevel,
        updatedAt: dbSchema.userBoardSerials.updatedAt,
        boardUuid: dbSchema.userBoardSerials.boardUuid,
        boardSlug: dbSchema.userBoards.slug,
      })
      .from(dbSchema.userBoardSerials)
      .leftJoin(
        dbSchema.userBoards,
        and(eq(dbSchema.userBoards.uuid, dbSchema.userBoardSerials.boardUuid), isNull(dbSchema.userBoards.deletedAt)),
      )
      .where(
        and(
          eq(dbSchema.userBoardSerials.userId, userId),
          // Same three-part key as the upsert target — without `boardName` this
          // could read back the OTHER board type's recording for the same serial.
          eq(dbSchema.userBoardSerials.boardName, boardName),
          eq(dbSchema.userBoardSerials.serialNumber, serialNumber),
        ),
      )
      .limit(1);

    // The upsert above always writes a row, so the re-select can only come back
    // empty under a concurrent delete of this exact (userId, boardName,
    // serialNumber). Guard
    // it so that race surfaces as a clean GraphQL error instead of an untyped
    // "cannot read property of undefined" crash.
    if (!row) {
      throw new Error('Failed to record board serial');
    }

    return {
      serialNumber: row.serialNumber,
      boardName: row.boardName,
      layoutId: Number(row.layoutId),
      sizeId: Number(row.sizeId),
      setIds: row.setIds,
      apiLevel: row.apiLevel,
      updatedAt: row.updatedAt.toISOString(),
      boardUuid: row.boardUuid,
      boardSlug: row.boardSlug,
    };
  },

  /**
   * Create a new board
   */
  createBoard: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 10, 'createBoard');

    const validatedInput = validateInput(CreateBoardInputSchema, input, 'input');
    await assertKnownBoardConfig(
      validatedInput.boardType,
      validatedInput.layoutId,
      validatedInput.sizeId,
      validatedInput.setIds,
    );
    const userId = ctx.userId!;

    // Before the duplicate guard, so the `allowDuplicateConfig` bypass — the one
    // path that can add unlimited same-config boards — is capped too.
    await assertBoardCapNotReached(userId);

    const incomingLocation = {
      latitude: validatedInput.latitude ?? null,
      longitude: validatedInput.longitude ?? null,
      locationName: validatedInput.locationName ?? null,
    };

    // Reject an accidental re-submit, but never a genuine second board. A config
    // tuple alone doesn't identify a wall — the same MoonBoard 2024 exists at
    // every gym that owns one — so the guard is config AND place, and the user
    // can override it once they've confirmed the two walls really are different
    // (#4166). Set-id equality is settled in JS, not SQL: the stored order is
    // whatever the board was created with, so '25,26,27,24' and '24,25,26,27'
    // are the same board but not the same string.
    if (validatedInput.allowDuplicateConfig) {
      // The guard is skipped only on the user's say-so, so leave a trail: this is
      // the one path that can add an unlimited number of same-config boards, and
      // without a log there'd be nothing separating a genuine two-gym create from
      // a script setting the flag on every call.
      logger.info('createBoard: duplicate-config guard bypassed by explicit confirmation', {
        userId,
        boardType: validatedInput.boardType,
        layoutId: validatedInput.layoutId,
        sizeId: validatedInput.sizeId,
        hasLocation:
          !!validatedInput.locationName || (validatedInput.latitude != null && validatedInput.longitude != null),
      });
    } else {
      const existing = await findOwnedBlockingDuplicate({
        ownerId: userId,
        boardType: validatedInput.boardType,
        layoutId: validatedInput.layoutId,
        sizeId: validatedInput.sizeId,
        incoming: { setIds: validatedInput.setIds, ...incomingLocation },
      });

      if (existing) {
        // The caller is always the owner here, so the full identity is theirs to see.
        throw duplicateBoardConfigError(existing, { includeIdentity: true });
      }
    }

    const uuid = uuidv4();
    const slug = await generateUniqueSlug(validatedInput.name);

    // Resolve the gym this board belongs to. An explicit gymUuid goes through the
    // shared link gate (owner/admin, or a nearby public gym the caller is adding
    // their own board to); otherwise infer one from the location.
    let gymId: number | null = null;
    let mintGymNamed: string | null = null;

    if (validatedInput.gymUuid) {
      const gym = await requireBoardGymLinkAccess({
        ctx,
        gymUuid: validatedInput.gymUuid,
        userId,
        boardLatitude: incomingLocation.latitude,
        boardLongitude: incomingLocation.longitude,
      });
      gymId = gym.id;
    } else {
      const resolution = await resolveAutoGymForBoard({
        userId,
        locationName: incomingLocation.locationName,
        latitude: incomingLocation.latitude,
        longitude: incomingLocation.longitude,
      });
      if (resolution.action === 'attach') {
        gymId = resolution.gymId;
      } else if (resolution.action === 'mint') {
        mintGymNamed = resolution.name;
      }
    }

    // One insert path for every case. The gym mint, when there is one, shares the
    // board's transaction so we never leave a gym with no board behind. Every
    // path — the mint, the mint-failure fallback, and the plain insert — runs
    // inside a transaction because `lockAndAssertBoardSerialAvailable` has to
    // hold the serial's advisory lock across BOTH its guard read and the insert.
    // An insert outside one reopens the cross-owner duplicate-serial race the
    // guard exists to close (#3407). The PostGIS writes deliberately sit OUTSIDE
    // the transaction — see below.
    let board: typeof dbSchema.userBoards.$inferSelect;
    let mintedGymId: number | null = null;

    const boardValues = {
      uuid,
      slug,
      ownerId: userId,
      boardType: validatedInput.boardType,
      layoutId: validatedInput.layoutId,
      sizeId: validatedInput.sizeId,
      setIds: validatedInput.setIds,
      name: validatedInput.name,
      description: validatedInput.description ?? null,
      locationName: incomingLocation.locationName,
      latitude: incomingLocation.latitude,
      longitude: incomingLocation.longitude,
      isPublic: validatedInput.isPublic ?? true,
      isUnlisted: validatedInput.isUnlisted ?? false,
      hideLocation: validatedInput.hideLocation ?? false,
      isOwned: validatedInput.isOwned ?? true,
      angle: validatedInput.angle ?? 40,
      isAngleAdjustable: validatedInput.isAngleAdjustable ?? true,
      serialNumber: validatedInput.serialNumber ?? null,
      timerName: validatedInput.timerName ?? null,
    };

    // The ONE way this resolver is allowed to insert a board without a gym mint.
    // Both callers below go through it so neither can drift back into a bare,
    // unlocked insert: the guard has to read and insert under the same serial
    // lock, and the fallback re-runs it because a competing create can commit in
    // the window between the mint's guard and this one.
    const insertGuardedBoard = async (linkedGymId: number | null) => {
      try {
        return await db.transaction(async (tx) => {
          await lockAndAssertBoardSerialAvailable(tx, validatedInput, userId);
          const [insertedBoard] = await tx
            .insert(dbSchema.userBoards)
            .values({ ...boardValues, gymId: linkedGymId })
            .returning();
          return insertedBoard;
        });
      } catch (error) {
        throwIfBoardSerialConflict(error);
        throw error;
      }
    };

    if (mintGymNamed != null) {
      const gymName = mintGymNamed;
      try {
        const gymUuid = uuidv4();
        const gymSlug = await generateUniqueGymSlug(gymName);
        const result = await db.transaction(async (tx) => {
          await lockAndAssertBoardSerialAvailable(tx, validatedInput, userId);

          const [newGym] = await tx
            .insert(dbSchema.gyms)
            .values({
              uuid: gymUuid,
              slug: gymSlug,
              ownerId: userId,
              name: gymName,
              isPublic: validatedInput.isPublic ?? true,
              latitude: incomingLocation.latitude,
              longitude: incomingLocation.longitude,
            })
            .returning();

          const [newBoard] = await tx
            .insert(dbSchema.userBoards)
            .values({ ...boardValues, gymId: newGym.id })
            .returning();

          return { newGym, newBoard };
        });
        mintedGymId = result.newGym.id;
        board = result.newBoard;
      } catch (error) {
        throwIfBoardSerialConflict(error);
        // The serial guard is a product decision, not an auto-gym failure. Never
        // swallow it and retry the insert below — that fallback would create the
        // very cross-owner duplicate the guard just refused.
        if (error instanceof GraphQLError && error.extensions.code === 'BOARD_SERIAL_EXISTS') throw error;
        // The gym couldn't be minted; still create the board, unlinked, rather
        // than failing the whole create.
        logger.error('Auto-gym creation failed, creating board without gym:', error);
        board = await insertGuardedBoard(null);
      }
    } else {
      board = await insertGuardedBoard(gymId);
    }

    // Populate the PostGIS `location` columns. These run AFTER the transaction,
    // each guarded on its own inside syncLocationGeography — see that helper for
    // why a failure here must never fail the mutation.
    if (incomingLocation.latitude != null && incomingLocation.longitude != null) {
      const { latitude, longitude } = incomingLocation;

      if (mintedGymId != null) {
        await syncLocationGeography({
          table: 'gyms',
          id: mintedGymId,
          latitude,
          longitude,
          operation: 'createBoard',
        });
      }

      await syncLocationGeography({
        table: 'user_boards',
        id: board.id,
        latitude,
        longitude,
        operation: 'createBoard',
      });
    }

    return enrichBoard(board, userId);
  },

  /**
   * Update a board's metadata
   */
  updateBoard: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'updateBoard');

    const validatedInput = validateInput(UpdateBoardInputSchema, input, 'input');
    const userId = ctx.userId!;

    const [board] = await db
      .select()
      .from(dbSchema.userBoards)
      .where(eq(dbSchema.userBoards.uuid, validatedInput.boardUuid))
      .limit(1);

    if (!board) {
      throw new Error('Board not found');
    }

    // A soft-deleted board is visible only to its owner (who can restore it by
    // editing). Moderators/gym admins must not resurrect a board the owner
    // deliberately removed — republishing its name, location, and serial.
    if (board.deletedAt && board.ownerId !== userId) {
      throw new Error('Board not found');
    }

    // Owner, community admin/leader (for this board type), or the linked gym's
    // owner/admin may edit. Community moderators can fix outdated catalog boards.
    await requireBoardEditAccess(ctx, board);

    if (!isBoardAngleSupported(board.boardType, validatedInput.angle)) {
      throw new GraphQLError(BOARD_ANGLE_VALIDATION_MESSAGE, {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    // Editing a soft-deleted board restores it (see `updateValues.deletedAt`
    // below), and the cap counts live rows only — so a restore is +1 live board
    // and pays the same toll as a mint. Without this, delete-N/create-N/restore-N
    // walks an account to cap+N. Editing an already-live board never gets here.
    if (board.deletedAt) {
      await assertBoardCapNotReached(board.ownerId);
    }

    // Config field changes (layoutId, sizeId, setIds). Authorized editors may
    // change these even when the board has logged climbs — a config change
    // reflects a real physical reconfiguration. Old boardsesh_ticks rows are
    // left untouched: they keep referencing the climbs/config they were logged
    // against. We do not delete, move, or modify any tick rows here.
    const hasConfigChange =
      validatedInput.layoutId !== undefined ||
      validatedInput.sizeId !== undefined ||
      validatedInput.setIds !== undefined;
    const newLayoutId = validatedInput.layoutId ?? board.layoutId;
    const newSizeId = validatedInput.sizeId ?? board.sizeId;
    const newSetIds = validatedInput.setIds ?? board.setIds;

    if (hasConfigChange) {
      await assertKnownBoardConfig(board.boardType, newLayoutId, newSizeId, newSetIds);
    }

    // Build update values (only provided fields)
    const updateValues: Record<string, unknown> = {
      updatedAt: new Date(),
      // A deliberate human edit — freeze the row so the location sync can never
      // overwrite these curated values (a moderator's catalog fix, say) on its
      // next run.
      syncFrozenAt: new Date(),
    };

    if (validatedInput.name !== undefined) updateValues.name = validatedInput.name;
    if (validatedInput.description !== undefined) updateValues.description = validatedInput.description;
    if (validatedInput.locationName !== undefined) updateValues.locationName = validatedInput.locationName;
    if (validatedInput.latitude !== undefined) updateValues.latitude = validatedInput.latitude;
    if (validatedInput.longitude !== undefined) updateValues.longitude = validatedInput.longitude;
    if (validatedInput.isPublic !== undefined) updateValues.isPublic = validatedInput.isPublic;
    if (validatedInput.isUnlisted !== undefined) updateValues.isUnlisted = validatedInput.isUnlisted;
    if (validatedInput.hideLocation !== undefined) updateValues.hideLocation = validatedInput.hideLocation;
    if (validatedInput.isOwned !== undefined) updateValues.isOwned = validatedInput.isOwned;
    if (validatedInput.angle !== undefined) updateValues.angle = validatedInput.angle;
    if (validatedInput.isAngleAdjustable !== undefined)
      updateValues.isAngleAdjustable = validatedInput.isAngleAdjustable;
    if (validatedInput.serialNumber !== undefined) updateValues.serialNumber = validatedInput.serialNumber;
    if (validatedInput.timerName !== undefined) updateValues.timerName = validatedInput.timerName;

    if (hasConfigChange) {
      // The clients resend layout/size/setIds on every edit whenever the config
      // section is unlocked, so `hasConfigChange` says "config fields were
      // present", not "the config moved". Compare the effective values —
      // set ids normalised, since the stored order is whatever the board was
      // created with — and skip the guard when nothing actually changed.
      // Without this skip, an owner of two same-config boards could never save
      // ANY edit to either one: renaming a board would be rejected for
      // colliding with its sibling.
      const configActuallyChanged =
        newLayoutId !== board.layoutId ||
        newSizeId !== board.sizeId ||
        normaliseSetIds(newSetIds) !== normaliseSetIds(board.setIds);

      // Keyed off the board's OWNER, not the caller — a moderator or gym admin
      // may be editing someone else's board. The system catalog owner is exempt:
      // many gyms legitimately share one config there, and blocking that would
      // break the catalog fixes moderation exists for.
      if (configActuallyChanged && board.ownerId !== SYSTEM_BOARD_OWNER_ID) {
        if (validatedInput.allowDuplicateConfig) {
          // Same trail as createBoard: this is the one path that lets an edit
          // land on a config the owner already has at the same place, so record
          // that a human confirmed it rather than leaving it indistinguishable
          // from a script setting the flag on every call.
          logger.info('updateBoard: duplicate-config guard bypassed by explicit confirmation', {
            userId,
            boardId: board.id,
            ownerId: board.ownerId,
            boardType: board.boardType,
            layoutId: newLayoutId,
            sizeId: newSizeId,
          });
        } else {
          // Probe with the POST-update location, so an edit that moves this
          // board onto a sibling's site is caught and one that moves it away is
          // allowed. A location-only edit is deliberately NOT guarded at all
          // (it never reaches here): as with createBoard after #4166, we block
          // the accident of re-submitting a wall, not every way two rows can end
          // up looking alike.
          const existing = await findOwnedBlockingDuplicate({
            ownerId: board.ownerId,
            boardType: board.boardType,
            layoutId: newLayoutId,
            sizeId: newSizeId,
            excludeBoardId: board.id,
            incoming: {
              setIds: newSetIds,
              locationName:
                validatedInput.locationName !== undefined ? validatedInput.locationName : board.locationName,
              latitude: validatedInput.latitude !== undefined ? validatedInput.latitude : board.latitude,
              longitude: validatedInput.longitude !== undefined ? validatedInput.longitude : board.longitude,
            },
          });

          if (existing) {
            // The colliding board belongs to this board's OWNER. A gym admin or
            // community moderator editing someone else's board gets the bare
            // rejection code — enough to render "this config is taken", nothing
            // that names or locates a board they have no read access to.
            throw duplicateBoardConfigError(existing, { includeIdentity: board.ownerId === userId });
          }
        }
      }

      if (validatedInput.layoutId !== undefined) updateValues.layoutId = validatedInput.layoutId;
      if (validatedInput.sizeId !== undefined) updateValues.sizeId = validatedInput.sizeId;
      if (validatedInput.setIds !== undefined) updateValues.setIds = validatedInput.setIds;
    }

    // Handle slug update
    if (validatedInput.slug !== undefined) {
      // Check slug uniqueness
      const [slugConflict] = await db
        .select({ id: dbSchema.userBoards.id })
        .from(dbSchema.userBoards)
        .where(
          and(
            eq(dbSchema.userBoards.slug, validatedInput.slug),
            isNull(dbSchema.userBoards.deletedAt),
            sql`${dbSchema.userBoards.id} != ${board.id}`,
          ),
        )
        .limit(1);

      if (slugConflict) {
        throw new Error('Slug is already taken');
      }
      updateValues.slug = validatedInput.slug;
    }

    // If board was soft-deleted, restore it
    if (board.deletedAt) {
      updateValues.deletedAt = null;
    }

    let updated: typeof dbSchema.userBoards.$inferSelect;
    try {
      const updatedRows = await db.transaction(async (tx) => {
        // Serialize partial edits to the same board before deriving the final
        // serial+config tuple. Without this row lock, a serial-only edit could
        // validate against C1 while a concurrent config-only edit changes the
        // row to C2, producing an unchecked S+C2 duplicate.
        const [lockedBoard] = rowsFromResult<{
          serialNumber: string | null;
          boardType: string;
          layoutId: number | string;
          sizeId: number | string;
          setIds: string;
          deletedAt: Date | null;
        }>(
          await tx.execute(sql`
            SELECT serial_number AS "serialNumber",
                   board_type AS "boardType",
                   layout_id AS "layoutId",
                   size_id AS "sizeId",
                   set_ids AS "setIds",
                   deleted_at AS "deletedAt"
              FROM user_boards
             WHERE id = ${board.id}
             FOR UPDATE
          `),
        );
        if (!lockedBoard) {
          throw new Error('Board not found');
        }

        const lockedLayoutId = Number(lockedBoard.layoutId);
        const lockedSizeId = Number(lockedBoard.sizeId);
        const resultingSerial =
          validatedInput.serialNumber === undefined ? lockedBoard.serialNumber : validatedInput.serialNumber;
        const serialChanged =
          validatedInput.serialNumber !== undefined && validatedInput.serialNumber !== lockedBoard.serialNumber;
        const serialConfigChanged =
          (validatedInput.layoutId !== undefined && validatedInput.layoutId !== lockedLayoutId) ||
          (validatedInput.sizeId !== undefined && validatedInput.sizeId !== lockedSizeId) ||
          (validatedInput.setIds !== undefined &&
            normaliseSetIds(validatedInput.setIds) !== normaliseSetIds(lockedBoard.setIds));
        const serialOrConfigBecomesActive =
          resultingSerial !== null && (serialChanged || serialConfigChanged || lockedBoard.deletedAt !== null);

        if (serialOrConfigBecomesActive) {
          await lockAndAssertBoardSerialAvailable(
            tx,
            {
              serialNumber: resultingSerial,
              boardType: lockedBoard.boardType,
              layoutId: validatedInput.layoutId ?? lockedLayoutId,
              sizeId: validatedInput.sizeId ?? lockedSizeId,
              setIds: validatedInput.setIds ?? lockedBoard.setIds,
            },
            board.ownerId,
            board.id,
          );
        }
        return tx.update(dbSchema.userBoards).set(updateValues).where(eq(dbSchema.userBoards.id, board.id)).returning();
      });
      [updated] = updatedRows;
    } catch (error) {
      throwIfBoardSerialConflict(error);
      throw error;
    }

    // A public→private flip takes the board out of the anon-readable set, so
    // the board-queue-preview producer goes quiet — public kiosks would keep
    // rendering the last snapshot forever. Clear them with a tombstone.
    // The "was previously anon-readable" gate lives HERE, on the pre-update
    // row we already hold: a board that was never anon-readable must not get a
    // publish on its channel at all (that alone would leak "something changed
    // here" to anyone who guessed the board id). System-owned boards stay
    // anon-readable regardless of isPublic, so a flip there is not a
    // transition and must not blank their kiosks.
    if (
      board.isPublic &&
      validatedInput.isPublic === false &&
      !board.deletedAt &&
      board.ownerId !== SYSTEM_BOARD_OWNER_ID
    ) {
      try {
        await publishBoardQueuePreviewTombstoneForBoard(board.id);
      } catch (error) {
        // A pubsub hiccup must never fail the edit itself — the kiosk clears
        // on its next reconnect/seed instead.
        logger.warn('Failed to publish board queue preview tombstone on private flip', {
          boardId: board.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Update PostGIS location column (guarded — see syncLocationGeography)
    if (validatedInput.latitude !== undefined || validatedInput.longitude !== undefined) {
      await syncLocationGeography({
        table: 'user_boards',
        id: updated.id,
        latitude: validatedInput.latitude ?? updated.latitude,
        longitude: validatedInput.longitude ?? updated.longitude,
        operation: 'updateBoard',
      });
    }

    return enrichBoard(updated, userId);
  },

  /**
   * Soft-delete a board
   */
  deleteBoard: async (_: unknown, { boardUuid }: { boardUuid: string }, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 10, 'deleteBoard');

    validateInput(UUIDSchema, boardUuid, 'boardUuid');
    const userId = ctx.userId!;

    const [board] = await db
      .select({
        id: dbSchema.userBoards.id,
        ownerId: dbSchema.userBoards.ownerId,
        isPublic: dbSchema.userBoards.isPublic,
      })
      .from(dbSchema.userBoards)
      .where(and(eq(dbSchema.userBoards.uuid, boardUuid), isNull(dbSchema.userBoards.deletedAt)))
      .limit(1);

    if (!board) {
      throw new Error('Board not found');
    }

    if (board.ownerId !== userId) {
      throw new Error('Not authorized to delete this board');
    }

    // Freeze it too, so a later sync can't resurrect the board the owner
    // deliberately removed (the board upsert clears deletedAt).
    await db
      .update(dbSchema.userBoards)
      .set({ deletedAt: new Date(), syncFrozenAt: new Date() })
      .where(eq(dbSchema.userBoards.id, board.id));

    // Same reasoning as the public→private flip in updateBoard: a soft-deleted
    // board drops out of the anon-readable set, so the preview producer goes
    // quiet and kiosks would keep the last snapshot. Gate on the pre-delete
    // row's anon-readability (a private board's channel never carried a
    // snapshot, and publishing on it would leak the deletion's timing).
    // `isPublic` alone is the whole gate: the other half of
    // `isBoardAnonReadable` — system-owned boards — is unreachable here,
    // because the ownership check above only lets the authenticated owner
    // through and nobody can authenticate as the synthetic system owner.
    if (board.isPublic) {
      try {
        await publishBoardQueuePreviewTombstoneForBoard(board.id);
      } catch (error) {
        logger.warn('Failed to publish board queue preview tombstone on board delete', {
          boardId: board.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return true;
  },

  /**
   * Follow a board
   */
  followBoard: async (
    _: unknown,
    { input }: { input: { boardUuid: string } },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'followBoard');

    const validatedInput = validateInput(FollowBoardInputSchema, input, 'input');
    const userId = ctx.userId!;

    return db.transaction(
      async (tx) => {
        // Keep the active-row check and follow insert under one shared board
        // lock. Concurrent followers can share it, while merge/privacy/delete
        // writers must either finish first or wait until this follow commits.
        const [board] = await tx
          .select({
            uuid: dbSchema.userBoards.uuid,
            ownerId: dbSchema.userBoards.ownerId,
            isPublic: dbSchema.userBoards.isPublic,
          })
          .from(dbSchema.userBoards)
          .where(and(eq(dbSchema.userBoards.uuid, validatedInput.boardUuid), isNull(dbSchema.userBoards.deletedAt)))
          .limit(1)
          .for('share');

        if (!board) {
          throw new Error('Board not found');
        }

        if (!board.isPublic && board.ownerId !== userId) {
          throw new Error('Cannot follow a private board');
        }

        await tx
          .insert(dbSchema.boardFollows)
          .values({
            userId,
            boardUuid: board.uuid,
          })
          .onConflictDoNothing();

        return true;
      },
      { isolationLevel: 'read committed' },
    );
  },

  /**
   * Unfollow a board
   */
  unfollowBoard: async (
    _: unknown,
    { input }: { input: { boardUuid: string } },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'unfollowBoard');

    const validatedInput = validateInput(FollowBoardInputSchema, input, 'input');
    const userId = ctx.userId!;

    await db
      .delete(dbSchema.boardFollows)
      .where(
        and(eq(dbSchema.boardFollows.userId, userId), eq(dbSchema.boardFollows.boardUuid, validatedInput.boardUuid)),
      );

    return true;
  },
};
