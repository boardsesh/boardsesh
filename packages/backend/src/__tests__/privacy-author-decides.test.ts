/**
 * Real-DB coverage for "author decides": a tick or session follows its author's
 * account privacy and its own audience. The session it was logged in and the
 * board it was logged on never hide it; board privacy only blanks the board's
 * identity on the item.
 */
import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { eq } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { canReadSocialEntity } from '../graphql/resolvers/shared/activity-privacy';
import { tickQueries } from '../graphql/resolvers/ticks/queries';
import { canAccessResource } from '../services/privacy';

const HOST = 'author-decides-host';
const CLIMBER = 'author-decides-climber';
const CLIMBER_FOLLOWER = 'author-decides-climber-follower';
const STRANGER = 'author-decides-stranger';
const BOARD_OWNER = 'author-decides-board-owner';
const CLIMB_UUID = 'author-decides-climb';

let inviteOnlyBoardId: number;
let deletedBoardId: number;

const viewer = (userId: string | null): ConnectionContext =>
  ({ connectionId: `author-decides-${userId ?? 'anon'}`, isAuthenticated: !!userId, userId }) as ConnectionContext;

async function insertTick(uuid: string, options: { userId?: string; sessionId?: string | null; boardId?: number }) {
  await db.insert(dbSchema.boardseshTicks).values({
    uuid,
    userId: options.userId ?? CLIMBER,
    climbUuid: CLIMB_UUID,
    boardType: 'kilter',
    angle: 40,
    status: 'send',
    climbedAt: '2026-10-01T10:00:00Z',
    sessionId: options.sessionId ?? null,
    boardId: options.boardId ?? null,
  });
}

async function insertSession(id: string, options: { createdBy?: string; boardId?: number | null } = {}) {
  await db.insert(dbSchema.boardSessions).values({
    id,
    boardPath: 'kilter/1/10/1/40',
    createdByUserId: options.createdBy ?? HOST,
    boardId: options.boardId ?? null,
    isPublic: true,
    status: 'ended',
  });
}

beforeAll(async () => {
  await db
    .insert(dbSchema.users)
    .values(
      [HOST, CLIMBER, CLIMBER_FOLLOWER, STRANGER, BOARD_OWNER].map((id) => ({ id, email: `${id}@test.com`, name: id })),
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
    ])
    .returning({ id: dbSchema.userBoards.id, uuid: dbSchema.userBoards.uuid });
  inviteOnlyBoardId = boards.find((board) => board.uuid === 'author-decides-invite-only')!.id;
  deletedBoardId = boards.find((board) => board.uuid === 'author-decides-deleted')!.id;
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
