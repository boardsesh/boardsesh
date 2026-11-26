import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import Redis from 'ioredis';
import { Kind, parse, type FieldNode, type GraphQLResolveInfo, type OperationDefinitionNode } from 'graphql';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import * as schema from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { socialBoardQueries } from '../graphql/resolvers/social/boards';
import { redisClientManager } from '../redis/client';
import { logger } from '../utils/logger';
import { resetAllRateLimits } from '../utils/rate-limiter';
import {
  SERIAL_REVEALS_PER_30_DAYS,
  SERIAL_REVEALS_PER_DAY,
  SERIAL_REVEALS_PER_HOUR,
} from '../utils/serial-reveal-budget';

// A private home board heard over Bluetooth (docs/product/privacy.md, "What a
// serial tells a climber nearby"): which boards say whose they are, to whom,
// what the card carries, and the caps. Real Postgres, because the gating is
// SQL, and real Redis, because the caps live only there.

type Audience = 'public' | 'unlisted' | 'followers' | 'invite_only' | 'only_me';

const owner = `reveal-owner-${uuidv4()}`;
const ownerName = 'Sam Setter';

const signedIn = (userId: string) =>
  ({ isAuthenticated: true, userId, connectionId: `reveal-${userId}-${Math.random()}` }) as ConnectionContext;
const signedOut = () =>
  ({ isAuthenticated: false, connectionId: `reveal-anon-${Math.random()}` }) as unknown as ConnectionContext;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A climber nearby. By default one the owner follows, with an account old
 * enough and a verified email: the one climber who gets cards.
 */
async function newClimber(
  label: string,
  {
    followedByOwner = true,
    followsOwner = false,
    accountAgeDays = 30,
    emailVerified = true,
  }: { followedByOwner?: boolean; followsOwner?: boolean; accountAgeDays?: number; emailVerified?: boolean } = {},
): Promise<string> {
  const id = `reveal-${label}-${uuidv4()}`;
  // Seeded before a test moves Date: eligibility reads Postgres' own clock.
  const createdAt = new Date(Date.now() - accountAgeDays * DAY_MS);
  await db
    .insert(schema.users)
    .values({ id, name: id, email: `${id}@test.invalid`, createdAt, emailVerified: emailVerified ? createdAt : null });
  if (followedByOwner) await db.insert(schema.userFollows).values({ followerId: owner, followingId: id });
  if (followsOwner) await db.insert(schema.userFollows).values({ followerId: id, followingId: owner });
  return id;
}

let boardCount = 0;
async function seedBoard(
  audience: Audience,
  options: {
    boardType?: string;
    gymId?: number;
    ownerId?: string;
    serial?: string;
    angle?: number;
    /** "Show to people I follow". On by default, so an Invite-only board is listed. */
    listedToFollowers?: boolean;
  } = {},
): Promise<{ uuid: string; slug: string; serial: string; boardType: string }> {
  boardCount += 1;
  const uuid = uuidv4();
  const slug = `reveal-${audience.replace(/_/g, '-')}-${boardCount}-${uuid.slice(0, 8)}`;
  const serial = options.serial ?? `RVL${uuid.slice(0, 8).toUpperCase()}`;
  const boardType = options.boardType ?? 'kilter';
  const boardOwner = options.ownerId ?? owner;
  await db.insert(schema.userBoards).values({
    uuid,
    slug,
    ownerId: boardOwner,
    name: `Garage ${audience} ${boardCount}`,
    boardType,
    layoutId: 1,
    sizeId: 10,
    setIds: '1,2',
    angle: options.angle ?? 40,
    isPublic: audience === 'public',
    isUnlisted: audience === 'unlisted',
    hideLocation: false,
    locationName: 'Secret garage, 12 Example Street',
    latitude: 51.5,
    longitude: -0.12,
    serialNumber: serial,
    gymId: options.gymId ?? null,
  });
  await db.insert(schema.resourcePrivacy).values({
    kind: 'board',
    resourceId: uuid,
    ownerId: boardOwner,
    audience,
    listedToFollowers: options.listedToFollowers ?? true,
    // Open to anyone who can read the board, so a card that leaked it would show.
    locationAudience: 'public',
  });
  return { uuid, slug, serial, boardType };
}

async function setGrant(boardUuid: string, userId: string, status: 'pending' | 'approved' | 'revoked') {
  await db
    .insert(schema.resourceGrants)
    .values({ kind: 'board', resourceId: boardUuid, userId, status, invitedBy: owner });
}

/** The resolve info for a client that selected exactly `fields` on each match. */
function infoSelecting(fields: string): GraphQLResolveInfo {
  const operation = parse(`{ observedBoardSerialMatches(input: []) { ${fields} } }`)
    .definitions[0] as OperationDefinitionNode;
  const fieldNode = operation.selectionSet.selections.find((selection) => selection.kind === Kind.FIELD) as FieldNode;
  return { fieldNodes: [fieldNode], fragments: {} } as unknown as GraphQLResolveInfo;
}

async function lookUp(
  boards: ReadonlyArray<{ serial: string; boardType: string }>,
  context: ConnectionContext,
  info?: GraphQLResolveInfo,
) {
  return socialBoardQueries.observedBoardSerialMatches(
    null,
    { input: boards.map((board) => ({ boardType: board.boardType, observedSerialNumber: board.serial })) },
    context,
    info,
  );
}

let publisher: Redis;

beforeAll(async () => {
  publisher = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6380', { maxRetriesPerRequest: 1 });
  await publisher.ping();
  vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '1');
  await db.insert(schema.users).values({ id: owner, name: 'sam-account', email: `${owner}@test.invalid` });
  await db
    .insert(schema.userProfiles)
    .values({ userId: owner, displayName: ownerName, avatarUrl: 'https://a.test/sam.png' });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await publisher.quit();
});
beforeEach(() => {
  resetAllRateLimits();
  vi.spyOn(redisClientManager, 'isRedisConnected').mockReturnValue(true);
  vi.spyOn(redisClientManager, 'getClients').mockReturnValue({
    publisher,
    subscriber: publisher,
    streamConsumer: publisher,
  } as unknown as ReturnType<typeof redisClientManager.getClients>);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** How many of the matches carry a card. */
function cardCount(matches: Awaited<ReturnType<typeof lookUp>>): number {
  return matches.filter((match) => match.candidateRequestCards[0] !== null).length;
}

/** Looks the boards up at `time`, 20 serials a call as the client sends them, and counts the cards. */
async function cardsAt(time: number, climber: string, boards: ReadonlyArray<{ serial: string; boardType: string }>) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(time);
  let named = 0;
  for (let start = 0; start < boards.length; start += 20) {
    named += cardCount(await lookUp(boards.slice(start, start + 20), signedIn(climber)));
  }
  return named;
}

describe('a private home board heard over Bluetooth', () => {
  it.each(['followers', 'invite_only'] as const)(
    'says whose a %s board is, and nothing that finds it again',
    async (audience) => {
      const climber = await newClimber('nearby');
      const board = await seedBoard(audience);
      const [match] = await lookUp([board], signedIn(climber));

      // The stub every binary has always seen stays as it was.
      expect(match.candidates).toHaveLength(1);
      expect(match.candidates[0]).toMatchObject({ uuid: '', slug: '', name: 'kilter', locationName: null });
      expect(match.candidateRequestCards).toEqual([
        {
          requested: false,
          ownerDisplayName: ownerName,
          ownerAvatarUrl: 'https://a.test/sam.png',
          preview: {
            uuid: board.uuid,
            // The board type, never "Garage …": a board's own name can name a place.
            name: 'kilter',
            boardType: 'kilter',
            layoutId: 1,
            sizeId: 10,
            setIds: '1,2',
            angle: 40,
          },
        },
      ]);
      const serialized = JSON.stringify(match.candidateRequestCards);
      for (const secret of [board.slug, board.serial, 'Garage', 'Secret garage', '51.5', '-0.12', owner]) {
        expect(serialized).not.toContain(secret);
      }
    },
  );

  it.each(['only_me', 'unlisted'] as const)('keeps a %s board anonymous', async (audience) => {
    // Unlisted: the uuid is the board's link, so a card would open it.
    const climber = await newClimber('nearby');
    const board = await seedBoard(audience);
    const [match] = await lookUp([board], signedIn(climber));
    expect(match.candidates[0]).toMatchObject({ uuid: '', name: 'kilter' });
    expect(match.candidateRequestCards).toEqual([null]);
  });

  it('gives a signed-out caller the stub and no card', async () => {
    const board = await seedBoard('followers');
    const [match] = await lookUp([board], signedOut());
    expect(match.candidates[0]).toMatchObject({ uuid: '', slug: '', name: 'kilter' });
    expect(match.candidateRequestCards).toEqual([null]);
  });

  it('leaves a board the climber can open exactly as it was, with no card', async () => {
    const climber = await newClimber('member');
    const publicBoard = await seedBoard('public');
    const memberBoard = await seedBoard('invite_only');
    await setGrant(memberBoard.uuid, climber, 'approved');
    const matches = await lookUp([publicBoard, memberBoard], signedIn(climber));
    expect(matches.map((match) => match.candidates[0]?.uuid)).toEqual([publicBoard.uuid, memberBoard.uuid]);
    expect(matches.map((match) => match.candidateRequestCards)).toEqual([[null], [null]]);
  });

  it('says Requested while an ask waits, and nothing to someone the owner removed', async () => {
    const asker = await newClimber('asker');
    const removed = await newClimber('removed');
    const board = await seedBoard('invite_only');
    await setGrant(board.uuid, asker, 'pending');
    await setGrant(board.uuid, removed, 'revoked');
    const [asked] = await lookUp([board], signedIn(asker));
    expect(asked.candidateRequestCards[0]).toMatchObject({ requested: true });
    const [removedMatch] = await lookUp([board], signedIn(removed));
    expect(removedMatch.candidateRequestCards).toEqual([null]);
  });

  it('names no spray wall and no wall at a public listed gym', async () => {
    const climber = await newClimber('nearby');
    const [gym] = await db
      .insert(schema.gyms)
      .values({ uuid: `reveal-gym-${uuidv4()}`, name: 'Reveal gym', ownerId: owner, isPublic: true, isListed: true })
      .returning({ id: schema.gyms.id });
    const gymWall = await seedBoard('invite_only', { gymId: Number(gym.id) });
    const spray = await seedBoard('invite_only', { boardType: 'spray' });
    const matches = await lookUp([gymWall, spray], signedIn(climber));
    expect(matches.flatMap((match) => match.candidateRequestCards)).toEqual([null, null]);
  });

  it(`names at most ${SERIAL_REVEALS_PER_HOUR} distinct boards an hour, then falls back to the stub`, async () => {
    const climber = await newClimber('scanner');
    const boards = [];
    for (let index = 0; index <= SERIAL_REVEALS_PER_HOUR; index += 1) boards.push(await seedBoard('invite_only'));
    // Mid-hour, so the lookups below share one hourly bucket.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2031, 0, 1, 9, 5));
    const infoSpy = vi.spyOn(logger, 'info');

    const first = await lookUp(boards, signedIn(climber));
    const named = first.filter((match) => match.candidateRequestCards[0] !== null);
    expect(named).toHaveLength(SERIAL_REVEALS_PER_HOUR);
    // Over the cap: the stub, not an error, so the scan keeps working.
    const heldBack = first.find((match) => match.candidateRequestCards[0] === null);
    expect(heldBack?.candidates[0]).toMatchObject({ uuid: '', name: 'kilter' });
    expect(infoSpy).toHaveBeenCalledWith('[serial-reveal] request cards', {
      userId: climber,
      revealed: SERIAL_REVEALS_PER_HOUR,
      heldBack: 1,
    });
    // The log says who and how many, never which serial or board.
    const logged = JSON.stringify(infoSpy.mock.calls);
    for (const board of boards) {
      expect(logged).not.toContain(board.serial);
      expect(logged).not.toContain(board.uuid);
    }
    infoSpy.mockRestore();

    // A board already named this hour is named again for free; a new one is not.
    const namedBoard = boards.find((board) => named.some((match) => match.observedSerialNumber === board.serial));
    const heldBackBoard = boards.find((board) => board.serial === heldBack?.observedSerialNumber);
    const [again] = await lookUp([namedBoard!], signedIn(climber));
    expect(again.candidateRequestCards[0]).not.toBeNull();
    const [stillHeld] = await lookUp([heldBackBoard!], signedIn(climber));
    expect(stillHeld.candidateRequestCards).toEqual([null]);
  });

  it('spends no budget for a client that does not ask for cards', async () => {
    const climber = await newClimber('old-binary');
    const boards = [];
    for (let index = 0; index <= SERIAL_REVEALS_PER_HOUR; index += 1) boards.push(await seedBoard('followers'));
    const infoSpy = vi.spyOn(logger, 'info');
    await lookUp(boards, signedIn(climber), infoSelecting('boardType observedSerialNumber candidates { uuid }'));
    expect(infoSpy).not.toHaveBeenCalledWith('[serial-reveal] request cards', expect.anything());
    infoSpy.mockRestore();

    const withCards = await lookUp(
      boards,
      signedIn(climber),
      infoSelecting('boardType candidates { uuid } candidateRequestCards { requested }'),
    );
    expect(withCards.filter((match) => match.candidateRequestCards[0] !== null)).toHaveLength(SERIAL_REVEALS_PER_HOUR);
  });

  it('names no board to a stranger, nor to someone who follows the owner but is not followed back', async () => {
    // A follow is one tap. Only the owner's follow, their consent to be listed,
    // unlocks a card, so following someone to see whose wall this is learns nothing.
    const stranger = await newClimber('stranger', { followedByOwner: false });
    const fan = await newClimber('fan', { followedByOwner: false, followsOwner: true });
    const friend = await newClimber('friend', { followedByOwner: true, followsOwner: false });
    const followersBoard = await seedBoard('followers');
    const inviteOnly = await seedBoard('invite_only');

    const strangerMatches = await lookUp([followersBoard, inviteOnly], signedIn(stranger));
    expect(strangerMatches.flatMap((match) => match.candidateRequestCards)).toEqual([null, null]);
    expect(strangerMatches.map((match) => match.candidates[0])).toMatchObject([
      { uuid: '', name: 'kilter' },
      { uuid: '', name: 'kilter' },
    ]);
    // Following a Followers board's owner opens it, so only the Invite-only one is a stub.
    const [fanMatch] = await lookUp([inviteOnly], signedIn(fan));
    expect(fanMatch.candidates[0]).toMatchObject({ uuid: '', name: 'kilter' });
    expect(fanMatch.candidateRequestCards).toEqual([null]);

    const friendMatches = await lookUp([followersBoard, inviteOnly], signedIn(friend));
    expect(friendMatches.map((match) => match.candidateRequestCards[0]?.preview.uuid)).toEqual([
      followersBoard.uuid,
      inviteOnly.uuid,
    ]);
  });

  it('keeps an Invite-only board the owner did not show to people they follow anonymous', async () => {
    const climber = await newClimber('nearby');
    const board = await seedBoard('invite_only', { listedToFollowers: false });
    const [match] = await lookUp([board], signedIn(climber));
    expect(match.candidateRequestCards).toEqual([null]);
  });

  it.each([
    ['an account under 7 days old', { accountAgeDays: 2 }],
    ['an account with no verified email', { emailVerified: false }],
  ])('names nothing to %s, and answers with the stub', async (_label, eligibility) => {
    const climber = await newClimber('new', eligibility);
    const board = await seedBoard('followers');
    const [match] = await lookUp([board], signedIn(climber));
    expect(match.candidates[0]).toMatchObject({ uuid: '', name: 'kilter' });
    expect(match.candidateRequestCards).toEqual([null]);
  });

  it("names neither the climber's own board, nor a deleted, merged or foreign-gym one", async () => {
    const climber = await newClimber('nearby');
    const own = await seedBoard('invite_only', { ownerId: climber });
    const deleted = await seedBoard('invite_only');
    await db.update(schema.userBoards).set({ deletedAt: new Date() }).where(eq(schema.userBoards.uuid, deleted.uuid));
    const canonical = await seedBoard('public');
    const merged = await seedBoard('invite_only');
    await db
      .update(schema.userBoards)
      .set({ mergedIntoBoardUuid: canonical.uuid })
      .where(eq(schema.userBoards.uuid, merged.uuid));
    // A private gym someone else runs: its walls are found through the gym.
    const gymOwner = await newClimber('gym-owner', { followedByOwner: false });
    const [gym] = await db
      .insert(schema.gyms)
      .values({
        uuid: `reveal-gym-${uuidv4()}`,
        name: 'Their gym',
        ownerId: gymOwner,
        isPublic: false,
        isListed: false,
      })
      .returning({ id: schema.gyms.id });
    const foreignGym = await seedBoard('invite_only', { gymId: Number(gym.id) });

    const matches = await lookUp([own, deleted, merged, foreignGym], signedIn(climber));
    const byInput = new Map(matches.map((match) => [match.observedSerialNumber, match]));
    // Their own board opens as itself; a deleted one is not a candidate at all.
    expect(byInput.get(own.serial)?.candidates[0]).toMatchObject({ uuid: own.uuid });
    expect(byInput.get(deleted.serial)?.candidates).toEqual([]);
    for (const match of matches) expect(match.candidateRequestCards.every((card) => card === null)).toBe(true);
  });

  it('lines each card up with its own candidate when two boards share a serial', async () => {
    const climber = await newClimber('nearby');
    // Serials are not unique across owners: the same one shipped twice.
    const stranger = await newClimber('other-owner', { followedByOwner: false });
    const friendBoard = await seedBoard('invite_only', { angle: 40 });
    const strangerBoard = await seedBoard('invite_only', { ownerId: stranger, serial: friendBoard.serial, angle: 25 });
    expect(strangerBoard.serial).toBe(friendBoard.serial);

    const [match] = await lookUp([friendBoard], signedIn(climber));
    expect(match.candidates).toHaveLength(2);
    expect(match.candidateRequestCards).toHaveLength(2);
    const pairs = match.candidates.map((candidate, index) => [candidate.angle, match.candidateRequestCards[index]]);
    expect(pairs).toContainEqual([40, expect.objectContaining({ preview: expect.objectContaining({ angle: 40 }) })]);
    expect(pairs).toContainEqual([25, null]);
  });

  it(`names at most ${SERIAL_REVEALS_PER_DAY} distinct boards a UTC day`, async () => {
    const climber = await newClimber('day-scanner');
    const boards = [];
    for (let index = 0; index <= SERIAL_REVEALS_PER_DAY; index += 1) boards.push(await seedBoard('followers'));
    const morning = Date.UTC(2031, 2, 3, 8, 10);

    expect(await cardsAt(morning, climber, boards)).toBe(SERIAL_REVEALS_PER_HOUR);
    // An hour later the hourly cap has room again, the daily one only for 5 more.
    const unnamed = boards.slice(SERIAL_REVEALS_PER_HOUR);
    expect(await cardsAt(morning + 60 * 60 * 1000, climber, unnamed)).toBe(
      SERIAL_REVEALS_PER_DAY - SERIAL_REVEALS_PER_HOUR,
    );
    const held = boards.slice(SERIAL_REVEALS_PER_DAY);
    expect(await cardsAt(morning + 2 * 60 * 60 * 1000, climber, held)).toBe(0);
    // After 00:00 UTC the 16th board is named.
    expect(await cardsAt(Date.UTC(2031, 2, 4, 0, 10), climber, held)).toBe(1);
  });

  it(`names at most ${SERIAL_REVEALS_PER_30_DAYS} distinct boards in any 30 days`, async () => {
    const climber = await newClimber('month-scanner');
    const boards = [];
    for (let index = 0; index <= SERIAL_REVEALS_PER_30_DAYS; index += 1) boards.push(await seedBoard('followers'));
    const start = Date.UTC(2031, 4, 1, 8, 10);
    const hour = 60 * 60 * 1000;
    // 10 an hour, 15 a day: 40 boards over three days.
    expect(await cardsAt(start, climber, boards.slice(0, 10))).toBe(10);
    expect(await cardsAt(start + hour, climber, boards.slice(10, 15))).toBe(5);
    expect(await cardsAt(start + DAY_MS, climber, boards.slice(15, 25))).toBe(10);
    expect(await cardsAt(start + DAY_MS + hour, climber, boards.slice(25, 30))).toBe(5);
    expect(await cardsAt(start + 2 * DAY_MS, climber, boards.slice(30, 40))).toBe(10);
    const last = boards.slice(40);
    // A new day and a new hour, but 40 boards were named within 30 days.
    expect(await cardsAt(start + 3 * DAY_MS, climber, last)).toBe(0);
    // A board already named in the window is named again on a new day.
    expect(await cardsAt(start + 3 * DAY_MS, climber, boards.slice(0, 1))).toBe(1);
    // Rolling: once the first day's boards have gone 30 days unnamed, there is
    // room again. Board 0 was named again three days in, so it still counts.
    expect(await cardsAt(start + 30 * DAY_MS + 2 * hour, climber, last)).toBe(1);
  });

  it('names nothing while Redis is unavailable, and the scan still answers', async () => {
    const climber = await newClimber('outage');
    const board = await seedBoard('followers');

    vi.spyOn(redisClientManager, 'isRedisConnected').mockReturnValue(false);
    const [disconnected] = await lookUp([board], signedIn(climber));
    expect(disconnected.candidates[0]).toMatchObject({ uuid: '', name: 'kilter' });
    expect(disconnected.candidateRequestCards).toEqual([null]);

    vi.spyOn(redisClientManager, 'isRedisConnected').mockReturnValue(true);
    // Only the caps' script fails: the rate limiter shares the client.
    const realEval = publisher.eval.bind(publisher) as (...args: unknown[]) => Promise<unknown>;
    const evalSpy = vi
      .spyOn(publisher, 'eval')
      .mockImplementation(((...args: unknown[]) =>
        String(args[0]).includes('rollingBudget')
          ? Promise.reject(new Error('READONLY'))
          : realEval(...args)) as unknown as typeof publisher.eval);
    const [failed] = await lookUp([board], signedIn(climber));
    evalSpy.mockRestore();
    expect(failed.candidates[0]).toMatchObject({ uuid: '', name: 'kilter' });
    expect(failed.candidateRequestCards).toEqual([null]);

    // Back up: the same board is named.
    const [recovered] = await lookUp([board], signedIn(climber));
    expect(recovered.candidateRequestCards[0]).toMatchObject({ preview: { uuid: board.uuid } });
  });
});
