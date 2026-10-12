import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vite-plus/test';
import { createRequire } from 'node:module';
import type * as GraphQLModule from 'graphql';
import { v4 as uuidv4 } from 'uuid';
import { eq, sql } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { schema as executableSchema } from '../graphql/index';
import { socialBoardMutations, socialBoardQueries } from '../graphql/resolvers/social/boards';
import { socialGymMutations } from '../graphql/resolvers/social/gyms';
import { socialGymStrayBoardMutations } from '../graphql/resolvers/social/gym-stray-boards';
import { projectBoardLocation } from '../services/board-location-projection';
import { boardSessionPrivacyResolvers } from '../graphql/resolvers/shared/board-session-privacy';
import { boardPresenceMutations } from '../graphql/resolvers/board-presence/mutations';
import { resetAllRateLimits } from '../utils/rate-limiter';
import { seedAuroraCatalogFixtures } from './helpers/board-catalog-fixture';

/**
 * Where a viewer sees a board, read time only (projectBoardLocation):
 *
 * - the board's own place, to its owner and to viewers its location choice admits;
 * - a public, live gym's listed name and coordinates, to everyone else;
 * - nothing otherwise.
 *
 * A gym never changes the board's own hide setting, so the scenarios that leaked
 * a home under the old write-time rule are replayed here and must never put the
 * board's own coordinates or typed name in front of an anonymous viewer.
 */

const { execute, parse } = createRequire(import.meta.url)('graphql') as typeof GraphQLModule;

const SYSTEM_OWNER = '00000000-0000-0000-0000-000000000000';
const CLIMBER = 'projection-climber';
const GYM_OWNER = 'projection-gym-owner';
const STRANGER = 'projection-stranger';
const BASE = { latitude: 47.0, longitude: 8.0 };
const LAT_60M = 47.0 + 0.00054;
const LAT_120M = 47.0 + 0.00108;
const LAT_8KM = 47.0 + 0.072;
const GYM_NAME = 'Boulder Central';
const HOME = '12 Elm Street';

let connectionCounter = 0;
const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `projection-${userId}-${connectionCounter++}`, isAuthenticated: true, userId }) as ConnectionContext;
const anonCtx = (): ConnectionContext =>
  ({ connectionId: `projection-anon-${connectionCounter++}`, isAuthenticated: false }) as ConnectionContext;

type LocationRead = {
  latitude: number | null;
  longitude: number | null;
  locationName: string | null;
  gymUuid: string | null;
  gymName: string | null;
};

const BOARD_LOCATION_QUERY = `
  query BoardLocation($boardUuid: ID!) {
    board(boardUuid: $boardUuid) { latitude longitude locationName gymUuid gymName gymId distanceMeters }
  }
`;

/** An anonymous read through the shipped schema, field resolvers included. */
async function anonymousSchemaRead(boardUuid: string): Promise<LocationRead | null> {
  const result = await execute({
    schema: executableSchema,
    document: parse(BOARD_LOCATION_QUERY),
    variableValues: { boardUuid },
    contextValue: anonCtx(),
  });
  expect(result.errors ?? []).toEqual([]);
  const board = (result.data as { board: (LocationRead & { gymId: number | null }) | null }).board;
  return board
    ? {
        latitude: board.latitude,
        longitude: board.longitude,
        locationName: board.locationName,
        gymUuid: board.gymUuid,
        gymName: board.gymName,
      }
    : null;
}

/** An anonymous read through the resolver (enrichBoard) and the schema; both must agree. */
async function anonymousRead(boardUuid: string): Promise<LocationRead> {
  const resolved = (await socialBoardQueries.board(null, { boardUuid }, anonCtx())) as LocationRead;
  const direct = {
    latitude: resolved.latitude,
    longitude: resolved.longitude,
    locationName: resolved.locationName,
    gymUuid: resolved.gymUuid,
    gymName: resolved.gymName,
  };
  expect(await anonymousSchemaRead(boardUuid)).toEqual(direct);
  return direct;
}

const HIDDEN: LocationRead = { latitude: null, longitude: null, locationName: null, gymUuid: null, gymName: null };
const atGym = (gymUuid: string): LocationRead => ({
  latitude: BASE.latitude,
  longitude: BASE.longitude,
  locationName: GYM_NAME,
  gymUuid,
  gymName: GYM_NAME,
});

/** No anonymous read ever carries the board's own non-gym place. */
function expectNoOwnPlace(read: LocationRead, ownLatitudes: number[]) {
  for (const latitude of ownLatitudes) expect(read.latitude).not.toBe(latitude);
  expect(read.locationName).not.toBe(HOME);
}

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

async function insertGym(opts: { ownerId: string; isPublic?: boolean }): Promise<{ id: number; uuid: string }> {
  const uuid = uuidv4();
  const [gym] = await db
    .insert(dbSchema.gyms)
    .values({
      uuid,
      slug: uuid,
      ownerId: opts.ownerId,
      name: GYM_NAME,
      isPublic: opts.isPublic ?? true,
      latitude: BASE.latitude,
      longitude: BASE.longitude,
    })
    .returning({ id: dbSchema.gyms.id });
  return { id: gym.id, uuid };
}

const createBoard = (input: Record<string, unknown>) =>
  socialBoardMutations.createBoard(
    null,
    {
      input: {
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 901,
        setIds: '1,2',
        allowDuplicateConfig: true,
        ...input,
      },
    },
    authCtx(CLIMBER),
  ) as Promise<{ uuid: string }>;
const updateBoard = (input: Record<string, unknown>) =>
  socialBoardMutations.updateBoard(null, { input }, authCtx(CLIMBER));
const linkToGym = (boardUuid: string, gymUuid: string | null) =>
  socialGymMutations.linkBoardToGym(null, { input: { boardUuid, gymUuid } }, authCtx(CLIMBER));
const storedRow = async (boardUuid: string) => {
  const [row] = await db.select().from(dbSchema.userBoards).where(eq(dbSchema.userBoards.uuid, boardUuid));
  return row;
};

let cleanupCatalog: () => Promise<void> = async () => {};

beforeAll(async () => {
  cleanupCatalog = await seedAuroraCatalogFixtures([
    {
      boardType: 'kilter',
      productId: 2_100_512_910,
      layoutId: 1,
      sizeId: 901,
      setIds: [1, 2],
      associationIdBase: 2_100_513_100,
    },
  ]);
});

afterAll(async () => {
  await cleanupCatalog();
});

beforeEach(async () => {
  resetAllRateLimits();
  await db.execute(sql`
    TRUNCATE TABLE "gym_members", "gym_follows", "location_sync_gym_sources", "user_boards", "gyms"
    RESTART IDENTITY CASCADE
  `);
  await Promise.all([SYSTEM_OWNER, CLIMBER, GYM_OWNER, STRANGER].map(insertUser));
});

describe('projectBoardLocation', () => {
  const board = { locationName: HOME, latitude: LAT_8KM, longitude: 8, gymId: 7 };
  const gym = {
    id: 7,
    uuid: 'gym-7',
    name: GYM_NAME,
    latitude: BASE.latitude,
    longitude: BASE.longitude,
    isPublic: true,
    deletedAt: null,
  };

  it("shows the board's own place to a viewer its location choice admits", () => {
    expect(projectBoardLocation(board, gym, true)).toMatchObject({
      latitude: LAT_8KM,
      locationName: HOME,
      gymUuid: 'gym-7',
      source: 'own',
    });
  });

  it("shows a public gym's listed place to anyone else, never the board's", () => {
    expect(projectBoardLocation(board, gym, false)).toEqual({
      locationName: GYM_NAME,
      latitude: BASE.latitude,
      longitude: BASE.longitude,
      gymId: 7,
      gymUuid: 'gym-7',
      gymName: GYM_NAME,
      source: 'gym',
    });
  });

  it.each([
    ['a private gym', { ...gym, isPublic: false }],
    ['a deleted gym', { ...gym, deletedAt: new Date() }],
    ['a gym the board is no longer in', { ...gym, id: 8 }],
    ['no gym', null],
  ])('shows nothing for %s', (_label, candidate) => {
    expect(projectBoardLocation(board, candidate, false)).toMatchObject({
      latitude: null,
      locationName: null,
      gymUuid: null,
      source: 'hidden',
    });
  });
});

describe("a board in a public gym, its owner's location hidden", () => {
  it("shows anonymous viewers the gym's name and coordinates and its owner the board's own", async () => {
    const gym = await insertGym({ ownerId: SYSTEM_OWNER });
    const board = await createBoard({
      name: 'Near the gym',
      locationName: 'Back room',
      latitude: LAT_60M,
      longitude: 8,
    });
    await linkToGym(board.uuid, gym.uuid);
    expect((await storedRow(board.uuid)).hideLocation).toBe(true);

    expect(await anonymousRead(board.uuid)).toEqual(atGym(gym.uuid));
    const own = (await socialBoardQueries.board(null, { boardUuid: board.uuid }, authCtx(CLIMBER))) as LocationRead;
    expect(own).toMatchObject({ latitude: LAT_60M, locationName: 'Back room', gymUuid: gym.uuid });
  });

  it("shows anyone the board's own place once its owner shows it", async () => {
    const gym = await insertGym({ ownerId: SYSTEM_OWNER });
    const board = await createBoard({
      name: 'Shown',
      locationName: 'Back room',
      latitude: LAT_60M,
      longitude: 8,
      hideLocation: false,
    });
    await linkToGym(board.uuid, gym.uuid);
    expect(await anonymousRead(board.uuid)).toEqual({
      latitude: LAT_60M,
      longitude: 8,
      locationName: 'Back room',
      gymUuid: gym.uuid,
      gymName: GYM_NAME,
    });
  });

  it("lists the board on the gym's page at the gym's place", async () => {
    const gym = await insertGym({ ownerId: SYSTEM_OWNER });
    const board = await createBoard({ name: 'Listed', latitude: LAT_60M, longitude: 8 });
    await linkToGym(board.uuid, gym.uuid);
    const listed = (await socialBoardQueries.gymBoards(null, { gymUuid: gym.uuid }, anonCtx())) as Array<
      LocationRead & { uuid: string }
    >;
    expect(listed.find((entry) => entry.uuid === board.uuid)).toMatchObject(atGym(gym.uuid));
  });

  it("projects a UserBoard a producer filled with the board's own place, field by field", async () => {
    const gym = await insertGym({ ownerId: SYSTEM_OWNER });
    const board = await createBoard({ name: 'Raw', locationName: HOME, latitude: LAT_60M, longitude: 8 });
    await linkToGym(board.uuid, gym.uuid);
    // As a careless producer (a payload, an event) might hand it over: raw.
    const raw = {
      uuid: board.uuid,
      latitude: LAT_60M,
      longitude: 8,
      locationName: HOME,
      gymId: null,
      gymUuid: null,
      gymName: null,
      distanceMeters: 12,
    } as unknown as Parameters<typeof boardSessionPrivacyResolvers.UserBoard.latitude>[0];
    const fields = boardSessionPrivacyResolvers.UserBoard;
    const viewer = anonCtx();
    expect({
      latitude: await fields.latitude(raw, null, viewer),
      longitude: await fields.longitude(raw, null, viewer),
      locationName: await fields.locationName(raw, null, viewer),
      gymUuid: await fields.gymUuid(raw, null, viewer),
      gymName: await fields.gymName(raw, null, viewer),
      distanceMeters: await fields.distanceMeters(raw, null, viewer),
    }).toEqual({ ...atGym(gym.uuid), distanceMeters: null });
  });

  it("names the gym, not the board's place, to an anonymous serial lookup through the schema", async () => {
    const gym = await insertGym({ ownerId: SYSTEM_OWNER });
    const board = await createBoard({
      name: 'Serial board',
      locationName: HOME,
      latitude: LAT_60M,
      longitude: 8,
      serialNumber: 'PROJ-SERIAL-1',
    });
    await linkToGym(board.uuid, gym.uuid);
    const result = await execute({
      schema: executableSchema,
      document: parse(`
        query Serial($serials: [String!]!) {
          boardsBySerialNumbers(serialNumbers: $serials) { uuid latitude longitude locationName gymUuid gymName }
        }
      `),
      variableValues: { serials: ['PROJ-SERIAL-1'] },
      contextValue: anonCtx(),
    });
    expect(result.errors ?? []).toEqual([]);
    const [found] = (result.data as { boardsBySerialNumbers: Array<LocationRead & { uuid: string }> })
      .boardsBySerialNumbers;
    // What a client receives: the public gym's place and link, never the board's.
    expect(found).toMatchObject({ uuid: board.uuid, ...atGym(gym.uuid) });
    expectNoOwnPlace(found, [LAT_60M]);
  });

  it("gives serial candidates the owner's own place and a stranger the gym's", async () => {
    const gym = await insertGym({ ownerId: SYSTEM_OWNER });
    const serial = 'PROJ-SERIAL-DUP';
    const insertSerialBoard = async (ownerId: string, name: string, extra: Record<string, unknown> = {}) => {
      const uuid = uuidv4();
      const [row] = await db
        .insert(dbSchema.userBoards)
        .values({
          uuid,
          slug: uuid,
          ownerId,
          boardType: 'kilter',
          layoutId: 1,
          sizeId: 901,
          setIds: '1,2',
          name,
          serialNumber: serial,
          isPublic: true,
          ...extra,
        })
        .returning({ id: dbSchema.userBoards.id });
      return row.id;
    };
    // The climber's board at the gym, location hidden; a second board shares the serial.
    const mine = await insertSerialBoard(CLIMBER, 'Gym Kilter', {
      gymId: gym.id,
      hideLocation: true,
      locationName: 'Back room',
      latitude: LAT_60M,
      longitude: 8,
    });
    await insertSerialBoard(GYM_OWNER, 'Other Kilter');
    const candidateFor = async (userId: string) => {
      const result = await boardPresenceMutations.resolveBoardCandidatesForSerial(
        undefined,
        { serial, boardType: 'kilter', layoutId: 1, sizeId: 901, setIds: '1,2' },
        authCtx(userId),
      );
      return (result.candidates ?? []).find((candidate) => candidate.boardId === mine);
    };

    expect(await candidateFor(CLIMBER)).toMatchObject({ locationName: 'Back room', gymName: GYM_NAME });
    expect(await candidateFor(STRANGER)).toMatchObject({ locationName: GYM_NAME, gymName: GYM_NAME });
  });

  it('decides the field resolvers per viewer, even for one board object resolved for two viewers', async () => {
    const gym = await insertGym({ ownerId: SYSTEM_OWNER });
    const board = await createBoard({ name: 'Shared object', locationName: HOME, latitude: LAT_60M, longitude: 8 });
    await linkToGym(board.uuid, gym.uuid);
    // The owner's read: the object carries the board's own place.
    const object = (await socialBoardQueries.board(
      null,
      { boardUuid: board.uuid },
      authCtx(CLIMBER),
    )) as unknown as Parameters<typeof boardSessionPrivacyResolvers.UserBoard.latitude>[0];
    const fields = boardSessionPrivacyResolvers.UserBoard;
    const read = async (viewer: ConnectionContext) => ({
      latitude: await fields.latitude(object, null, viewer),
      longitude: await fields.longitude(object, null, viewer),
      locationName: await fields.locationName(object, null, viewer),
      gymUuid: await fields.gymUuid(object, null, viewer),
      gymName: await fields.gymName(object, null, viewer),
    });

    // Concurrently, so a memo shared across viewers would hand one the other's.
    const [owner, anonymous] = await Promise.all([read(authCtx(CLIMBER)), read(anonCtx())]);
    expect(owner).toMatchObject({ latitude: LAT_60M, locationName: HOME });
    expect(anonymous).toEqual(atGym(gym.uuid));
    // And again after the owner's decision settled.
    const later = await read(anonCtx());
    expect(later).toEqual(atGym(gym.uuid));
  });
});

describe("the old leak scenarios never show the board's own place", () => {
  it('an installed client that edits before it leaves the gym', async () => {
    const gym = await insertGym({ ownerId: SYSTEM_OWNER });
    const board = await createBoard({ name: 'Moved home', gymUuid: gym.uuid, locationName: GYM_NAME, ...BASE });
    expect(await anonymousRead(board.uuid)).toEqual(atGym(gym.uuid));

    await updateBoard({
      boardUuid: board.uuid,
      latitude: LAT_8KM,
      longitude: 8,
      locationName: HOME,
      hideLocation: true,
    });
    const whileStillInGym = await anonymousRead(board.uuid);
    expect(whileStillInGym).toEqual(atGym(gym.uuid));
    expectNoOwnPlace(whileStillInGym, [LAT_8KM]);

    await linkToGym(board.uuid, null);
    expect(await anonymousRead(board.uuid)).toEqual(HIDDEN);
  });

  it('the edit screen leaving the gym first, then a move with no hide choice', async () => {
    const gym = await insertGym({ ownerId: SYSTEM_OWNER });
    const board = await createBoard({ name: 'Moved home', gymUuid: gym.uuid, locationName: GYM_NAME, ...BASE });
    await linkToGym(board.uuid, null);
    await updateBoard({ boardUuid: board.uuid, latitude: LAT_8KM, longitude: 8, locationName: HOME });
    expect(await anonymousRead(board.uuid)).toEqual(HIDDEN);
  });

  // Accepted by the owner (round 6): a board created from a GPS fix with no gym
  // picked is attached to the one synced gym within about 150 m, even with its
  // location hidden, and then shows that gym's place to whoever can open the
  // board. That tells them the board is near that gym; the fix itself stays hidden.
  it("a gym the server guessed from the climber's GPS fix shows the gym, never the fix", async () => {
    const gym = await insertGym({ ownerId: SYSTEM_OWNER });
    const board = await createBoard({
      name: 'Home wall',
      isPublic: true,
      hideLocation: true,
      latitude: LAT_120M,
      longitude: 8,
    });
    expect((await storedRow(board.uuid)).gymId).toBe(gym.id);
    const read = await anonymousRead(board.uuid);
    expect(read).toEqual(atGym(gym.uuid));
    expectNoOwnPlace(read, [LAT_120M]);
  });

  it('picking a public gym after clearing the location, then linking', async () => {
    // A home board 120 m from a gym, made before the gym existed.
    const board = await createBoard({ name: 'Home wall', locationName: HOME, latitude: LAT_120M, longitude: 8 });
    const gym = await insertGym({ ownerId: SYSTEM_OWNER });
    // The picker sends the gym's name; Clear location sends no coordinates.
    await updateBoard({ boardUuid: board.uuid, locationName: GYM_NAME, hideLocation: true });
    await linkToGym(board.uuid, gym.uuid);
    const read = await anonymousRead(board.uuid);
    expect(read).toEqual(atGym(gym.uuid));
    expectNoOwnPlace(read, [LAT_120M]);
    expect((await storedRow(board.uuid)).latitude).toBe(LAT_120M);
  });

  describe("taken out of someone else's public gym", () => {
    const boardInGymOwnersGym = async () => {
      const gym = await insertGym({ ownerId: GYM_OWNER });
      const board = await createBoard({ name: 'Visitor wall', locationName: HOME, latitude: LAT_60M, longitude: 8 });
      await linkToGym(board.uuid, gym.uuid);
      expect(await anonymousRead(board.uuid)).toEqual(atGym(gym.uuid));
      return { gym, board };
    };

    it("by the gym owner's detach", async () => {
      const { gym, board } = await boardInGymOwnersGym();
      await socialGymStrayBoardMutations.detachBoardFromGym(
        null,
        { input: { gymUuid: gym.uuid, boardUuid: board.uuid } },
        authCtx(GYM_OWNER),
      );
      await updateBoard({ boardUuid: board.uuid, latitude: LAT_8KM, longitude: 8 });
      expect(await anonymousRead(board.uuid)).toEqual(HIDDEN);
    });

    it("by the gym's deletion", async () => {
      const { gym, board } = await boardInGymOwnersGym();
      await socialGymMutations.deleteGym(null, { gymUuid: gym.uuid }, authCtx(GYM_OWNER));
      expect(await anonymousRead(board.uuid)).toEqual(HIDDEN);
    });

    it('by the gym going private', async () => {
      const { gym, board } = await boardInGymOwnersGym();
      await socialGymMutations.updateGym(null, { input: { gymUuid: gym.uuid, isPublic: false } }, authCtx(GYM_OWNER));
      expect(await anonymousRead(board.uuid)).toEqual(HIDDEN);
    });
  });
});
