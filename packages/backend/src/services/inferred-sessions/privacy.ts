import { and, asc, eq, inArray } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
import type { PrivacyResourceAudience } from '@boardsesh/privacy';
import type { ReconciliationTransaction } from './window-loader';

type GrantStatus = 'pending' | 'approved' | 'revoked';
export type InferredPrivacy = {
  audience: PrivacyResourceAudience;
  inheritFollowers: boolean;
  grants: Map<string, GrantStatus>;
};

/** Intersection is conservative: a follower exception never becomes a durable grant. */
export function intersectInferredPrivacy(policies: readonly InferredPrivacy[]): InferredPrivacy {
  if (policies.length === 1) return policies[0];
  const acceptsFollowers = (policy: InferredPrivacy) =>
    policy.audience !== 'only_me' &&
    (policy.audience === 'public' || policy.audience === 'followers' || policy.inheritFollowers);
  const audience: PrivacyResourceAudience = policies.some((policy) => policy.audience === 'only_me')
    ? 'only_me'
    : policies.every((policy) => policy.audience === 'public')
      ? 'public'
      : policies.every(acceptsFollowers)
        ? 'followers'
        : 'invite_only';
  const candidates = new Set(policies.flatMap((policy) => [...policy.grants.keys()]));
  const grants = new Map<string, GrantStatus>();
  for (const userId of candidates) {
    if (policies.some((policy) => policy.grants.get(userId) === 'revoked')) grants.set(userId, 'revoked');
    else if (policies.every((policy) => policy.audience === 'public' || policy.grants.get(userId) === 'approved'))
      grants.set(userId, 'approved');
  }
  return { audience, inheritFollowers: false, grants };
}

export async function loadInferredPrivacy(
  tx: ReconciliationTransaction,
  sessionIds: string[],
): Promise<Map<string, InferredPrivacy>> {
  if (!sessionIds.length) return new Map();
  const sessions = await tx
    .select({ id: schema.boardSessions.id, isPublic: schema.boardSessions.isPublic })
    .from(schema.boardSessions)
    .where(inArray(schema.boardSessions.id, sessionIds))
    .orderBy(asc(schema.boardSessions.id))
    .for('update');
  const [policies, grants, participants] = await Promise.all([
    tx
      .select()
      .from(schema.resourcePrivacy)
      .where(and(eq(schema.resourcePrivacy.kind, 'session'), inArray(schema.resourcePrivacy.resourceId, sessionIds))),
    tx
      .select()
      .from(schema.resourceGrants)
      .where(and(eq(schema.resourceGrants.kind, 'session'), inArray(schema.resourceGrants.resourceId, sessionIds))),
    tx
      .select({ sessionId: schema.boardSessionParticipants.sessionId, userId: schema.boardSessionParticipants.userId })
      .from(schema.boardSessionParticipants)
      .where(inArray(schema.boardSessionParticipants.sessionId, sessionIds)),
  ]);
  const result = new Map<string, InferredPrivacy>(
    sessions.map(
      (session) =>
        [
          session.id,
          {
            audience: session.isPublic ? ('public' as const) : ('invite_only' as const),
            inheritFollowers: false,
            grants: new Map<string, GrantStatus>(),
          },
        ] as const,
    ),
  );
  for (const policy of policies)
    result.set(policy.resourceId, {
      audience: policy.audience,
      inheritFollowers: policy.inheritFollowers,
      grants: new Map(),
    });
  const explicitPolicies = new Set(policies.map((policy) => policy.resourceId));
  for (const participant of participants)
    if (!explicitPolicies.has(participant.sessionId))
      result.get(participant.sessionId)?.grants.set(participant.userId, 'approved');
  for (const grant of grants) result.get(grant.resourceId)?.grants.set(grant.userId, grant.status);
  return result;
}

export async function writeInferredPrivacy(
  tx: ReconciliationTransaction,
  sessionId: string,
  userId: string,
  privacy: InferredPrivacy,
): Promise<void> {
  await tx
    .insert(schema.resourcePrivacy)
    .values({
      kind: 'session',
      resourceId: sessionId,
      ownerId: userId,
      audience: privacy.audience,
      inheritFollowers: privacy.inheritFollowers,
    })
    .onConflictDoUpdate({
      target: [schema.resourcePrivacy.kind, schema.resourcePrivacy.resourceId],
      set: { audience: privacy.audience, inheritFollowers: privacy.inheritFollowers },
    });
  // Existing approved grants that failed the intersection must be explicitly
  // revoked, so a future audience change cannot revive them accidentally.
  const existing = await tx
    .select({ userId: schema.resourceGrants.userId })
    .from(schema.resourceGrants)
    .where(and(eq(schema.resourceGrants.kind, 'session'), eq(schema.resourceGrants.resourceId, sessionId)));
  const grants = new Map(privacy.grants);
  for (const grant of existing) if (!grants.has(grant.userId)) grants.set(grant.userId, 'revoked');
  for (const [grantee, status] of grants) {
    await tx
      .insert(schema.resourceGrants)
      .values({ kind: 'session', resourceId: sessionId, userId: grantee, status })
      .onConflictDoUpdate({
        target: [schema.resourceGrants.kind, schema.resourceGrants.resourceId, schema.resourceGrants.userId],
        set: { status },
      });
  }
  await tx
    .update(schema.boardSessions)
    .set({ isPublic: privacy.audience === 'public' })
    .where(eq(schema.boardSessions.id, sessionId));
}
