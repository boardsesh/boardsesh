import { pubsub } from '../../../pubsub';
import { createAsyncIterator } from '../shared/async-iterators';
import { withSubscriptionCleanup } from '../shared/managed-subscription';
import { and, desc, eq, sql } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { z } from 'zod';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import type { PrivacyContentType, PrivacyResourceKind } from '@boardsesh/privacy';
import * as schema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';
import {
  canViewUserActivity,
  canViewContent,
  getPrivacySettings,
  getResourcePrivacy,
  isApprovedFollower,
  requirePrivacyControls,
  setContentPrivacy,
} from '../../../services/privacy';
import { publishSocialEvent } from '../../../events';
import { logger } from '../../../utils/logger';

const resourceAudience = z.enum(['public', 'unlisted', 'followers', 'invite_only', 'only_me']);
const locationAudience = z.enum(['public', 'followers', 'members', 'only_me']);
const contentAudience = z.enum(['public', 'followers', 'only_me']);
const contentType = z.enum(['tick', 'session', 'comment', 'climb', 'playlist', 'beta']);
const identifier = z.string().min(1).max(2048);
const updateSettingsSchema = z
  .object({
    isPrivate: z.boolean().optional(),
    defaultSessionAudience: z.enum(['public', 'followers', 'invite_only', 'only_me']).optional(),
    privacyOnboardingVersion: z.number().int().min(1).max(1).optional(),
  })
  .strict();
const publicationSchema = z
  .object({
    entityType: contentType,
    entityId: identifier,
    audience: contentAudience,
    privacyRevision: z.number().int().min(0),
  })
  .strict();
const resourceSchema = z
  .object({
    kind: z.enum(['board', 'session']),
    resourceId: identifier,
    audience: resourceAudience,
    locationAudience: locationAudience.optional(),
    inheritFollowers: z.boolean().optional(),
  })
  .strict();
function notFound(): never {
  throw new GraphQLError('Not found', { extensions: { code: 'NOT_FOUND' } });
}
function actor(ctx: ConnectionContext): string {
  requireAuthenticated(ctx);
  return ctx.userId!;
}
async function privacyActor(ctx: ConnectionContext): Promise<string> {
  const userId = actor(ctx);
  requirePrivacyControls();
  await applyRateLimit(ctx, 30, 'privacyMutation');
  return userId;
}
async function publishFollow(followerId: string, followingId: string): Promise<void> {
  await publishSocialEvent({
    type: 'follow.created',
    actorId: followerId,
    entityType: 'user',
    entityId: followingId,
    timestamp: Date.now(),
    metadata: { followedUserId: followingId },
  }).catch((error: unknown) => logger.error('[Privacy] follow event failed', { error }));
}
export async function getPrivacyRelationship(viewerId: string | null | undefined, userId: string) {
  const [subject] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!subject) notFound();
  const [settings, isFollowing, requests] = await Promise.all([
    getPrivacySettings(userId),
    isApprovedFollower(viewerId, userId),
    viewerId
      ? db
          .select()
          .from(schema.userFollowRequests)
          .where(
            and(eq(schema.userFollowRequests.requesterId, viewerId), eq(schema.userFollowRequests.recipientId, userId)),
          )
          .limit(1)
      : Promise.resolve([]),
  ]);
  return { userId, isPrivate: settings.isPrivate, isFollowing, requestPending: requests.length > 0 && !isFollowing };
}
/** Used by legacy followUser too: an old client cannot skip private approval. */
export async function requestPrivacyFollow(followerId: string, followingId: string): Promise<void> {
  if (followerId === followingId)
    throw new GraphQLError('Cannot follow yourself', { extensions: { code: 'BAD_USER_INPUT' } });
  let createdFollow = false;
  await db.transaction(async (transaction) => {
    const [subject] = await transaction
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, followingId))
      .for('update');
    if (!subject) notFound();
    const [profile] = await transaction
      .select()
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, followingId))
      .limit(1);
    const [existing] = await transaction
      .select()
      .from(schema.userFollows)
      .where(and(eq(schema.userFollows.followerId, followerId), eq(schema.userFollows.followingId, followingId)))
      .limit(1);
    if (existing) return;
    if (profile?.isPrivate) {
      await transaction
        .insert(schema.userFollowRequests)
        .values({ requesterId: followerId, recipientId: followingId })
        .onConflictDoNothing();
    } else {
      const inserted = await transaction
        .insert(schema.userFollows)
        .values({ followerId, followingId })
        .onConflictDoNothing()
        .returning({ id: schema.userFollows.id });
      createdFollow = inserted.length > 0;
      await transaction
        .delete(schema.userFollowRequests)
        .where(
          and(
            eq(schema.userFollowRequests.requesterId, followerId),
            eq(schema.userFollowRequests.recipientId, followingId),
          ),
        );
    }
  });
  if (createdFollow) await publishFollow(followerId, followingId);
  pubsub.publishPrivacyChanged();
}
export async function removePrivacyFollow(followerId: string, followingId: string): Promise<void> {
  await db.transaction(async (transaction) => {
    // Same recipient lock as approval and account visibility, so a racing approval cannot recreate access.
    await transaction
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, followingId))
      .for('update');
    await transaction
      .delete(schema.userFollows)
      .where(and(eq(schema.userFollows.followerId, followerId), eq(schema.userFollows.followingId, followingId)));
    await transaction
      .delete(schema.userFollowRequests)
      .where(
        and(
          eq(schema.userFollowRequests.requesterId, followerId),
          eq(schema.userFollowRequests.recipientId, followingId),
        ),
      );
  });
  pubsub.publishPrivacyChanged();
}
async function contentOwner(
  entityType: PrivacyContentType,
  entityId: string,
  requestingUserId?: string,
  executor: Pick<typeof db, 'select'> = db,
): Promise<string> {
  if (entityType === 'tick') {
    const [row] = await executor
      .select({ ownerId: schema.boardseshTicks.userId })
      .from(schema.boardseshTicks)
      .where(eq(schema.boardseshTicks.uuid, entityId))
      .limit(1)
      .for('update');
    return row?.ownerId ?? notFound();
  }
  if (entityType === 'session') {
    const [row] = await executor
      .select({ ownerId: schema.boardSessions.createdByUserId })
      .from(schema.boardSessions)
      .where(eq(schema.boardSessions.id, entityId))
      .limit(1)
      .for('update');
    return row?.ownerId ?? notFound();
  }
  if (entityType === 'comment') {
    const [row] = await executor
      .select({ ownerId: schema.comments.userId })
      .from(schema.comments)
      .where(and(eq(schema.comments.uuid, entityId), sql`${schema.comments.deletedAt} IS NULL`))
      .limit(1)
      .for('update');
    return row?.ownerId ?? notFound();
  }
  if (entityType === 'climb') {
    const [row] = await executor
      .select({ ownerId: schema.boardClimbs.userId })
      .from(schema.boardClimbs)
      .where(eq(schema.boardClimbs.uuid, entityId))
      .limit(1)
      .for('update');
    return row?.ownerId ?? notFound();
  }
  if (entityType === 'playlist') {
    const rows = await executor
      .select({ ownerId: schema.playlistOwnership.userId })
      .from(schema.playlistOwnership)
      .innerJoin(schema.playlists, eq(schema.playlists.id, schema.playlistOwnership.playlistId))
      .where(and(eq(schema.playlists.uuid, entityId), eq(schema.playlistOwnership.role, 'owner')))
      .for('update');
    return rows.find((row) => row.ownerId === requestingUserId)?.ownerId ?? rows[0]?.ownerId ?? notFound();
  }
  const firstColon = entityId.indexOf(':');
  const secondColon = entityId.indexOf(':', firstColon + 1);
  if (firstColon < 1 || secondColon < 0) notFound();
  const [row] = await executor
    .select({ ownerId: schema.boardBetaLinks.createdByUserId })
    .from(schema.boardBetaLinks)
    .where(
      and(
        eq(schema.boardBetaLinks.boardType, entityId.slice(0, firstColon)),
        eq(schema.boardBetaLinks.climbUuid, entityId.slice(firstColon + 1, secondColon)),
        eq(schema.boardBetaLinks.link, entityId.slice(secondColon + 1)),
      ),
    )
    .limit(1)
    .for('update');
  return row?.ownerId ?? notFound();
}
type PrivacyTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function lockOwnedResource(
  transaction: PrivacyTransaction,
  kind: PrivacyResourceKind,
  resourceId: string,
  userId: string,
): Promise<void> {
  const rows =
    kind === 'board'
      ? await transaction
          .select({ ownerId: schema.userBoards.ownerId })
          .from(schema.userBoards)
          .where(
            and(
              eq(schema.userBoards.uuid, resourceId),
              eq(schema.userBoards.ownerId, userId),
              sql`${schema.userBoards.deletedAt} IS NULL`,
            ),
          )
          .for('update')
      : await transaction
          .select({ ownerId: schema.boardSessions.createdByUserId })
          .from(schema.boardSessions)
          .where(and(eq(schema.boardSessions.id, resourceId), eq(schema.boardSessions.createdByUserId, userId)))
          .for('update');
  if (rows.length === 0) notFound();
}
async function requireResourceOwner(kind: PrivacyResourceKind, resourceId: string, userId: string) {
  const resource = await getResourcePrivacy(kind, resourceId);
  if (!resource || resource.ownerId !== userId) notFound();
  return resource;
}
async function notifyResourceChanged(kind: PrivacyResourceKind, resourceId: string): Promise<void> {
  const { notifyResourcePrivacyChanged } = await import('../../../services/board-session-privacy');
  await notifyResourcePrivacyChanged(kind, resourceId);
}
export const privacyQueries = {
  privacySettings: async (_: unknown, __: unknown, ctx: ConnectionContext) => getPrivacySettings(actor(ctx)),
  privacyRelationship: async (_: unknown, { userId }: { userId: string }, ctx: ConnectionContext) =>
    getPrivacyRelationship(ctx.isAuthenticated ? ctx.userId : null, userId),
  incomingFollowRequests: async (_: unknown, __: unknown, ctx: ConnectionContext) => {
    const userId = actor(ctx);
    const requests = await db
      .select({
        requesterId: schema.userFollowRequests.requesterId,
        recipientId: schema.userFollowRequests.recipientId,
        createdAt: schema.userFollowRequests.createdAt,
        displayName: sql<string | null>`COALESCE(${schema.userProfiles.displayName}, ${schema.users.name})`,
        avatarUrl: sql<string | null>`COALESCE(${schema.userProfiles.avatarUrl}, ${schema.users.image})`,
      })
      .from(schema.userFollowRequests)
      .innerJoin(schema.users, eq(schema.users.id, schema.userFollowRequests.requesterId))
      .leftJoin(schema.userProfiles, eq(schema.userProfiles.userId, schema.users.id))
      .where(eq(schema.userFollowRequests.recipientId, userId))
      .orderBy(desc(schema.userFollowRequests.createdAt))
      .limit(100);
    return requests.map((request) => ({ ...request, createdAt: request.createdAt.toISOString() }));
  },
  contentAudience: async (
    _: unknown,
    { entityType, entityId }: { entityType: PrivacyContentType; entityId: string },
    ctx: ConnectionContext,
  ) => {
    const viewerId = actor(ctx);
    const ownerId = await contentOwner(entityType, entityId, viewerId);
    if (viewerId !== ownerId && !(await canViewContent(viewerId, entityType, entityId, ownerId))) notFound();
    const [stored] = await db
      .select()
      .from(schema.contentPrivacy)
      .where(and(eq(schema.contentPrivacy.entityType, entityType), eq(schema.contentPrivacy.entityId, entityId)))
      .limit(1);
    const settings = await getPrivacySettings(ownerId);
    const stalePublic =
      stored?.audience === 'public' && settings.isPrivate && stored.publicConsentRevision !== settings.privacyRevision;
    return {
      audience: stalePublic ? 'followers' : (stored?.audience ?? (settings.isPrivate ? 'followers' : 'public')),
      isExplicit: !!stored,
      canEdit: viewerId === ownerId,
    };
  },
  resourcePrivacy: async (
    _: unknown,
    { kind, resourceId }: { kind: PrivacyResourceKind; resourceId: string },
    ctx: ConnectionContext,
  ) => {
    const userId = actor(ctx);
    await requireResourceOwner(kind, resourceId, userId);
    return getResourcePrivacy(kind, resourceId);
  },
  resourceAccessRequests: async (
    _: unknown,
    { kind, resourceId }: { kind: PrivacyResourceKind; resourceId: string },
    ctx: ConnectionContext,
  ) => {
    await requireResourceOwner(kind, resourceId, actor(ctx));
    return db
      .select({
        userId: schema.resourceGrants.userId,
        status: schema.resourceGrants.status,
        invitedBy: schema.resourceGrants.invitedBy,
        displayName: sql<string | null>`COALESCE(${schema.userProfiles.displayName}, ${schema.users.name})`,
        avatarUrl: sql<string | null>`COALESCE(${schema.userProfiles.avatarUrl}, ${schema.users.image})`,
      })
      .from(schema.resourceGrants)
      .innerJoin(schema.users, eq(schema.users.id, schema.resourceGrants.userId))
      .leftJoin(schema.userProfiles, eq(schema.userProfiles.userId, schema.users.id))
      .where(and(eq(schema.resourceGrants.kind, kind), eq(schema.resourceGrants.resourceId, resourceId)))
      .limit(100);
  },
};
export const privacyMutations = {
  updatePrivacySettings: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    const userId = await privacyActor(ctx);
    const settings = validateInput(updateSettingsSchema, input, 'input');
    await db.transaction(async (transaction) => {
      await transaction
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .for('no key update');
      await transaction.insert(schema.userProfiles).values({ userId }).onConflictDoNothing();
      const [current] = await transaction
        .select()
        .from(schema.userProfiles)
        .where(eq(schema.userProfiles.userId, userId))
        .limit(1);
      const becomingPrivate = settings.isPrivate === true && !current.isPrivate;
      await transaction
        .update(schema.userProfiles)
        .set({
          ...(settings.isPrivate !== undefined ? { isPrivate: settings.isPrivate } : {}),
          ...(settings.defaultSessionAudience !== undefined
            ? { defaultSessionAudience: settings.defaultSessionAudience }
            : {}),
          ...(settings.privacyOnboardingVersion !== undefined
            ? {
                privacyOnboardingVersion: Math.max(settings.privacyOnboardingVersion, current.privacyOnboardingVersion),
              }
            : {}),
          privacyRevision: current.privacyRevision + (becomingPrivate ? 1 : 0),
          updatedAt: new Date(),
        })
        .where(eq(schema.userProfiles.userId, userId));
    });
    return getPrivacySettings(userId);
  },
  requestFollow: async (_: unknown, { userId }: { userId: string }, ctx: ConnectionContext) => {
    const requesterId = await privacyActor(ctx);
    await requestPrivacyFollow(requesterId, userId);
    return getPrivacyRelationship(requesterId, userId);
  },
  cancelFollowRequest: async (_: unknown, { userId }: { userId: string }, ctx: ConnectionContext) => {
    const requesterId = await privacyActor(ctx);
    await db.transaction(async (transaction) => {
      await transaction
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .for('update');
      await transaction
        .delete(schema.userFollowRequests)
        .where(
          and(
            eq(schema.userFollowRequests.requesterId, requesterId),
            eq(schema.userFollowRequests.recipientId, userId),
          ),
        );
    });
    return true;
  },
  approveFollowRequest: async (_: unknown, { userId }: { userId: string }, ctx: ConnectionContext) => {
    const recipientId = await privacyActor(ctx);
    let accepted = false;
    await db.transaction(async (transaction) => {
      await transaction
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, recipientId))
        .for('update');
      const requests = await transaction
        .delete(schema.userFollowRequests)
        .where(
          and(
            eq(schema.userFollowRequests.requesterId, userId),
            eq(schema.userFollowRequests.recipientId, recipientId),
          ),
        )
        .returning();
      if (!requests.length) return;
      const inserted = await transaction
        .insert(schema.userFollows)
        .values({ followerId: userId, followingId: recipientId })
        .onConflictDoNothing()
        .returning();
      accepted = inserted.length > 0;
    });
    if (accepted) await publishFollow(userId, recipientId);
    return true;
  },
  declineFollowRequest: async (_: unknown, { userId }: { userId: string }, ctx: ConnectionContext) => {
    const recipientId = await privacyActor(ctx);
    await db.transaction(async (transaction) => {
      await transaction
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, recipientId))
        .for('update');
      await transaction
        .delete(schema.userFollowRequests)
        .where(
          and(
            eq(schema.userFollowRequests.requesterId, userId),
            eq(schema.userFollowRequests.recipientId, recipientId),
          ),
        );
    });
    return true;
  },
  removeFollower: async (_: unknown, { userId }: { userId: string }, ctx: ConnectionContext) => {
    await removePrivacyFollow(userId, await privacyActor(ctx));
    return true;
  },
  setContentAudience: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    const userId = await privacyActor(ctx);
    const publication = validateInput(publicationSchema, input, 'input');
    if (publication.entityType === 'session')
      throw new GraphQLError('Use session resource privacy settings', { extensions: { code: 'BAD_USER_INPUT' } });
    await db.transaction(async (transaction) => {
      const ownerId = await contentOwner(publication.entityType, publication.entityId, userId, transaction);
      if (ownerId !== userId) notFound();
      await setContentPrivacy(
        transaction,
        userId,
        publication.entityType,
        publication.entityId,
        publication.audience,
        publication.privacyRevision,
      );
      if (publication.entityType === 'playlist') {
        await transaction
          .update(schema.playlists)
          .set({ isPublic: publication.audience === 'public', updatedAt: new Date() })
          .where(eq(schema.playlists.uuid, publication.entityId));
      }
    });
    return true;
  },
  updateResourcePrivacy: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    const userId = await privacyActor(ctx);
    const update = validateInput(resourceSchema, input, 'input');
    if (update.kind === 'session' && update.audience === 'unlisted')
      throw new GraphQLError('Sessions do not support unlisted audiences', { extensions: { code: 'BAD_USER_INPUT' } });
    const current = await requireResourceOwner(update.kind, update.resourceId, userId);
    if (update.kind === 'board') {
      const [board] = await db
        .select({ boardType: schema.userBoards.boardType })
        .from(schema.userBoards)
        .where(eq(schema.userBoards.uuid, update.resourceId))
        .limit(1);
      if (board?.boardType === 'spray') {
        const { updateSprayResourcePrivacy } = await import('../board/spray-walls');
        await updateSprayResourcePrivacy(
          update.resourceId,
          {
            audience: update.audience,
            locationAudience: update.locationAudience ?? current.locationAudience,
            inheritFollowers: update.inheritFollowers ?? current.inheritFollowers,
          },
          ctx,
        );
        await notifyResourceChanged(update.kind, update.resourceId);
        return getResourcePrivacy(update.kind, update.resourceId);
      }
    }
    await db.transaction(async (transaction) => {
      // Serialize with other settings writers without changing the content owner.
      await transaction
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .for('update');
      await lockOwnedResource(transaction, update.kind, update.resourceId, userId);
      const [lockedOverride] = await transaction
        .select()
        .from(schema.resourcePrivacy)
        .where(
          and(eq(schema.resourcePrivacy.kind, update.kind), eq(schema.resourcePrivacy.resourceId, update.resourceId)),
        )
        .for('update');
      if (update.kind === 'session' && !lockedOverride) {
        const participants = await transaction
          .select({ userId: schema.boardSessionParticipants.userId })
          .from(schema.boardSessionParticipants)
          .where(eq(schema.boardSessionParticipants.sessionId, update.resourceId));
        if (participants.length)
          await transaction
            .insert(schema.resourceGrants)
            .values(
              participants.map((participant) => ({
                kind: update.kind,
                resourceId: update.resourceId,
                userId: participant.userId,
                status: 'approved' as const,
                invitedBy: userId,
              })),
            )
            .onConflictDoNothing();
      }
      const settings = {
        ownerId: userId,
        audience: update.audience,
        locationAudience: update.locationAudience ?? lockedOverride?.locationAudience ?? current.locationAudience,
        inheritFollowers: update.inheritFollowers ?? lockedOverride?.inheritFollowers ?? current.inheritFollowers,
        updatedAt: new Date(),
      };
      await transaction
        .insert(schema.resourcePrivacy)
        .values({ kind: update.kind, resourceId: update.resourceId, ...settings, revision: 1 })
        .onConflictDoUpdate({
          target: [schema.resourcePrivacy.kind, schema.resourcePrivacy.resourceId],
          set: { ...settings, revision: sql`${schema.resourcePrivacy.revision} + 1` },
        });
      // Old readers must never see a newly restricted resource as public.
      if (update.kind === 'session')
        await transaction
          .update(schema.boardSessions)
          .set({ isPublic: update.audience === 'public' })
          .where(eq(schema.boardSessions.id, update.resourceId));
      else
        await transaction
          .update(schema.userBoards)
          .set({
            isPublic: update.audience === 'public',
            isUnlisted: update.audience === 'unlisted',
            hideLocation: settings.locationAudience !== 'public',
          })
          .where(eq(schema.userBoards.uuid, update.resourceId));
    });
    await notifyResourceChanged(update.kind, update.resourceId);
    return getResourcePrivacy(update.kind, update.resourceId);
  },
  requestResourceAccess: async (
    _: unknown,
    { kind, resourceId }: { kind: PrivacyResourceKind; resourceId: string },
    ctx: ConnectionContext,
  ) => {
    const userId = await privacyActor(ctx);
    const resource = await getResourcePrivacy(kind, resourceId);
    if (!resource || !resource.ownerId || resource.audience === 'only_me') notFound();
    await db
      .insert(schema.resourceGrants)
      .values({ kind, resourceId, userId, status: 'pending' })
      .onConflictDoNothing();
    return true;
  },
  approveResourceAccess: async (
    _: unknown,
    input: { kind: PrivacyResourceKind; resourceId: string; userId: string },
    ctx: ConnectionContext,
  ) => {
    const ownerId = await privacyActor(ctx);
    await requireResourceOwner(input.kind, input.resourceId, ownerId);
    await db.transaction(async (transaction) => {
      await lockOwnedResource(transaction, input.kind, input.resourceId, ownerId);
      await transaction
        .update(schema.resourceGrants)
        .set({ status: 'approved', invitedBy: ownerId, updatedAt: new Date() })
        .where(
          and(
            eq(schema.resourceGrants.kind, input.kind),
            eq(schema.resourceGrants.resourceId, input.resourceId),
            eq(schema.resourceGrants.userId, input.userId),
            eq(schema.resourceGrants.status, 'pending'),
          ),
        );
    });
    await notifyResourceChanged(input.kind, input.resourceId);
    return true;
  },
  revokeResourceAccess: async (
    _: unknown,
    input: { kind: PrivacyResourceKind; resourceId: string; userId: string },
    ctx: ConnectionContext,
  ) => {
    const ownerId = await privacyActor(ctx);
    await requireResourceOwner(input.kind, input.resourceId, ownerId);
    if (ownerId === input.userId)
      throw new GraphQLError('The owner retains access', { extensions: { code: 'BAD_USER_INPUT' } });
    await db.transaction(async (transaction) => {
      await lockOwnedResource(transaction, input.kind, input.resourceId, ownerId);
      await transaction
        .insert(schema.resourceGrants)
        .values({ ...input, status: 'revoked', invitedBy: ownerId })
        .onConflictDoUpdate({
          target: [schema.resourceGrants.kind, schema.resourceGrants.resourceId, schema.resourceGrants.userId],
          set: { status: 'revoked', invitedBy: ownerId, updatedAt: new Date() },
        });
    });
    await notifyResourceChanged(input.kind, input.resourceId);
    return true;
  },
  inviteResourceMember: async (
    _: unknown,
    input: { kind: PrivacyResourceKind; resourceId: string; userId: string },
    ctx: ConnectionContext,
  ) => {
    const ownerId = await privacyActor(ctx);
    await requireResourceOwner(input.kind, input.resourceId, ownerId);
    const [invitee] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, input.userId))
      .limit(1);
    if (!invitee) notFound();
    await db.transaction(async (transaction) => {
      await lockOwnedResource(transaction, input.kind, input.resourceId, ownerId);
      await transaction
        .insert(schema.resourceGrants)
        .values({ ...input, status: 'approved', invitedBy: ownerId })
        .onConflictDoUpdate({
          target: [schema.resourceGrants.kind, schema.resourceGrants.resourceId, schema.resourceGrants.userId],
          set: { status: 'approved', invitedBy: ownerId, updatedAt: new Date() },
        });
    });
    await notifyResourceChanged(input.kind, input.resourceId);
    return true;
  },
};
export const privacyProfileFields = {
  isPrivate: async (profile: { id: string; isPrivate?: boolean }) =>
    profile.isPrivate ?? (await getPrivacySettings(profile.id)).isPrivate,
  canViewActivity: async (profile: { id: string; canViewActivity?: boolean }, _: unknown, ctx: ConnectionContext) =>
    profile.canViewActivity ?? canViewUserActivity(ctx.isAuthenticated ? ctx.userId : null, profile.id),
};

export const notifyingPrivacyMutations = Object.fromEntries(
  Object.entries(privacyMutations).map(([name, resolver]) => [
    name,
    async (...args: Parameters<typeof resolver>) => {
      const result = await (resolver as (...parameters: Parameters<typeof resolver>) => Promise<unknown>)(...args);
      if (name === 'updatePrivacySettings' || name === 'setContentAudience' || name === 'updateResourcePrivacy') {
        // Newly public beta must not wait behind an older empty anonymous cache.
        const { invalidateRecentBetaLinksCache } = await import('../beta-videos/queries');
        await invalidateRecentBetaLinksCache();
      }
      pubsub.publishPrivacyChanged();
      return result;
    },
  ]),
);
export const privacySubscriptions = {
  privacyChanged: {
    subscribe: withSubscriptionCleanup(async function* (lifetime, _: unknown, __: unknown, ctx: ConnectionContext) {
      actor(ctx);
      const iterator = await lifetime.own(
        createAsyncIterator<boolean>((push) => pubsub.subscribePrivacy(() => push(true)), 'privacyChanged'),
      );
      // Reconnection is an invalidation too: Redis pub/sub has no replay window.
      yield { privacyChanged: true };
      for await (const changed of iterator) yield { privacyChanged: changed };
    }),
  },
};
