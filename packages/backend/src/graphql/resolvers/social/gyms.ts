import { v4 as uuidv4 } from 'uuid';
import { eq, and, count, isNull, sql, ilike, or, desc, inArray } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';
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
    contactEmail: (row.contact_email as string | null) ?? null,
    contactPhone: (row.contact_phone as string | null) ?? null,
    latitude: row.latitude != null ? Number(row.latitude) : null,
    longitude: row.longitude != null ? Number(row.longitude) : null,
    isPublic: row.is_public as boolean,
    description: (row.description as string | null) ?? null,
    imageUrl: (row.image_url as string | null) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    deletedAt: (row.deleted_at as Date | null) ?? null,
  };
}

/**
 * Enrich a gym row with computed fields (counts, follow status, membership).
 */
async function enrichGym(gym: typeof dbSchema.gyms.$inferSelect, authenticatedUserId?: string) {
  const [
    ownerResult,
    boardCountResult,
    memberCountResult,
    followerCountResult,
    commentCountResult,
    followCheckResult,
    memberCheckResult,
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
  ]);

  const ownerInfo = ownerResult[0];
  const boardCount = Number(boardCountResult[0]?.count || 0);
  const memberCount = Number(memberCountResult[0]?.count || 0);
  const followerCount = Number(followerCountResult[0]?.count || 0);
  const commentCount = Number(commentCountResult[0]?.count || 0);
  const isFollowedByMe = Number(followCheckResult[0]?.count || 0) > 0;

  // Determine membership: owner is always a member with "admin" implied
  const isOwner = authenticatedUserId === gym.ownerId;
  const memberRow = (memberCheckResult as Array<{ role: string }>)[0];
  const isMember = isOwner || !!memberRow;
  const myRole = isOwner ? 'admin' : ((memberRow?.role as 'admin' | 'member' | undefined) ?? null);

  return {
    uuid: gym.uuid,
    slug: gym.slug,
    ownerId: gym.ownerId,
    ownerDisplayName: ownerInfo?.displayName || ownerInfo?.name || undefined,
    ownerAvatarUrl: ownerInfo?.avatarUrl || ownerInfo?.image || undefined,
    name: gym.name,
    description: gym.description,
    address: gym.address,
    contactEmail: gym.contactEmail,
    contactPhone: gym.contactPhone,
    latitude: gym.latitude,
    longitude: gym.longitude,
    isPublic: gym.isPublic,
    imageUrl: gym.imageUrl,
    createdAt: gym.createdAt.toISOString(),
    boardCount,
    memberCount,
    followerCount,
    commentCount,
    isFollowedByMe,
    isMember,
    myRole,
  };
}

/**
 * Verify user is gym owner or admin, return the gym row.
 */
async function requireGymOwnerOrAdmin(gymUuid: string, userId: string): Promise<typeof dbSchema.gyms.$inferSelect> {
  const [gym] = await db
    .select()
    .from(dbSchema.gyms)
    .where(and(eq(dbSchema.gyms.uuid, gymUuid), isNull(dbSchema.gyms.deletedAt)))
    .limit(1);

  if (!gym) {
    throw new Error('Gym not found');
  }

  if (gym.ownerId === userId) {
    return gym;
  }

  // Check if user is admin
  const [member] = await db
    .select({ role: dbSchema.gymMembers.role })
    .from(dbSchema.gymMembers)
    .where(
      and(
        eq(dbSchema.gymMembers.gymId, gym.id),
        eq(dbSchema.gymMembers.userId, userId),
        eq(dbSchema.gymMembers.role, 'admin'),
      ),
    )
    .limit(1);

  if (!member) {
    throw new Error('Not authorized: must be gym owner or admin');
  }

  return gym;
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
    const { query, latitude, longitude, radiusKm } = validatedInput;
    const limit = validatedInput.limit ?? 20;
    const offset = validatedInput.offset ?? 0;
    const useProximity = latitude !== undefined && longitude !== undefined;

    if (useProximity) {
      const radiusMeters = (radiusKm ?? 50) * 1000;
      const lon = Number(longitude);
      const lat = Number(latitude);

      const escapedQuery = query ? query.replace(/[%_\\]/g, '\\$&') : null;
      const likePattern = escapedQuery ? `%${escapedQuery}%` : null;

      const countRows = await db.execute(
        likePattern
          ? sql`SELECT count(*)::int as count FROM gyms WHERE is_public = true AND deleted_at IS NULL AND location IS NOT NULL AND ST_DWithin(location, ST_MakePoint(${lon}, ${lat})::geography, ${radiusMeters}) AND (name ILIKE ${likePattern} OR address ILIKE ${likePattern})`
          : sql`SELECT count(*)::int as count FROM gyms WHERE is_public = true AND deleted_at IS NULL AND location IS NOT NULL AND ST_DWithin(location, ST_MakePoint(${lon}, ${lat})::geography, ${radiusMeters})`,
      );
      const totalCount = Number((countRows as unknown as Array<Record<string, unknown>>)[0]?.count || 0);

      const gymRows = await db.execute(
        likePattern
          ? sql`SELECT *, ST_Distance(location, ST_MakePoint(${lon}, ${lat})::geography) as distance_meters FROM gyms WHERE is_public = true AND deleted_at IS NULL AND location IS NOT NULL AND ST_DWithin(location, ST_MakePoint(${lon}, ${lat})::geography, ${radiusMeters}) AND (name ILIKE ${likePattern} OR address ILIKE ${likePattern}) ORDER BY distance_meters ASC LIMIT ${limit} OFFSET ${offset}`
          : sql`SELECT *, ST_Distance(location, ST_MakePoint(${lon}, ${lat})::geography) as distance_meters FROM gyms WHERE is_public = true AND deleted_at IS NULL AND location IS NOT NULL AND ST_DWithin(location, ST_MakePoint(${lon}, ${lat})::geography, ${radiusMeters}) ORDER BY distance_meters ASC LIMIT ${limit} OFFSET ${offset}`,
      );
      const rows = gymRows as unknown as Array<Record<string, unknown>>;

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

  gymMembers: async (_: unknown, { input }: { input: unknown }) => {
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
    await applyRateLimit(ctx, 10);

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
    await applyRateLimit(ctx, 20);

    const validatedInput = validateInput(UpdateGymInputSchema, input, 'input');
    const userId = ctx.userId!;

    const gym = await requireGymOwnerOrAdmin(validatedInput.gymUuid, userId);

    const updateValues: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (validatedInput.name !== undefined) updateValues.name = validatedInput.name;
    if (validatedInput.description !== undefined) updateValues.description = validatedInput.description;
    if (validatedInput.address !== undefined) updateValues.address = validatedInput.address;
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
    await applyRateLimit(ctx, 10);

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
    await applyRateLimit(ctx, 20);

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
    await applyRateLimit(ctx, 20);

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

  followGym: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20);

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
    await applyRateLimit(ctx, 20);

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
    await applyRateLimit(ctx, 20);

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
