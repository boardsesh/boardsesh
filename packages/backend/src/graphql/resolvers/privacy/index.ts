import { pubsub, type PrivacyChangeSource } from '../../../pubsub';
import { createAsyncIterator } from '../shared/async-iterators';
import { withSubscriptionCleanup } from '../shared/managed-subscription';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { z } from 'zod';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { normalizeLocationAudience, type PrivacyContentType, type PrivacyResourceKind } from '@boardsesh/privacy';
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
import { isShareLinkAudience, revokeBoardShareLinks } from '../../../services/board-share-links';
import { deleteFollowRequestNotifications, lockFollowRequestPair } from '../../../events/follow-request-notifications';
import { logger } from '../../../utils/logger';

const resourceAudience = z.enum(['public', 'unlisted', 'followers', 'invite_only', 'only_me']);
// `followers` stays accepted for older clients but is stored as `members`: on a
// public account follows auto-approve, so it would not restrict anything.
const locationAudience = z.enum(['public', 'followers', 'members', 'only_me']).transform(normalizeLocationAudience);
const contentAudience = z.enum(['public', 'followers', 'only_me']);
const contentType = z.enum(['tick', 'session', 'comment', 'climb', 'playlist', 'beta']);
const identifier = z.string().min(1).max(2048);
const updateSettingsSchema = z
  .object({
    isPrivate: z.boolean().optional(),
    defaultSessionAudience: z.enum(['public', 'followers', 'invite_only', 'only_me']).optional(),
    // Retired with the privacy setup screen. Installed apps that still show it
    // send this on finishing; it is accepted and ignored.
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
/**
 * One page of an owner's access list. A share link lets anyone holding it add
 * themselves, so the list can outgrow a page: the app pages by `offset`, and a
 * search asks for its results' own grants by `userIds`.
 */
const ACCESS_LIST_PAGE_SIZE = 100;
const accessListArgsSchema = z.object({
  offset: z.number().int().min(0).max(1_000_000).nullish(),
  userIds: z.array(identifier).max(ACCESS_LIST_PAGE_SIZE).nullish(),
});
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
/**
 * Answering a pending follow request only carries out a choice the owner made
 * when they went private, so it works with the controls switched off too. A
 * rollback that turns the controls off keeps old clients' followUser creating
 * requests, and the owner must still be able to answer them from the inbox.
 */
async function followRequestAnswerActor(ctx: ConnectionContext): Promise<string> {
  const userId = actor(ctx);
  await applyRateLimit(ctx, 30, 'privacyMutation');
  return userId;
}
async function publishFollow(
  followerId: string,
  followingId: string,
  { fromApproval = false }: { fromApproval?: boolean } = {},
): Promise<void> {
  await publishSocialEvent({
    type: 'follow.created',
    actorId: followerId,
    entityType: 'user',
    entityId: followingId,
    timestamp: Date.now(),
    // An approval is the account owner's own tap: telling them "X started
    // following you" right after it would only echo what they just did.
    metadata: { followedUserId: followingId, ...(fromApproval ? { fromFollowRequestApproval: 'true' } : {}) },
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
async function publishFollowRequest(requesterId: string, recipientId: string): Promise<void> {
  // entityId is the requester, so each request is its own inbox row with its
  // own Approve and Decline, rather than one group for every requester.
  await publishSocialEvent({
    type: 'follow.requested',
    actorId: requesterId,
    entityType: 'user',
    entityId: requesterId,
    timestamp: Date.now(),
    metadata: { recipientUserId: recipientId },
  }).catch((error: unknown) => logger.error('[Privacy] follow request event failed', { error }));
}
/**
 * What a follow attempt did. `following`: the follow exists (made now or
 * earlier). `requested`: the account is private, so only a request exists and
 * the requester must not be shown as following.
 */
export type PrivacyFollowOutcome = 'following' | 'requested';
/** Used by legacy followUser too: an old client cannot skip private approval. */
export async function requestPrivacyFollow(followerId: string, followingId: string): Promise<PrivacyFollowOutcome> {
  if (followerId === followingId)
    throw new GraphQLError('Cannot follow yourself', { extensions: { code: 'BAD_USER_INPUT' } });
  let createdFollow = false;
  let createdRequest = false;
  let outcome: PrivacyFollowOutcome = 'following';
  await db.transaction(async (transaction) => {
    // Pair lock before the users row lock: see lockFollowRequestPair.
    await lockFollowRequestPair(transaction, followerId, followingId);
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
      outcome = 'requested';
      const inserted = await transaction
        .insert(schema.userFollowRequests)
        .values({ requesterId: followerId, recipientId: followingId })
        .onConflictDoNothing()
        .returning({ requesterId: schema.userFollowRequests.requesterId });
      createdRequest = inserted.length > 0;
    } else {
      const inserted = await transaction
        .insert(schema.userFollows)
        .values({ followerId, followingId })
        .onConflictDoNothing()
        .returning({ id: schema.userFollows.id });
      createdFollow = inserted.length > 0;
      // The account is public now, so any older request became a follow: its
      // inbox row has nothing left to answer.
      await transaction
        .delete(schema.userFollowRequests)
        .where(
          and(
            eq(schema.userFollowRequests.requesterId, followerId),
            eq(schema.userFollowRequests.recipientId, followingId),
          ),
        );
      await deleteFollowRequestNotifications(followerId, followingId, transaction);
    }
  });
  // No privacyChanged here: a request grants nothing, and a direct follow of a
  // public account only widens what the follower's own client can read. That
  // client refreshes its own caches after the mutation.
  if (createdFollow) await publishFollow(followerId, followingId);
  if (createdRequest) await publishFollowRequest(followerId, followingId);
  return outcome;
}
/**
 * Unfollow or remove a follower, retaining a hidden request notification for
 * its day-long dedup window. Returns whether approved access was removed.
 */
export async function removePrivacyFollow(followerId: string, followingId: string): Promise<boolean> {
  return db.transaction(async (transaction) => {
    // Same recipient lock as approval and account visibility, so a racing approval cannot recreate access.
    await transaction
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, followingId))
      .for('update');
    const removed = await transaction
      .delete(schema.userFollows)
      .where(and(eq(schema.userFollows.followerId, followerId), eq(schema.userFollows.followingId, followingId)))
      .returning({ id: schema.userFollows.id });
    await transaction
      .delete(schema.userFollowRequests)
      .where(
        and(
          eq(schema.userFollowRequests.requesterId, followerId),
          eq(schema.userFollowRequests.recipientId, followingId),
        ),
      );
    return removed.length > 0;
  });
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
/**
 * Refresh a resource's public previews. Callers publish privacyChanged BEFORE
 * this: the write has committed, and this does its own reads and can fail, which
 * must not leave other viewers holding copies they can no longer read.
 */
async function notifyResourceChanged(kind: PrivacyResourceKind, resourceId: string): Promise<void> {
  const { notifyResourcePrivacyChanged } = await import('../../../services/board-session-privacy');
  await notifyResourcePrivacyChanged(kind, resourceId);
}
/**
 * The grant's status before an owner writes it, read under the resource lock.
 * Null when there is no row. A repeated revoke or invite changes nobody's
 * access, so it must not publish privacyChanged.
 */
async function lockedGrantStatus(
  transaction: PrivacyTransaction,
  input: { kind: PrivacyResourceKind; resourceId: string; userId: string },
): Promise<string | null> {
  const [grant] = await transaction
    .select({ status: schema.resourceGrants.status })
    .from(schema.resourceGrants)
    .where(
      and(
        eq(schema.resourceGrants.kind, input.kind),
        eq(schema.resourceGrants.resourceId, input.resourceId),
        eq(schema.resourceGrants.userId, input.userId),
      ),
    )
    .for('update');
  return grant?.status ?? null;
}
/** Newly public beta must not wait behind an older empty anonymous cache. Runs before the publish. */
async function invalidateBetaCache(): Promise<void> {
  const { invalidateRecentBetaLinksCache } = await import('../beta-videos/queries');
  await invalidateRecentBetaLinksCache();
}
/** Publish after the beta cache is cleared, and publish even when clearing it fails. */
async function publishAfterBetaInvalidation(source: PrivacyChangeSource): Promise<void> {
  try {
    await invalidateBetaCache();
  } finally {
    pubsub.publishPrivacyChanged(source);
  }
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
  /**
   * Without `userIds`: pending requests first, then members, newest first,
   * one page from `offset`. Removed climbers are left out; the owner reaches
   * them by searching. With `userIds`: those people's grants whatever their
   * status, so a search shows each result's real state.
   */
  resourceAccessRequests: async (
    _: unknown,
    {
      kind,
      resourceId,
      ...page
    }: { kind: PrivacyResourceKind; resourceId: string; offset?: number | null; userIds?: string[] | null },
    ctx: ConnectionContext,
  ) => {
    const ownerId = actor(ctx);
    const { offset, userIds } = validateInput(accessListArgsSchema, page, 'access list');
    await requireResourceOwner(kind, resourceId, ownerId);
    if (userIds?.length === 0) return [];
    const onResource = and(eq(schema.resourceGrants.kind, kind), eq(schema.resourceGrants.resourceId, resourceId));
    const query = db
      .select({
        userId: schema.resourceGrants.userId,
        status: schema.resourceGrants.status,
        invitedBy: schema.resourceGrants.invitedBy,
        displayName: sql<string | null>`COALESCE(${schema.userProfiles.displayName}, ${schema.users.name})`,
        avatarUrl: sql<string | null>`COALESCE(${schema.userProfiles.avatarUrl}, ${schema.users.image})`,
      })
      .from(schema.resourceGrants)
      .innerJoin(schema.users, eq(schema.users.id, schema.resourceGrants.userId))
      .leftJoin(schema.userProfiles, eq(schema.userProfiles.userId, schema.users.id));
    if (userIds) return query.where(and(onResource, inArray(schema.resourceGrants.userId, userIds)));
    return query
      .where(and(onResource, ne(schema.resourceGrants.status, 'revoked')))
      .orderBy(
        sql`CASE WHEN ${schema.resourceGrants.status} = 'pending' THEN 0 ELSE 1 END`,
        desc(schema.resourceGrants.updatedAt),
        asc(schema.resourceGrants.userId),
      )
      .limit(ACCESS_LIST_PAGE_SIZE)
      .offset(offset ?? 0);
  },
};
export const privacyMutations = {
  updatePrivacySettings: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    const userId = await privacyActor(ctx);
    const settings = validateInput(updateSettingsSchema, input, 'input');
    // Only the account switch changes who can read existing content. The
    // session default applies to sessions created later, and every settings
    // and onboarding save resends it (NULL on pre-privacy accounts), so it
    // must not publish.
    const accountSwitched = await db.transaction(async (transaction) => {
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
          privacyRevision: current.privacyRevision + (becomingPrivate ? 1 : 0),
          updatedAt: new Date(),
        })
        .where(eq(schema.userProfiles.userId, userId));
      return settings.isPrivate !== undefined && settings.isPrivate !== current.isPrivate;
    });
    await invalidateBetaCache();
    if (accountSwitched) pubsub.publishPrivacyChanged('updatePrivacySettings');
    return getPrivacySettings(userId);
  },
  /**
   * A plain preference, so it is open whatever `BOARDSESH_PRIVACY_ENABLED`
   * says. Board-facing reads apply it at query time, and live streams recheck
   * it on their next event, so saving it publishes nothing: no app listens to
   * `privacyChanged` any more. Saving the stored value again writes nothing.
   */
  setAnonymousOnForeignBoards: async (_: unknown, { enabled }: { enabled: unknown }, ctx: ConnectionContext) => {
    const userId = actor(ctx);
    await applyRateLimit(ctx, 5, 'anonymousBoardPreference');
    const anonymousOnForeignBoards = validateInput(z.boolean(), enabled, 'enabled');
    await db
      .insert(schema.userProfiles)
      .values({ userId, anonymousOnForeignBoards })
      .onConflictDoUpdate({
        target: schema.userProfiles.userId,
        set: { anonymousOnForeignBoards, updatedAt: new Date() },
        setWhere: sql`${schema.userProfiles.anonymousOnForeignBoards} IS DISTINCT FROM ${anonymousOnForeignBoards}`,
      });
    return getPrivacySettings(userId);
  },
  requestFollow: async (_: unknown, { userId }: { userId: string }, ctx: ConnectionContext) => {
    const requesterId = await privacyActor(ctx);
    await requestPrivacyFollow(requesterId, userId);
    return getPrivacyRelationship(requesterId, userId);
  },
  // The follow_request notification is kept, hidden, on purpose: see removePrivacyFollow.
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
    const recipientId = await followRequestAnswerActor(ctx);
    let accepted = false;
    await db.transaction(async (transaction) => {
      // Pair lock before the users row lock: see lockFollowRequestPair.
      await lockFollowRequestPair(transaction, userId, recipientId);
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
      await deleteFollowRequestNotifications(userId, recipientId, transaction);
      if (!requests.length) return;
      const inserted = await transaction
        .insert(schema.userFollows)
        .values({ followerId: userId, followingId: recipientId })
        .onConflictDoNothing()
        .returning();
      accepted = inserted.length > 0;
    });
    if (accepted) {
      await publishFollow(userId, recipientId, { fromApproval: true });
      pubsub.publishPrivacyChanged('approveFollowRequest');
    }
    return true;
  },
  declineFollowRequest: async (_: unknown, { userId }: { userId: string }, ctx: ConnectionContext) => {
    const recipientId = await followRequestAnswerActor(ctx);
    await db.transaction(async (transaction) => {
      // Pair lock before the users row lock: see lockFollowRequestPair.
      await lockFollowRequestPair(transaction, userId, recipientId);
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
      await deleteFollowRequestNotifications(userId, recipientId, transaction);
    });
    return true;
  },
  removeFollower: async (_: unknown, { userId }: { userId: string }, ctx: ConnectionContext) => {
    // Followers-only items and resources exist on public accounts too, so any
    // real removal withdraws access, whatever the account's switch says.
    if (await removePrivacyFollow(userId, await privacyActor(ctx))) pubsub.publishPrivacyChanged('removeFollower');
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
    await invalidateBetaCache();
    pubsub.publishPrivacyChanged('setContentAudience');
    return true;
  },
  updateResourcePrivacy: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    const userId = await privacyActor(ctx);
    const update = validateInput(resourceSchema, input, 'input');
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
        await publishAfterBetaInvalidation('updateResourcePrivacy');
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
      else {
        await transaction
          .update(schema.userBoards)
          .set({
            isPublic: update.audience === 'public',
            isUnlisted: update.audience === 'unlisted',
            hideLocation: settings.locationAudience !== 'public',
          })
          .where(eq(schema.userBoards.uuid, update.resourceId));
        // A share link belongs to a Followers or Invite-only board. Leaving those
        // retires it, so an old link cannot reopen the board after a round trip
        // through Public or Only me.
        if (!isShareLinkAudience(update.audience)) await revokeBoardShareLinks(transaction, update.resourceId);
      }
    });
    await publishAfterBetaInvalidation('updateResourcePrivacy');
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
    const approved = await db.transaction(async (transaction) => {
      await lockOwnedResource(transaction, input.kind, input.resourceId, ownerId);
      const updated = await transaction
        .update(schema.resourceGrants)
        .set({ status: 'approved', invitedBy: ownerId, updatedAt: new Date() })
        .where(
          and(
            eq(schema.resourceGrants.kind, input.kind),
            eq(schema.resourceGrants.resourceId, input.resourceId),
            eq(schema.resourceGrants.userId, input.userId),
            eq(schema.resourceGrants.status, 'pending'),
          ),
        )
        .returning({ userId: schema.resourceGrants.userId });
      return updated.length > 0;
    });
    if (approved) pubsub.publishPrivacyChanged('approveResourceAccess');
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
    const revoked = await db.transaction(async (transaction) => {
      await lockOwnedResource(transaction, input.kind, input.resourceId, ownerId);
      // A new revoked row counts as a change: it overrides inherited follower access.
      const previous = await lockedGrantStatus(transaction, input);
      await transaction
        .insert(schema.resourceGrants)
        .values({ ...input, status: 'revoked', invitedBy: ownerId })
        .onConflictDoUpdate({
          target: [schema.resourceGrants.kind, schema.resourceGrants.resourceId, schema.resourceGrants.userId],
          set: { status: 'revoked', invitedBy: ownerId, updatedAt: new Date() },
        });
      return previous !== 'revoked';
    });
    if (revoked) pubsub.publishPrivacyChanged('revokeResourceAccess');
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
    const invited = await db.transaction(async (transaction) => {
      await lockOwnedResource(transaction, input.kind, input.resourceId, ownerId);
      const previous = await lockedGrantStatus(transaction, input);
      await transaction
        .insert(schema.resourceGrants)
        .values({ ...input, status: 'approved', invitedBy: ownerId })
        .onConflictDoUpdate({
          target: [schema.resourceGrants.kind, schema.resourceGrants.resourceId, schema.resourceGrants.userId],
          set: { status: 'approved', invitedBy: ownerId, updatedAt: new Date() },
        });
      return previous !== 'approved';
    });
    if (invited) pubsub.publishPrivacyChanged('inviteResourceMember');
    await notifyResourceChanged(input.kind, input.resourceId);
    return true;
  },
};
/**
 * `privacyOnboardingVersion` is retired with the forced privacy setup screen.
 * Installed apps open that screen while the value is below 1, so it always
 * reads 1: nobody is sent to setup, and privacy lives in Settings.
 */
export const privacySettingsFields = {
  privacyOnboardingVersion: () => 1,
};

export const privacyProfileFields = {
  isPrivate: async (profile: { id: string; isPrivate?: boolean }) =>
    profile.isPrivate ?? (await getPrivacySettings(profile.id)).isPrivate,
  canViewActivity: async (profile: { id: string; canViewActivity?: boolean }, _: unknown, ctx: ConnectionContext) =>
    profile.canViewActivity ?? canViewUserActivity(ctx.isAuthenticated ? ctx.userId : null, profile.id),
};

export const privacySubscriptions = {
  privacyChanged: {
    subscribe: withSubscriptionCleanup(async function* (lifetime, _: unknown, __: unknown, ctx: ConnectionContext) {
      actor(ctx);
      const iterator = await lifetime.own(
        createAsyncIterator<boolean>((push) => pubsub.subscribePrivacy(() => push(true)), 'privacyChanged'),
      );
      // Reconnection is an invalidation too: Redis pub/sub has no replay window.
      // Keep this first event even though it costs every client a refresh on
      // connect: every shipped app bundle stamps its offline catalogue viewer
      // marker from it. Dropping it needs a client release that no longer waits
      // for it first.
      yield { privacyChanged: true };
      for await (const changed of iterator) yield { privacyChanged: changed };
    }),
  },
};
