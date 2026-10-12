/**
 * Real-DB coverage for "author decides": a tick or session follows its author's
 * account privacy and its own audience. The session it was logged in and the
 * board it was logged on never hide it; board privacy only blanks the board's
 * identity on the item.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { and, eq, sql } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import type { ConnectionContext, SessionFeedItem } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { canReadSocialEntity } from '../graphql/resolvers/shared/activity-privacy';
import { tickQueries } from '../graphql/resolvers/ticks/queries';
import { activityFeedQueries } from '../graphql/resolvers/social/activity-feed';
import { sessionFeedQueries } from '../graphql/resolvers/social/session-feed';
import { sessionEditMutations } from '../graphql/resolvers/social/session-mutations';
import { betaLinkQueries, dropRecentBetaLinksFallback } from '../graphql/resolvers/beta-videos/queries';
import { privacyMutations } from '../graphql/resolvers/privacy';
import { canAccessResource } from '../services/privacy';
import { projectSessionBoardPath } from '../services/board-session-privacy';

const HOST = 'author-decides-host';
const CLIMBER = 'author-decides-climber';
const CLIMBER_FOLLOWER = 'author-decides-climber-follower';
const STRANGER = 'author-decides-stranger';
const BOARD_OWNER = 'author-decides-board-owner';
const GRANTEE = 'author-decides-grantee';
const CLIMB_UUID = 'author-decides-climb';

let inviteOnlyBoardId: number;
let deletedBoardId: number;
let unlistedBoardId: number;

afterEach(() => vi.unstubAllEnvs());

const viewer = (userId: string | null): ConnectionContext =>
  ({ connectionId: `author-decides-${userId ?? 'anon'}`, isAuthenticated: !!userId, userId }) as ConnectionContext;

async function insertTick(
  uuid: string,
  options: { userId?: string; sessionId?: string | null; boardId?: number; climbedAt?: string },
) {
  await db.insert(dbSchema.boardseshTicks).values({
    uuid,
    userId: options.userId ?? CLIMBER,
    climbUuid: CLIMB_UUID,
    boardType: 'kilter',
    angle: 40,
    status: 'send',
    climbedAt: options.climbedAt ?? '2026-10-01T10:00:00Z',
    sessionId: options.sessionId ?? null,
    boardId: options.boardId ?? null,
  });
}

async function insertSession(
  id: string,
  options: { createdBy?: string; boardId?: number | null; boardPath?: string; isPublic?: boolean; name?: string } = {},
) {
  await db.insert(dbSchema.boardSessions).values({
    id,
    boardPath: options.boardPath ?? 'kilter/1/10/1/40',
    createdByUserId: options.createdBy ?? HOST,
    boardId: options.boardId ?? null,
    isPublic: options.isPublic ?? true,
    name: options.name ?? null,
    status: 'ended',
  });
}

const ascentBoard = async (reader: string | null, tickUuid: string) =>
  (await tickQueries.userAscentsFeed(null, { userId: CLIMBER, input: { limit: 50 } }, viewer(reader))).items.find(
    (item) => item.uuid === tickUuid,
  );

beforeAll(async () => {
  await db.insert(dbSchema.users).values(
    [HOST, CLIMBER, CLIMBER_FOLLOWER, STRANGER, BOARD_OWNER, GRANTEE].map((id) => ({
      id,
      email: `${id}@test.com`,
      name: id,
    })),
  );
  await db.insert(dbSchema.userProfiles).values({ userId: HOST, isPrivate: true });
  await db.insert(dbSchema.userFollows).values({ followerId: CLIMBER_FOLLOWER, followingId: CLIMBER });
  await db.insert(dbSchema.boardClimbs).values({
    uuid: CLIMB_UUID,
    boardType: 'kilter',
    layoutId: 1,
    name: 'Author decides climb',
    isListed: true,
    isDraft: false,
    frames: 'p1r1',
  });
  const boards = await db
    .insert(dbSchema.userBoards)
    .values([
      {
        uuid: 'author-decides-invite-only',
        slug: 'author-decides-invite-only',
        ownerId: BOARD_OWNER,
        name: 'Invite Only Garage',
        locationName: 'Back Street Garage',
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1',
        isPublic: false,
      },
      {
        uuid: 'author-decides-deleted',
        slug: 'author-decides-deleted',
        ownerId: BOARD_OWNER,
        name: 'Deleted Wall',
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1',
        isPublic: false,
        deletedAt: new Date(),
      },
      {
        uuid: 'author-decides-unlisted',
        slug: 'author-decides-unlisted',
        ownerId: BOARD_OWNER,
        name: 'Link Only Shed',
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1',
        isPublic: true,
        isUnlisted: true,
      },
    ])
    .returning({ id: dbSchema.userBoards.id, uuid: dbSchema.userBoards.uuid });
  inviteOnlyBoardId = boards.find((board) => board.uuid === 'author-decides-invite-only')!.id;
  deletedBoardId = boards.find((board) => board.uuid === 'author-decides-deleted')!.id;
  unlistedBoardId = boards.find((board) => board.uuid === 'author-decides-unlisted')!.id;
  await db.insert(dbSchema.resourceGrants).values(
    ['author-decides-invite-only', 'author-decides-unlisted'].map((resourceId) => ({
      kind: 'board' as const,
      resourceId,
      userId: GRANTEE,
      status: 'approved' as const,
    })),
  );
  await db.insert(dbSchema.resourcePrivacy).values({
    kind: 'board',
    resourceId: 'author-decides-invite-only',
    ownerId: BOARD_OWNER,
    audience: 'invite_only',
  });
});

describe('author decides', () => {
  it('shows a public author’s tick on an Invite-only board to a stranger, without naming the board', async () => {
    await insertTick('author-decides-on-private-board', { boardId: inviteOnlyBoardId });

    expect(await canReadSocialEntity('tick', 'author-decides-on-private-board', STRANGER)).toBe(true);
    expect(await canReadSocialEntity('tick', 'author-decides-on-private-board', null)).toBe(true);

    const forStranger = await tickQueries.userAscentsFeed(
      null,
      { userId: CLIMBER, input: { limit: 10 } },
      viewer(STRANGER),
    );
    const strangerItem = forStranger.items.find((item) => item.uuid === 'author-decides-on-private-board');
    expect(strangerItem).toMatchObject({ boardId: null, boardDisplayName: null });
    expect(JSON.stringify(forStranger)).not.toContain('Invite Only Garage');
    expect(JSON.stringify(forStranger)).not.toContain('Back Street Garage');

    // The climber keeps the wall's name in their own logbook, and so does its owner.
    for (const reader of [CLIMBER, BOARD_OWNER]) {
      const feed = await tickQueries.userAscentsFeed(null, { userId: CLIMBER, input: { limit: 10 } }, viewer(reader));
      expect(feed.items.find((item) => item.uuid === 'author-decides-on-private-board')).toMatchObject({
        boardId: inviteOnlyBoardId,
        boardDisplayName: 'Invite Only Garage',
      });
    }
  });

  it('keeps sessions and ticks on a soft-deleted board readable', async () => {
    await insertSession('author-decides-deleted-session', { createdBy: CLIMBER, boardId: deletedBoardId });
    await insertTick('author-decides-on-deleted-board', {
      sessionId: 'author-decides-deleted-session',
      boardId: deletedBoardId,
    });

    expect(await canAccessResource('session', 'author-decides-deleted-session', STRANGER)).toBe(true);
    expect(await canAccessResource('session', 'author-decides-deleted-session', null)).toBe(true);
    expect(await canReadSocialEntity('session', 'author-decides-deleted-session', null)).toBe(true);
    expect(await canReadSocialEntity('tick', 'author-decides-on-deleted-board', STRANGER)).toBe(true);

    // The deleted board is no longer named, like any board the viewer cannot
    // see: the row stays with its board fields blank. Its climber keeps the name.
    const forStranger = await tickQueries.userAscentsFeed(
      null,
      { userId: CLIMBER, input: { limit: 10 } },
      viewer(STRANGER),
    );
    expect(forStranger.items.find((item) => item.uuid === 'author-decides-on-deleted-board')).toMatchObject({
      boardId: null,
      boardDisplayName: null,
    });
    expect(JSON.stringify(forStranger)).not.toContain('Deleted Wall');
    const forClimber = await tickQueries.userAscentsFeed(
      null,
      { userId: CLIMBER, input: { limit: 10 } },
      viewer(CLIMBER),
    );
    expect(forClimber.items.find((item) => item.uuid === 'author-decides-on-deleted-board')).toMatchObject({
      boardId: deletedBoardId,
    });
  });

  it('reads a tick whose session row is missing by its author’s policy', async () => {
    await insertTick('author-decides-orphaned', { sessionId: 'author-decides-session-that-was-deleted' });

    expect(await canReadSocialEntity('tick', 'author-decides-orphaned', STRANGER)).toBe(true);
    expect(await canReadSocialEntity('tick', 'author-decides-orphaned', null)).toBe(true);
  });

  it('shows a public participant’s tick in a private host’s Followers session to the participant’s followers', async () => {
    await insertSession('author-decides-followers-session', { createdBy: HOST });
    await db.insert(dbSchema.resourcePrivacy).values({
      kind: 'session',
      resourceId: 'author-decides-followers-session',
      ownerId: HOST,
      audience: 'followers',
    });
    await insertTick('author-decides-participant-tick', { sessionId: 'author-decides-followers-session' });

    // The session (its name and roster) stays with the host's followers…
    expect(await canAccessResource('session', 'author-decides-followers-session', CLIMBER_FOLLOWER)).toBe(false);
    // …while the participant's own log follows the participant.
    expect(await canReadSocialEntity('tick', 'author-decides-participant-tick', CLIMBER_FOLLOWER)).toBe(true);
    const feed = await tickQueries.userAscentsFeed(
      null,
      { userId: CLIMBER, input: { limit: 10 } },
      viewer(CLIMBER_FOLLOWER),
    );
    expect(feed.items.map((item) => item.uuid)).toContain('author-decides-participant-tick');

    // A private participant's tick reaches their accepted followers, not strangers.
    await db.insert(dbSchema.userProfiles).values({ userId: CLIMBER, isPrivate: true });
    try {
      expect(await canReadSocialEntity('tick', 'author-decides-participant-tick', CLIMBER_FOLLOWER)).toBe(true);
      expect(await canReadSocialEntity('tick', 'author-decides-participant-tick', STRANGER)).toBe(false);
    } finally {
      await db.delete(dbSchema.userProfiles).where(eq(dbSchema.userProfiles.userId, CLIMBER));
    }
  });
});

describe('author decides across feeds', () => {
  it('names a board to its grant holder and blanks it for a stranger and an anonymous reader', async () => {
    await insertTick('author-decides-feeds-invite', { boardId: inviteOnlyBoardId });
    expect(await ascentBoard(GRANTEE, 'author-decides-feeds-invite')).toMatchObject({
      boardDisplayName: 'Invite Only Garage',
    });
    for (const reader of [STRANGER, null]) {
      expect(await ascentBoard(reader, 'author-decides-feeds-invite')).toMatchObject({
        boardId: null,
        boardDisplayName: null,
      });
    }

    type GroupItem = { uuid: string; boardDisplayName: string | null };
    const grouped = async (reader: string) =>
      (
        (await tickQueries.userGroupedAscentsFeed(undefined, { userId: CLIMBER, input: {} }, viewer(reader))) as {
          groups: Array<{ items: GroupItem[] }>;
        }
      ).groups
        .flatMap((group) => group.items)
        .find((item) => item.uuid === 'author-decides-feeds-invite');
    expect((await grouped(GRANTEE))?.boardDisplayName).toBe('Invite Only Garage');
    expect(await grouped(STRANGER)).toMatchObject({ boardDisplayName: null });
  });

  it('names an unlisted board to the people who hold it, never to a reader with only a log', async () => {
    await insertTick('author-decides-feeds-unlisted', { boardId: unlistedBoardId });
    expect((await ascentBoard(GRANTEE, 'author-decides-feeds-unlisted'))?.boardDisplayName).toBe('Link Only Shed');
    expect((await ascentBoard(BOARD_OWNER, 'author-decides-feeds-unlisted'))?.boardDisplayName).toBe('Link Only Shed');
    expect(await ascentBoard(STRANGER, 'author-decides-feeds-unlisted')).toMatchObject({
      boardId: null,
      boardDisplayName: null,
    });
  });

  it('blanks a hidden board in the materialized feed and refuses a feed filtered to it', async () => {
    await insertTick('author-decides-fanned-out', { boardId: inviteOnlyBoardId });
    await db.execute(sql`
      INSERT INTO feed_items (recipient_id, actor_id, type, entity_type, entity_id, board_uuid, metadata, created_at)
      VALUES (${CLIMBER_FOLLOWER}, ${CLIMBER}, 'ascent', 'tick', 'author-decides-fanned-out',
              'author-decides-invite-only', ${JSON.stringify({ climbUuid: CLIMB_UUID, boardType: 'kilter' })}::jsonb, now()),
             (${GRANTEE}, ${CLIMBER}, 'ascent', 'tick', 'author-decides-fanned-out',
              'author-decides-invite-only', ${JSON.stringify({ climbUuid: CLIMB_UUID, boardType: 'kilter' })}::jsonb, now())
    `);
    type FeedItem = { entityId: string; boardUuid: string | null };
    const read = async (reader: string, boardUuid?: string) =>
      (
        (await activityFeedQueries.activityFeed({}, { input: { limit: 20, boardUuid } }, viewer(reader))) as {
          items: FeedItem[];
        }
      ).items.filter((item) => item.entityId === 'author-decides-fanned-out');

    // The follower sees their climber's send, without the board they cannot see.
    expect(await read(CLIMBER_FOLLOWER)).toEqual([expect.objectContaining({ boardUuid: null })]);
    expect(await read(GRANTEE)).toEqual([expect.objectContaining({ boardUuid: 'author-decides-invite-only' })]);
    // A feed for one wall is the wall's activity: it needs the wall.
    expect(await read(CLIMBER_FOLLOWER, 'author-decides-invite-only')).toEqual([]);
    expect(await read(GRANTEE, 'author-decides-invite-only')).toHaveLength(1);
  });

  it('refuses a trending list filtered to a board the reader cannot see', async () => {
    await insertTick('author-decides-trending', { boardId: inviteOnlyBoardId });
    type TrendingItem = { entityId: string };
    const trending = async (reader: string) =>
      (
        (await activityFeedQueries.trendingFeed(
          {},
          { input: { limit: 50, boardUuid: 'author-decides-invite-only' } },
          viewer(reader),
        )) as { items: TrendingItem[] }
      ).items.map((item) => item.entityId);
    expect(await trending(STRANGER)).toEqual([]);
    expect(await trending(GRANTEE)).toContain('author-decides-trending');
  });

  it('puts a followed climber’s log from a session the reader cannot open on their daily card', async () => {
    const day = '2026-09-20T10:00:00Z';
    await insertSession('author-decides-host-followers', { createdBy: HOST, name: 'Host secret session' });
    await db.insert(dbSchema.resourcePrivacy).values({
      kind: 'session',
      resourceId: 'author-decides-host-followers',
      ownerId: HOST,
      audience: 'followers',
    });
    await insertTick('author-decides-home-tick', { sessionId: 'author-decides-host-followers', climbedAt: day });

    const feed = (await sessionFeedQueries.sessionGroupedFeed(
      undefined,
      { input: { followingOnly: true, includeDailyHighlights: true, limit: 50 } },
      viewer(CLIMBER_FOLLOWER),
    )) as {
      sessions: Array<{ sessionId: string; sessionName: string | null; participants: Array<{ userId: string }> }>;
    };
    expect(feed.sessions.map((card) => card.sessionId)).not.toContain('author-decides-host-followers');
    const daily = feed.sessions.find((card) => card.sessionId === `daily:${CLIMBER}:2026-09-20`);
    expect(daily).toMatchObject({ sessionName: null, participants: [expect.objectContaining({ userId: CLIMBER })] });
    expect(JSON.stringify(feed)).not.toContain('Host secret session');

    const detail = (await sessionFeedQueries.sessionDetail(
      undefined,
      { sessionId: `daily:${CLIMBER}:2026-09-20` },
      viewer(CLIMBER_FOLLOWER),
    )) as { ticks: Array<{ uuid: string }> } | null;
    expect(detail?.ticks.map((tick) => tick.uuid)).toContain('author-decides-home-tick');
  });

  it('keeps restricted-session and standalone ticks beside an openable session on the same day', async () => {
    await insertSession('author-decides-same-day-open', { createdBy: CLIMBER });
    await insertSession('author-decides-same-day-restricted', { createdBy: HOST, name: 'Private same-day session' });
    await db.insert(dbSchema.resourcePrivacy).values({
      kind: 'session',
      resourceId: 'author-decides-same-day-restricted',
      ownerId: HOST,
      audience: 'only_me',
    });
    for (const [uuid, sessionId] of [
      ['author-decides-same-day-open-tick', 'author-decides-same-day-open'],
      ['author-decides-same-day-restricted-tick', 'author-decides-same-day-restricted'],
      ['author-decides-same-day-standalone-tick', null],
    ] as const) {
      await insertTick(uuid, { sessionId, climbedAt: '2026-09-19T10:00:00Z' });
    }

    for (const input of [
      { userId: CLIMBER, includeDailyHighlights: true, limit: 50 },
      { followingOnly: true, includeDailyHighlights: true, limit: 50 },
    ]) {
      const feed = await sessionFeedQueries.sessionGroupedFeed(undefined, { input }, viewer(CLIMBER_FOLLOWER));
      expect(feed.sessions.find((card) => card.sessionId === 'author-decides-same-day-open')?.tickCount).toBe(1);
      const daily = feed.sessions.find((card) => card.sessionId === `daily:${CLIMBER}:2026-09-19`);
      expect(daily).toMatchObject({ tickCount: 2, totalSends: 2, sessionName: null });
      expect(JSON.stringify(feed)).not.toContain('Private same-day session');
    }
    const detail = await sessionFeedQueries.sessionDetail(
      undefined,
      { sessionId: `daily:${CLIMBER}:2026-09-19` },
      viewer(CLIMBER_FOLLOWER),
    );
    expect(detail?.ticks.map((tick) => tick.uuid).sort()).toEqual([
      'author-decides-same-day-restricted-tick',
      'author-decides-same-day-standalone-tick',
    ]);
  });

  it('keeps an unlisted session’s card off a stranger’s feed while its link still opens', async () => {
    await insertSession('author-decides-unlisted-session', { createdBy: CLIMBER, isPublic: false, name: 'Quiet one' });
    await insertTick('author-decides-unlisted-tick', {
      sessionId: 'author-decides-unlisted-session',
      climbedAt: '2026-09-21T10:00:00Z',
    });
    const cards = async (reader: string | null) =>
      (
        (await sessionFeedQueries.sessionGroupedFeed(undefined, { input: { limit: 50 } }, viewer(reader))) as {
          sessions: Array<{ sessionId: string }>;
        }
      ).sessions.map((card) => card.sessionId);
    expect(await cards(null)).not.toContain('author-decides-unlisted-session');
    expect(await cards(STRANGER)).not.toContain('author-decides-unlisted-session');
    expect(await cards(CLIMBER)).toContain('author-decides-unlisted-session');
    expect(await canAccessResource('session', 'author-decides-unlisted-session', STRANGER)).toBe(true);
  });

  it('returns a tick’s session id only to its climber from a public logbook', async () => {
    await insertSession('author-decides-logbook-session', { createdBy: CLIMBER, isPublic: false });
    await insertTick('author-decides-logbook-tick', { sessionId: 'author-decides-logbook-session' });
    const sessionIdFor = async (reader: string | null) =>
      (
        (await tickQueries.userTicks(null, { userId: CLIMBER, boardType: 'kilter' }, viewer(reader))) as Array<{
          uuid: string;
          sessionId: string | null;
        }>
      ).find((tick) => tick.uuid === 'author-decides-logbook-tick')?.sessionId;
    expect(await sessionIdFor(null)).toBeNull();
    expect(await sessionIdFor(STRANGER)).toBeNull();
    expect(await sessionIdFor(CLIMBER)).toBe('author-decides-logbook-session');
  });

  it('lists a public climber’s beta filmed on a hidden board, without the board', async () => {
    await insertTick('author-decides-beta-tick', { boardId: inviteOnlyBoardId });
    await db.insert(dbSchema.boardBetaLinks).values({
      boardType: 'kilter',
      climbUuid: CLIMB_UUID,
      link: 'https://www.youtube.com/watch?v=author-decides-beta',
      isListed: true,
      createdByUserId: CLIMBER,
      tickUuid: 'author-decides-beta-tick',
      boardId: inviteOnlyBoardId,
      thumbnail: 'https://example.test/thumb.jpg',
    });
    type Beta = { link: string; boardId: number | null };
    const beta = async (reader: string | null) =>
      (
        (await betaLinkQueries.betaLinks(
          undefined,
          { boardType: 'kilter', climbUuid: CLIMB_UUID },
          viewer(reader),
        )) as Beta[]
      ).find((link) => link.link.includes('author-decides-beta'));
    expect(await beta(STRANGER)).toMatchObject({ boardId: null });
    expect(await beta(null)).toMatchObject({ boardId: null });
    expect(await beta(GRANTEE)).toMatchObject({ boardId: inviteOnlyBoardId });
    expect(await beta(CLIMBER)).toMatchObject({ boardId: inviteOnlyBoardId });
  });

  it('preserves the uploader’s board in recent beta even without ordinary board access', async () => {
    const link = 'https://www.youtube.com/watch?v=author-decides-recent-beta';
    await db.insert(dbSchema.boardBetaLinks).values({
      boardType: 'kilter',
      climbUuid: CLIMB_UUID,
      link,
      isListed: true,
      createdByUserId: CLIMBER,
      boardId: inviteOnlyBoardId,
      thumbnail: '/static/beta-link-thumbnails/author-decides-recent.jpg',
      createdAt: '2026-10-01T10:00:00Z',
    });
    dropRecentBetaLinksFallback();
    const recent = async (reader: string | null) =>
      (await betaLinkQueries.recentBetaLinks(undefined, { limit: 50 }, viewer(reader))).find(
        (item) => item.betaLink.link === link,
      )?.betaLink;
    expect(await canAccessResource('board', 'author-decides-invite-only', CLIMBER)).toBe(false);
    expect(await recent(null)).toMatchObject({ boardId: null });
    expect(await recent(STRANGER)).toMatchObject({ boardId: null });
    expect(await recent(CLIMBER)).toMatchObject({ boardId: inviteOnlyBoardId });
    expect(await recent(GRANTEE)).toMatchObject({ boardId: inviteOnlyBoardId });
    dropRecentBetaLinksFallback();
  });

  it('features the clip attached to the tick over a guessed one, naming its board to the board’s owner', async () => {
    const [ownBoard] = await db
      .insert(dbSchema.userBoards)
      .values({
        uuid: 'author-decides-own-public',
        slug: 'author-decides-own-public',
        ownerId: CLIMBER,
        name: 'Own Public Wall',
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1',
        isPublic: true,
      })
      .returning({ id: dbSchema.userBoards.id });
    await insertSession('author-decides-own-board-session', { createdBy: CLIMBER, boardId: ownBoard.id });
    await insertTick('author-decides-own-board-tick', {
      sessionId: 'author-decides-own-board-session',
      boardId: ownBoard.id,
      climbedAt: '2026-09-22T10:00:00Z',
    });
    const attachedLink = 'https://www.youtube.com/watch?v=author-decides-attached-clip';
    await db.insert(dbSchema.boardBetaLinks).values([
      {
        boardType: 'kilter',
        climbUuid: CLIMB_UUID,
        link: attachedLink,
        isListed: true,
        createdByUserId: CLIMBER,
        tickUuid: 'author-decides-own-board-tick',
        boardId: ownBoard.id,
        createdAt: '2026-09-22T11:00:00Z',
      },
      // The same climber's clip with no tick matches this send by climb and
      // author too. It is newer, so only the attached-first key keeps it second.
      {
        boardType: 'kilter',
        climbUuid: CLIMB_UUID,
        link: 'https://www.youtube.com/watch?v=author-decides-guessed-clip',
        isListed: true,
        createdByUserId: CLIMBER,
        createdAt: '2026-10-05T11:00:00Z',
      },
    ]);
    const card = (
      (await sessionFeedQueries.sessionGroupedFeed(
        undefined,
        { input: { userId: CLIMBER, limit: 50 } },
        viewer(CLIMBER),
      )) as { sessions: SessionFeedItem[] }
    ).sessions.find((session) => session.sessionId === 'author-decides-own-board-session');
    expect(card?.featuredBeta?.betaLink).toMatchObject({ link: attachedLink, boardId: ownBoard.id });
  });

  it.each([
    ['party', '2026-09-28T10:00:00Z'],
    ['daily', '2026-09-29T10:00:00Z'],
  ] as const)(
    'names a featured clip’s hidden board on a %s card only to people who hold it',
    async (kind, climbedAt) => {
      const tickUuid = `author-decides-featured-${kind}`;
      const sessionId = kind === 'party' ? 'author-decides-featured-session' : null;
      if (sessionId) await insertSession(sessionId, { createdBy: CLIMBER });
      await insertTick(tickUuid, { sessionId, boardId: inviteOnlyBoardId, climbedAt });
      const link = `https://www.youtube.com/watch?v=author-decides-featured-${kind}`;
      await db.insert(dbSchema.boardBetaLinks).values({
        boardType: 'kilter',
        climbUuid: CLIMB_UUID,
        link,
        isListed: true,
        createdByUserId: CLIMBER,
        tickUuid,
        boardId: inviteOnlyBoardId,
      });
      const raw = await db.execute(sql`SELECT board_id FROM board_beta_links WHERE link = ${link}`);
      // The driver returns a bigint as text, which is what the readers must number.
      expect(typeof raw[0].board_id).toBe('string');
      const cardFor = async (reader: string | null) => {
        const feed = (await sessionFeedQueries.sessionGroupedFeed(
          undefined,
          { input: { limit: 50, ...(kind === 'daily' ? { userId: CLIMBER, includeDailyHighlights: true } : {}) } },
          viewer(reader),
        )) as { sessions: SessionFeedItem[] };
        return feed.sessions.find((card) => card.featuredBeta?.betaLink.link === link);
      };
      for (const reader of [BOARD_OWNER, GRANTEE]) {
        expect((await cardFor(reader))?.featuredBeta?.betaLink.boardId).toBe(inviteOnlyBoardId);
      }
      for (const reader of [null, STRANGER]) {
        expect((await cardFor(reader))?.featuredBeta?.betaLink.boardId).toBeNull();
      }
    },
  );

  it('gives a joiner who cannot see a named board its geometry instead of its slug', async () => {
    const slugPath = '/b/author-decides-invite-only/35';
    expect(await projectSessionBoardPath(slugPath, BOARD_OWNER)).toBe(slugPath);
    expect(await projectSessionBoardPath(slugPath, GRANTEE)).toBe(slugPath);
    expect(await projectSessionBoardPath(slugPath, STRANGER)).toBe('/kilter/1/10/1/35');
    expect(await projectSessionBoardPath(slugPath, null)).toBe('/kilter/1/10/1/35');
    // A geometry path passes through; a slug no board carries names nothing.
    expect(await projectSessionBoardPath('/kilter/1/10/1/40', STRANGER)).toBe('/kilter/1/10/1/40');
    expect(await projectSessionBoardPath('/b/never-existed/40', STRANGER)).toBe('');
  });

  it('lets the legacy switch move a session between Public and Unlisted both ways', async () => {
    await insertSession('author-decides-switch', { createdBy: CLIMBER, isPublic: true });
    await db.insert(dbSchema.resourcePrivacy).values({
      kind: 'session',
      resourceId: 'author-decides-switch',
      ownerId: CLIMBER,
      audience: 'public',
    });
    const policy = async () =>
      (
        await db
          .select({ audience: dbSchema.resourcePrivacy.audience })
          .from(dbSchema.resourcePrivacy)
          .where(
            and(
              eq(dbSchema.resourcePrivacy.kind, 'session'),
              eq(dbSchema.resourcePrivacy.resourceId, 'author-decides-switch'),
            ),
          )
      )[0]?.audience;
    const toggle = (isPublic: boolean) =>
      sessionEditMutations.updateSession(undefined, { input: { sessionId: 'author-decides-switch', isPublic } }, {
        ...viewer(CLIMBER),
        connectionId: 'author-decides-switch-conn',
      } as ConnectionContext);
    expect(await toggle(false)).toMatchObject({ isPublic: false });
    expect(await policy()).toBe('unlisted');
    expect(await toggle(true)).toMatchObject({ isPublic: true });
    expect(await policy()).toBe('public');
  });

  it('accepts Unlisted as a session audience from the audience control', async () => {
    vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '1');
    await insertSession('author-decides-control', { createdBy: CLIMBER, isPublic: true });
    await privacyMutations.updateResourcePrivacy(
      undefined,
      { input: { kind: 'session', resourceId: 'author-decides-control', audience: 'unlisted' } },
      viewer(CLIMBER),
    );
    const [row] = await db
      .select({ isPublic: dbSchema.boardSessions.isPublic })
      .from(dbSchema.boardSessions)
      .where(eq(dbSchema.boardSessions.id, 'author-decides-control'));
    expect(row.isPublic).toBe(false);
    expect(await canAccessResource('session', 'author-decides-control', STRANGER)).toBe(true);
  });
});
