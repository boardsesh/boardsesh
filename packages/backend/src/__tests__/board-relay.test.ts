/**
 * Relay mode (#7220): `relayBoardClimb`, the holder-only `BoardClimbRelayRequested`
 * event, the holder's opt-out (`setBoardRelayAccepting`), and the
 * `reportBoardClimb(relayRequestId:)` echo on `BoardClimbSet`.
 *
 * The holder lives in Redis (the writer slot), so every case that needs one
 * skips cleanly when pubsub Redis is unavailable, like the holder tests in
 * board-presence.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { inArray } from 'drizzle-orm';
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
const KILTER_CLIMB_UUID = 'relay-test-kilter-climb';

const ctxFor = (userId: string | null): ConnectionContext =>
  ({
    connectionId: `relay-${userId ?? 'anon'}-${randomUUID()}`,
    isAuthenticated: !!userId,
    userId: userId ?? undefined,
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
      isPublic: true,
      moonboardLinkMode: options.moonboardLinkMode ?? null,
    })
    .returning({ id: dbSchema.userBoards.id, uuid: dbSchema.userBoards.uuid });
  createdBoardIds.push(Number(board.id));
  return { id: Number(board.id), uuid: board.uuid };
}

const stamp = (boardId: number, ctx: ConnectionContext) =>
  pubsub.stampBoardMembership(String(boardId), emitterIdOf(ctx));

const relay = (
  boardId: number,
  ctx: ConnectionContext,
  overrides: { relayRequestId?: string; climbUuid?: string } = {},
) =>
  boardPresenceMutations.relayBoardClimb(
    undefined,
    {
      boardId,
      climb: queueItem(overrides.climbUuid),
      angle: 40,
      mirrored: true,
      relayRequestId: overrides.relayRequestId ?? `relay-${randomUUID()}`,
    },
    ctx,
  );

/** A MoonBoard (relay by default) with `holderCtx` holding it and `relayerCtx` stamped. */
async function heldBoard(holderCtx: ConnectionContext, relayerCtx: ConnectionContext, options: BoardOptions = {}) {
  const board = await insertBoard(options);
  await stamp(board.id, holderCtx);
  await stamp(board.id, relayerCtx);
  await boardPresenceMutations.reportBoardClimb(
    undefined,
    { boardId: board.id, climb: queueItem(), angle: 40 },
    holderCtx,
  );
  return board;
}

type SubscriptionIterator = AsyncGenerator<unknown, unknown, unknown>;

async function openFeed(
  boardId: number,
  ctx: ConnectionContext,
): Promise<{ iterator: SubscriptionIterator; next: Promise<IteratorResult<unknown>> }> {
  const iterator = boardPresenceSubscriptions.boardNowPlaying.subscribe(
    undefined,
    { boardId },
    ctx,
  ) as unknown as SubscriptionIterator;
  // The first next() runs the generator up to its first yield, which awaits the
  // eager channel subscribe. Give it a moment before publishing anything.
  const next = iterator.next();
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { iterator, next };
}

const eventOf = (result: IteratorResult<unknown>) =>
  (result.value as { boardNowPlaying: BoardPresenceEvent }).boardNowPlaying;

let redisOn = false;

async function clearRelayRedisKeys(): Promise<void> {
  if (!redisClientManager.isRedisConnected()) return;
  const { publisher } = redisClientManager.getClients();
  for (const pattern of ['ratelimit:relay:*', ...TEST_USERS.map((userId) => `ratelimit:${userId}:*`)]) {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await publisher.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = nextCursor;
      if (keys.length > 0) await publisher.del(...keys);
    } while (cursor !== '0');
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
  if (createdBoardIds.length > 0) {
    await db.delete(dbSchema.boardClimbEvents).where(inArray(dbSchema.boardClimbEvents.boardId, createdBoardIds));
    await db.delete(dbSchema.userBoards).where(inArray(dbSchema.userBoards.id, createdBoardIds));
  }
  await db.delete(dbSchema.boardClimbs).where(inArray(dbSchema.boardClimbs.uuid, [MOON_CLIMB_UUID, KILTER_CLIMB_UUID]));
  await db.delete(dbSchema.userProfiles).where(inArray(dbSchema.userProfiles.userId, TEST_USERS));
  await db.delete(dbSchema.users).where(inArray(dbSchema.users.id, TEST_USERS));
  await clearRelayRedisKeys();
  if (redisOn) await redisClientManager.disconnect().catch(() => {});
});

beforeEach(async () => {
  resetAllRateLimits();
  await clearRelayRedisKeys();
  await privacyMutations.setAnonymousOnForeignBoards(null, { enabled: false }, ctxFor(RELAYER));
});

describe('relayBoardClimb gates', () => {
  it('refuses a caller without a board-presence stamp', async () => {
    const board = await insertBoard();
    await expect(relay(board.id, ctxFor(RELAYER))).rejects.toThrow('Not connected to this board');
  });

  it('refuses past the per-board budget of 20 a minute', async () => {
    const board = await insertBoard();
    const relayerCtx = ctxFor(RELAYER);
    await stamp(board.id, relayerCtx);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await relay(board.id, relayerCtx);
    }
    await expect(relay(board.id, relayerCtx)).rejects.toMatchObject({ extensions: { code: 'RATE_LIMITED' } });
  });

  it('says NOT_RELAY_BOARD when the person chose multi', async () => {
    const board = await insertBoard({ moonboardLinkMode: 'multi' });
    const relayerCtx = ctxFor(RELAYER);
    await stamp(board.id, relayerCtx);
    expect(await relay(board.id, relayerCtx)).toEqual({ status: 'NOT_RELAY_BOARD', holder: null });
  });

  it('says NOT_RELAY_BOARD on a Kilter board', async () => {
    const board = await insertBoard({ boardType: 'kilter', layoutId: KILTER_LAYOUT_ID });
    const relayerCtx = ctxFor(RELAYER);
    await stamp(board.id, relayerCtx);
    expect((await relay(board.id, relayerCtx, { climbUuid: KILTER_CLIMB_UUID })).status).toBe('NOT_RELAY_BOARD');
  });

  it('says NOT_RELAY_BOARD on a shared per-config feed', async () => {
    const board = await insertBoard({ ownerId: SYSTEM_BOARD_OWNER_ID, slug: `presence-relay-${randomUUID()}` });
    const relayerCtx = ctxFor(RELAYER);
    await stamp(board.id, relayerCtx);
    expect((await relay(board.id, relayerCtx)).status).toBe('NOT_RELAY_BOARD');
  });

  it('says NO_HOLDER when nobody holds the board', async () => {
    const board = await insertBoard();
    const relayerCtx = ctxFor(RELAYER);
    await stamp(board.id, relayerCtx);
    expect(await relay(board.id, relayerCtx)).toEqual({ status: 'NO_HOLDER', holder: null });
  });

  it('says SELF_HOLDER to the holder', async () => {
    if (!redisOn) return;
    const holderCtx = ctxFor(HOLDER);
    const board = await heldBoard(holderCtx, ctxFor(RELAYER));
    expect(await relay(board.id, holderCtx)).toEqual({ status: 'SELF_HOLDER', holder: null });
  });

  it('rejects a malformed relay request id', async () => {
    const board = await insertBoard();
    const relayerCtx = ctxFor(RELAYER);
    await stamp(board.id, relayerCtx);
    await expect(relay(board.id, relayerCtx, { relayRequestId: 'has spaces' })).rejects.toThrow();
  });
});

describe('relayBoardClimb delivery', () => {
  it('reaches only the holder, with catalog fields, and the holder confirms with the echo', async () => {
    if (!redisOn) return;
    const holderCtx = ctxFor(HOLDER);
    const relayerCtx = ctxFor(RELAYER);
    const anonViewerCtx = ctxFor(null);
    const board = await heldBoard(holderCtx, relayerCtx);

    const holderFeed = await openFeed(board.id, holderCtx);
    const relayerFeed = await openFeed(board.id, relayerCtx);
    const anonFeed = await openFeed(board.id, anonViewerCtx);

    const relayRequestId = `relay-${randomUUID()}`;
    const result = await relay(board.id, relayerCtx, { relayRequestId });
    expect(result.status).toBe('SENT');
    expect(result.holder?.userId).toBe(HOLDER);

    const request = eventOf(await holderFeed.next) as BoardClimbRelayRequested;
    expect(request.__typename).toBe('BoardClimbRelayRequested');
    expect(request.relayRequestId).toBe(relayRequestId);
    expect(request.angle).toBe(40);
    expect(request.mirrored).toBe(true);
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
    expect(request).not.toHaveProperty('holderEmitterId');

    // The holder lights it and echoes the id. The holder already has this same
    // climb lit (heldBoard), so without the relay bypass it would dedup to silence.
    await boardPresenceMutations.reportBoardClimb(
      undefined,
      { boardId: board.id, climb: queueItem(), angle: 40, relayRequestId },
      holderCtx,
    );

    // Every other subscriber's FIRST event is the confirmation, not the request.
    for (const feed of [relayerFeed, anonFeed, holderFeed]) {
      const nextResult = feed === holderFeed ? await holderFeed.iterator.next() : await feed.next;
      const climbSet = eventOf(nextResult) as BoardClimbSet;
      expect(climbSet.__typename).toBe('BoardClimbSet');
      expect(climbSet.relayRequestId).toBe(relayRequestId);
    }

    for (const feed of [holderFeed, relayerFeed, anonFeed]) await feed.iterator.return?.(undefined);
  });

  it('names an anonymous-on-boards relayer as anonymous to the holder', async () => {
    if (!redisOn) return;
    await privacyMutations.setAnonymousOnForeignBoards(null, { enabled: true }, ctxFor(RELAYER));
    const holderCtx = ctxFor(HOLDER);
    const relayerCtx = ctxFor(RELAYER);
    const board = await heldBoard(holderCtx, relayerCtx);
    const holderFeed = await openFeed(board.id, holderCtx);

    expect((await relay(board.id, relayerCtx)).status).toBe('SENT');
    const request = eventOf(await holderFeed.next) as BoardClimbRelayRequested;
    expect(request.relayer).toEqual({ userId: null, displayName: null, avatarUrl: null, anonymous: true });
    await holderFeed.iterator.return?.(undefined);
  });

  it('marks a signed-out relayer as anonymous', async () => {
    if (!redisOn) return;
    const holderCtx = ctxFor(HOLDER);
    const anonRelayerCtx = ctxFor(null);
    const board = await heldBoard(holderCtx, anonRelayerCtx);
    const holderFeed = await openFeed(board.id, holderCtx);

    expect((await relay(board.id, anonRelayerCtx)).status).toBe('SENT');
    const request = eventOf(await holderFeed.next) as BoardClimbRelayRequested;
    expect(request.relayer.anonymous).toBe(true);
    expect(request.relayer.userId).toBeNull();
    await holderFeed.iterator.return?.(undefined);
  });
});

describe('setBoardRelayAccepting', () => {
  it('lets only the holder opt out, and the opt-out lapses when the holder changes', async () => {
    if (!redisOn) return;
    const holderCtx = ctxFor(HOLDER);
    const relayerCtx = ctxFor(RELAYER);
    const board = await heldBoard(holderCtx, relayerCtx);

    // A non-holder cannot change it.
    expect(
      await boardPresenceMutations.setBoardRelayAccepting(
        undefined,
        { boardId: board.id, accepting: false },
        relayerCtx,
      ),
    ).toBe(false);
    expect((await relay(board.id, relayerCtx)).status).toBe('SENT');

    expect(
      await boardPresenceMutations.setBoardRelayAccepting(
        undefined,
        { boardId: board.id, accepting: false },
        holderCtx,
      ),
    ).toBe(true);
    const optedOut = await relay(board.id, relayerCtx);
    expect(optedOut.status).toBe('HOLDER_OPTED_OUT');
    expect(optedOut.holder?.userId).toBe(HOLDER);

    // Back on.
    expect(
      await boardPresenceMutations.setBoardRelayAccepting(undefined, { boardId: board.id, accepting: true }, holderCtx),
    ).toBe(true);
    expect((await relay(board.id, relayerCtx)).status).toBe('SENT');

    // Off again, then a new holder takes the board: relay is on for them.
    await boardPresenceMutations.setBoardRelayAccepting(undefined, { boardId: board.id, accepting: false }, holderCtx);
    const nextHolderCtx = ctxFor(NEXT_HOLDER);
    await stamp(board.id, nextHolderCtx);
    await boardPresenceMutations.reportBoardClimb(
      undefined,
      { boardId: board.id, climb: queueItem(), angle: 40 },
      nextHolderCtx,
    );
    const afterHandOff = await relay(board.id, relayerCtx);
    expect(afterHandOff.status).toBe('SENT');
    expect(afterHandOff.holder?.userId).toBe(NEXT_HOLDER);
  });
});
