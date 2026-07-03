import { v4 as uuidv4 } from 'uuid';
import { eq, and, count, isNull, sql, ilike, or, desc, inArray, type SQL } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { rowsFromResult } from '@boardsesh/db/client';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';
import { getUserCommunityRoles, rolesGrantAdminOrLeader } from './roles';
import {
  CreateGymInputSchema,
  UpdateGymInputSchema,
  AddGymMemberInputSchema,
  RemoveGymMemberInputSchema,
  FollowGymInputSchema,
  MyGymsInputSchema,
  SearchGymsInputSchema,
  GymMembersInputSchema,
  LinkBoardToGymInputSchema,
  GrantGymWriteAccessInputSchema,
  RevokeGymWriteAccessInputSchema,
  UUIDSchema,
} from '../../../validation/schemas';

// ============================================
// Helpers
// ============================================

/**
 * Generate a unique slug from a gym name.
 * Exported for reuse in board auto-gym creation.
 */
export async function generateUniqueGymSlug(name: string): Promise<string> {
  const baseSlug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 100) || 'gym';

  // Find all existing slugs matching this base in a single query
  const existing = await db
    .select({ slug: dbSchema.gyms.slug })
    .from(dbSchema.gyms)
    .where(
      and(
        or(eq(dbSchema.gyms.slug, baseSlug), ilike(dbSchema.gyms.slug, `${baseSlug.replace(/[%_\\]/g, '\\$&')}-%`)),
        isNull(dbSchema.gyms.deletedAt),
      ),
    );

  const existingSlugs = new Set(existing.map((r) => r.slug));

  if (!existingSlugs.has(baseSlug)) {
    return baseSlug;
  }

  for (let i = 2; i <= 100; i++) {
    const candidateSlug = `${baseSlug}-${i}`;
    if (!existingSlugs.has(candidateSlug)) {
      return candidateSlug;
    }
  }

  return `${baseSlug}-${uuidv4().slice(0, 8)}`;
}

/**
 * Map a raw SQL row (snake_case columns) to the Drizzle gym schema shape.
 * Used for PostGIS proximity queries that bypass the Drizzle query builder.
 */
function mapRawGymRow(row: Record<string, unknown>): typeof dbSchema.gyms.$inferSelect {
  return {
    id: row.id as number,
    uuid: row.uuid as string,
    name: row.name as string,
    slug: (row.slug as string | null) ?? null,
    ownerId: row.owner_id as string,
    address: (row.address as string | null) ?? null,
    website: (row.website as string | null) ?? null,
    contactEmail: (row.contact_email as string | null) ?? null,
    contactPhone: (row.contact_phone as string | null) ?? null,
    latitude: row.latitude != null ? Number(row.latitude) : null,
    longitude: row.longitude != null ? Number(row.longitude) : null,
    isPublic: row.is_public as boolean,
    description: (row.description as string | null) ?? null,
    imageUrl: (row.image_url as string | null) ?? null,
    // Raw `db.execute` returns timestamps as strings (the Drizzle query builder
    // hydrates them to Date). Coerce here so downstream `.toISOString()` works
    // regardless of which path produced the row. `new Date(Date)` is a no-op, so
    // this is safe even if the driver ever returns Date objects.
    createdAt: row.created_at != null ? new Date(row.created_at as string) : (null as unknown as Date),
    updatedAt: row.updated_at != null ? new Date(row.updated_at as string) : (null as unknown as Date),
    deletedAt: row.deleted_at != null ? new Date(row.deleted_at as string) : null,
  };
}

/**
 * Enrich a gym row with computed fields (counts, follow status, membership).
 */
async function enrichGym(gym: typeof dbSchema.gyms.$inferSelect, authenticatedUserId?: string) {
  const [
    ownerResult,
    boardCountResult,
    boardTypesResult,
    memberCountResult,
    followerCountResult,
    commentCountResult,
    followCheckResult,
    memberCheckResult,
    viewerRolesResult,
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
      .where(eq(dbSchema.users.id, gym.ownerId))
      .limit(1),

    // Count linked boards
    db
      .select({ count: count() })
      .from(dbSchema.userBoards)
      .where(and(eq(dbSchema.userBoards.gymId, gym.id), isNull(dbSchema.userBoards.deletedAt))),

    // Distinct board types at this gym (for filtering + badges)
    db
      .selectDistinct({ boardType: dbSchema.userBoards.boardType })
      .from(dbSchema.userBoards)
      .where(and(eq(dbSchema.userBoards.gymId, gym.id), isNull(dbSchema.userBoards.deletedAt))),

    // Count members
    db.select({ count: count() }).from(dbSchema.gymMembers).where(eq(dbSchema.gymMembers.gymId, gym.id)),

    // Count followers
    db.select({ count: count() }).from(dbSchema.gymFollows).where(eq(dbSchema.gymFollows.gymId, gym.id)),

    // Count comments
    db
      .select({ count: count() })
      .from(dbSchema.comments)
      .where(
        and(
          eq(dbSchema.comments.entityType, 'gym'),
          eq(dbSchema.comments.entityId, gym.uuid),
          isNull(dbSchema.comments.deletedAt),
        ),
      ),

    // Check if authenticated user follows this gym
    authenticatedUserId
      ? db
          .select({ count: count() })
          .from(dbSchema.gymFollows)
          .where(and(eq(dbSchema.gymFollows.userId, authenticatedUserId), eq(dbSchema.gymFollows.gymId, gym.id)))
      : Promise.resolve([]),

    // Check if authenticated user is a member
    authenticatedUserId
      ? db
          .select({ role: dbSchema.gymMembers.role })
          .from(dbSchema.gymMembers)
          .where(and(eq(dbSchema.gymMembers.userId, authenticatedUserId), eq(dbSchema.gymMembers.gymId, gym.id)))
          .limit(1)
      : Promise.resolve([]),

    // Viewer's community roles (for canEdit: a community admin/leader scoped to
    // one of the gym's board types, or global, may edit the gym)
    authenticatedUserId ? getUserCommunityRoles(authenticatedUserId) : Promise.resolve([]),
  ]);

  const ownerInfo = ownerResult[0];
  const boardCount = Number(boardCountResult[0]?.count || 0);
  const boardTypes = boardTypesResult.map((row) => row.boardType);
  const memberCount = Number(memberCountResult[0]?.count || 0);
  const followerCount = Number(followerCountResult[0]?.count || 0);
  const commentCount = Number(commentCountResult[0]?.count || 0);
  const isFollowedByMe = Number(followCheckResult[0]?.count || 0) > 0;

  // Determine membership: owner is always a member with "admin" implied
  const isOwner = authenticatedUserId === gym.ownerId;
  const memberRow = (memberCheckResult as Array<{ role: string }>)[0];
  const isMember = isOwner || !!memberRow;
  const myRole = isOwner ? 'admin' : ((memberRow?.role as 'admin' | 'editor' | 'member' | undefined) ?? null);

  // A community admin/leader whose role is global or scoped to one of the gym's
  // board types. Drives both edit and grant permissions below.
  const viewerRoles = viewerRolesResult as Array<{ role: string; boardType: string | null }>;
  const hasCommunityAccess =
    rolesGrantAdminOrLeader(viewerRoles, null) ||
    boardTypes.some((boardType) => rolesGrantAdminOrLeader(viewerRoles, boardType));

  // Editable by gym owner/admin/editor, or a covering community admin/leader.
  const canEdit = isOwner || memberRow?.role === 'admin' || memberRow?.role === 'editor' || hasCommunityAccess;
  // Grantable (write-access grants) by owner/gym-admin or a covering community
  // admin/leader — NOT plain editors. Mirrors requireGymGrantAccess.
  const canGrantAccess = isOwner || memberRow?.role === 'admin' || hasCommunityAccess;
  // A signed-in viewer who has no edit access can start a claim. Owners, gym
  // admins/editors, and covering community leaders are excluded — they can
  // already edit the gym, so the self-service claim path isn't for them (and the
  // domain path would reject them anyway).
  const canClaim =
    !!authenticatedUserId &&
    !isOwner &&
    memberRow?.role !== 'admin' &&
    memberRow?.role !== 'editor' &&
    !hasCommunityAccess;

  return {
    uuid: gym.uuid,
    slug: gym.slug,
    ownerId: gym.ownerId,
    ownerDisplayName: ownerInfo?.displayName || ownerInfo?.name || undefined,
    ownerAvatarUrl: ownerInfo?.avatarUrl || ownerInfo?.image || undefined,
    name: gym.name,
    description: gym.description,
    address: gym.address,
    website: gym.website,
    contactEmail: gym.contactEmail,
    contactPhone: gym.contactPhone,
    latitude: gym.latitude,
    longitude: gym.longitude,
    isPublic: gym.isPublic,
    imageUrl: gym.imageUrl,
    createdAt: gym.createdAt.toISOString(),
    boardCount,
    boardTypes,
    memberCount,
    followerCount,
    commentCount,
    isFollowedByMe,
    isMember,
    myRole,
    canEdit,
    canGrantAccess,
    canClaim,
  };
}

type GymMemberRole = 'admin' | 'editor' | 'member';

/**
 * Load a gym and the caller's per-gym role (null if not owner/member). Shared
 * building block for the gym gates below.
 */
async function loadGymWithMemberRole(
  gymUuid: string,
  userId: string,
): Promise<{ gym: typeof dbSchema.gyms.$inferSelect; isOwner: boolean; memberRole: GymMemberRole | null }> {
  const [gym] = await db
    .select()
    .from(dbSchema.gyms)
    .where(and(eq(dbSchema.gyms.uuid, gymUuid), isNull(dbSchema.gyms.deletedAt)))
    .limit(1);

  if (!gym) {
    throw new Error('Gym not found');
  }

  if (gym.ownerId === userId) {
    return { gym, isOwner: true, memberRole: null };
  }

  const [member] = await db
    .select({ role: dbSchema.gymMembers.role })
    .from(dbSchema.gymMembers)
    .where(and(eq(dbSchema.gymMembers.gymId, gym.id), eq(dbSchema.gymMembers.userId, userId)))
    .limit(1);

  return { gym, isOwner: false, memberRole: (member?.role as GymMemberRole | undefined) ?? null };
}

/**
 * Whether a user holds a community admin/leader role that covers this gym —
 * global (boardType null) or scoped to one of the gym's board types. Shared by
 * the edit + grant gates and mirrored read-side in enrichGym.
 */
async function hasGymCommunityAccess(gym: typeof dbSchema.gyms.$inferSelect, userId: string): Promise<boolean> {
  const [roles, gymBoardTypeRows] = await Promise.all([
    getUserCommunityRoles(userId),
    db
      .selectDistinct({ boardType: dbSchema.userBoards.boardType })
      .from(dbSchema.userBoards)
      .where(and(eq(dbSchema.userBoards.gymId, gym.id), isNull(dbSchema.userBoards.deletedAt))),
  ]);
  const gymBoardTypes = gymBoardTypeRows.map((row) => row.boardType);
  return (
    rolesGrantAdminOrLeader(roles, null) || gymBoardTypes.some((boardType) => rolesGrantAdminOrLeader(roles, boardType))
  );
}

/**
 * Whether a user already has edit access to a gym (owner, gym admin/editor
 * member, or a covering community admin/leader). Exported so the claim flow can
 * refuse the self-service domain path to anyone who can already edit the gym's
 * `website` — otherwise they could rewrite it and self-verify into ownership.
 */
export async function userCanEditGym(gym: typeof dbSchema.gyms.$inferSelect, userId: string): Promise<boolean> {
  if (gym.ownerId === userId) return true;
  const [member] = await db
    .select({ role: dbSchema.gymMembers.role })
    .from(dbSchema.gymMembers)
    .where(and(eq(dbSchema.gymMembers.gymId, gym.id), eq(dbSchema.gymMembers.userId, userId)))
    .limit(1);
  const role = member?.role as GymMemberRole | undefined;
  if (role === 'admin' || role === 'editor') return true;
  return hasGymCommunityAccess(gym, userId);
}

/**
 * Gate for gym MANAGEMENT (add/remove members, link boards): owner or gym admin
 * member only. Community moderators are intentionally excluded here — otherwise
 * a board-type-scoped role could self-promote to a persistent gym admin (a
 * gym_members row that outlives the community role) or evict other admins.
 */
async function requireGymOwnerOrAdmin(gymUuid: string, userId: string): Promise<typeof dbSchema.gyms.$inferSelect> {
  const { gym, isOwner, memberRole } = await loadGymWithMemberRole(gymUuid, userId);
  if (!isOwner && memberRole !== 'admin') {
    throw new Error('Not authorized: must be gym owner or admin');
  }
  return gym;
}

/**
 * Gate for EDITING a gym's own details (updateGym): owner, gym admin member, gym
 * editor member, or a community admin/leader whose role is global or scoped to
 * one of the gym's board types. Mirrors the `canEdit` computation in enrichGym
 * so the edit UI and the mutation agree. Editing details only — never membership.
 */
async function requireGymEditAccess(gymUuid: string, userId: string): Promise<typeof dbSchema.gyms.$inferSelect> {
  const { gym, isOwner, memberRole } = await loadGymWithMemberRole(gymUuid, userId);
  if (isOwner || memberRole === 'admin' || memberRole === 'editor') {
    return gym;
  }
  if (await hasGymCommunityAccess(gym, userId)) {
    return gym;
  }
  throw new Error('Not authorized to edit this gym');
}

/**
 * Gate for GRANTING/REVOKING write access (grant/revokeGymWriteAccess): owner,
 * gym admin member, or a community admin/leader covering the gym. Editors are
 * intentionally NOT grantors — write access can't spread itself.
 */
async function requireGymGrantAccess(gymUuid: string, userId: string): Promise<typeof dbSchema.gyms.$inferSelect> {
  const { gym, isOwner, memberRole } = await loadGymWithMemberRole(gymUuid, userId);
  if (isOwner || memberRole === 'admin') {
    return gym;
  }
  if (await hasGymCommunityAccess(gym, userId)) {
    return gym;
  }
  throw new Error('Not authorized to grant write access for this gym');
}

// ============================================
// Queries
// ============================================

export const socialGymQueries = {
  gym: async (_: unknown, { gymUuid }: { gymUuid: string }, ctx: ConnectionContext) => {
    validateInput(UUIDSchema, gymUuid, 'gymUuid');

    const [gym] = await db
      .select()
      .from(dbSchema.gyms)
      .where(and(eq(dbSchema.gyms.uuid, gymUuid), isNull(dbSchema.gyms.deletedAt)))
      .limit(1);

    if (!gym) return null;
    return enrichGym(gym, ctx.isAuthenticated ? ctx.userId : undefined);
  },

  gymBySlug: async (_: unknown, { slug }: { slug: string }, ctx: ConnectionContext) => {
    if (!slug || slug.length > 120 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) {
      return null;
    }

    const [gym] = await db
      .select()
      .from(dbSchema.gyms)
      .where(and(eq(dbSchema.gyms.slug, slug), isNull(dbSchema.gyms.deletedAt)))
      .limit(1);

    if (!gym) return null;
    return enrichGym(gym, ctx.isAuthenticated ? ctx.userId : undefined);
  },

  myGyms: async (_: unknown, { input }: { input?: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    const validatedInput = validateInput(MyGymsInputSchema, input || {}, 'input');
    const userId = ctx.userId!;
    const limit = validatedInput.limit ?? 20;
    const offset = validatedInput.offset ?? 0;
    const includeFollowed = validatedInput.includeFollowed ?? false;

    // Get IDs of gyms the user follows (if requested)
    let followedGymIds: number[] = [];
    if (includeFollowed) {
      const followedGyms = await db
        .select({ gymId: dbSchema.gymFollows.gymId })
        .from(dbSchema.gymFollows)
        .where(eq(dbSchema.gymFollows.userId, userId));
      followedGymIds = followedGyms.map((f) => f.gymId);
    }

    // Build WHERE: owned OR followed, and not deleted
    const ownerCondition = eq(dbSchema.gyms.ownerId, userId);
    const followedCondition = followedGymIds.length > 0 ? inArray(dbSchema.gyms.id, followedGymIds) : undefined;
    const matchCondition = followedCondition ? or(ownerCondition, followedCondition)! : ownerCondition;
    const whereClause = and(matchCondition, isNull(dbSchema.gyms.deletedAt));

    const [countResult] = await db.select({ count: count() }).from(dbSchema.gyms).where(whereClause);

    const totalCount = Number(countResult?.count || 0);

    const gymRows = await db
      .select()
      .from(dbSchema.gyms)
      .where(whereClause)
      .orderBy(desc(dbSchema.gyms.createdAt))
      .limit(limit)
      .offset(offset);

    const enrichedGyms = await Promise.all(gymRows.map((g) => enrichGym(g, userId)));

    return {
      gyms: enrichedGyms,
      totalCount,
      hasMore: offset + gymRows.length < totalCount,
    };
  },

  searchGyms: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    const validatedInput = validateInput(SearchGymsInputSchema, input, 'input');
    const { query, boardTypes, layoutIds, sizeIds, multiBoardTypeOnly, latitude, longitude, radiusKm } = validatedInput;
    const limit = validatedInput.limit ?? 20;
    const offset = validatedInput.offset ?? 0;
    const useProximity = latitude !== undefined && longitude !== undefined;

    // A board-level match: the gym must own ONE board satisfying every active
    // board filter (type AND layout AND size), so they're ANDed inside a single
    // EXISTS — never separate ones, or a gym could pass by owning a Kilter and a
    // separate 16x10 board. Parameterised by the gym-id expression so the same
    // logic composes into the raw PostGIS SQL (`gyms.id`) and the text-only
    // Drizzle path (`dbSchema.gyms.id`). Returns null when no board filter is set.
    const boardMatchExists = (gymId: SQL): SQL | null => {
      const parts: SQL[] = [];
      if (boardTypes && boardTypes.length > 0) {
        parts.push(
          sql`ub.board_type IN (${sql.join(
            boardTypes.map((boardType) => sql`${boardType}`),
            sql`, `,
          )})`,
        );
      }
      if (layoutIds && layoutIds.length > 0) {
        parts.push(
          sql`ub.layout_id IN (${sql.join(
            layoutIds.map((layoutId) => sql`${layoutId}`),
            sql`, `,
          )})`,
        );
      }
      if (sizeIds && sizeIds.length > 0) {
        parts.push(
          sql`ub.size_id IN (${sql.join(
            sizeIds.map((sizeId) => sql`${sizeId}`),
            sql`, `,
          )})`,
        );
      }
      if (parts.length === 0) return null;
      return sql`EXISTS (SELECT 1 FROM user_boards ub WHERE ub.gym_id = ${gymId} AND ub.deleted_at IS NULL AND ${sql.join(
        parts,
        sql` AND `,
      )})`;
    };

    // A gym-level match: at least two distinct board types present.
    const multiBoardTypeExists = (gymId: SQL): SQL | null =>
      multiBoardTypeOnly
        ? sql`(SELECT count(DISTINCT ub2.board_type) FROM user_boards ub2 WHERE ub2.gym_id = ${gymId} AND ub2.deleted_at IS NULL) > 1`
        : null;

    if (useProximity) {
      const radiusMeters = (radiusKm ?? 50) * 1000;
      const lon = Number(longitude);
      const lat = Number(latitude);

      // Board/gym filters appended to the raw PostGIS WHERE. `gyms.id` is the
      // bare column in this raw query's FROM.
      const proximityFilters = [boardMatchExists(sql`gyms.id`), multiBoardTypeExists(sql`gyms.id`)].filter(
        (clause): clause is SQL => clause !== null,
      );
      const proximityFilterClause =
        proximityFilters.length > 0 ? sql` AND ${sql.join(proximityFilters, sql` AND `)}` : sql.empty();

      const escapedQuery = query ? query.replace(/[%_\\]/g, '\\$&') : null;
      const likePattern = escapedQuery ? `%${escapedQuery}%` : null;

      const countRows = await db.execute(
        likePattern
          ? sql`SELECT count(*)::int as count FROM gyms WHERE is_public = true AND deleted_at IS NULL AND location IS NOT NULL AND ST_DWithin(location, ST_MakePoint(${lon}, ${lat})::geography, ${radiusMeters}) AND (name ILIKE ${likePattern} OR address ILIKE ${likePattern})${proximityFilterClause}`
          : sql`SELECT count(*)::int as count FROM gyms WHERE is_public = true AND deleted_at IS NULL AND location IS NOT NULL AND ST_DWithin(location, ST_MakePoint(${lon}, ${lat})::geography, ${radiusMeters})${proximityFilterClause}`,
      );
      const totalCount = Number(rowsFromResult<Record<string, unknown>>(countRows)[0]?.count || 0);

      const gymRows = await db.execute(
        likePattern
          ? sql`SELECT *, ST_Distance(location, ST_MakePoint(${lon}, ${lat})::geography) as distance_meters FROM gyms WHERE is_public = true AND deleted_at IS NULL AND location IS NOT NULL AND ST_DWithin(location, ST_MakePoint(${lon}, ${lat})::geography, ${radiusMeters}) AND (name ILIKE ${likePattern} OR address ILIKE ${likePattern})${proximityFilterClause} ORDER BY distance_meters ASC LIMIT ${limit} OFFSET ${offset}`
          : sql`SELECT *, ST_Distance(location, ST_MakePoint(${lon}, ${lat})::geography) as distance_meters FROM gyms WHERE is_public = true AND deleted_at IS NULL AND location IS NOT NULL AND ST_DWithin(location, ST_MakePoint(${lon}, ${lat})::geography, ${radiusMeters})${proximityFilterClause} ORDER BY distance_meters ASC LIMIT ${limit} OFFSET ${offset}`,
      );
      const rows = rowsFromResult<Record<string, unknown>>(gymRows);

      const mappedGyms = rows.map(mapRawGymRow);

      const enrichedGyms = await Promise.all(
        mappedGyms.map((g) => enrichGym(g, ctx.isAuthenticated ? ctx.userId : undefined)),
      );

      return {
        gyms: enrichedGyms,
        totalCount,
        hasMore: offset + mappedGyms.length < totalCount,
      };
    }

    // Text-only search path
    const conditions = [eq(dbSchema.gyms.isPublic, true), isNull(dbSchema.gyms.deletedAt)];

    if (query) {
      const escapedQuery = query.replace(/[%_\\]/g, '\\$&');
      conditions.push(
        or(ilike(dbSchema.gyms.name, `%${escapedQuery}%`), ilike(dbSchema.gyms.address, `%${escapedQuery}%`))!,
      );
    }

    const textBoardMatch = boardMatchExists(sql`${dbSchema.gyms.id}`);
    if (textBoardMatch) conditions.push(textBoardMatch);
    const textMultiBoardType = multiBoardTypeExists(sql`${dbSchema.gyms.id}`);
    if (textMultiBoardType) conditions.push(textMultiBoardType);

    const whereClause = and(...conditions);

    const [countResult] = await db.select({ count: count() }).from(dbSchema.gyms).where(whereClause);

    const totalCount = Number(countResult?.count || 0);

    const gymRows = await db
      .select()
      .from(dbSchema.gyms)
      .where(whereClause)
      .orderBy(desc(dbSchema.gyms.createdAt))
      .limit(limit)
      .offset(offset);

    const enrichedGyms = await Promise.all(
      gymRows.map((g) => enrichGym(g, ctx.isAuthenticated ? ctx.userId : undefined)),
    );

    return {
      gyms: enrichedGyms,
      totalCount,
      hasMore: offset + gymRows.length < totalCount,
    };
  },

  gymMembers: async (_: unknown, { input }: { input: unknown }, _ctx: ConnectionContext) => {
    const validatedInput = validateInput(GymMembersInputSchema, input, 'input');
    const { gymUuid } = validatedInput;
    const limit = validatedInput.limit ?? 20;
    const offset = validatedInput.offset ?? 0;

    // Verify gym exists
    const [gym] = await db
      .select({ id: dbSchema.gyms.id, ownerId: dbSchema.gyms.ownerId })
      .from(dbSchema.gyms)
      .where(and(eq(dbSchema.gyms.uuid, gymUuid), isNull(dbSchema.gyms.deletedAt)))
      .limit(1);

    if (!gym) {
      throw new Error('Gym not found');
    }

    const [countResult] = await db
      .select({ count: count() })
      .from(dbSchema.gymMembers)
      .where(eq(dbSchema.gymMembers.gymId, gym.id));

    const totalCount = Number(countResult?.count || 0);

    const members = await db
      .select({
        userId: dbSchema.gymMembers.userId,
        role: dbSchema.gymMembers.role,
        createdAt: dbSchema.gymMembers.createdAt,
        displayName: dbSchema.userProfiles.displayName,
        avatarUrl: dbSchema.userProfiles.avatarUrl,
        userName: dbSchema.users.name,
        userImage: dbSchema.users.image,
      })
      .from(dbSchema.gymMembers)
      .leftJoin(dbSchema.users, eq(dbSchema.gymMembers.userId, dbSchema.users.id))
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.gymMembers.userId, dbSchema.userProfiles.userId))
      .where(eq(dbSchema.gymMembers.gymId, gym.id))
      .orderBy(desc(dbSchema.gymMembers.createdAt))
      .limit(limit)
      .offset(offset);

    const enrichedMembers = members.map((m) => ({
      userId: m.userId,
      displayName: m.displayName || m.userName || undefined,
      avatarUrl: m.avatarUrl || m.userImage || undefined,
      role: m.role,
      createdAt: m.createdAt.toISOString(),
    }));

    return {
      members: enrichedMembers,
      totalCount,
      hasMore: offset + members.length < totalCount,
    };
  },
};

// ============================================
// Mutations
// ============================================

export const socialGymMutations = {
  createGym: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 10, 'createGym');

    const validatedInput = validateInput(CreateGymInputSchema, input, 'input');
    const userId = ctx.userId!;

    const uuid = uuidv4();
    const slug = await generateUniqueGymSlug(validatedInput.name);

    const [gym] = await db
      .insert(dbSchema.gyms)
      .values({
        uuid,
        slug,
        ownerId: userId,
        name: validatedInput.name,
        description: validatedInput.description ?? null,
        address: validatedInput.address ?? null,
        website: validatedInput.website ?? null,
        contactEmail: validatedInput.contactEmail ?? null,
        contactPhone: validatedInput.contactPhone ?? null,
        latitude: validatedInput.latitude ?? null,
        longitude: validatedInput.longitude ?? null,
        isPublic: validatedInput.isPublic ?? true,
        imageUrl: validatedInput.imageUrl ?? null,
      })
      .returning();

    // Populate PostGIS location column if lat/lon provided
    if (validatedInput.latitude != null && validatedInput.longitude != null) {
      await db.execute(
        sql`UPDATE gyms SET location = ST_MakePoint(${validatedInput.longitude}, ${validatedInput.latitude})::geography WHERE id = ${gym.id}`,
      );
    }

    // Optionally link a board
    if (validatedInput.boardUuid) {
      const [board] = await db
        .select({ id: dbSchema.userBoards.id, ownerId: dbSchema.userBoards.ownerId })
        .from(dbSchema.userBoards)
        .where(and(eq(dbSchema.userBoards.uuid, validatedInput.boardUuid), isNull(dbSchema.userBoards.deletedAt)))
        .limit(1);

      if (board && board.ownerId === userId) {
        await db.update(dbSchema.userBoards).set({ gymId: gym.id }).where(eq(dbSchema.userBoards.id, board.id));
      }
    }

    return enrichGym(gym, userId);
  },

  updateGym: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'updateGym');

    const validatedInput = validateInput(UpdateGymInputSchema, input, 'input');
    const userId = ctx.userId!;

    const gym = await requireGymEditAccess(validatedInput.gymUuid, userId);

    const updateValues: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (validatedInput.name !== undefined) updateValues.name = validatedInput.name;
    if (validatedInput.description !== undefined) updateValues.description = validatedInput.description;
    if (validatedInput.address !== undefined) updateValues.address = validatedInput.address;
    if (validatedInput.website !== undefined) updateValues.website = validatedInput.website;
    if (validatedInput.contactEmail !== undefined) updateValues.contactEmail = validatedInput.contactEmail;
    if (validatedInput.contactPhone !== undefined) updateValues.contactPhone = validatedInput.contactPhone;
    if (validatedInput.latitude !== undefined) updateValues.latitude = validatedInput.latitude;
    if (validatedInput.longitude !== undefined) updateValues.longitude = validatedInput.longitude;
    if (validatedInput.isPublic !== undefined) updateValues.isPublic = validatedInput.isPublic;
    if (validatedInput.imageUrl !== undefined) updateValues.imageUrl = validatedInput.imageUrl;

    // Handle slug update
    if (validatedInput.slug !== undefined) {
      const [slugConflict] = await db
        .select({ id: dbSchema.gyms.id })
        .from(dbSchema.gyms)
        .where(
          and(
            eq(dbSchema.gyms.slug, validatedInput.slug),
            isNull(dbSchema.gyms.deletedAt),
            sql`${dbSchema.gyms.id} != ${gym.id}`,
          ),
        )
        .limit(1);

      if (slugConflict) {
        throw new Error('Slug is already taken');
      }
      updateValues.slug = validatedInput.slug;
    }

    const [updated] = await db.update(dbSchema.gyms).set(updateValues).where(eq(dbSchema.gyms.id, gym.id)).returning();

    // Update PostGIS location column
    if (validatedInput.latitude !== undefined || validatedInput.longitude !== undefined) {
      const lat = validatedInput.latitude ?? updated.latitude;
      const lon = validatedInput.longitude ?? updated.longitude;
      if (lat != null && lon != null) {
        await db.execute(
          sql`UPDATE gyms SET location = ST_MakePoint(${lon}, ${lat})::geography WHERE id = ${updated.id}`,
        );
      } else {
        await db.execute(sql`UPDATE gyms SET location = NULL WHERE id = ${updated.id}`);
      }
    }

    return enrichGym(updated, userId);
  },

  deleteGym: async (_: unknown, { gymUuid }: { gymUuid: string }, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 10, 'deleteGym');

    validateInput(UUIDSchema, gymUuid, 'gymUuid');
    const userId = ctx.userId!;

    const [gym] = await db
      .select({ id: dbSchema.gyms.id, ownerId: dbSchema.gyms.ownerId })
      .from(dbSchema.gyms)
      .where(and(eq(dbSchema.gyms.uuid, gymUuid), isNull(dbSchema.gyms.deletedAt)))
      .limit(1);

    if (!gym) {
      throw new Error('Gym not found');
    }

    if (gym.ownerId !== userId) {
      throw new Error('Not authorized to delete this gym');
    }

    // Soft-delete the gym
    await db.update(dbSchema.gyms).set({ deletedAt: new Date() }).where(eq(dbSchema.gyms.id, gym.id));

    // Unlink all boards
    await db.update(dbSchema.userBoards).set({ gymId: null }).where(eq(dbSchema.userBoards.gymId, gym.id));

    return true;
  },

  addGymMember: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'addGymMember');

    const validatedInput = validateInput(AddGymMemberInputSchema, input, 'input');
    const userId = ctx.userId!;

    const gym = await requireGymOwnerOrAdmin(validatedInput.gymUuid, userId);

    // Verify target user exists
    const [targetUser] = await db
      .select({ id: dbSchema.users.id })
      .from(dbSchema.users)
      .where(eq(dbSchema.users.id, validatedInput.userId))
      .limit(1);

    if (!targetUser) {
      throw new Error('User not found');
    }

    await db
      .insert(dbSchema.gymMembers)
      .values({
        gymId: gym.id,
        userId: validatedInput.userId,
        role: validatedInput.role,
      })
      .onConflictDoNothing();

    return true;
  },

  removeGymMember: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'removeGymMember');

    const validatedInput = validateInput(RemoveGymMemberInputSchema, input, 'input');
    const userId = ctx.userId!;

    const gym = await requireGymOwnerOrAdmin(validatedInput.gymUuid, userId);

    // Prevent removing the owner
    if (validatedInput.userId === gym.ownerId) {
      throw new Error('Cannot remove the gym owner');
    }

    await db
      .delete(dbSchema.gymMembers)
      .where(and(eq(dbSchema.gymMembers.gymId, gym.id), eq(dbSchema.gymMembers.userId, validatedInput.userId)));

    return true;
  },

  grantGymWriteAccess: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'grantGymWriteAccess');

    const validatedInput = validateInput(GrantGymWriteAccessInputSchema, input, 'input');
    const userId = ctx.userId!;

    const gym = await requireGymGrantAccess(validatedInput.gymUuid, userId);

    // Verify target user exists
    const [targetUser] = await db
      .select({ id: dbSchema.users.id })
      .from(dbSchema.users)
      .where(eq(dbSchema.users.id, validatedInput.userId))
      .limit(1);

    if (!targetUser) {
      throw new Error('User not found');
    }

    // The owner already has full access; granting them "editor" would plant a
    // stale member row that a later ownership change could misread.
    if (validatedInput.userId === gym.ownerId) {
      throw new Error('The gym owner already has full access');
    }

    // Upsert an editor row. Never downgrade an existing admin — only promote a
    // plain member (or a no-op re-grant of an editor) to editor.
    await db
      .insert(dbSchema.gymMembers)
      .values({
        gymId: gym.id,
        userId: validatedInput.userId,
        role: 'editor',
      })
      .onConflictDoUpdate({
        target: [dbSchema.gymMembers.gymId, dbSchema.gymMembers.userId],
        set: { role: 'editor' },
        setWhere: sql`${dbSchema.gymMembers.role} <> 'admin'`,
      });

    return true;
  },

  revokeGymWriteAccess: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'revokeGymWriteAccess');

    const validatedInput = validateInput(RevokeGymWriteAccessInputSchema, input, 'input');
    const userId = ctx.userId!;

    const gym = await requireGymGrantAccess(validatedInput.gymUuid, userId);

    // Only remove editor rows — never a gym admin or plain member.
    await db
      .delete(dbSchema.gymMembers)
      .where(
        and(
          eq(dbSchema.gymMembers.gymId, gym.id),
          eq(dbSchema.gymMembers.userId, validatedInput.userId),
          eq(dbSchema.gymMembers.role, 'editor'),
        ),
      );

    return true;
  },

  followGym: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'followGym');

    const validatedInput = validateInput(FollowGymInputSchema, input, 'input');
    const userId = ctx.userId!;

    const [gym] = await db
      .select({
        id: dbSchema.gyms.id,
        isPublic: dbSchema.gyms.isPublic,
        ownerId: dbSchema.gyms.ownerId,
      })
      .from(dbSchema.gyms)
      .where(and(eq(dbSchema.gyms.uuid, validatedInput.gymUuid), isNull(dbSchema.gyms.deletedAt)))
      .limit(1);

    if (!gym) {
      throw new Error('Gym not found');
    }

    if (!gym.isPublic && gym.ownerId !== userId) {
      throw new Error('Cannot follow a private gym');
    }

    await db
      .insert(dbSchema.gymFollows)
      .values({
        gymId: gym.id,
        userId,
      })
      .onConflictDoNothing();

    return true;
  },

  unfollowGym: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'unfollowGym');

    const validatedInput = validateInput(FollowGymInputSchema, input, 'input');
    const userId = ctx.userId!;

    // Look up gym by UUID to get id
    const [gym] = await db
      .select({ id: dbSchema.gyms.id })
      .from(dbSchema.gyms)
      .where(eq(dbSchema.gyms.uuid, validatedInput.gymUuid))
      .limit(1);

    if (!gym) {
      throw new Error('Gym not found');
    }

    await db
      .delete(dbSchema.gymFollows)
      .where(and(eq(dbSchema.gymFollows.userId, userId), eq(dbSchema.gymFollows.gymId, gym.id)));

    return true;
  },

  linkBoardToGym: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'linkBoardToGym');

    const validatedInput = validateInput(LinkBoardToGymInputSchema, input, 'input');
    const userId = ctx.userId!;

    // Verify board ownership
    const [board] = await db
      .select({ id: dbSchema.userBoards.id, ownerId: dbSchema.userBoards.ownerId })
      .from(dbSchema.userBoards)
      .where(and(eq(dbSchema.userBoards.uuid, validatedInput.boardUuid), isNull(dbSchema.userBoards.deletedAt)))
      .limit(1);

    if (!board) {
      throw new Error('Board not found');
    }

    if (board.ownerId !== userId) {
      throw new Error('Not authorized to modify this board');
    }

    if (validatedInput.gymUuid) {
      // Link to gym — verify gym ownership/admin
      const gym = await requireGymOwnerOrAdmin(validatedInput.gymUuid, userId);

      await db.update(dbSchema.userBoards).set({ gymId: gym.id }).where(eq(dbSchema.userBoards.id, board.id));
    } else {
      // Unlink from gym
      await db.update(dbSchema.userBoards).set({ gymId: null }).where(eq(dbSchema.userBoards.id, board.id));
    }

    return true;
  },
};
