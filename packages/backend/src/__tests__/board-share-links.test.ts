import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { and, count, eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import * as schema from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { pubsub } from '../pubsub';
import { boardShareLinkMutations, boardShareLinkQueries } from '../graphql/resolvers/privacy/board-share-links';
import { privacyMutations, privacyQueries } from '../graphql/resolvers/privacy';
import { socialBoardQueries } from '../graphql/resolvers/social/boards';
import { boardPresenceQueries } from '../graphql/resolvers/board-presence/queries';
import { liveSessionQueries } from '../graphql/resolvers/sessions/live-sessions';
import { resolveSessionBoardId } from '../services/session-board-binding';
import { canAccessResource } from '../services/privacy';
import { withoutTokenInErrors } from '../services/board-share-links';
import { isDatabaseLeakError } from '../graphql/mask-error';

// A home board's share link grants membership (privacy series B8). Real
// Postgres: the grant, the partial unique index and the row locks are the
// behaviour under test.

const owner = 'share-link-owner';
const member = 'share-link-member';
const second = 'share-link-second';
const stranger = 'share-link-stranger';
const otherOwner = 'share-link-other-owner';

const context = (userId: string) =>
  ({ isAuthenticated: true, userId, connectionId: `share-link-${userId}-${Math.random()}` }) as ConnectionContext;
const anonymous = () =>
  ({ isAuthenticated: false, connectionId: `share-link-anon-${Math.random()}` }) as ConnectionContext;

type Audience = 'public' | 'unlisted' | 'followers' | 'invite_only' | 'only_me';
type SeededBoard = { uuid: string; slug: string; id: number };

let boardSerial = 0;
async function seedBoard(
  ownerId: string,
  audience: Audience | 'legacy_only_me',
  boardType = 'kilter',
): Promise<SeededBoard> {
  boardSerial += 1;
  const uuid = uuidv4();
  // Slugs are lower-case letters, digits and hyphens; `resolveBoardLinkBySlug` refuses anything else.
  const slug = `share-link-${audience.replace(/_/g, '-')}-${boardSerial}`;
  const [row] = await db
    .insert(schema.userBoards)
    .values({
      uuid,
      slug,
      ownerId,
      name: `Share Link ${audience} ${boardSerial}`,
      boardType,
      layoutId: 1,
      // A distinct size per board keeps the per-owner config unique index happy.
      sizeId: 100 + boardSerial,
      setIds: '1',
      isPublic: audience === 'public' || audience === 'unlisted',
      isUnlisted: audience === 'unlisted',
      locationName: 'Secret garage, 12 Example Street',
    })
    .returning({ id: schema.userBoards.id });
  if (audience !== 'legacy_only_me') {
    await db.insert(schema.resourcePrivacy).values({ kind: 'board', resourceId: uuid, ownerId, audience });
  }
  return { uuid, slug, id: Number(row.id) };
}

async function grantRows(boardUuid: string, userId: string) {
  return db
    .select()
    .from(schema.resourceGrants)
    .where(
      and(
        eq(schema.resourceGrants.kind, 'board'),
        eq(schema.resourceGrants.resourceId, boardUuid),
        eq(schema.resourceGrants.userId, userId),
      ),
    );
}

async function shareLink(boardUuid: string, userId = owner) {
  return boardShareLinkQueries.boardShareLink(null, { boardUuid }, context(userId));
}

async function redeem(token: string, userId: string) {
  return boardShareLinkMutations.redeemBoardShareLink(null, { token }, context(userId));
}

beforeAll(async () => {
  vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '1');
  await db
    .insert(schema.users)
    .values([owner, member, second, stranger, otherOwner].map((id) => ({ id, email: `${id}@test.com` })));
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => vi.unstubAllEnvs());

describe('the owner reads a share link', () => {
  it('mints one link for an Invite-only board and keeps handing back the same one', async () => {
    const board = await seedBoard(owner, 'invite_only');
    const first = await shareLink(board.uuid);
    expect(first).not.toBeNull();
    expect(first!.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(first!.path).toBe(`/b/${board.slug}?invite=${first!.token}`);
    expect(first!.boardUuid).toBe(board.uuid);
    expect((await shareLink(board.uuid))!.token).toBe(first!.token);
  });

  it('mints a link for a Followers board too', async () => {
    const board = await seedBoard(owner, 'followers');
    expect(await shareLink(board.uuid)).not.toBeNull();
  });

  it('gives Public and Unlisted boards no tokened link; their plain link already works', async () => {
    for (const audience of ['public', 'unlisted'] as const) {
      const board = await seedBoard(owner, audience);
      expect(await shareLink(board.uuid)).toBeNull();
    }
  });

  it('gives an Only-me board no link at all, explicit or legacy', async () => {
    for (const audience of ['only_me', 'legacy_only_me'] as const) {
      const board = await seedBoard(owner, audience);
      expect(await shareLink(board.uuid)).toBeNull();
      await expect(
        boardShareLinkMutations.resetBoardShareLink(null, { boardUuid: board.uuid }, context(owner)),
      ).resolves.toBeNull();
      const [{ total }] = await db
        .select({ total: count() })
        .from(schema.boardShareLinks)
        .where(eq(schema.boardShareLinks.boardUuid, board.uuid));
      expect(total).toBe(0);
    }
  });

  it('leaves spray walls on their own ?wall= link', async () => {
    const wall = await seedBoard(owner, 'invite_only', 'spray');
    expect(await shareLink(wall.uuid)).toBeNull();
  });

  it('refuses a non-owner both the link and a reset', async () => {
    const board = await seedBoard(owner, 'invite_only');
    const link = await shareLink(board.uuid);
    await expect(shareLink(board.uuid, stranger)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    await expect(
      boardShareLinkMutations.resetBoardShareLink(null, { boardUuid: board.uuid }, context(stranger)),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    // The stranger's attempt changed nothing.
    expect((await shareLink(board.uuid))!.token).toBe(link!.token);
  });

  it('mints exactly one link when two first reads race', async () => {
    const board = await seedBoard(owner, 'invite_only');
    const [left, right] = await Promise.all([shareLink(board.uuid), shareLink(board.uuid)]);
    expect(left!.token).toBe(right!.token);
    const rows = await db.select().from(schema.boardShareLinks).where(eq(schema.boardShareLinks.boardUuid, board.uuid));
    expect(rows).toHaveLength(1);
  });

  it('needs the privacy controls, like every other privacy setting', async () => {
    const board = await seedBoard(owner, 'invite_only');
    vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '0');
    try {
      await expect(shareLink(board.uuid)).rejects.toMatchObject({ extensions: { code: 'PRIVACY_UNAVAILABLE' } });
      await expect(redeem('A'.repeat(22), member)).rejects.toMatchObject({
        extensions: { code: 'PRIVACY_UNAVAILABLE' },
      });
    } finally {
      vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '1');
    }
  });
});

describe('opening a share link', () => {
  it('makes the climber an approved member who reads the board, its presence and its sessions at once', async () => {
    const board = await seedBoard(owner, 'invite_only');
    const link = await shareLink(board.uuid);
    const sessionPath = `/b/${board.slug}/40`;

    // Before: the board is not found for them anywhere.
    expect(await socialBoardQueries.boardBySlug(null, { slug: board.slug }, context(member))).toBeNull();
    await expect(
      boardPresenceQueries.boardConnection(undefined, { boardId: board.id }, context(member)),
    ).rejects.toThrow('Board not found');
    await expect(resolveSessionBoardId(sessionPath, member)).rejects.toThrow('Board not found');

    // A join only adds access: nothing for other clients to drop, so no
    // privacyChanged (the app no longer listens for it, #6411).
    const publish = vi.spyOn(pubsub, 'publishPrivacyChanged');
    const redemption = await redeem(link!.token, member);
    expect(redemption).toEqual({ boardUuid: board.uuid, slug: board.slug });
    expect(publish).not.toHaveBeenCalled();

    const [grant] = await grantRows(board.uuid, member);
    expect(grant).toMatchObject({ status: 'approved', invitedBy: owner });

    // After, on the very next request.
    expect(await canAccessResource('board', board.uuid, member)).toBe(true);
    expect((await socialBoardQueries.boardBySlug(null, { slug: board.slug }, context(member)))?.uuid).toBe(board.uuid);
    // Resolves (to "nobody is connected") instead of throwing NOT_FOUND.
    await boardPresenceQueries.boardConnection(undefined, { boardId: board.id }, context(member));
    await expect(
      liveSessionQueries.boardLiveSessions(undefined, { boardId: board.id }, context(member)),
    ).resolves.toEqual([]);
    expect(await resolveSessionBoardId(sessionPath, member)).toBe(board.id);
  });

  it('is idempotent: a second open writes nothing', async () => {
    const board = await seedBoard(owner, 'followers');
    const link = await shareLink(board.uuid);
    await redeem(link!.token, member);
    const [before] = await grantRows(board.uuid, member);

    await expect(redeem(link!.token, member)).resolves.toEqual({ boardUuid: board.uuid, slug: board.slug });
    const after = await grantRows(board.uuid, member);
    expect(after).toHaveLength(1);
    expect(after[0].updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it('turns a pending access request into membership', async () => {
    const board = await seedBoard(owner, 'invite_only');
    await privacyMutations.requestResourceAccess(null, { kind: 'board', resourceId: board.uuid }, context(second));
    expect((await grantRows(board.uuid, second))[0].status).toBe('pending');
    await redeem((await shareLink(board.uuid))!.token, second);
    expect((await grantRows(board.uuid, second))[0]).toMatchObject({ status: 'approved', invitedBy: owner });
  });

  it('opens only the board the token belongs to', async () => {
    const linked = await seedBoard(owner, 'invite_only');
    const other = await seedBoard(owner, 'invite_only');
    const link = await shareLink(linked.uuid);
    await redeem(link!.token, second);
    expect(await canAccessResource('board', linked.uuid, second)).toBe(true);
    expect(await canAccessResource('board', other.uuid, second)).toBe(false);
    expect(await grantRows(other.uuid, second)).toEqual([]);
  });

  it('answers NOT_FOUND for an unknown or malformed token', async () => {
    for (const token of ['AAAAAAAAAAAAAAAAAAAAAA', 'not-a-token', '', 'x'.repeat(5000)]) {
      await expect(redeem(token, stranger)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    }
  });

  it('never echoes the token in the error a dead link answers with', async () => {
    const board = await seedBoard(owner, 'invite_only');
    const link = await shareLink(board.uuid);
    await boardShareLinkMutations.resetBoardShareLink(null, { boardUuid: board.uuid }, context(owner));
    const failure = await redeem(link!.token, stranger).catch((error: unknown) => error);
    expect(JSON.stringify(failure)).not.toContain(link!.token);
    expect(String((failure as Error).message)).not.toContain(link!.token);
  });

  it('lets the owner open their own link without writing a grant', async () => {
    const board = await seedBoard(owner, 'invite_only');
    await expect(redeem((await shareLink(board.uuid))!.token, owner)).resolves.toEqual({
      boardUuid: board.uuid,
      slug: board.slug,
    });
    expect(await grantRows(board.uuid, owner)).toEqual([]);
  });

  it('keeps a climber the owner removed out, whatever link they hold', async () => {
    const board = await seedBoard(owner, 'invite_only');
    const link = await shareLink(board.uuid);
    await redeem(link!.token, second);
    await privacyMutations.revokeResourceAccess(
      null,
      { kind: 'board', resourceId: board.uuid, userId: second },
      context(owner),
    );
    await expect(redeem(link!.token, second)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    expect((await grantRows(board.uuid, second))[0].status).toBe('revoked');
    expect(await canAccessResource('board', board.uuid, second)).toBe(false);
    // The owner can still bring them back by name.
    await privacyMutations.inviteResourceMember(
      null,
      { kind: 'board', resourceId: board.uuid, userId: second },
      context(owner),
    );
    expect(await canAccessResource('board', board.uuid, second)).toBe(true);
  });
});

describe("the owner's access list", () => {
  type AccessArgs = { offset?: number | null; userIds?: string[] | null };
  async function accessList(boardUuid: string, args: AccessArgs = {}, userId = owner) {
    return privacyQueries.resourceAccessRequests(
      null,
      { kind: 'board', resourceId: boardUuid, ...args },
      context(userId),
    );
  }

  it('pages every link joiner, pending requests first and then newest, and finds any one of them by id', async () => {
    const board = await seedBoard(owner, 'invite_only');
    // 40 people the owner removed, 80 waiting on a request and 30 older
    // members. Every id sorts ahead of the joiner's, so the old list (no
    // order, capped at 100) stopped before reaching them.
    const crowd = Array.from({ length: 150 }, (_, index) => `share-link-crowd-${String(index).padStart(3, '0')}`);
    const crowdStatus = (index: number): 'revoked' | 'pending' | 'approved' =>
      index < 40 ? 'revoked' : index < 120 ? 'pending' : 'approved';
    await db.insert(schema.users).values(crowd.map((id) => ({ id, email: `${id}@test.com` })));
    await db.insert(schema.resourceGrants).values(
      crowd.map((userId, index) => ({
        kind: 'board' as const,
        resourceId: board.uuid,
        userId,
        status: crowdStatus(index),
        invitedBy: crowdStatus(index) === 'approved' ? owner : null,
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
      })),
    );
    const joiner = 'share-link-zz-joiner';
    await db.insert(schema.users).values({ id: joiner, email: `${joiner}@test.com` });
    await redeem((await shareLink(board.uuid))!.token, joiner);

    const firstPage = await accessList(board.uuid);
    const secondPage = await accessList(board.uuid, { offset: firstPage.length });
    expect(firstPage).toHaveLength(100);
    expect(await accessList(board.uuid, { offset: firstPage.length + secondPage.length })).toEqual([]);

    const listed = [...firstPage, ...secondPage];
    const pendingIds = crowd.filter((_, index) => crowdStatus(index) === 'pending').reverse();
    const olderMemberIds = crowd.filter((_, index) => crowdStatus(index) === 'approved').reverse();
    // Removed climbers are not on the list; the rest come once each, in order.
    expect(listed.map((grant) => grant.userId)).toEqual([...pendingIds, joiner, ...olderMemberIds]);
    expect(listed.find((grant) => grant.userId === joiner)).toMatchObject({ status: 'approved', invitedBy: owner });

    // A search asks for its results' real state: the joiner reads as a member
    // the owner can remove, a removed climber as removed, a stranger not at all.
    const searched = await accessList(board.uuid, { userIds: [joiner, crowd[0], stranger] });
    expect(new Map(searched.map((grant) => [grant.userId, grant.status]))).toEqual(
      new Map([
        [joiner, 'approved'],
        [crowd[0], 'revoked'],
      ]),
    );

    await privacyMutations.revokeResourceAccess(
      null,
      { kind: 'board', resourceId: board.uuid, userId: joiner },
      context(owner),
    );
    expect(await canAccessResource('board', board.uuid, joiner)).toBe(false);
    expect((await accessList(board.uuid, { userIds: [joiner] }))[0]).toMatchObject({ status: 'revoked' });
  });

  it('refuses a malformed page or lookup, and anyone but the owner', async () => {
    const board = await seedBoard(owner, 'invite_only');
    await expect(accessList(board.uuid, { offset: -1 })).rejects.toThrow();
    await expect(accessList(board.uuid, { offset: 1.5 })).rejects.toThrow();
    await expect(
      accessList(board.uuid, { userIds: Array.from({ length: 101 }, (_, index) => `someone-${index}`) }),
    ).rejects.toThrow();
    await expect(accessList(board.uuid, {}, member)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
  });

  it('answers a lookup by id NOT_FOUND for anyone but the owner, so nobody can probe who belongs', async () => {
    const notFound = { extensions: { code: 'NOT_FOUND' } };
    const board = await seedBoard(owner, 'invite_only');
    await redeem((await shareLink(board.uuid))!.token, member);
    await privacyMutations.requestResourceAccess(null, { kind: 'board', resourceId: board.uuid }, context(second));
    // Board uuids travel in session and presence payloads. A signed-in
    // stranger and a member who is not the owner both hold this one.
    for (const prober of [stranger, member]) {
      await expect(accessList(board.uuid, { userIds: [member, second] }, prober)).rejects.toMatchObject(notFound);
    }
    expect(await accessList(board.uuid, { userIds: [member, second] })).toHaveLength(2);

    // A session's grants answer the same way.
    const sessionId = uuidv4();
    await db
      .insert(schema.boardSessions)
      .values({ id: sessionId, createdByUserId: owner, isPublic: false, boardPath: 'kilter/1/1/1/40' });
    await db
      .insert(schema.resourcePrivacy)
      .values({ kind: 'session', resourceId: sessionId, ownerId: owner, audience: 'invite_only' });
    await db
      .insert(schema.resourceGrants)
      .values({ kind: 'session', resourceId: sessionId, userId: member, status: 'approved', invitedBy: owner });
    const sessionLookup = (userId: string) =>
      privacyQueries.resourceAccessRequests(
        null,
        { kind: 'session', resourceId: sessionId, userIds: [member] },
        context(userId),
      );
    for (const prober of [stranger, member]) {
      await expect(sessionLookup(prober)).rejects.toMatchObject(notFound);
    }
    expect(await sessionLookup(owner)).toEqual([expect.objectContaining({ userId: member, status: 'approved' })]);
  });
});

describe('resetting and retiring a link', () => {
  it('mints a new token, kills the old one and keeps everyone who already joined', async () => {
    const board = await seedBoard(owner, 'invite_only');
    const oldLink = await shareLink(board.uuid);
    await redeem(oldLink!.token, member);

    const fresh = await boardShareLinkMutations.resetBoardShareLink(null, { boardUuid: board.uuid }, context(owner));
    expect(fresh!.token).not.toBe(oldLink!.token);
    expect((await shareLink(board.uuid))!.token).toBe(fresh!.token);

    await expect(redeem(oldLink!.token, second)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    expect(await canAccessResource('board', board.uuid, second)).toBe(false);
    expect(await canAccessResource('board', board.uuid, member)).toBe(true);

    await redeem(fresh!.token, second);
    expect(await canAccessResource('board', board.uuid, second)).toBe(true);
  });

  it("retires the link when the board leaves Followers or Invite-only, so a round trip can't revive it", async () => {
    const board = await seedBoard(owner, 'invite_only');
    const link = await shareLink(board.uuid);
    for (const audience of ['public', 'invite_only'] as const) {
      await privacyMutations.updateResourcePrivacy(
        null,
        { input: { kind: 'board', resourceId: board.uuid, audience } },
        context(owner),
      );
    }
    await expect(redeem(link!.token, stranger)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    const next = await shareLink(board.uuid);
    expect(next!.token).not.toBe(link!.token);
  });

  it('keeps the link when a board moves between Followers and Invite-only', async () => {
    const board = await seedBoard(owner, 'followers');
    const link = await shareLink(board.uuid);
    await privacyMutations.updateResourcePrivacy(
      null,
      { input: { kind: 'board', resourceId: board.uuid, audience: 'invite_only' } },
      context(owner),
    );
    expect((await shareLink(board.uuid))!.token).toBe(link!.token);
    await redeem(link!.token, stranger);
    expect(await canAccessResource('board', board.uuid, stranger)).toBe(true);
  });

  it('refuses a live token once its board is no longer shareable', async () => {
    const board = await seedBoard(owner, 'followers');
    const link = await shareLink(board.uuid);
    // Written straight to the policy row: the token is still active, the audience is not.
    await db
      .update(schema.resourcePrivacy)
      .set({ audience: 'only_me' })
      .where(and(eq(schema.resourcePrivacy.kind, 'board'), eq(schema.resourcePrivacy.resourceId, board.uuid)));
    await expect(redeem(link!.token, stranger)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    expect(await grantRows(board.uuid, stranger)).toEqual([]);
  });

  it('refuses a token whose board was deleted', async () => {
    const board = await seedBoard(otherOwner, 'invite_only');
    const link = await shareLink(board.uuid, otherOwner);
    await db.update(schema.userBoards).set({ deletedAt: new Date() }).where(eq(schema.userBoards.uuid, board.uuid));
    await expect(redeem(link!.token, stranger)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
  });
});

describe('races', () => {
  // Each pair runs in both orders often enough to interleave. The rule under
  // test is the lock order (owner row, then board): no deadlock, no INTERNAL,
  // and an end state one of the two serial orders could have produced.
  const nonNotFound = (outcome: PromiseSettledResult<unknown>) =>
    outcome.status === 'rejected' &&
    (outcome.reason as { extensions?: { code?: string } })?.extensions?.code !== 'NOT_FOUND';

  it('a redemption racing a reset either joins on the old link or is refused, never both or neither', async () => {
    for (let round = 0; round < 4; round += 1) {
      const board = await seedBoard(owner, 'invite_only');
      const joiner = `share-link-race-reset-${round}`;
      await db.insert(schema.users).values({ id: joiner, email: `${joiner}@test.com` });
      const link = await shareLink(board.uuid);
      const [redeemed, reset] = await Promise.allSettled([
        redeem(link!.token, joiner),
        boardShareLinkMutations.resetBoardShareLink(null, { boardUuid: board.uuid }, context(owner)),
      ]);
      expect(reset.status).toBe('fulfilled');
      expect(nonNotFound(redeemed)).toBe(false);
      const grants = await grantRows(board.uuid, joiner);
      expect(grants.length).toBe(redeemed.status === 'fulfilled' ? 1 : 0);
    }
  });

  it('a redemption racing a removal never leaves the removed climber approved', async () => {
    for (let round = 0; round < 4; round += 1) {
      const board = await seedBoard(owner, 'invite_only');
      const joiner = `share-link-race-revoke-${round}`;
      await db.insert(schema.users).values({ id: joiner, email: `${joiner}@test.com` });
      const link = await shareLink(board.uuid);
      const [redeemed, revoked] = await Promise.allSettled([
        redeem(link!.token, joiner),
        privacyMutations.revokeResourceAccess(
          null,
          { kind: 'board', resourceId: board.uuid, userId: joiner },
          context(owner),
        ),
      ]);
      expect(revoked.status).toBe('fulfilled');
      expect(nonNotFound(redeemed)).toBe(false);
      // The owner's removal is the later word whichever ran first.
      expect((await grantRows(board.uuid, joiner))[0].status).toBe('revoked');
    }
  });

  it('an audience change racing a first read or a redemption never deadlocks', async () => {
    for (let round = 0; round < 4; round += 1) {
      const board = await seedBoard(owner, 'invite_only');
      const joiner = `share-link-race-audience-${round}`;
      await db.insert(schema.users).values({ id: joiner, email: `${joiner}@test.com` });
      const link = await shareLink(board.uuid);
      const outcomes = await Promise.allSettled([
        redeem(link!.token, joiner),
        privacyMutations.updateResourcePrivacy(
          null,
          { input: { kind: 'board', resourceId: board.uuid, audience: 'only_me' } },
          context(owner),
        ),
        shareLink(board.uuid),
      ]);
      expect(outcomes[1].status).toBe('fulfilled');
      expect(outcomes[2].status).toBe('fulfilled');
      expect(nonNotFound(outcomes[0])).toBe(false);
      // Only me now, whatever else happened: the link is retired.
      await expect(redeem(link!.token, stranger)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    }
  });
});

describe('keeping the token out of logs', () => {
  it("replaces a failed statement's message, which names its parameters, with the SQLSTATE alone", async () => {
    const token = 'Ab3_dE-fGhIjKlMnOpQrSt';
    const driverFailure = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const drizzleFailure = Object.assign(
      new Error(`Failed query: select "board_uuid" from "board_share_links" where "token" = $1\nparams: ${token}`),
      { cause: driverFailure, query: 'select …', params: [token] },
    );
    const thrown = await withoutTokenInErrors(async () => {
      throw drizzleFailure;
    }).catch((error: unknown) => error);

    expect(JSON.stringify(thrown)).not.toContain(token);
    expect(String((thrown as Error).message)).not.toContain(token);
    expect(String((thrown as Error).stack)).not.toContain(token);
    expect((thrown as { cause?: unknown }).cause).toBeUndefined();
    expect(thrown).toMatchObject({ code: '57014' });
    // Still a database failure to the Yoga mask, so an outage keeps its 503.
    expect(isDatabaseLeakError(thrown)).toBe(true);
  });

  it('lets its own NOT_FOUND through untouched', async () => {
    await expect(redeem('CCCCCCCCCCCCCCCCCCCCCC', stranger)).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
  });
});

describe('the signed-out preview', () => {
  it("names the board, and nothing else, for an active link's holder", async () => {
    const board = await seedBoard(owner, 'invite_only');
    const link = await shareLink(board.uuid);
    const preview = await boardShareLinkQueries.boardShareLinkPreview(null, { token: link!.token }, anonymous());
    expect(preview).toEqual({ name: expect.stringContaining('Share Link invite_only') });
    expect(JSON.stringify(preview)).not.toContain('Example Street');
  });

  it('says nothing for a revoked, unknown or malformed token, or with the controls off', async () => {
    const board = await seedBoard(owner, 'invite_only');
    const link = await shareLink(board.uuid);
    await boardShareLinkMutations.resetBoardShareLink(null, { boardUuid: board.uuid }, context(owner));
    for (const token of [link!.token, 'BBBBBBBBBBBBBBBBBBBBBB', 'short']) {
      await expect(boardShareLinkQueries.boardShareLinkPreview(null, { token }, anonymous())).resolves.toBeNull();
    }
    const live = await shareLink(board.uuid);
    vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '0');
    try {
      await expect(
        boardShareLinkQueries.boardShareLinkPreview(null, { token: live!.token }, anonymous()),
      ).resolves.toBeNull();
    } finally {
      vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '1');
    }
  });
});
