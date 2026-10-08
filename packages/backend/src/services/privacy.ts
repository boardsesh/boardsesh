import { sessionBoardAccessCondition, userActivityVisibilityCondition } from '@boardsesh/db/queries';
export {
  approvedFollowerCondition,
  userActivityVisibilityCondition,
  contentVisibilityCondition,
  resourceAccessCondition,
  resourceLocationCondition,
  sessionBoardLocationCondition,
} from '@boardsesh/db/queries';
import { and, eq, sql } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import * as schema from '@boardsesh/db/schema';
import {
  canReadContent,
  canReadLocation,
  canReadResource,
  type PrivacySettings,
  type PrivacyResourceKind,
  type PrivacyResourceAudience,
  type PrivacyLocationAudience,
} from '@boardsesh/privacy';
import { db } from '../db/client';

type ViewerId = string | null | undefined;
export const privacyControlsEnabled = (): boolean => process.env.BOARDSESH_PRIVACY_ENABLED === '1';
export function requirePrivacyControls(): void {
  if (!privacyControlsEnabled())
    throw new GraphQLError('Privacy controls are not available yet', { extensions: { code: 'PRIVACY_UNAVAILABLE' } });
}
/** Old full-form booleans may narrow, but cannot replace a newer restricted audience. */
export function legacyResourceAudience(
  current: PrivacyResourceAudience | undefined,
  requested: PrivacyResourceAudience,
): PrivacyResourceAudience {
  if (!current || current === 'public' || requested === 'only_me') return requested;
  if (current === 'unlisted' && requested !== 'public') return requested;
  if (current === 'followers' && requested === 'invite_only') return requested;
  return current;
}

export async function getPrivacySettings(userId: string): Promise<PrivacySettings> {
  const [profile] = await db.select().from(schema.userProfiles).where(eq(schema.userProfiles.userId, userId)).limit(1);
  return {
    isPrivate: profile?.isPrivate ?? false,
    privacyRevision: profile?.privacyRevision ?? 0,
    privacyOnboardingVersion: profile?.privacyOnboardingVersion ?? 0,
    defaultSessionAudience: profile?.defaultSessionAudience ?? (profile?.isPrivate ? 'followers' : 'public'),
    enabled: privacyControlsEnabled(),
  };
}
export async function isApprovedFollower(viewerId: ViewerId, subjectId: string): Promise<boolean> {
  if (!viewerId) return false;
  const [follow] = await db
    .select({ id: schema.userFollows.id })
    .from(schema.userFollows)
    .where(and(eq(schema.userFollows.followerId, viewerId), eq(schema.userFollows.followingId, subjectId)))
    .limit(1);
  return !!follow;
}
export async function canViewUserActivity(viewerId: ViewerId, subjectId: string): Promise<boolean> {
  if (viewerId === subjectId) return true;
  const [subject] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.id, subjectId), userActivityVisibilityCondition(schema.users.id, viewerId)))
    .limit(1);
  return !!subject;
}
/** Account/item policy only. Callers must additionally apply enclosing wall/session access. */
export async function canViewContent(
  viewerId: ViewerId,
  entityType: string,
  entityId: string,
  ownerId: string | null,
): Promise<boolean> {
  if (ownerId && viewerId === ownerId) return true;
  const [content] = await db
    .select()
    .from(schema.contentPrivacy)
    .where(
      and(
        eq(schema.contentPrivacy.entityType, entityType as (typeof schema.contentPrivacy.$inferSelect)['entityType']),
        eq(schema.contentPrivacy.entityId, entityId),
      ),
    )
    .limit(1);
  if (!ownerId) return !content;
  const [owner] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, ownerId))
    .limit(1);
  if (!owner) return false;
  const [settings, approved] = await Promise.all([getPrivacySettings(ownerId), isApprovedFollower(viewerId, ownerId)]);
  return canReadContent(settings, content?.ownerId === ownerId ? content : null, {
    isOwner: false,
    isApprovedFollower: approved,
  });
}
export interface ResourcePrivacyState {
  kind: PrivacyResourceKind;
  resourceId: string;
  ownerId: string | null;
  audience: PrivacyResourceAudience;
  locationAudience: PrivacyLocationAudience;
  inheritFollowers: boolean;
  revision: number;
  hasOverride: boolean;
}
/** Read current ownership from the resource, never from a potentially stale override. */
export async function getResourcePrivacy(
  kind: PrivacyResourceKind,
  resourceId: string,
): Promise<ResourcePrivacyState | null> {
  let legacy: { ownerId: string | null; audience: PrivacyResourceAudience; locationAudience: PrivacyLocationAudience };
  if (kind === 'board') {
    const [board] = await db
      .select()
      .from(schema.userBoards)
      .where(and(eq(schema.userBoards.uuid, resourceId), sql`${schema.userBoards.deletedAt} IS NULL`))
      .limit(1);
    if (!board) return null;
    legacy = {
      ownerId: board.ownerId,
      audience:
        board.ownerId === '00000000-0000-0000-0000-000000000000'
          ? 'public'
          : board.isUnlisted
            ? 'unlisted'
            : board.isPublic
              ? 'public'
              : 'only_me',
      locationAudience: board.hideLocation ? 'only_me' : 'public',
    };
  } else {
    const [session] = await db
      .select()
      .from(schema.boardSessions)
      .where(eq(schema.boardSessions.id, resourceId))
      .limit(1);
    if (!session) return null;
    legacy = {
      ownerId: session.createdByUserId,
      audience: session.isPublic ? 'public' : 'invite_only',
      locationAudience: 'only_me',
    };
  }
  const [override] = await db
    .select()
    .from(schema.resourcePrivacy)
    .where(and(eq(schema.resourcePrivacy.kind, kind), eq(schema.resourcePrivacy.resourceId, resourceId)))
    .limit(1);
  return {
    kind,
    resourceId,
    ...legacy,
    audience: override?.audience ?? legacy.audience,
    locationAudience: override?.locationAudience ?? legacy.locationAudience,
    inheritFollowers: override?.inheritFollowers ?? false,
    revision: override?.revision ?? 0,
    hasOverride: !!override,
  };
}
async function resourceViewer(resource: ResourcePrivacyState, viewerId: ViewerId) {
  const [grant] = viewerId
    ? await db
        .select()
        .from(schema.resourceGrants)
        .where(
          and(
            eq(schema.resourceGrants.kind, resource.kind),
            eq(schema.resourceGrants.resourceId, resource.resourceId),
            eq(schema.resourceGrants.userId, viewerId),
          ),
        )
        .limit(1)
    : [];
  const [legacyParticipant] =
    viewerId && resource.kind === 'session' && !resource.hasOverride
      ? await db
          .select({ userId: schema.boardSessionParticipants.userId })
          .from(schema.boardSessionParticipants)
          .where(
            and(
              eq(schema.boardSessionParticipants.sessionId, resource.resourceId),
              eq(schema.boardSessionParticipants.userId, viewerId),
            ),
          )
          .limit(1)
      : [];
  return {
    isOwner: !!viewerId && resource.ownerId === viewerId,
    isApprovedFollower: !!resource.ownerId && (await isApprovedFollower(viewerId, resource.ownerId)),
    hasApprovedGrant: grant?.status === 'approved' || (!!legacyParticipant && grant?.status !== 'revoked'),
    hasRevokedGrant: grant?.status === 'revoked',
    inheritFollowers: resource.inheritFollowers,
  };
}
export async function canAccessResource(
  kind: PrivacyResourceKind,
  resourceId: string,
  viewerId: ViewerId,
): Promise<boolean> {
  const resource = await getResourcePrivacy(kind, resourceId);
  if (!resource) return false;
  if (!canReadResource(resource.audience, await resourceViewer(resource, viewerId))) return false;
  return kind !== 'session' || sessionBoardsAreReadable(resourceId, viewerId);
}
/** Numeric IDs, slugs and discovery are not unlisted-link capabilities. */
export async function canAccessResourceWithoutLink(
  kind: PrivacyResourceKind,
  resourceId: string,
  viewerId: ViewerId,
): Promise<boolean> {
  const resource = await getResourcePrivacy(kind, resourceId);
  if (!resource) return false;
  const hasAccess = canReadResource(
    resource.audience === 'unlisted' ? 'invite_only' : resource.audience,
    await resourceViewer(resource, viewerId),
  );
  return hasAccess && (kind !== 'session' || (await sessionBoardsAreReadable(resourceId, viewerId)));
}
async function sessionBoardsAreReadable(sessionId: string, viewerId: ViewerId): Promise<boolean> {
  const [accessible] = await db
    .select({ id: schema.boardSessions.id })
    .from(schema.boardSessions)
    .where(and(eq(schema.boardSessions.id, sessionId), sessionBoardAccessCondition(schema.boardSessions.id, viewerId)))
    .limit(1);
  return !!accessible;
}
export async function requireResourceAccess(
  kind: PrivacyResourceKind,
  resourceId: string,
  viewerId: ViewerId,
): Promise<void> {
  if (!(await canAccessResource(kind, resourceId, viewerId)))
    throw new GraphQLError('Not found', { extensions: { code: 'NOT_FOUND' } });
}
export async function canViewResourceLocation(boardUuid: string, viewerId: ViewerId): Promise<boolean> {
  const resource = await getResourcePrivacy('board', boardUuid);
  if (!resource) return false;
  const viewer = await resourceViewer(resource, viewerId);
  return canReadLocation(resource.locationAudience, {
    ...viewer,
    hasResourceAccess: canReadResource(resource.audience, viewer),
  });
}
/** SQL equivalent of canAccessResource for filtering before pagination and counts. */
export async function canViewActivityIdentity(
  subjectUserId: string,
  viewerId: ViewerId,
  context?: { sessionId?: string | null; boardId?: string | null; entityType?: string; entityId?: string },
): Promise<boolean> {
  if (subjectUserId === viewerId) return true;
  if (context?.sessionId && !(await canAccessResource('session', context.sessionId, viewerId))) return false;
  if (context?.boardId && !(await canAccessResource('board', context.boardId, viewerId))) return false;
  return context?.entityType && context.entityId
    ? canViewContent(viewerId, context.entityType, context.entityId, subjectUserId)
    : canViewUserActivity(viewerId, subjectUserId);
}

export type PrivacyExecutor = Pick<typeof db, 'select' | 'insert'>;
/** Call inside the writer's transaction before publishing any event. */
export async function setContentPrivacy(
  executor: PrivacyExecutor,
  userId: string,
  entityType: (typeof schema.contentPrivacy.$inferSelect)['entityType'],
  entityId: string,
  audience: (typeof schema.contentPrivacy.$inferSelect)['audience'],
  privacyRevision: number,
): Promise<void> {
  // The flag hides controls; queued publications must still commit their exact
  // audience during rollback. Authorization and stale-public consent stay active.
  await executor
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .for('no key update');
  const [profile] = await executor
    .select({ revision: schema.userProfiles.privacyRevision })
    .from(schema.userProfiles)
    .where(eq(schema.userProfiles.userId, userId))
    .limit(1);
  const currentRevision = profile?.revision ?? 0;
  if (audience === 'public' && privacyRevision !== currentRevision) {
    throw new GraphQLError('Privacy settings changed; choose an audience again', {
      extensions: { code: 'PRIVACY_REVISION_CONFLICT' },
    });
  }
  const settings = {
    ownerId: userId,
    audience,
    publicConsentRevision: audience === 'public' ? currentRevision : null,
    updatedAt: new Date(),
  };
  await executor
    .insert(schema.contentPrivacy)
    .values({ entityType, entityId, ...settings })
    .onConflictDoUpdate({
      target: [schema.contentPrivacy.entityType, schema.contentPrivacy.entityId],
      set: settings,
    });
}
export function betaPrivacyEntityId(boardType: string, climbUuid: string, link: string): string {
  return `${boardType}:${climbUuid}:${link}`;
}
