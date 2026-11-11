import { and, eq, inArray } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
import { userProfiles } from '@boardsesh/db/schema/auth';
import type { ConsolidationContext, ConsolidationDomainHandler, ConsolidationTransaction } from './executor';
import { ConsolidationError } from './planner';

export type ConsolidationPreimageArchive = (
  context: ConsolidationContext,
  domain: string,
  preimages: Readonly<Record<string, unknown>>,
) => Promise<void>;

type Profile = typeof userProfiles.$inferSelect;
type SessionAudience = NonNullable<Profile['defaultSessionAudience']>;
const AUDIENCES: readonly SessionAudience[] = ['public', 'followers', 'invite_only', 'only_me'];

/** Preserve the canonical display fields; only privacy becomes more restrictive. */
export function consolidateProfilePrivacy(profiles: readonly Profile[], canonical: Profile | undefined) {
  const effectiveAudiences = profiles.map(
    (profile) => profile.defaultSessionAudience ?? (profile.isPrivate ? 'followers' : 'public'),
  );
  if (effectiveAudiences.some((audience) => !AUDIENCES.includes(audience))) throw new ConsolidationError('UNSAFE_PLAN');
  const audience = effectiveAudiences.reduce<SessionAudience>(
    (strictest, candidate) => (AUDIENCES.indexOf(candidate) > AUDIENCES.indexOf(strictest) ? candidate : strictest),
    'public',
  );
  const revision = Math.max(canonical?.privacyRevision ?? 0, ...profiles.map((profile) => profile.privacyRevision)) + 1;
  if (!Number.isSafeInteger(revision) || revision > 2147483647) throw new ConsolidationError('UNSAFE_PLAN');
  return {
    isPrivate: profiles.some((profile) => profile.isPrivate),
    anonymousOnForeignBoards: profiles.some((profile) => profile.anonymousOnForeignBoards),
    defaultSessionAudience: audience,
    privacyRevision: revision,
    updatedAt: new Date(),
  };
}

/** Freeze follower-scoped visibility before relationship union expands the canonical follower set. */
async function guardPreMergeFollowerPrivacy(
  transaction: ConsolidationTransaction,
  context: ConsolidationContext,
  profiles: readonly Profile[],
  archive: ConsolidationPreimageArchive,
): Promise<number> {
  const members = [context.survivorUserId, ...context.sourceUserIds];
  const follows = await transaction
    .select()
    .from(schema.userFollows)
    .where(inArray(schema.userFollows.followingId, members))
    .limit(100001);
  if (follows.length > 100000) throw new ConsolidationError('INPUT_LIMIT');
  const followerSets = members.map((userId) =>
    JSON.stringify(
      follows
        .filter((follow) => follow.followingId === userId && !members.includes(follow.followerId))
        .map((follow) => follow.followerId)
        .sort(),
    ),
  );
  if (new Set(followerSets).size <= 1) return 0;
  const originalPrivacy = await transaction
    .select()
    .from(schema.contentPrivacy)
    .where(inArray(schema.contentPrivacy.ownerId, members))
    .limit(100001)
    .for('update');
  const resourcePolicies = await transaction
    .select()
    .from(schema.resourcePrivacy)
    .where(inArray(schema.resourcePrivacy.ownerId, members))
    .limit(100001)
    .for('update');
  const privateOwners = profiles.filter((profile) => profile.isPrivate).map((profile) => profile.userId);
  const candidates: {
    entityType: typeof schema.contentPrivacy.$inferInsert.entityType;
    entityId: string;
    ownerId: string;
  }[] = originalPrivacy
    .filter((policy) => policy.audience === 'followers' && policy.ownerId !== null)
    .map((policy) => ({ entityType: policy.entityType, entityId: policy.entityId, ownerId: policy.ownerId! }));
  if (privateOwners.length) {
    const ticks = await transaction
      .select({ entityId: schema.boardseshTicks.uuid, ownerId: schema.boardseshTicks.userId })
      .from(schema.boardseshTicks)
      .where(inArray(schema.boardseshTicks.userId, privateOwners))
      .limit(100001);
    const comments = await transaction
      .select({ entityId: schema.comments.uuid, ownerId: schema.comments.userId })
      .from(schema.comments)
      .where(inArray(schema.comments.userId, privateOwners))
      .limit(100001);
    const sessions = await transaction
      .select({ entityId: schema.boardSessions.id, ownerId: schema.boardSessions.createdByUserId })
      .from(schema.boardSessions)
      .where(inArray(schema.boardSessions.createdByUserId, privateOwners))
      .limit(100001);
    const playlists = await transaction
      .select({ entityId: schema.playlists.uuid, ownerId: schema.playlistOwnership.userId })
      .from(schema.playlistOwnership)
      .innerJoin(schema.playlists, eq(schema.playlists.id, schema.playlistOwnership.playlistId))
      .where(and(inArray(schema.playlistOwnership.userId, privateOwners), eq(schema.playlistOwnership.role, 'owner')))
      .limit(100001);
    for (const [entityType, rows] of [
      ['tick', ticks],
      ['comment', comments],
      ['session', sessions],
      ['playlist', playlists],
    ] as const) {
      for (const row of rows)
        if (row.ownerId !== null) candidates.push({ entityType, entityId: row.entityId, ownerId: row.ownerId });
    }
  }
  if (candidates.length > 100000 || originalPrivacy.length > 100000 || resourcePolicies.length > 100000)
    throw new ConsolidationError('INPUT_LIMIT');
  const originalByEntity = new Map(
    originalPrivacy.map((policy) => [JSON.stringify([policy.entityType, policy.entityId]), policy]),
  );
  const profileByOwner = new Map(profiles.map((profile) => [profile.userId, profile]));
  const guards = new Map<string, (typeof candidates)[number]>();
  for (const candidate of candidates) {
    const key = JSON.stringify([candidate.entityType, candidate.entityId]);
    const existing = originalByEntity.get(key);
    if (existing?.audience === 'only_me') continue;
    if (
      existing?.audience === 'public' &&
      existing.publicConsentRevision === profileByOwner.get(candidate.ownerId)?.privacyRevision
    )
      continue;
    guards.set(key, candidate);
  }
  await archive(context, 'pre-merge-follower-privacy', {
    follows,
    originalPrivacy,
    resourcePolicies,
    guardedEntities: [...guards.values()],
  });
  for (const candidate of guards.values()) {
    const written = await transaction
      .insert(schema.contentPrivacy)
      .values({ ...candidate, audience: 'only_me', publicConsentRevision: null })
      .onConflictDoUpdate({
        target: [schema.contentPrivacy.entityType, schema.contentPrivacy.entityId],
        set: { audience: 'only_me', publicConsentRevision: null, updatedAt: new Date() },
        setWhere: eq(schema.contentPrivacy.ownerId, candidate.ownerId),
      })
      .returning({ entityId: schema.contentPrivacy.entityId });
    if (written.length !== 1) throw new ConsolidationError('UNSAFE_PLAN');
  }
  for (const policy of resourcePolicies) {
    const guardAudience = policy.audience === 'followers' || policy.inheritFollowers;
    if (guardAudience || policy.locationAudience === 'followers')
      await transaction
        .update(schema.resourcePrivacy)
        .set({
          ...(guardAudience ? { audience: 'only_me' as const, inheritFollowers: false } : {}),
          ...(policy.locationAudience === 'followers' ? { locationAudience: 'only_me' as const } : {}),
          revision: policy.revision + 1,
          updatedAt: new Date(),
        })
        .where(
          and(eq(schema.resourcePrivacy.kind, policy.kind), eq(schema.resourcePrivacy.resourceId, policy.resourceId)),
        );
  }
  return guards.size;
}

export function createConsolidationProfileHandler(options: {
  readonly archivePreimages: ConsolidationPreimageArchive;
}): ConsolidationDomainHandler {
  return {
    name: 'profile',
    userReferences: ['public.user_profiles.user_id'],
    async apply(transaction, context) {
      const profiles = await transaction
        .select()
        .from(userProfiles)
        .where(inArray(userProfiles.userId, [context.survivorUserId, ...context.sourceUserIds]))
        .orderBy(userProfiles.userId)
        .for('update');
      const canonical = profiles.find((profile) => profile.userId === context.survivorUserId);
      const privacy = consolidateProfilePrivacy(profiles, canonical);
      const followerPrivacyGuards = await guardPreMergeFollowerPrivacy(
        transaction,
        context,
        profiles,
        options.archivePreimages,
      );
      // The mandatory sink persists exact originals outside the public audit before writes.
      await options.archivePreimages(context, 'profile', { profiles });
      if (canonical) {
        await transaction.update(userProfiles).set(privacy).where(eq(userProfiles.userId, context.survivorUserId));
      } else {
        await transaction.insert(userProfiles).values({ userId: context.survivorUserId, ...privacy });
      }
      // Source profiles remain attached to retired source rows for provenance.
      return {
        canonicalProfilesWritten: 1,
        followerPrivacyGuards,
        sourceProfilesPreserved: profiles.filter((profile) => profile.userId !== context.survivorUserId).length,
      };
    },
  };
}
