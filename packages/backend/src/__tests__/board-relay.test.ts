/**
 * Relay mode (#7220): `relayBoardClimb`, the holder-only `BoardClimbRelayRequested`
 * event, the holder's opt-out (`setBoardRelayAccepting`), and the
 * `reportBoardClimb(relayRequestId:)` echo on `BoardClimbSet`.
 *
 * The holder lives in Redis (the writer slot and `writer-conn`), so every case
 * that needs one skips cleanly when pubsub Redis is unavailable, like the holder
 * tests in board-presence.test.ts. Run with `REDIS_URL=redis://127.0.0.1:6380`
 * to exercise them locally.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { and, eq, inArray } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import type { MoonboardLinkMode } from '@boardsesh/board-config';
import type {
  BoardClimbRelayRequested,
  BoardClimbSet,
  BoardPresenceEvent,
  ClimbQueueItemInput,
  ConnectionContext,
} from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { pubsub } from '../pubsub';
import { redisClientManager } from '../redis/client';
import { boardPresenceMutations } from '../graphql/resolvers/board-presence/mutations';
import { boardPresenceSubscriptions } from '../graphql/resolvers/board-presence/subscription';
import { SYSTEM_BOARD_OWNER_ID } from '../graphql/resolvers/board-presence/shared';
import { privacyMutations } from '../graphql/resolvers/privacy';
import { resetAllRateLimits } from '../utils/rate-limiter';

const OWNER = 'relay-test-owner';
const HOLDER = 'relay-test-holder';
const RELAYER = 'relay-test-relayer';
const NEXT_HOLDER = 'relay-test-next-holder';
const TEST_USERS = [OWNER, HOLDER, RELAYER, NEXT_HOLDER];
const RELAYER_DISPLAY_NAME = 'Relaying Rosa';
const MOON_LAYOUT_ID = 987_220;
const KILTER_LAYOUT_ID = 987_221;
const MOON_CLIMB_UUID = 'relay-test-moon-climb';
const OTHER_MOON_CLIMB_UUID = 'relay-test-other-moon-climb';
const DRAFT_MOON_CLIMB_UUID = 'relay-test-draft-moon-climb';
const KILTER_CLIMB_UUID = 'relay-test-kilter-climb';
const TEST_CLIMB_UUIDS = [MOON_CLIMB_UUID, OTHER_MOON_CLIMB_UUID, DRAFT_MOON_CLIMB_UUID, KILTER_CLIMB_UUID];

const ctxFor = (userId: string | null, overrides: Partial<ConnectionContext> = {}): ConnectionContext =>
  ({
    connectionId: `relay-${userId ?? 'anon'}-${randomUUID()}`,
    isAuthenticated: !!userId,
    userId: userId ?? undefined,
    ...overrides,
  }) as ConnectionContext;

const emitterIdOf = (ctx: ConnectionContext) => ctx.userId ?? `conn:${ctx.connectionId}`;

function queueItem(climbUuid = MOON_CLIMB_UUID): ClimbQueueItemInput {
  return {
    uuid: `queue-${randomUUID()}`,
    climb: {
      uuid: climbUuid,
      setter_username: 'client-says-setter',
      name: 'Client-supplied name',
      frames: 'client-frames',
      angle: 40,
      ascensionist_count: 0,
      difficulty: 'V5',
      quality_average: '0',
      stars: 0,
      difficulty_error: '0',
    },
  };
}

type BoardOptions = {
  boardType?: string;
  layoutId?: number;
  ownerId?: string;
  slug?: string;
  moonboardLinkMode?: MoonboardLinkMode | null;
  isPublic?: boolean;
};

const createdBoardIds: number[] = [];

async function insertBoard(options: BoardOptions = {}): Promise<{ id: number; uuid: string }> {
  const uuid = randomUUID();
  const [board] = await db
    .insert(dbSchema.userBoards)
    .values({
      uuid,
      slug: options.slug ?? `relay-test-${uuid}`,
      ownerId: options.ownerId ?? OWNER,
      name: 'Relay wall',
      boardType: options.boardType ?? 'moonboard',
      layoutId: options.layoutId ?? MOON_LAYOUT_ID,
      sizeId: 1,
      setIds: '1',
      angle: 40,
      isPublic: options.isPublic ?? true,
      moonboardLinkMode: options.moonboardLinkMode ?? null,
    })
    .returning({ id: dbSchema.userBoards.id, uuid: dbSchema.userBoards.uuid });
  createdBoardIds.push(Number(board.id));
  // Other suites truncate user_boards with RESTART IDENTITY, so an id can come
  // back with an older run's Redis keys still alive. Start every board clean.
  await clearBoardKeys([Number(board.id)]);
  return { id: Number(board.id), uuid: board.uuid };
}

const stamp = (boardId: number, ctx: ConnectionContext) =>
  pubsub.stampBoardMembership(String(boardId), emitterIdOf(ctx));

type RelayOverrides = { relayRequestId?: string; climbUuid?: string; angle?: number; mirrored?: boolean };

const relay = (boardId: number, ctx: ConnectionContext, overrides: RelayOverrides = {}) =>
  boardPresenceMutations.relayBoardClimb(
    undefined,
    {
      boardId,
      climb: queueItem(overrides.climbUuid),
      angle: overrides.angle ?? 40,
      mirrored: overrides.mirrored ?? false,
      relayRequestId: overrides.relayRequestId ?? `relay-${randomUUID()}`,
    },
    ctx,
  );

const report = (
  boardId: number,
  ctx: ConnectionContext,
  options: { climbUuid?: string; relayRequestId?: string } = {},
) =>
  boardPresenceMutations.reportBoardClimb(
    undefined,
    { boardId, climb: queueItem(options.climbUuid), angle: 40, relayRequestId: options.relayRequestId },
    ctx,
  );

type SubscriptionIterator = AsyncGenerator<unknown, unknown, unknown>;
type Feed = { iterator: SubscriptionIterator; next: Promise<IteratorResult<unknown>> };
const openFeeds = new Set<Feed>();

/** Open a boardNowPlaying stream (a relay one when `relayCapable`) and wait for its setup. */
async function openFeed(boardId: number, ctx: ConnectionContext, relayCapable = false): Promise<Feed> {
  const iterator = boardPresenceSubscriptions.boardNowPlaying.subscribe(
    undefined,
    { boardId, ...(relayCapable ? { relay: true } : {}) },
    ctx,
  ) as unknown as SubscriptionIterator;
  // The first next() runs the generator up to its first yield, which awaits the
  // eager channel subscribe and the viewer keys. Give it a moment.
  const next = iterator.next();
  next.catch(() => {});
  // Ready once its viewer key (and, for a relay feed, its listener key) is up;
  // both are set after the channel subscribe.
  const isReady = async () => {
    if (!(await pubsub.isBoardViewer(String(boardId), ctx.connectionId))) return false;
    if (!relayCapable || !redisClientManager.isRedisConnected()) return true;
    const { publisher } = redisClientManager.getClients();
    return (await publisher.exists(`board:${boardId}:relay-listener:${ctx.connectionId}`)) === 1;
  };
  const deadline = Date.now() + 3_000;
  while (!(await isReady())) {
    if (Date.now() > deadline) throw new Error(`boardNowPlaying for ${ctx.connectionId} never became ready`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const feed = { iterator, next };
  openFeeds.add(feed);
  return feed;
}

async function closeFeed(feed: Feed): Promise<void> {
  openFeeds.delete(feed);
  await feed.iterator.return?.(undefined);
  // The viewer keys are dropped by the stream's cleanup, fire-and-forget.
  await new Promise((resolve) => setTimeout(resolve, 20));
}

const eventOf = (result: IteratorResult<unknown>) =>
  (result.value as { boardNowPlaying: BoardPresenceEvent }).boardNowPlaying;

/** Every event published on the board, straight off the channel (no per-subscriber filter). */
async function recordChannel(boardId: number): Promise<{ events: BoardPresenceEvent[]; stop: () => void }> {
  const events: BoardPresenceEvent[] = [];
  const stop = await pubsub.subscribeBoardPresence(String(boardId), (event) => events.push(event));
  return { events, stop };
}

const climbSets = (events: BoardPresenceEvent[]) =>
  events.filter((event): event is BoardClimbSet => event.__typename === 'BoardClimbSet');

/** A MoonBoard (relay by default) held by `holderCtx`, which also has a relay feed open. */
async function heldBoard(holderCtx: ConnectionContext, options: BoardOptions = {}) {
  const board = await insertBoard(options);
  await stamp(board.id, holderCtx);
  await report(board.id, holderCtx);
  const holderFeed = await openFeed(board.id, holderCtx, true);
  return { board, holderFeed };
}

/** Stamp `ctx` on the board and open a plain feed for it (the relayer's two proofs). */
async function joinAsRelayer(boardId: number, ctx: ConnectionContext, relayCapable = false): Promise<Feed> {
  await stamp(boardId, ctx);
  return openFeed(boardId, ctx, relayCapable);
}

let redisOn = false;

async function deleteMatching(pattern: string): Promise<void> {
  const { publisher } = redisClientManager.getClients();
  let cursor = '0';
  do {
    const [nextCursor, keys] = await publisher.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = nextCursor;
    if (keys.length > 0) await publisher.del(...keys);
  } while (cursor !== '0');
}

async function clearRateLimitKeys(): Promise<void> {
  if (!redisClientManager.isRedisConnected()) return;
  for (const pattern of ['ratelimit:relay*', ...TEST_USERS.map((userId) => `ratelimit:${userId}:*`)]) {
    await deleteMatching(pattern);
  }
}

/**
 * Every Redis key this suite's boards create: writer, writer-conn, relay-off,
 * relay:*, relay-listener:*, viewer:*, lastReport, history, seq, the membership
 * stamps. Without this a local re-run inside the 12 h TTLs collides with them.
 */
async function clearBoardKeys(boardIds: readonly number[] = createdBoardIds): Promise<void> {
  if (!redisClientManager.isRedisConnected()) return;
  for (const boardId of boardIds) {
    await deleteMatching(`board:${boardId}:*`);
    await deleteMatching(`presence:board:${boardId}:*`);
  }
}

beforeAll(async () => {
  await pubsub.initialize().catch(() => {});
  redisOn = pubsub.isRedisConnected();
  if (!redisOn) console.warn('[board-relay] pubsub Redis unavailable — skipping holder cases');

  await db
    .insert(dbSchema.users)
    .values(
      [...TEST_USERS, SYSTEM_BOARD_OWNER_ID].map((id) => ({
        id,
        email: `${id}@relay.test`,
        name: `Account ${id}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    )
    .onConflictDoNothing();
  await db
    .insert(dbSchema.userProfiles)
    .values({ userId: RELAYER, displayName: RELAYER_DISPLAY_NAME })
    .onConflictDoNothing();
  await db
    .insert(dbSchema.boardClimbs)
    .values([
      {
        uuid: MOON_CLIMB_UUID,
        boardType: 'moonboard',
        layoutId: MOON_LAYOUT_ID,
        name: 'Catalog Moon Climb',
        frames: 'p1r42p2r43',
        setterUsername: 'catalog-setter',
        angle: 40,
        isListed: true,
        isDraft: false,
      },
      {
        uuid: OTHER_MOON_CLIMB_UUID,
        boardType: 'moonboard',
        layoutId: MOON_LAYOUT_ID,
        name: 'Other Moon Climb',
        frames: 'p3r42',
        angle: 40,
        isListed: true,
        isDraft: false,
      },
      {
        uuid: DRAFT_MOON_CLIMB_UUID,
        boardType: 'moonboard',
        layoutId: MOON_LAYOUT_ID,
        name: 'Rosa draft',
        frames: 'p4r42',
        angle: 40,
        userId: RELAYER,
        isListed: true,
        isDraft: true,
      },
      {
        uuid: KILTER_CLIMB_UUID,
        boardType: 'kilter',
        layoutId: KILTER_LAYOUT_ID,
        name: 'Catalog Kilter Climb',
        frames: 'p1145r12',
        angle: 40,
        isListed: true,
        isDraft: false,
      },
    ])
    .onConflictDoNothing();
});

afterAll(async () => {
  await clearBoardKeys();
  await clearRateLimitKeys();
  if (createdBoardIds.length > 0) {
    await db.delete(dbSchema.boardClimbEvents).where(inArray(dbSchema.boardClimbEvents.boardId, createdBoardIds));
    await db.delete(dbSchema.userBoards).where(inArray(dbSchema.userBoards.id, createdBoardIds));
  }
  await db.delete(dbSchema.boardClimbs).where(inArray(dbSchema.boardClimbs.uuid, TEST_CLIMB_UUIDS));
  await db.delete(dbSchema.userProfiles).where(inArray(dbSchema.userProfiles.userId, TEST_USERS));
  await db.delete(dbSchema.users).where(inArray(dbSchema.users.id, TEST_USERS));
  if (redisOn) await redisClientManager.disconnect().catch(() => {});
});

beforeEach(async () => {
  resetAllRateLimits();
  await clearRateLimitKeys();
  await privacyMutations.setAnonymousOnForeignBoards(null, { enabled: false }, ctxFor(RELAYER));
});

afterEach(async () => {
  for (const feed of [...openFeeds]) await closeFeed(feed);
  await clearBoardKeys();
});

describe('relayBoardClimb gates', () => {
  it('refuses a caller without a board-presence stamp', async () => {
    const board = await insertBoard();
    const relayerCtx = ctxFor(RELAYER);
    await openFeed(board.id, relayerCtx);
    await expect(relay(board.id, relayerCtx)).rejects.toThrow('Not connected to this board');
  });

  it('refuses a stamped viewer who lost read access to a private wall since the feed opened', async () => {
    // A crewmate reads a private home wall only while in the owner's live session
    // (#7220); the stamp outlives that by up to 12 hours. A revoked grant ends
    // access the same way, through the same policy read.
    const board = await insertBoard({ isPublic: false });
    await db
      .insert(dbSchema.resourcePrivacy)
      .values({ kind: 'board', resourceId: board.uuid, ownerId: OWNER, audience: 'invite_only' });
    await db
      .insert(dbSchema.resourceGrants)
      .values({ kind: 'board', resourceId: board.uuid, userId: RELAYER, status: 'approved' });
    const relayerCtx = ctxFor(RELAYER);
    await joinAsRelayer(board.id, relayerCtx);
    await expect(relay(board.id, relayerCtx)).resolves.toMatchObject({ status: 'NO_HOLDER' });
    await db
      .update(dbSchema.resourceGrants)
      .set({ status: 'revoked' })
      .where(and(eq(dbSchema.resourceGrants.resourceId, board.uuid), eq(dbSchema.resourceGrants.userId, RELAYER)));
    await expect(relay(board.id, relayerCtx)).rejects.toThrow('Board not found');
    await db.delete(dbSchema.resourceGrants).where(eq(dbSchema.resourceGrants.resourceId, board.uuid));
    await db.delete(dbSchema.resourcePrivacy).where(eq(dbSchema.resourcePrivacy.resourceId, board.uuid));
  });

  it('refuses a stamped caller with no boardNowPlaying open on this connection', async () => {
    const board = await insertBoard();
    const relayerCtx = ctxFor(RELAYER);
    await stamp(board.id, relayerCtx);
    await expect(relay(board.id, relayerCtx)).rejects.toThrow('Not connected to this board');

    // A feed on another connection of the same account is not this connection's.
    await openFeed(board.id, ctxFor(RELAYER));
    await expect(relay(board.id, relayerCtx)).rejects.toThrow('Not connected to this board');

    // Closing the feed withdraws the proof again.
    const feed = await openFeed(board.id, relayerCtx);
    expect((await relay(board.id, relayerCtx)).status).toBe('NO_HOLDER');
    await closeFeed(feed);
    await expect(relay(board.id, relayerCtx)).rejects.toThrow('Not connected to this board');
  });

  it('refuses past the per-caller budget of 20 a minute on one board', async () => {
    const board = await insertBoard();
    const relayerCtx = ctxFor(RELAYER);
    await joinAsRelayer(board.id, relayerCtx);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await relay(board.id, relayerCtx);
    }
    await expect(relay(board.id, relayerCtx)).rejects.toMatchObject({ extensions: { code: 'RATE_LIMITED' } });
  });

  it('keys anonymous callers on their IP, so reconnecting shares the budget', async () => {
    const board = await insertBoard();
    const firstConnection = ctxFor(null, { clientIp: '203.0.113.7' });
    const secondConnection = ctxFor(null, { clientIp: '203.0.113.7' });
    const otherIp = ctxFor(null, { clientIp: '198.51.100.9' });
    for (const ctx of [firstConnection, secondConnection, otherIp]) await joinAsRelayer(board.id, ctx);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await relay(board.id, firstConnection);
      await relay(board.id, secondConnection);
    }
    await expect(relay(board.id, secondConnection)).rejects.toMatchObject({ extensions: { code: 'RATE_LIMITED' } });
    expect((await relay(board.id, otherIp)).status).toBe('NO_HOLDER');
  });

  it('caps a board at 60 relays a minute across every relayer', async () => {
    const board = await insertBoard();
    const relayers = [RELAYER, NEXT_HOLDER, HOLDER, OWNER].map((userId) => ctxFor(userId));
    for (const ctx of relayers) await joinAsRelayer(board.id, ctx);
    for (const ctx of relayers.slice(0, 3)) {
      for (let attempt = 0; attempt < 20; attempt += 1) await relay(board.id, ctx);
    }
    await expect(relay(board.id, relayers[3])).rejects.toMatchObject({ extensions: { code: 'RATE_LIMITED' } });
  });

  it('says NOT_RELAY_BOARD when the person chose multi', async () => {
    const board = await insertBoard({ moonboardLinkMode: 'multi' });
    const relayerCtx = ctxFor(RELAYER);
    await joinAsRelayer(board.id, relayerCtx);
    expect(await relay(board.id, relayerCtx)).toEqual({ status: 'NOT_RELAY_BOARD', holder: null });
  });

  it('says NOT_RELAY_BOARD on a Kilter board', async () => {
    const board = await insertBoard({ boardType: 'kilter', layoutId: KILTER_LAYOUT_ID });
    const relayerCtx = ctxFor(RELAYER);
    await joinAsRelayer(board.id, relayerCtx);
    expect((await relay(board.id, relayerCtx, { climbUuid: KILTER_CLIMB_UUID })).status).toBe('NOT_RELAY_BOARD');
  });

  it('says NOT_RELAY_BOARD on a shared per-config feed', async () => {
    const board = await insertBoard({ ownerId: SYSTEM_BOARD_OWNER_ID, slug: `presence-relay-${randomUUID()}` });
    const relayerCtx = ctxFor(RELAYER);
    await joinAsRelayer(board.id, relayerCtx);
    expect((await relay(board.id, relayerCtx)).status).toBe('NOT_RELAY_BOARD');
  });

  it('says NO_HOLDER when nobody holds the board', async () => {
    const board = await insertBoard();
    const relayerCtx = ctxFor(RELAYER);
    await joinAsRelayer(board.id, relayerCtx);
    expect(await relay(board.id, relayerCtx)).toEqual({ status: 'NO_HOLDER', holder: null });
  });

  it('rejects a malformed relay request id', async () => {
    const board = await insertBoard();
    const relayerCtx = ctxFor(RELAYER);
    await joinAsRelayer(board.id, relayerCtx);
    await expect(relay(board.id, relayerCtx, { relayRequestId: 'has spaces' })).rejects.toThrow();
  });
});

describe('the holder is a connection', () => {
  it('says SELF_HOLDER only to the holding connection; the same account on another phone gets SENT', async () => {
    if (!redisOn) return;
    const holderPhone = ctxFor(HOLDER);
    const { board, holderFeed } = await heldBoard(holderPhone);
    expect(await relay(board.id, holderPhone)).toEqual({ status: 'SELF_HOLDER', holder: null });

    const secondPhone = ctxFor(HOLDER);
    const secondPhoneFeed = await joinAsRelayer(board.id, secondPhone, true);
    const result = await relay(board.id, secondPhone);
    expect(result.status).toBe('SENT');
    expect(result.holder?.userId).toBe(HOLDER);

    // The holding phone gets it; the same account's other (relay-capable) phone does not.
    expect(eventOf(await holderFeed.next).__typename).toBe('BoardClimbRelayRequested');
    await report(board.id, holderPhone, { climbUuid: OTHER_MOON_CLIMB_UUID });
    expect(eventOf(await secondPhoneFeed.next).__typename).toBe('BoardClimbSet');
  });
});

describe('relayBoardClimb delivery', () => {
  it('reaches only the holder connection’s relay feed, and the holder confirms with the echo', async () => {
    if (!redisOn) return;
    const holderCtx = ctxFor(HOLDER);
    const relayerCtx = ctxFor(RELAYER);
    const { board, holderFeed } = await heldBoard(holderCtx);
    // The holder connection's own plain feed is not relay-capable.
    const holderPlainFeed = await openFeed(board.id, holderCtx);
    const relayerFeed = await joinAsRelayer(board.id, relayerCtx, true);
    const anonFeed = await openFeed(board.id, ctxFor(null));

    const relayRequestId = `relay-${randomUUID()}`;
    const result = await relay(board.id, relayerCtx, { relayRequestId, mirrored: true });
    expect(result.status).toBe('SENT');
    expect(result.holder?.userId).toBe(HOLDER);

    const request = eventOf(await holderFeed.next) as BoardClimbRelayRequested;
    expect(request.__typename).toBe('BoardClimbRelayRequested');
    expect(request.relayRequestId).toBe(relayRequestId);
    expect(request.angle).toBe(40);
    // A MoonBoard is never lit mirrored, whatever the relayer asked for.
    expect(request.mirrored).toBe(false);
    // Display fields come from the catalog, never from the relaying client.
    expect(request.climb).toMatchObject({
      climbUuid: MOON_CLIMB_UUID,
      name: 'Catalog Moon Climb',
      frames: 'p1r42p2r43',
      setter: 'catalog-setter',
    });
    expect(request.relayer).toEqual({
      userId: RELAYER,
      displayName: RELAYER_DISPLAY_NAME,
      avatarUrl: null,
      anonymous: false,
    });
    // The server-only routing key never leaves.
    expect(request).not.toHaveProperty('holderConnectionId');

    // The holder lights it and echoes the id. The holder already has this same
    // climb lit (heldBoard), so without the relay bypass it would dedup to silence.
    await report(board.id, holderCtx, { relayRequestId });

    // Every other subscriber's FIRST event is the confirmation, not the request.
    for (const nextResult of [
      await relayerFeed.next,
      await anonFeed.next,
      await holderPlainFeed.next,
      await holderFeed.iterator.next(),
    ]) {
      const climbSet = eventOf(nextResult) as BoardClimbSet;
      expect(climbSet.__typename).toBe('BoardClimbSet');
      expect(climbSet.relayRequestId).toBe(relayRequestId);
    }
  });

  it('says HOLDER_UNREACHABLE while the holder has no relay feed open', async () => {
    if (!redisOn) return;
    const holderCtx = ctxFor(HOLDER);
    const relayerCtx = ctxFor(RELAYER);
    const { board, holderFeed } = await heldBoard(holderCtx);
    await joinAsRelayer(board.id, relayerCtx);
    expect((await relay(board.id, relayerCtx)).status).toBe('SENT');

    await closeFeed(holderFeed);
    const unreachable = await relay(board.id, relayerCtx);
    expect(unreachable.status).toBe('HOLDER_UNREACHABLE');
    expect(unreachable.holder?.userId).toBe(HOLDER);

    // A plain feed (an app without relay) doesn't make the holder reachable.
    await openFeed(board.id, holderCtx);
    expect((await relay(board.id, relayerCtx)).status).toBe('HOLDER_UNREACHABLE');
    await openFeed(board.id, holderCtx, true);
    expect((await relay(board.id, relayerCtx)).status).toBe('SENT');
  });

  it('says CLIMB_UNAVAILABLE for an unknown climb, a wrong angle, or a climb the holder may not read', async () => {
    if (!redisOn) return;
    const holderCtx = ctxFor(HOLDER);
    const relayerCtx = ctxFor(RELAYER);
    const { board } = await heldBoard(holderCtx);
    await joinAsRelayer(board.id, relayerCtx);

    expect((await relay(board.id, relayerCtx, { climbUuid: 'relay-test-no-such-climb' })).status).toBe(
      'CLIMB_UNAVAILABLE',
    );
    expect((await relay(board.id, relayerCtx, { angle: 25 })).status).toBe('CLIMB_UNAVAILABLE');
    const draft = await relay(board.id, relayerCtx, { climbUuid: DRAFT_MOON_CLIMB_UUID });
    expect(draft.status).toBe('CLIMB_UNAVAILABLE');
    expect(draft.holder?.userId).toBe(HOLDER);
    expect((await relay(board.id, relayerCtx, { angle: 40 })).status).toBe('SENT');
  });

  it('names an anonymous-on-boards relayer as anonymous to the holder', async () => {
    if (!redisOn) return;
    await privacyMutations.setAnonymousOnForeignBoards(null, { enabled: true }, ctxFor(RELAYER));
    const holderCtx = ctxFor(HOLDER);
    const relayerCtx = ctxFor(RELAYER);
    const { board, holderFeed } = await heldBoard(holderCtx);
    await joinAsRelayer(board.id, relayerCtx);

    expect((await relay(board.id, relayerCtx)).status).toBe('SENT');
    const request = eventOf(await holderFeed.next) as BoardClimbRelayRequested;
    expect(request.relayer).toEqual({ userId: null, displayName: null, avatarUrl: null, anonymous: true });
  });

  it('marks a signed-out relayer as anonymous', async () => {
    if (!redisOn) return;
    const holderCtx = ctxFor(HOLDER);
    const anonRelayerCtx = ctxFor(null, { clientIp: '192.0.2.44' });
    const { board, holderFeed } = await heldBoard(holderCtx);
    await joinAsRelayer(board.id, anonRelayerCtx);

    expect((await relay(board.id, anonRelayerCtx)).status).toBe('SENT');
    const request = eventOf(await holderFeed.next) as BoardClimbRelayRequested;
    expect(request.relayer.anonymous).toBe(true);
    expect(request.relayer.userId).toBeNull();
  });
});

describe('reportBoardClimb relayRequestId', () => {
  it('ignores an id that names no request: normal dedup, no echo', async () => {
    if (!redisOn) return;
    const holderCtx = ctxFor(HOLDER);
    const { board } = await heldBoard(holderCtx);
    const channel = await recordChannel(board.id);

    // Same climb the holder already has lit, with a made-up id: dedups to silence.
    await report(board.id, holderCtx, { relayRequestId: `relay-${randomUUID()}` });
    expect(climbSets(channel.events)).toHaveLength(0);

    // A different climb publishes, without the made-up id.
    await report(board.id, holderCtx, { climbUuid: OTHER_MOON_CLIMB_UUID, relayRequestId: 'relay-made-up' });
    expect(climbSets(channel.events)).toHaveLength(1);
    expect(climbSets(channel.events)[0].relayRequestId).toBeNull();
    channel.stop();
  });

  it('honours an id only for the connection it was sent to, and only once', async () => {
    if (!redisOn) return;
    const holderCtx = ctxFor(HOLDER);
    const relayerCtx = ctxFor(RELAYER);
    const { board } = await heldBoard(holderCtx);
    await joinAsRelayer(board.id, relayerCtx);
    const relayRequestId = `relay-${randomUUID()}`;
    expect((await relay(board.id, relayerCtx, { relayRequestId })).status).toBe('SENT');
    const channel = await recordChannel(board.id);

    // The relayer replays the id on its own report: not honoured, and not burned.
    await report(board.id, relayerCtx, { relayRequestId });
    expect(climbSets(channel.events).at(-1)?.relayRequestId).toBeNull();

    // The connection it went to claims it.
    await report(board.id, holderCtx, { relayRequestId });
    expect(climbSets(channel.events).at(-1)?.relayRequestId).toBe(relayRequestId);

    // Used up: the same report again is an ordinary retry and dedups.
    const before = climbSets(channel.events).length;
    await report(board.id, holderCtx, { relayRequestId });
    expect(climbSets(channel.events)).toHaveLength(before);
    channel.stop();
  });
});

describe('setBoardRelayAccepting', () => {
  const setAccepting = (boardId: number, ctx: ConnectionContext, accepting: boolean) =>
    boardPresenceMutations.setBoardRelayAccepting(undefined, { boardId, accepting }, ctx);

  it('lets only the holding connection opt out, and the opt-out ends with that connection’s hold', async () => {
    if (!redisOn) return;
    const holderPhone = ctxFor(HOLDER);
    const relayerCtx = ctxFor(RELAYER);
    const { board } = await heldBoard(holderPhone);
    await joinAsRelayer(board.id, relayerCtx);

    // Neither a relayer nor the holder's other phone can change it.
    const secondPhone = ctxFor(HOLDER);
    await joinAsRelayer(board.id, secondPhone, true);
    expect(await setAccepting(board.id, relayerCtx, false)).toBe(false);
    expect(await setAccepting(board.id, secondPhone, false)).toBe(false);
    expect((await relay(board.id, relayerCtx)).status).toBe('SENT');

    expect(await setAccepting(board.id, holderPhone, false)).toBe(true);
    const optedOut = await relay(board.id, relayerCtx);
    expect(optedOut.status).toBe('HOLDER_OPTED_OUT');
    expect(optedOut.holder?.userId).toBe(HOLDER);

    // Back on.
    expect(await setAccepting(board.id, holderPhone, true)).toBe(true);
    expect((await relay(board.id, relayerCtx)).status).toBe('SENT');

    // Off again, then the same account's other phone takes the board: relay is on.
    await setAccepting(board.id, holderPhone, false);
    await report(board.id, secondPhone, { climbUuid: OTHER_MOON_CLIMB_UUID });
    expect((await relay(board.id, relayerCtx)).status).toBe('SENT');
  });

  it('drops the opt-out when the holder lets go, and a new holder starts with relay on', async () => {
    if (!redisOn) return;
    const holderCtx = ctxFor(HOLDER);
    const relayerCtx = ctxFor(RELAYER);
    const { board } = await heldBoard(holderCtx);
    await joinAsRelayer(board.id, relayerCtx);

    await setAccepting(board.id, holderCtx, false);
    expect(await boardPresenceMutations.reportBoardDisconnect(undefined, { boardId: board.id }, holderCtx)).toBe(true);
    await report(board.id, holderCtx, { climbUuid: OTHER_MOON_CLIMB_UUID });
    expect((await relay(board.id, relayerCtx)).status).toBe('SENT');

    await setAccepting(board.id, holderCtx, false);
    const nextHolderCtx = ctxFor(NEXT_HOLDER);
    await stamp(board.id, nextHolderCtx);
    await report(board.id, nextHolderCtx);
    await openFeed(board.id, nextHolderCtx, true);
    const afterHandOff = await relay(board.id, relayerCtx);
    expect(afterHandOff.status).toBe('SENT');
    expect(afterHandOff.holder?.userId).toBe(NEXT_HOLDER);
  });
});
