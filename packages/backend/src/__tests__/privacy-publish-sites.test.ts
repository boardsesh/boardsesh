import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { and, eq, isNotNull } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { pubsub } from '../pubsub';
import { logger } from '../utils/logger';
import { privacyMutations } from '../graphql/resolvers/privacy';
import { socialFollowMutations } from '../graphql/resolvers/social/follows';
import { socialBoardMutations } from '../graphql/resolvers/social/boards';
import { sessionEditMutations } from '../graphql/resolvers/social/session-mutations';
import { playlistMutations } from '../graphql/resolvers/playlists/mutations';
import { tickMutations } from '../graphql/resolvers/ticks/mutations';
import { reconcileInferredSessions } from '../services/inferred-sessions/reconcile';
import { ensureSessionRecordExists } from '../services/room-manager/client-lifecycle';
import { updateSessionBoardPathIfChanged } from '../services/room-manager/session-discovery';
import { getPrivacySettings } from '../services/privacy';
import { resetAllRateLimits } from '../utils/rate-limiter';

vi.mock('../events', () => ({ publishSocialEvent: vi.fn(async () => undefined) }));
vi.mock('../graphql/resolvers/ticks/debounced-climb-stats-publisher', () => ({
  queueClimbStatsRecompute: vi.fn(),
  recomputeClimbStatsNow: vi.fn(async () => undefined),
}));
vi.mock('../graphql/resolvers/sessions/debounced-stats-publisher', () => ({
  publishDebouncedSessionStats: vi.fn(),
}));
vi.mock('../graphql/resolvers/board-presence/stats', () => ({ queueBoardStatsPublish: vi.fn() }));

/**
 * Every privacyChanged event makes every connected app withdraw and refetch its
 * protected queries, so only a change in who may read something publishes.
 * Follows, renames and session regrouping must stay silent.
 */
const owner = 'privacy-publish-owner';
const privateOwner = 'privacy-publish-private';
const follower = 'privacy-publish-follower';
const member = 'privacy-publish-member';
const settingsUser = 'privacy-publish-settings';
const climber = 'privacy-publish-climber';
const users = [owner, privateOwner, follower, member, settingsUser, climber];

const HOUR = 60 * 60 * 1000;
const BASE = Date.UTC(2026, 4, 12, 9, 0, 0);
const iso = (epochMs: number) => new Date(epochMs).toISOString().replace('T', ' ').replace('Z', '');

const context = (userId: string) =>
  ({ isAuthenticated: true, userId, connectionId: `privacy-publish-${userId}` }) as ConnectionContext;

/** The sources published while `action` ran, in order. */
async function publishesDuring(action: () => Promise<unknown>): Promise<Array<string | undefined>> {
  const publish = vi.spyOn(pubsub, 'publishPrivacyChanged');
  try {
    await action();
    return publish.mock.calls.map(([source]) => source);
  } finally {
    publish.mockRestore();
  }
}

async function insertBoard(isPublic: boolean): Promise<{ id: number; uuid: string; slug: string }> {
  const uuid = randomUUID();
  const [board] = await db
    .insert(schema.userBoards)
    .values({
      uuid,
      slug: `privacy-publish-${uuid}`,
      ownerId: owner,
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 1,
      setIds: '1',
      name: 'Publish test wall',
      isPublic,
    })
    .returning({ id: schema.userBoards.id, uuid: schema.userBoards.uuid, slug: schema.userBoards.slug });
  return { id: Number(board.id), uuid: board.uuid, slug: board.slug };
}

async function insertTick(climbedAtMs: number): Promise<string> {
  const uuid = randomUUID();
  await db.insert(schema.boardseshTicks).values({
    uuid,
    userId: climber,
    boardType: 'kilter',
    climbUuid: 'privacy-publish-climb',
    angle: 40,
    status: 'send',
    attemptCount: 1,
    climbedAt: iso(climbedAtMs),
  });
  await db.transaction((tx) => reconcileInferredSessions(tx, climber, new Date(climbedAtMs)));
  return uuid;
}

async function climberSessionIds(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ sessionId: schema.boardseshTicks.sessionId })
    .from(schema.boardseshTicks)
    .where(and(eq(schema.boardseshTicks.userId, climber), isNotNull(schema.boardseshTicks.sessionId)));
  return rows.map((row) => row.sessionId!);
}

beforeAll(async () => {
  vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '1');
  await db.insert(schema.users).values(users.map((id) => ({ id, email: `${id}@test.com` })));
  await db.insert(schema.userProfiles).values({ userId: privateOwner, isPrivate: true });
});
beforeEach(() => resetAllRateLimits());
afterEach(() => {
  delete process.env.INFERRED_SESSIONS_ENABLED;
});
afterAll(() => vi.unstubAllEnvs());

describe('privacyChanged publish sites', () => {
  it('stays silent for follows, unfollows and follow requests', async () => {
    expect(
      await publishesDuring(() =>
        socialFollowMutations.followUser(null, { input: { userId: owner } }, context(follower)),
      ),
    ).toEqual([]);
    const [follow] = await db
      .select()
      .from(schema.userFollows)
      .where(and(eq(schema.userFollows.followerId, follower), eq(schema.userFollows.followingId, owner)));
    expect(follow).toBeDefined();
    expect(
      await publishesDuring(() =>
        socialFollowMutations.unfollowUser(null, { input: { userId: owner } }, context(follower)),
      ),
    ).toEqual([]);
    expect(
      await publishesDuring(() => privacyMutations.requestFollow(null, { userId: privateOwner }, context(follower))),
    ).toEqual([]);
    expect(
      await publishesDuring(() =>
        privacyMutations.cancelFollowRequest(null, { userId: privateOwner }, context(follower)),
      ),
    ).toEqual([]);
    await privacyMutations.requestFollow(null, { userId: privateOwner }, context(member));
    expect(
      await publishesDuring(() =>
        privacyMutations.declineFollowRequest(null, { userId: member }, context(privateOwner)),
      ),
    ).toEqual([]);
  });

  it('publishes once when access to an account is granted or withdrawn, never for a no-op', async () => {
    await privacyMutations.requestFollow(null, { userId: privateOwner }, context(follower));
    expect(
      await publishesDuring(() =>
        privacyMutations.approveFollowRequest(null, { userId: follower }, context(privateOwner)),
      ),
    ).toEqual(['approveFollowRequest']);
    expect(
      await publishesDuring(() =>
        privacyMutations.approveFollowRequest(null, { userId: follower }, context(privateOwner)),
      ),
    ).toEqual([]);
    expect(
      await publishesDuring(() => privacyMutations.removeFollower(null, { userId: follower }, context(privateOwner))),
    ).toEqual(['removeFollower']);
    expect(
      await publishesDuring(() => privacyMutations.removeFollower(null, { userId: follower }, context(privateOwner))),
    ).toEqual([]);
  });

  it('publishes account settings only when the account switch or session default changes', async () => {
    const update = (input: Record<string, unknown>) =>
      publishesDuring(() => privacyMutations.updatePrivacySettings(null, { input }, context(settingsUser)));
    const info = vi.spyOn(logger, 'info');
    try {
      expect(await update({ isPrivate: true })).toEqual(['updatePrivacySettings']);
      expect(info).toHaveBeenCalledWith(
        '[Privacy] privacyChanged published',
        expect.objectContaining({ source: 'updatePrivacySettings', count: expect.any(Number) }),
      );
    } finally {
      info.mockRestore();
    }
    expect(await update({ isPrivate: true })).toEqual([]);
    expect(await update({ privacyOnboardingVersion: 1 })).toEqual([]);
    expect(await update({ defaultSessionAudience: 'only_me' })).toEqual(['updatePrivacySettings']);
    expect(await update({ isPrivate: false })).toEqual(['updatePrivacySettings']);
  });

  it('publishes a board edit only when its audience or location changes', async () => {
    const board = await insertBoard(true);
    const edit = (input: Record<string, unknown>) =>
      publishesDuring(() =>
        socialBoardMutations.updateBoard(null, { input: { boardUuid: board.uuid, ...input } }, context(owner)),
      );
    expect(await edit({ name: 'Renamed wall' })).toEqual([]);
    // Old edit screens resend every visibility boolean with a rename.
    expect(await edit({ name: 'Renamed again', isPublic: true, hideLocation: false })).toEqual([]);
    expect(await edit({ description: 'New description' })).toEqual([]);
    expect(await edit({ isPublic: false })).toEqual(['updateBoard']);
    expect(await edit({ hideLocation: true })).toEqual(['updateBoard']);
  });

  it('publishes a session edit only when its visibility flips', async () => {
    const sessionId = randomUUID();
    await db
      .insert(schema.boardSessions)
      .values({ id: sessionId, createdByUserId: owner, boardPath: 'kilter/1/1/1/40', isPublic: true });
    const edit = (input: Record<string, unknown>) =>
      publishesDuring(() =>
        sessionEditMutations.updateSession(null, { input: { sessionId, ...input } }, context(owner)),
      );
    expect(await edit({ notes: 'Warm-up felt good' })).toEqual([]);
    expect(await edit({ name: 'Tuesday', notes: 'Edited', isPublic: true })).toEqual([]);
    expect(await edit({ isPublic: false })).toEqual(['updateSession']);
  });

  it('stays silent when a party moves its session to another wall', async () => {
    const first = await insertBoard(true);
    const second = await insertBoard(true);
    const sessionId = randomUUID();
    await ensureSessionRecordExists(sessionId, `/b/${first.slug}/40`, owner);
    expect(
      await publishesDuring(() => updateSessionBoardPathIfChanged(sessionId, `/b/${second.slug}/40`, owner)),
    ).toEqual([]);
    const [session] = await db
      .select({ boardId: schema.boardSessions.boardId })
      .from(schema.boardSessions)
      .where(eq(schema.boardSessions.id, sessionId));
    expect(session.boardId).toBe(second.id);
  });

  it('publishes a playlist edit only when its visibility flips', async () => {
    const uuid = randomUUID();
    const [playlist] = await db
      .insert(schema.playlists)
      .values({ uuid, boardType: 'kilter', name: 'Projects', isPublic: true })
      .returning();
    await db.insert(schema.playlistOwnership).values({ playlistId: playlist.id, userId: owner, role: 'owner' });
    const edit = (input: Record<string, unknown>) =>
      publishesDuring(() =>
        playlistMutations.updatePlaylist(null, { input: { playlistId: uuid, ...input } }, context(owner)),
      );
    expect(await edit({ name: 'Summer projects', isPublic: true })).toEqual([]);
    expect(await edit({ isPublic: false })).toEqual(['updatePlaylist']);
  });

  it('publishes resource access decisions, not access requests', async () => {
    const board = await insertBoard(false);
    const resource = { kind: 'board' as const, resourceId: board.uuid };
    expect(
      await publishesDuring(() =>
        privacyMutations.updateResourcePrivacy(
          null,
          { input: { ...resource, audience: 'invite_only' } },
          context(owner),
        ),
      ),
    ).toEqual(['updateResourcePrivacy']);
    expect(
      await publishesDuring(() => privacyMutations.requestResourceAccess(null, resource, context(member))),
    ).toEqual([]);
    const access = { ...resource, userId: member };
    expect(await publishesDuring(() => privacyMutations.approveResourceAccess(null, access, context(owner)))).toEqual([
      'approveResourceAccess',
    ]);
    expect(await publishesDuring(() => privacyMutations.approveResourceAccess(null, access, context(owner)))).toEqual(
      [],
    );
    expect(await publishesDuring(() => privacyMutations.revokeResourceAccess(null, access, context(owner)))).toEqual([
      'revokeResourceAccess',
    ]);
    expect(await publishesDuring(() => privacyMutations.inviteResourceMember(null, access, context(owner)))).toEqual([
      'inviteResourceMember',
    ]);
  });

  it('publishes an explicit tick audience choice, not tick edits that regroup sessions', async () => {
    process.env.INFERRED_SESSIONS_ENABLED = 'true';
    await insertTick(BASE);
    const evening = await insertTick(BASE + 10 * HOUR);
    const late = await insertTick(BASE + 40 * HOUR);
    expect(await climberSessionIds()).toHaveLength(3);

    // Moving the late climb into the gap welds the morning and evening runs
    // together and empties the late session: a merge, which used to publish.
    expect(
      await publishesDuring(() =>
        tickMutations.updateTick(
          null,
          { uuid: late, input: { climbedAt: new Date(BASE + 5 * HOUR).toISOString() } },
          context(climber),
        ),
      ),
    ).toEqual([]);
    expect(await climberSessionIds()).toHaveLength(1);
    expect(await publishesDuring(() => tickMutations.deleteTick(null, { uuid: evening }, context(climber)))).toEqual(
      [],
    );

    const { privacyRevision } = await getPrivacySettings(climber);
    expect(
      await publishesDuring(() =>
        tickMutations.updateTick(
          null,
          { uuid: late, input: { privacy: { audience: 'followers', privacyRevision } } },
          context(climber),
        ),
      ),
    ).toEqual(['updateTick']);
    expect(
      await publishesDuring(() =>
        privacyMutations.setContentAudience(
          null,
          { input: { entityType: 'tick', entityId: late, audience: 'only_me', privacyRevision } },
          context(climber),
        ),
      ),
    ).toEqual(['setContentAudience']);
  });
});
