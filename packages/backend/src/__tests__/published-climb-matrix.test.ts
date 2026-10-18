import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createRequire } from 'node:module';
import type * as GraphQLModule from 'graphql';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
import type { BoardPresenceStats, ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { schema as graphqlSchema } from '../graphql/index';
import { searchCache } from '../services/search-cache';
import { redactBoardStats } from '../services/board-session-privacy';
import { computeBoardPresenceStats } from '../graphql/resolvers/board-presence/stats';
import { playlistClimbs } from '../graphql/resolvers/playlists/queries/playlist-climbs';
import { smartPlaylist } from '../graphql/resolvers/playlists/queries/smart-playlists';
import { climbQueries } from '../graphql/resolvers/climbs/queries';
import { setterFollowQueries } from '../graphql/resolvers/social/setter-follows';
import { resolveClimbAuthorId } from '../graphql/resolvers/climbs/climb-author';
import {
  canReadSocialEntity,
  canSeeActorOnEntity,
  notificationPrivacyCondition,
  tickPrivacyCondition,
} from '../graphql/resolvers/shared/activity-privacy';
import { userMutations } from '../graphql/resolvers/users/mutations';
import { socialFeedQueries } from '../graphql/resolvers/social/feed';
import { climbLogsQueries } from '../graphql/resolvers/social/climb-logs';
import { socialProposalQueries } from '../graphql/resolvers/social/proposals';
import { batchEnrichProposals } from '../graphql/resolvers/social/proposals/enrichment';
import { socialCommentQueries } from '../graphql/resolvers/social/comments';
import { socialNotificationQueries } from '../graphql/resolvers/social/notifications';
import { resetAllRateLimits } from '../utils/rate-limiter';

// ---------------------------------------------------------------------------
// A published climb is public everywhere (real Postgres).
//
// Published and listed, a climb is public to everyone, signed in or not, whoever
// set it: a private account, a followers-only tick on it, or an author who has
// since deleted their account changes nothing. A draft is its owner's alone,
// by uuid too. An unlisted climb is out of the lists but still opens by uuid.
// The first-ascent name is a tick rule: the earliest send this viewer may read.
// Who set a published, listed climb is public with it (#6418): its account id,
// and the account behind its setter name, go to everyone. What a private
// account keeps private is its activity.
// ---------------------------------------------------------------------------

const describeWithDatabase = process.env.SKIP_TEST_INFRA === '1' ? describe.skip : describe;

const BOARD = 'kilter';
const LAYOUT_ID = 99_783;
const ANGLE = 40;
const SETTER_NAME = 'matrix-private-setter';

const PRIVATE_AUTHOR = 'matrix-private-author';
const FOLLOWER = 'matrix-follower';
const STRANGER = 'matrix-stranger';
const PRIVATE_SENDER = 'matrix-private-sender';
const PUBLIC_SENDER = 'matrix-public-sender';
const DELETED_AUTHOR = 'matrix-deleted-author';
/** A private account linked to a Kilter login only, with no Boardsesh-authored climb under it. */
const MAPPED_PRIVATE = 'matrix-mapped-private';
/** A private account with no linked board login, which set a climb in Boardsesh (as a MoonBoard climb is set). */
const UNLINKED_AUTHOR = 'matrix-unlinked-author';
const USERS = [
  PRIVATE_AUTHOR,
  FOLLOWER,
  STRANGER,
  PRIVATE_SENDER,
  PUBLIC_SENDER,
  DELETED_AUTHOR,
  MAPPED_PRIVATE,
  UNLINKED_AUTHOR,
];

const PRIVATE_PUBLISHED = 'matrix-private-published';
const TICKED_PUBLISHED = 'matrix-ticked-published';
const LINKED_ONLY = 'matrix-linked-only';
const DELETED_PUBLISHED = 'matrix-deleted-published';
const DRAFT = 'matrix-draft';
const UNLISTED = 'matrix-unlisted';
/** The deleted author's draft: account deletion deletes the row outright. */
const DELETED_DRAFT = 'matrix-deleted-draft';
/**
 * A draft nobody owns, as an import from before imports stamped an owner left
 * it. The row stays, so a by-uuid read reaches the draft rule, and the rule
 * returns it to no one.
 */
const OWNERLESS_DRAFT = 'matrix-ownerless-draft';
const ALL_CLIMBS = [PRIVATE_PUBLISHED, TICKED_PUBLISHED, LINKED_ONLY, DELETED_PUBLISHED, DRAFT, UNLISTED];
/** Published and listed, then hidden by the community: moderation, not privacy. */
const HIDDEN = 'matrix-hidden';
/** A public account's climbs, one of them hidden by the community. */
const PUBLIC_SHOWN = 'matrix-public-shown';
const PUBLIC_HIDDEN = 'matrix-public-hidden';
/** Imported under the mapped private account's Kilter login: no `user_id`. */
const MAPPED_SETTER_NAME = 'matrix-mapped-setter';
const MAPPED_ONLY = 'matrix-mapped-only';
/** The mapped private account's own climb under that name, hidden by the community. */
const MAPPED_HIDDEN = 'matrix-mapped-hidden';
/** A Kilter setter name that a public account linked on Tension, not on Kilter. */
const CROSS_BOARD_SETTER_NAME = 'matrix-cross-board-setter';
const CROSS_BOARD = 'matrix-cross-board';
const UNLINKED_SETTER_NAME = 'matrix-unlinked-setter';
const UNLINKED_AUTHORED = 'matrix-unlinked-authored';

// `graphql` resolves to two module instances under the test transform. The
// schema was built with the CJS copy, so `execute` has to come from the same
// one. See spray-visibility-sweep.test.ts for the long version.
const { execute, parse } = createRequire(import.meta.url)('graphql') as typeof GraphQLModule;

const ctxFor = (userId: string): ConnectionContext =>
  ({ userId, isAuthenticated: true, connectionId: `matrix-${userId}` }) as ConnectionContext;
const anonymous = { isAuthenticated: false, userId: undefined, connectionId: 'matrix-anon' } as ConnectionContext;
const boardInput = { boardName: BOARD, layoutId: LAYOUT_ID, sizeId: 1, setIds: '1', angle: ANGLE };

async function removeFixtures(): Promise<void> {
  await db.execute(sql`DELETE FROM user_favorites WHERE climb_uuid LIKE 'matrix-%'`);
  await db.execute(sql`DELETE FROM playlists WHERE uuid LIKE 'matrix-%'`);
  await db.execute(sql`DELETE FROM comments WHERE uuid LIKE 'matrix-%'`);
  await db.execute(sql`DELETE FROM climb_proposals WHERE uuid LIKE 'matrix-%'`);
  await db.execute(sql`DELETE FROM notifications WHERE uuid LIKE 'matrix-%'`);
  await db.execute(sql`DELETE FROM content_privacy WHERE entity_id LIKE 'matrix-%'`);
  await db.execute(sql`DELETE FROM boardsesh_ticks WHERE climb_uuid LIKE 'matrix-%'`);
  await db.execute(sql`DELETE FROM board_climb_stats WHERE climb_uuid LIKE 'matrix-%'`);
  await db.execute(sql`DELETE FROM board_climbs WHERE uuid LIKE 'matrix-%'`);
  await db.execute(sql`DELETE FROM user_boards WHERE uuid LIKE 'matrix-%'`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${sql.join(USERS, sql`, `)})`);
}

async function insertClimb(
  uuid: string,
  userId: string | null,
  options: { isDraft?: boolean; isListed?: boolean; isHidden?: boolean; setterUsername?: string },
) {
  await db.insert(schema.boardClimbs).values({
    uuid,
    boardType: BOARD,
    layoutId: LAYOUT_ID,
    userId,
    name: `Name of ${uuid}`,
    setterUsername: options.setterUsername ?? SETTER_NAME,
    frames: 'p1r12p2r13',
    framesCount: 1,
    isDraft: options.isDraft ?? false,
    isListed: options.isListed ?? true,
    isHidden: options.isHidden ?? false,
    compatibleSizeIds: [1],
    requiredSetIds: [1],
  });
  await db.insert(schema.boardClimbStats).values({
    boardType: BOARD,
    climbUuid: uuid,
    angle: ANGLE,
    displayDifficulty: 20,
    ascensionistCount: 2,
    faUsername: 'Stored first ascensionist',
    // What recompute stores: the earliest send of ANY visibility, here the
    // private sender's followers-only flash.
    faAt: '2026-01-01T10:00:00Z',
  });
}

describeWithDatabase('a published climb is public everywhere (real DB)', () => {
  beforeAll(async () => {
    await removeFixtures();
    await db.insert(schema.users).values(USERS.map((id) => ({ id, name: `Name ${id}`, email: `${id}@example.test` })));
    await db.insert(schema.userProfiles).values([
      { userId: PRIVATE_AUTHOR, isPrivate: true },
      { userId: PRIVATE_SENDER, isPrivate: true },
      { userId: DELETED_AUTHOR, isPrivate: true },
      { userId: MAPPED_PRIVATE, isPrivate: true },
      { userId: UNLINKED_AUTHOR, isPrivate: true, displayName: 'Unlinked author' },
      { userId: PUBLIC_SENDER, isPrivate: false, displayName: 'Public sender' },
    ]);
    await db.insert(schema.userFollows).values([
      { followerId: FOLLOWER, followingId: PRIVATE_AUTHOR },
      { followerId: FOLLOWER, followingId: PRIVATE_SENDER },
    ]);
    // The private author's linked board account sets under the same name.
    await db.insert(schema.userBoardMappings).values([
      { userId: PRIVATE_AUTHOR, boardType: BOARD, boardUsername: SETTER_NAME },
      { userId: MAPPED_PRIVATE, boardType: BOARD, boardUsername: MAPPED_SETTER_NAME },
      { userId: PUBLIC_SENDER, boardType: 'tension', boardUsername: CROSS_BOARD_SETTER_NAME },
    ]);

    await insertClimb(PRIVATE_PUBLISHED, PRIVATE_AUTHOR, {});
    await insertClimb(TICKED_PUBLISHED, PRIVATE_AUTHOR, {});
    await insertClimb(LINKED_ONLY, null, {});
    await insertClimb(DELETED_PUBLISHED, DELETED_AUTHOR, { setterUsername: 'matrix-deleted-setter' });
    await insertClimb(DRAFT, PRIVATE_AUTHOR, { isDraft: true, isListed: false });
    await insertClimb(UNLISTED, PRIVATE_AUTHOR, { isListed: false });
    await insertClimb(HIDDEN, PRIVATE_AUTHOR, { isHidden: true });
    await insertClimb(PUBLIC_HIDDEN, PUBLIC_SENDER, { isHidden: true, setterUsername: 'matrix-public-setter' });
    await insertClimb(PUBLIC_SHOWN, PUBLIC_SENDER, { setterUsername: 'matrix-public-setter' });
    await insertClimb(MAPPED_ONLY, null, { setterUsername: MAPPED_SETTER_NAME });
    await insertClimb(MAPPED_HIDDEN, MAPPED_PRIVATE, { setterUsername: MAPPED_SETTER_NAME, isHidden: true });
    await insertClimb(CROSS_BOARD, null, { setterUsername: CROSS_BOARD_SETTER_NAME });
    await insertClimb(UNLINKED_AUTHORED, UNLINKED_AUTHOR, { setterUsername: UNLINKED_SETTER_NAME });
    await insertClimb(DELETED_DRAFT, DELETED_AUTHOR, {
      isDraft: true,
      isListed: false,
      setterUsername: 'matrix-deleted-setter',
    });
    await insertClimb(OWNERLESS_DRAFT, null, {
      isDraft: true,
      isListed: false,
      setterUsername: 'matrix-ownerless-setter',
    });

    // The first send is a private account's, explicitly followers-only; the
    // second is a public account's.
    await db.insert(schema.boardseshTicks).values([
      {
        uuid: 'matrix-followers-only-tick',
        userId: PRIVATE_SENDER,
        boardType: BOARD,
        climbUuid: TICKED_PUBLISHED,
        angle: ANGLE,
        status: 'flash',
        climbedAt: '2026-01-01T10:00:00Z',
      },
      {
        uuid: 'matrix-public-tick',
        userId: PUBLIC_SENDER,
        boardType: BOARD,
        climbUuid: TICKED_PUBLISHED,
        angle: ANGLE,
        status: 'send',
        climbedAt: '2026-01-02T10:00:00Z',
      },
    ]);
    await db.insert(schema.contentPrivacy).values({
      entityType: 'tick',
      entityId: 'matrix-followers-only-tick',
      ownerId: PRIVATE_SENDER,
      audience: 'followers',
    });

    // Notifications the deleted author caused, written while the account existed.
    await db.insert(schema.notifications).values(
      [DELETED_PUBLISHED, DELETED_DRAFT].map((climbUuid) => ({
        uuid: `matrix-n-${climbUuid}`,
        recipientId: STRANGER,
        actorId: DELETED_AUTHOR,
        type: 'new_climb' as const,
        entityType: 'climb' as const,
        entityId: climbUuid,
      })),
    );
    // One about the ownerless draft, with no actor, so only the climb decides it.
    await db.insert(schema.notifications).values({
      uuid: `matrix-n-${OWNERLESS_DRAFT}`,
      recipientId: STRANGER,
      actorId: null,
      type: 'new_climb',
      entityType: 'climb',
      entityId: OWNERLESS_DRAFT,
    });

    await userMutations.deleteAccount(null, { input: { removeSetterName: false } }, ctxFor(DELETED_AUTHOR));
  });
  afterAll(removeFixtures);
  beforeEach(() => resetAllRateLimits());

  it('kept the deleted author’s published climb, with no author', async () => {
    const [climb] = await db
      .select({ userId: schema.boardClimbs.userId, marked: schema.boardClimbs.isBoardseshAuthored })
      .from(schema.boardClimbs)
      .where(eq(schema.boardClimbs.uuid, DELETED_PUBLISHED));
    expect(climb).toEqual({ userId: null, marked: true });
    // Their draft did not lose its owner: it was deleted with the account.
    const draftRows = await db
      .select({ uuid: schema.boardClimbs.uuid })
      .from(schema.boardClimbs)
      .where(eq(schema.boardClimbs.uuid, DELETED_DRAFT));
    expect(draftRows).toEqual([]);
  });

  describe.each([
    ['a stranger', ctxFor(STRANGER)],
    ['an anonymous caller', anonymous],
    ['an approved follower', ctxFor(FOLLOWER)],
  ])('for %s', (_label, ctx) => {
    it('opens every published climb by uuid, unlisted included, and never the draft', async () => {
      for (const climbUuid of ALL_CLIMBS) {
        const climb = await climbQueries.climb({}, { ...boardInput, climbUuid }, ctx);
        expect(climb?.uuid ?? null, climbUuid).toBe(climbUuid === DRAFT ? null : climbUuid);
      }
    });

    it('reads the stats of every published climb, and none of the draft', async () => {
      for (const climbUuid of ALL_CLIMBS) {
        const rows = await climbQueries.climbStatsForAngles(undefined, { boardName: BOARD, climbUuid }, ctx);
        expect(rows.length, climbUuid).toBe(climbUuid === DRAFT ? 0 : 1);
      }
    });

    it("counts the private account's published, listed climbs on its setter page", async () => {
      const profile = await setterFollowQueries.setterProfile(undefined, { input: { username: SETTER_NAME } }, ctx);
      // Its own two, and the one its linked board account set; the draft and
      // the unlisted climb are out.
      expect(profile?.climbCount).toBe(3);
      const deleted = await setterFollowQueries.setterProfile(
        undefined,
        { input: { username: 'matrix-deleted-setter' } },
        ctx,
      );
      expect(deleted?.climbCount).toBe(1);
    });
  });

  it('names a private account behind a setter name it set Boardsesh climbs under, to everyone', async () => {
    // Who set a published, listed climb is public with it: the private author
    // is the `user_id` on published, listed climbs under this name.
    for (const ctx of [ctxFor(STRANGER), anonymous, ctxFor(FOLLOWER)]) {
      const profile = await setterFollowQueries.setterProfile(undefined, { input: { username: SETTER_NAME } }, ctx);
      expect(profile).toMatchObject({ linkedUserId: PRIVATE_AUTHOR, linkedUserDisplayName: `Name ${PRIVATE_AUTHOR}` });
    }
  });

  it('names a private account that set climbs under a name with no linked login', async () => {
    // A MoonBoard climb, or any climb set in Boardsesh, carries the author's
    // `user_id` with no Kilter or Tension login behind it.
    for (const ctx of [ctxFor(STRANGER), anonymous]) {
      const profile = await setterFollowQueries.setterProfile(
        undefined,
        { input: { username: UNLINKED_SETTER_NAME } },
        ctx,
      );
      expect(profile).toMatchObject({ linkedUserId: UNLINKED_AUTHOR, linkedUserDisplayName: 'Unlinked author' });
    }
  });

  it('keeps a private account linked to a setter name by its Kilter login alone from strangers', async () => {
    // No listable climb under this name carries the account's id, so naming it
    // would reveal which board login the private account linked. Its own climb
    // there was hidden by the community, and a hidden climb names no one.
    const profileFor = (ctx: ConnectionContext) =>
      setterFollowQueries.setterProfile(undefined, { input: { username: MAPPED_SETTER_NAME } }, ctx);
    for (const ctx of [ctxFor(STRANGER), anonymous, ctxFor(FOLLOWER)]) {
      const profile = await profileFor(ctx);
      expect(profile?.climbCount).toBe(1);
      expect(profile?.linkedUserId ?? null).toBeNull();
      expect(profile?.linkedUserDisplayName ?? null).toBeNull();
    }
    expect((await profileFor(ctxFor(MAPPED_PRIVATE)))?.linkedUserId).toBe(MAPPED_PRIVATE);

    // Nor are the climbs imported under that login listed under the account.
    for (const ctx of [ctxFor(STRANGER), anonymous]) {
      expect(await setterFollowQueries.userClimbs(undefined, { input: { userId: MAPPED_PRIVATE } }, ctx)).toEqual({
        climbs: [],
        totalCount: 0,
        hasMore: false,
      });
    }
    const forOwner = await setterFollowQueries.userClimbs(
      undefined,
      { input: { userId: MAPPED_PRIVATE } },
      ctxFor(MAPPED_PRIVATE),
    );
    expect(forOwner.climbs.map((climb) => climb.uuid).sort()).toEqual([MAPPED_HIDDEN, MAPPED_ONLY].sort());
  });

  it("never names an account whose login is on another board type than the setter name's climbs", async () => {
    // A public account linked Tension "matrix-cross-board-setter"; the climbs
    // under that name are on Kilter, set by someone else.
    for (const ctx of [ctxFor(STRANGER), anonymous, ctxFor(PUBLIC_SENDER)]) {
      const profile = await setterFollowQueries.setterProfile(
        undefined,
        { input: { username: CROSS_BOARD_SETTER_NAME } },
        ctx,
      );
      expect(profile?.climbCount).toBe(1);
      expect(profile?.linkedUserId ?? null).toBeNull();
    }
  });

  it("lists a private account's own published, listed climbs to everyone, and its linked login's to followers", async () => {
    // A stranger and an anonymous caller get the published, listed climbs
    // whose `user_id` is the account. The climb imported under its linked
    // Kilter login carries no `user_id`, so it stays with the viewers who may
    // see the account's activity.
    for (const ctx of [ctxFor(STRANGER), anonymous]) {
      const listed = await setterFollowQueries.userClimbs(undefined, { input: { userId: PRIVATE_AUTHOR } }, ctx);
      expect(listed.climbs.map((climb) => climb.uuid).sort()).toEqual([PRIVATE_PUBLISHED, TICKED_PUBLISHED].sort());
      expect(listed.totalCount).toBe(2);
    }
    // A follower also gets the linked login's climb. Nobody but the owner gets
    // the one the community hid, the unlisted one or the draft.
    const forFollower = await setterFollowQueries.userClimbs(
      undefined,
      { input: { userId: PRIVATE_AUTHOR } },
      ctxFor(FOLLOWER),
    );
    expect(forFollower.climbs.map((climb) => climb.uuid).sort()).toEqual(
      [PRIVATE_PUBLISHED, TICKED_PUBLISHED, LINKED_ONLY].sort(),
    );
    expect(forFollower.totalCount).toBe(3);
    expect(forFollower.climbs.every((climb) => climb.is_hidden !== true)).toBe(true);

    // The owner also sees their unlisted climb, and the hidden one flagged.
    const forOwner = await setterFollowQueries.userClimbs(
      undefined,
      { input: { userId: PRIVATE_AUTHOR } },
      ctxFor(PRIVATE_AUTHOR),
    );
    expect(forOwner.climbs.map((climb) => climb.uuid).sort()).toEqual(
      [PRIVATE_PUBLISHED, TICKED_PUBLISHED, LINKED_ONLY, UNLISTED, HIDDEN].sort(),
    );
    expect(forOwner.climbs.find((climb) => climb.uuid === HIDDEN)?.is_hidden).toBe(true);
  });

  it("keeps a public account's community-hidden climb out of its list for anyone but the owner", async () => {
    const listed = async (ctx: ConnectionContext) =>
      (await setterFollowQueries.userClimbs(undefined, { input: { userId: PUBLIC_SENDER } }, ctx)).climbs
        .map((climb) => climb.uuid)
        .sort();
    expect(await listed(ctxFor(STRANGER))).toEqual([PUBLIC_SHOWN]);
    expect(await listed(ctxFor(PUBLIC_SENDER))).toEqual([PUBLIC_HIDDEN, PUBLIC_SHOWN]);
  });

  it('opens the draft to its owner alone', async () => {
    const climb = await climbQueries.climb({}, { ...boardInput, climbUuid: DRAFT }, ctxFor(PRIVATE_AUTHOR));
    expect(climb?.uuid).toBe(DRAFT);
  });

  it('never hides a tick because of who set its climb', async () => {
    for (const viewer of [STRANGER, null]) {
      const ticks = await db
        .select({ uuid: schema.boardseshTicks.uuid })
        .from(schema.boardseshTicks)
        .where(and(eq(schema.boardseshTicks.climbUuid, TICKED_PUBLISHED), tickPrivacyCondition(viewer)));
      // The private sender's followers-only tick stays theirs; the public one shows.
      expect(ticks.map((tick) => tick.uuid)).toEqual(['matrix-public-tick']);
    }
  });

  it('credits the first ascent to the earliest send the viewer may read, and dates that send', async () => {
    const firstAscent = async (ctx: ConnectionContext) => {
      const [row] = await climbQueries.climbStatsForAngles(
        undefined,
        { boardName: BOARD, climbUuid: TICKED_PUBLISHED },
        ctx,
      );
      return { name: row?.faUsername, at: String(row?.faAt).slice(0, 10) };
    };
    // The first send is hidden from a stranger, so the credit falls to the next
    // visible one, with ITS date: never the stored date of the hidden send.
    expect(await firstAscent(ctxFor(STRANGER))).toEqual({ name: 'Public sender', at: '2026-01-02' });
    expect(await firstAscent(anonymous)).toEqual({ name: 'Public sender', at: '2026-01-02' });
    // A follower of the first sender sees them credited, on their date.
    expect(await firstAscent(ctxFor(FOLLOWER))).toEqual({ name: `Name ${PRIVATE_SENDER}`, at: '2026-01-01' });
  });

  it("names a published climb's author on its new-climb row to everyone, and a comment on it only to who may see the commenter", async () => {
    await db.insert(schema.notifications).values([
      // The private author published it. Who set a published, listed climb is
      // public with it, as on every other surface.
      {
        uuid: 'matrix-n-author',
        recipientId: STRANGER,
        actorId: PRIVATE_AUTHOR,
        type: 'new_climb',
        entityType: 'climb',
        entityId: PRIVATE_PUBLISHED,
      },
      // A different private account's comment reply on the same climb, stored
      // with no comment row (the inline writer, or a reply deleted since).
      {
        uuid: 'matrix-n-other',
        recipientId: STRANGER,
        actorId: PRIVATE_SENDER,
        type: 'comment_reply',
        entityType: 'climb',
        entityId: PRIVATE_PUBLISHED,
      },
      // The author's own comment reply on their climb is activity, not
      // authorship: it keeps the account's privacy.
      {
        uuid: 'matrix-n-author-reply',
        recipientId: STRANGER,
        actorId: PRIVATE_AUTHOR,
        type: 'comment_reply',
        entityType: 'climb',
        entityId: PRIVATE_PUBLISHED,
      },
    ]);
    // One row at a time by its unique uuid, as the inbox reads it: the policy
    // sits in the select list, so the planner never runs it across the table.
    const visibleTo = async (viewerId: string) => {
      const visible: string[] = [];
      for (const uuid of ['matrix-n-author', 'matrix-n-other', 'matrix-n-author-reply']) {
        const [row] = await db
          .select({ allowed: notificationPrivacyCondition(viewerId) })
          .from(schema.notifications)
          .where(eq(schema.notifications.uuid, uuid));
        if (row?.allowed === true) visible.push(uuid);
      }
      return visible;
    };
    // The stranger is told who set the climb, never who commented on it, the
    // author included.
    expect(await visibleTo(STRANGER)).toEqual(['matrix-n-author']);
    // An approved follower of both accounts sees all three.
    expect(await visibleTo(FOLLOWER)).toEqual(['matrix-n-author', 'matrix-n-other', 'matrix-n-author-reply']);

    // The inbox itself, flat and grouped, as the app reads it.
    const strangerInbox = await socialNotificationQueries.notifications(null, {}, ctxFor(STRANGER));
    const strangerUuids = strangerInbox.notifications.map((notification) => notification.uuid);
    expect(strangerUuids).toContain('matrix-n-author');
    expect(strangerUuids).not.toContain('matrix-n-author-reply');
    expect(strangerUuids).not.toContain('matrix-n-other');
    const strangerGroups = await socialNotificationQueries.groupedNotifications(null, { limit: 50 }, ctxFor(STRANGER));
    expect(
      strangerGroups.groups.filter((group) => group.type === 'comment_reply' && group.entityId === PRIVATE_PUBLISHED),
    ).toEqual([]);

    // The worker's check before it writes a notification agrees.
    expect(await canSeeActorOnEntity('climb', PRIVATE_PUBLISHED, PRIVATE_AUTHOR, STRANGER, 'new_climb')).toBe(true);
    expect(await canSeeActorOnEntity('climb', PRIVATE_PUBLISHED, PRIVATE_AUTHOR, STRANGER, 'new_climb_global')).toBe(
      true,
    );
    expect(await canSeeActorOnEntity('climb', PRIVATE_PUBLISHED, PRIVATE_AUTHOR, FOLLOWER, 'new_climb')).toBe(true);
    expect(await canSeeActorOnEntity('climb', PRIVATE_PUBLISHED, PRIVATE_AUTHOR, STRANGER, 'comment_reply')).toBe(
      false,
    );
    expect(await canSeeActorOnEntity('climb', PRIVATE_PUBLISHED, PRIVATE_AUTHOR, FOLLOWER, 'comment_reply')).toBe(true);
    expect(await canSeeActorOnEntity('climb', PRIVATE_PUBLISHED, PRIVATE_SENDER, STRANGER, 'new_climb')).toBe(false);
    expect(await canSeeActorOnEntity('climb', PRIVATE_PUBLISHED, PRIVATE_SENDER, FOLLOWER, 'new_climb')).toBe(true);
    // An unlisted climb and a draft are not public, so their private author
    // keeps the account rule.
    expect(await canSeeActorOnEntity('climb', UNLISTED, PRIVATE_AUTHOR, STRANGER, 'new_climb')).toBe(false);
    expect(await canSeeActorOnEntity('climb', DRAFT, PRIVATE_AUTHOR, STRANGER, 'new_climb')).toBe(false);
    expect(await canSeeActorOnEntity('climb', UNLISTED, PRIVATE_AUTHOR, FOLLOWER, 'new_climb')).toBe(true);
  });

  it("still delivers a deleted author's published climb in a notification, never their draft", async () => {
    const allowed = async (uuid: string, viewerId: string) => {
      const [row] = await db
        .select({ actorId: schema.notifications.actorId, allowed: notificationPrivacyCondition(viewerId) })
        .from(schema.notifications)
        .where(eq(schema.notifications.uuid, uuid));
      return row;
    };
    for (const viewerId of [STRANGER, FOLLOWER]) {
      // The account is gone, so the actor is cleared; the published climb stays public.
      expect(await allowed(`matrix-n-${DELETED_PUBLISHED}`, viewerId)).toEqual({ actorId: null, allowed: true });
      // The draft was deleted with the account, so nothing resolves it.
      expect(await allowed(`matrix-n-${DELETED_DRAFT}`, viewerId)).toEqual({ actorId: null, allowed: false });
      // A draft nobody owns still exists, and the draft rule returns it to no one.
      expect(await allowed(`matrix-n-${OWNERLESS_DRAFT}`, viewerId)).toEqual({ actorId: null, allowed: false });
    }
    for (const ctx of [ctxFor(STRANGER), anonymous, ctxFor(FOLLOWER)]) {
      expect(await climbQueries.climb({}, { ...boardInput, climbUuid: DELETED_DRAFT }, ctx)).toBeNull();
      expect(await climbQueries.climb({}, { ...boardInput, climbUuid: OWNERLESS_DRAFT }, ctx)).toBeNull();
    }
  });

  it("keeps an unlisted climb's logs out of both ascent feeds, and on its own page", async () => {
    await db.insert(schema.userFollows).values({ followerId: FOLLOWER, followingId: PUBLIC_SENDER });
    // Newest of everything, so a leak would sit at the top of either feed.
    const now = new Date().toISOString();
    await db.insert(schema.boardseshTicks).values([
      {
        uuid: 'matrix-unlisted-tick',
        userId: PUBLIC_SENDER,
        boardType: BOARD,
        climbUuid: UNLISTED,
        angle: ANGLE,
        status: 'send',
        climbedAt: now,
      },
      {
        uuid: 'matrix-listed-tick',
        userId: PUBLIC_SENDER,
        boardType: BOARD,
        climbUuid: PRIVATE_PUBLISHED,
        angle: ANGLE,
        status: 'send',
        climbedAt: now,
      },
    ]);
    const feedClimbs = async (items: Promise<unknown>) =>
      ((await items) as { items: Array<{ climbUuid?: string }> }).items.map((item) => item.climbUuid);

    for (const ctx of [ctxFor(STRANGER), anonymous]) {
      const global = await feedClimbs(
        socialFeedQueries.globalAscentsFeed({}, { input: { limit: 50, offset: 0 } }, ctx),
      );
      expect(global).toContain(PRIVATE_PUBLISHED);
      expect(global).not.toContain(UNLISTED);
    }
    const following = await feedClimbs(
      socialFeedQueries.followingAscentsFeed({}, { input: { limit: 50, offset: 0 } }, ctxFor(FOLLOWER)),
    );
    expect(following).toContain(PRIVATE_PUBLISHED);
    expect(following).not.toContain(UNLISTED);

    // The climb's own page opens by its link, and so do its logs.
    for (const ctx of [ctxFor(STRANGER), anonymous]) {
      const logs = await climbLogsQueries.climbLogs(
        undefined,
        { input: { boardType: BOARD, climbUuid: UNLISTED } },
        ctx,
      );
      expect(logs.items.map((item) => item.uuid)).toContain('matrix-unlisted-tick');
    }
  });

  describe('an unlisted climb in proposals, comment feeds and inboxes', () => {
    const LISTED_PROPOSAL = 'matrix-proposal-listed';
    const UNLISTED_PROPOSAL = 'matrix-proposal-unlisted';
    const UNLISTED_COMMENT = 'matrix-comment-unlisted';

    beforeAll(async () => {
      // Written by a public account before the climb was unlisted: nothing but
      // the listed rule keeps them from a stranger.
      await db.insert(schema.climbProposals).values(
        [
          [LISTED_PROPOSAL, PRIVATE_PUBLISHED],
          [UNLISTED_PROPOSAL, UNLISTED],
        ].map(([uuid, climbUuid]) => ({
          uuid,
          climbUuid,
          boardType: BOARD,
          angle: null,
          proposerId: PUBLIC_SENDER,
          type: 'hide' as const,
          proposedValue: 'true',
          currentValue: 'false',
          reason: `Reason on ${climbUuid}`,
        })),
      );
      await db.insert(schema.comments).values({
        uuid: UNLISTED_COMMENT,
        userId: PUBLIC_SENDER,
        entityType: 'climb',
        entityId: UNLISTED,
        body: 'Beta on the unlisted climb',
      });
      // About the unlisted climb, from its author, to an approved follower of
      // that author: account privacy lets it through, the listed rule does not.
      await db.insert(schema.notifications).values({
        uuid: 'matrix-n-unlisted',
        recipientId: FOLLOWER,
        actorId: PRIVATE_AUTHOR,
        type: 'new_climb',
        entityType: 'climb',
        entityId: UNLISTED,
      });
    });

    const browsed = async (ctx: ConnectionContext) =>
      (await socialProposalQueries.browseProposals({}, { input: { boardType: BOARD, limit: 50 } }, ctx)).proposals.map(
        (proposal) => proposal.uuid,
      );

    it("keeps an unlisted climb's proposals out of the moderation feed, except for its owner", async () => {
      for (const ctx of [ctxFor(STRANGER), anonymous, ctxFor(FOLLOWER)]) {
        const uuids = await browsed(ctx);
        expect(uuids).toContain(LISTED_PROPOSAL);
        expect(uuids).not.toContain(UNLISTED_PROPOSAL);
      }
      expect(await browsed(ctxFor(PRIVATE_AUTHOR))).toEqual(
        expect.arrayContaining([LISTED_PROPOSAL, UNLISTED_PROPOSAL]),
      );
    });

    it("lists an unlisted climb's proposals to its owner alone, even by the climb's uuid", async () => {
      const onClimb = async (ctx: ConnectionContext) =>
        socialProposalQueries.climbProposals({}, { input: { climbUuid: UNLISTED, boardType: BOARD } }, ctx);
      for (const ctx of [ctxFor(STRANGER), anonymous, ctxFor(FOLLOWER)]) {
        expect((await onClimb(ctx)).totalCount).toBe(0);
      }
      const forOwner = await onClimb(ctxFor(PRIVATE_AUTHOR));
      expect(forOwner.proposals.map((proposal) => proposal.uuid)).toEqual([UNLISTED_PROPOSAL]);
    });

    it('names an unlisted climb on a proposal to its owner alone', async () => {
      const [row] = await db
        .select()
        .from(schema.climbProposals)
        .where(eq(schema.climbProposals.uuid, UNLISTED_PROPOSAL));
      for (const viewerId of [STRANGER, FOLLOWER, PUBLIC_SENDER, null]) {
        const [enriched] = await batchEnrichProposals([row], viewerId);
        expect(enriched.climbName, String(viewerId)).toBeUndefined();
        expect(enriched.frames, String(viewerId)).toBeUndefined();
      }
      const [forOwner] = await batchEnrichProposals([row], PRIVATE_AUTHOR);
      expect(forOwner.climbName).toBe(`Name of ${UNLISTED}`);
    });

    it("withholds an unlisted climb's proposal thread and notifications from everyone but the owner", async () => {
      for (const viewerId of [STRANGER, FOLLOWER, null]) {
        expect(await canReadSocialEntity('proposal', UNLISTED_PROPOSAL, viewerId), String(viewerId)).toBe(false);
        expect(await canReadSocialEntity('proposal', LISTED_PROPOSAL, viewerId), String(viewerId)).toBe(true);
      }
      expect(await canReadSocialEntity('proposal', UNLISTED_PROPOSAL, PRIVATE_AUTHOR)).toBe(true);
    });

    it("keeps an unlisted climb's comments out of the global comment feed, and on its own thread", async () => {
      for (const ctx of [ctxFor(STRANGER), anonymous]) {
        const feed = await socialCommentQueries.globalCommentFeed({}, { input: { limit: 50 } }, ctx);
        expect(feed.comments.map((comment) => comment.uuid)).not.toContain(UNLISTED_COMMENT);
        const thread = await socialCommentQueries.comments(
          {},
          { input: { entityType: 'climb', entityId: UNLISTED } },
          ctx,
        );
        expect(thread.comments.map((comment) => comment.uuid)).toEqual([UNLISTED_COMMENT]);
      }
      const ownerFeed = await socialCommentQueries.globalCommentFeed(
        {},
        { input: { limit: 50 } },
        ctxFor(PRIVATE_AUTHOR),
      );
      expect(ownerFeed.comments.map((comment) => comment.uuid)).toContain(UNLISTED_COMMENT);
    });

    it("keeps a notification about an unlisted climb out of a follower's inbox", async () => {
      const [row] = await db
        .select({ allowed: notificationPrivacyCondition(FOLLOWER) })
        .from(schema.notifications)
        .where(eq(schema.notifications.uuid, 'matrix-n-unlisted'));
      expect(row?.allowed).toBe(false);
      // The climb itself still opens for them by its link.
      expect(await canReadSocialEntity('climb', UNLISTED, FOLLOWER)).toBe(true);
      expect(await canReadSocialEntity('climb', UNLISTED, FOLLOWER, 'listed')).toBe(false);
    });
  });

  describe('search, count and a climb by uuid, through the schema', () => {
    const SEARCH = /* GraphQL */ `
      query ($input: ClimbSearchInput!) {
        searchClimbs(input: $input) {
          totalCount
          climbs {
            uuid
            userId
          }
        }
      }
    `;
    const CLIMB = /* GraphQL */ `
      query ($boardName: String!, $layoutId: Int!, $sizeId: Int!, $setIds: String!, $angle: Int!, $climbUuid: ID!) {
        climb(
          boardName: $boardName
          layoutId: $layoutId
          sizeId: $sizeId
          setIds: $setIds
          angle: $angle
          climbUuid: $climbUuid
        ) {
          uuid
          userId
        }
      }
    `;
    const searchInput = { boardName: BOARD, layoutId: LAYOUT_ID, sizeId: 1, setIds: '1', angle: ANGLE, pageSize: 50 };
    /** Published, listed and not hidden, whoever set them: what every viewer's search returns. */
    const SEARCHABLE = [
      PRIVATE_PUBLISHED,
      TICKED_PUBLISHED,
      LINKED_ONLY,
      DELETED_PUBLISHED,
      PUBLIC_SHOWN,
      MAPPED_ONLY,
      CROSS_BOARD,
      UNLINKED_AUTHORED,
    ].sort();
    type SearchAnswer = {
      searchClimbs: { totalCount: number; climbs: Array<{ uuid: string; userId: string | null }> };
    };

    async function run<T>(source: string, variables: Record<string, unknown>, ctx: ConnectionContext): Promise<T> {
      const result = await execute({
        schema: graphqlSchema,
        document: parse(source),
        variableValues: variables,
        contextValue: ctx,
      });
      expect((result.errors ?? []).map((error) => error.message)).toEqual([]);
      return result.data as T;
    }

    describe.each([
      ['with no search cache', false],
      ['through the shared search cache', true],
    ])('%s', (_label, cached) => {
      const store = new Map<string, unknown>();
      let hits = 0;
      beforeEach(() => {
        store.clear();
        hits = 0;
        vi.spyOn(searchCache, 'getCachedResult').mockImplementation(async <T>(key: string): Promise<T | null> => {
          if (!cached || !store.has(key)) return null;
          hits += 1;
          return store.get(key) as T;
        });
        vi.spyOn(searchCache, 'setCachedResult').mockImplementation((key: string, data: unknown) => {
          if (cached) store.set(key, data);
        });
      });
      afterEach(() => {
        vi.restoreAllMocks();
      });

      it('returns and counts the same climbs to every viewer, each with its author id', async () => {
        // The owner first: on the cached run every later viewer is served the
        // page the owner's search stored, so a viewer-dependent field in the
        // cached rows would leak here.
        const viewers = [ctxFor(PRIVATE_AUTHOR), ctxFor(STRANGER), anonymous, ctxFor(FOLLOWER)];
        for (const ctx of viewers) {
          const { searchClimbs } = await run<SearchAnswer>(SEARCH, { input: searchInput }, ctx);
          // Drafts, the unlisted climb and the hidden ones are out for everyone.
          expect(searchClimbs.climbs.map((climb) => climb.uuid).sort()).toEqual(SEARCHABLE);
          expect(searchClimbs.totalCount).toBe(SEARCHABLE.length);
          const authorOf = (uuid: string) => searchClimbs.climbs.find((climb) => climb.uuid === uuid)?.userId ?? null;
          // Who set a published, listed climb is public with it, a private
          // account's included.
          expect(authorOf(PRIVATE_PUBLISHED)).toBe(PRIVATE_AUTHOR);
          expect(authorOf(TICKED_PUBLISHED)).toBe(PRIVATE_AUTHOR);
          // A public account's id is public with its climbs; a deleted one has none.
          expect(authorOf(PUBLIC_SHOWN)).toBe(PUBLIC_SENDER);
          expect(authorOf(DELETED_PUBLISHED)).toBeNull();
        }
        // Three later viewers, each served the climbs and the count from the cache.
        expect(hits).toBe(cached ? 6 : 0);
      });
    });

    const climbVariables = (climbUuid: string) => ({
      boardName: BOARD,
      layoutId: LAYOUT_ID,
      sizeId: 1,
      setIds: '1',
      angle: ANGLE,
      climbUuid,
    });

    it('names the author of a published, listed climb opened by uuid to everyone', async () => {
      for (const ctx of [ctxFor(STRANGER), anonymous, ctxFor(FOLLOWER), ctxFor(PRIVATE_AUTHOR)]) {
        const { climb } = await run<{ climb: { uuid: string; userId: string | null } | null }>(
          CLIMB,
          climbVariables(PRIVATE_PUBLISHED),
          ctx,
        );
        expect(climb).toEqual({ uuid: PRIVATE_PUBLISHED, userId: PRIVATE_AUTHOR });
      }
    });

    it('fills the author on producers that never select it (userClimbs, setterClimbsFull)', async () => {
      const USER_CLIMBS = /* GraphQL */ `
        query ($userId: ID!) {
          userClimbs(input: { userId: $userId }) {
            climbs {
              uuid
              userId
            }
          }
        }
      `;
      const SETTER_CLIMBS_FULL = /* GraphQL */ `
        query ($username: String!) {
          setterClimbsFull(input: { username: $username }) {
            climbs {
              uuid
              userId
            }
          }
        }
      `;
      type ClimbRows = { climbs: Array<{ uuid: string; userId: string | null }> };
      for (const ctx of [ctxFor(STRANGER), anonymous]) {
        const { userClimbs } = await run<{ userClimbs: ClimbRows }>(USER_CLIMBS, { userId: PRIVATE_AUTHOR }, ctx);
        expect(Object.fromEntries(userClimbs.climbs.map((climb) => [climb.uuid, climb.userId]))).toEqual({
          [PRIVATE_PUBLISHED]: PRIVATE_AUTHOR,
          [TICKED_PUBLISHED]: PRIVATE_AUTHOR,
        });
        const { setterClimbsFull } = await run<{ setterClimbsFull: ClimbRows }>(
          SETTER_CLIMBS_FULL,
          { username: SETTER_NAME },
          ctx,
        );
        expect(Object.fromEntries(setterClimbsFull.climbs.map((climb) => [climb.uuid, climb.userId]))).toEqual({
          [PRIVATE_PUBLISHED]: PRIVATE_AUTHOR,
          [TICKED_PUBLISHED]: PRIVATE_AUTHOR,
          // Imported under the linked login: no author on the row.
          [LINKED_ONLY]: null,
        });
      }
    });

    it('names the private author of an unlisted climb opened by its link only to who may see the account', async () => {
      for (const [ctx, expectedAuthor] of [
        [ctxFor(STRANGER), null],
        [anonymous, null],
        [ctxFor(FOLLOWER), PRIVATE_AUTHOR],
        [ctxFor(PRIVATE_AUTHOR), PRIVATE_AUTHOR],
      ] as const) {
        const { climb } = await run<{ climb: { uuid: string; userId: string | null } | null }>(
          CLIMB,
          climbVariables(UNLISTED),
          ctx,
        );
        expect(climb).toEqual({ uuid: UNLISTED, userId: expectedAuthor });
      }
    });
  });

  describe('Climb.userId on a parent the server did not read (a queued climb)', () => {
    // A session queue carries the climb a member sent, so the parent's
    // `userId` is the sender's claim. Only a published, listed row in
    // `board_climbs` makes the author public.
    it("keeps a draft's private author from a stranger, and gives the owner their own id", async () => {
      const draft = { uuid: DRAFT, userId: PRIVATE_AUTHOR };
      expect(await resolveClimbAuthorId(draft, ctxFor(STRANGER))).toBeNull();
      expect(await resolveClimbAuthorId(draft, anonymous)).toBeNull();
      expect(await resolveClimbAuthorId(draft, ctxFor(FOLLOWER))).toBe(PRIVATE_AUTHOR);
      expect(await resolveClimbAuthorId(draft, ctxFor(PRIVATE_AUTHOR))).toBe(PRIVATE_AUTHOR);
    });

    it('takes the author of a published, listed climb from its row, whatever the parent claims', async () => {
      // PRIVATE_PUBLISHED is the private author's. A parent that claims another
      // private account, or claims nobody at all (a producer that never selects
      // the field), still gets the real author; a draft with no claim gets none.
      const spoofed = { uuid: PRIVATE_PUBLISHED, userId: PRIVATE_SENDER };
      expect(await resolveClimbAuthorId(spoofed, ctxFor(STRANGER))).toBe(PRIVATE_AUTHOR);
      // Resolved in one batch, each parent gets its own answer.
      const answers = await Promise.all([
        resolveClimbAuthorId({ uuid: PRIVATE_PUBLISHED, userId: PRIVATE_AUTHOR }, ctxFor(STRANGER)),
        resolveClimbAuthorId(spoofed, ctxFor(STRANGER)),
        resolveClimbAuthorId({ uuid: TICKED_PUBLISHED }, ctxFor(STRANGER)),
        resolveClimbAuthorId({ uuid: LINKED_ONLY }, ctxFor(STRANGER)),
        resolveClimbAuthorId({ uuid: DRAFT }, ctxFor(STRANGER)),
        resolveClimbAuthorId({ uuid: UNLISTED, userId: PRIVATE_AUTHOR }, ctxFor(STRANGER)),
      ]);
      expect(answers).toEqual([PRIVATE_AUTHOR, PRIVATE_AUTHOR, PRIVATE_AUTHOR, null, null, null]);
    });
  });

  describe('a list someone else made', () => {
    const PLAYLIST = 'matrix-playlist';

    beforeAll(async () => {
      // A public account's public playlist and liked list, holding the private
      // author's published climb, its unlisted one and its draft.
      const [playlist] = await db
        .insert(schema.playlists)
        .values({ uuid: PLAYLIST, boardType: BOARD, layoutId: LAYOUT_ID, name: 'Matrix playlist', isPublic: true })
        .returning({ id: schema.playlists.id });
      await db
        .insert(schema.playlistOwnership)
        .values({ playlistId: playlist.id, userId: PUBLIC_SENDER, role: 'owner' });
      await db.insert(schema.playlistClimbs).values([
        { playlistId: playlist.id, climbUuid: PRIVATE_PUBLISHED, angle: ANGLE, position: 0 },
        { playlistId: playlist.id, climbUuid: UNLISTED, angle: ANGLE, position: 1 },
        { playlistId: playlist.id, climbUuid: DRAFT, angle: ANGLE, position: 2 },
      ]);
      await db.insert(schema.userFavorites).values([
        { userId: PUBLIC_SENDER, boardName: BOARD, climbUuid: PRIVATE_PUBLISHED, angle: ANGLE },
        { userId: PUBLIC_SENDER, boardName: BOARD, climbUuid: UNLISTED, angle: ANGLE },
        { userId: PUBLIC_SENDER, boardName: BOARD, climbUuid: DRAFT, angle: ANGLE },
      ]);
    });

    const inPlaylist = async (ctx: ConnectionContext, boardScoped: boolean) => {
      const page = await playlistClimbs(
        undefined,
        {
          input: boardScoped
            ? { playlistId: PLAYLIST, boardName: BOARD, layoutId: LAYOUT_ID }
            : { playlistId: PLAYLIST },
        },
        ctx,
      );
      return { uuids: page.climbs.map((climb) => climb.uuid).sort(), totalCount: page.totalCount };
    };

    // A list shows an unlisted climb it holds to everyone who may open the
    // list, as on main: the list's owner put it there. A draft stays with its
    // own owner, whoever's list it sits in.
    const published = { uuids: [PRIVATE_PUBLISHED, UNLISTED].sort(), totalCount: 2 };
    const withDraft = { uuids: [PRIVATE_PUBLISHED, UNLISTED, DRAFT].sort(), totalCount: 3 };

    it.each([
      ['board-scoped', true],
      ['all-boards', false],
    ])(
      "shows a %s public playlist's unlisted climb to its visitors, and the draft to its owner alone",
      async (_label, boardScoped) => {
        for (const ctx of [ctxFor(STRANGER), anonymous, ctxFor(FOLLOWER), ctxFor(PUBLIC_SENDER)]) {
          expect(await inPlaylist(ctx, boardScoped)).toEqual(published);
        }
        expect(await inPlaylist(ctxFor(PRIVATE_AUTHOR), boardScoped)).toEqual(withDraft);
      },
    );

    it("shows another climber's liked unlisted climb, and the draft to its owner alone", async () => {
      const liked = async (ctx: ConnectionContext) => {
        const page = await smartPlaylist(undefined, { input: { type: 'LIKED_CLIMBS', userId: PUBLIC_SENDER } }, ctx);
        return { uuids: page.climbs.map((climb) => climb.uuid).sort(), totalCount: page.totalCount };
      };
      for (const ctx of [ctxFor(STRANGER), anonymous, ctxFor(PUBLIC_SENDER)]) {
        expect(await liked(ctx)).toEqual(published);
      }
      expect(await liked(ctxFor(PRIVATE_AUTHOR))).toEqual(withDraft);
    });
  });

  describe("a board's hardest send", () => {
    const BOARD_UUID = 'matrix-board';
    // The stats carry no sender, so the board id only tags the projection: no
    // board-scoped identity rule runs.
    const STATS_BOARD_ID = 0;

    const statsWithHardest = (climbUuid: string): BoardPresenceStats => ({
      climbsSentCount: 3,
      distinctClimbersCount: 2,
      hardestGrade: 'V8',
      hardestSend: {
        climbUuid,
        grade: 'V8',
        climbOwnerId: PRIVATE_AUTHOR,
        sentByUserId: null,
        sentAt: '2026-05-01T00:00:00.000Z',
      },
    });

    it('never features an unlisted climb to anyone but its owner, and keeps every aggregate', async () => {
      for (const ctx of [STRANGER, FOLLOWER, null]) {
        const redacted = await redactBoardStats(statsWithHardest(UNLISTED), ctx, STATS_BOARD_ID);
        expect(redacted.hardestSend ?? null).toBeNull();
        expect(redacted).toMatchObject({ climbsSentCount: 3, distinctClimbersCount: 2, hardestGrade: 'V8' });
      }
      expect(
        (await redactBoardStats(statsWithHardest(UNLISTED), PRIVATE_AUTHOR, STATS_BOARD_ID)).hardestSend?.climbUuid,
      ).toBe(UNLISTED);
      expect(
        (await redactBoardStats(statsWithHardest(PRIVATE_PUBLISHED), STRANGER, STATS_BOARD_ID)).hardestSend?.climbUuid,
      ).toBe(PRIVATE_PUBLISHED);
    });

    it('hides foreign and ownerless drafts while retaining board aggregates', async () => {
      for (const viewer of [STRANGER, FOLLOWER, null]) {
        for (const climbUuid of [DRAFT, OWNERLESS_DRAFT]) {
          const redacted = await redactBoardStats(statsWithHardest(climbUuid), viewer, STATS_BOARD_ID);
          expect(redacted.hardestSend ?? null).toBeNull();
          expect(redacted).toMatchObject({ climbsSentCount: 3, distinctClimbersCount: 2, hardestGrade: 'V8' });
        }
      }
      expect(
        (await redactBoardStats(statsWithHardest(DRAFT), PRIVATE_AUTHOR, STATS_BOARD_ID)).hardestSend?.climbUuid,
      ).toBe(DRAFT);
      expect(
        (await redactBoardStats(statsWithHardest(OWNERLESS_DRAFT), PRIVATE_AUTHOR, STATS_BOARD_ID)).hardestSend ?? null,
      ).toBeNull();
    });

    it('never picks a climb the community hid', async () => {
      const [board] = await db
        .insert(schema.userBoards)
        .values({
          uuid: BOARD_UUID,
          slug: 'matrix-board',
          ownerId: PUBLIC_SENDER,
          boardType: BOARD,
          layoutId: LAYOUT_ID,
          sizeId: 1,
          setIds: '1',
          name: 'Matrix board',
        })
        .returning({ id: schema.userBoards.id });
      // The hidden climb's send is the hardest by a wide margin.
      await db.insert(schema.boardseshTicks).values(
        [
          ['matrix-board-hidden-send', HIDDEN, 28],
          ['matrix-board-listed-send', PRIVATE_PUBLISHED, 20],
        ].map(([uuid, climbUuid, difficulty]) => ({
          uuid: String(uuid),
          userId: PUBLIC_SENDER,
          boardType: BOARD,
          boardId: board.id,
          climbUuid: String(climbUuid),
          angle: ANGLE,
          status: 'send' as const,
          difficulty: Number(difficulty),
          climbedAt: '2026-03-01T10:00:00Z',
        })),
      );
      const stats = await computeBoardPresenceStats(board.id, BOARD);
      expect(stats.hardestSend?.climbUuid).toBe(PRIVATE_PUBLISHED);
      // The wall's own numbers still count the hidden climb's send.
      expect(stats.climbsSentCount).toBe(2);
    });
  });
});
