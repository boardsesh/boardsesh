import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { Kind, parse, type FieldNode, type GraphQLResolveInfo, type OperationDefinitionNode } from 'graphql';
import { v4 as uuidv4 } from 'uuid';
import * as schema from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { socialBoardQueries } from '../graphql/resolvers/social/boards';
import { logger } from '../utils/logger';
import { resetAllRateLimits } from '../utils/rate-limiter';
import { resetSerialRevealBudgets, SERIAL_REVEALS_PER_HOUR } from '../utils/serial-reveal-budget';

// A private home board heard over Bluetooth (docs/product/privacy.md, "What a
// serial tells a climber nearby"): which boards say whose they are, what the
// card carries, and the hourly cap. Real Postgres: the gating is SQL.

type Audience = 'public' | 'unlisted' | 'followers' | 'invite_only' | 'only_me';

const owner = `reveal-owner-${uuidv4()}`;
const ownerName = 'Sam Setter';

const signedIn = (userId: string) =>
  ({ isAuthenticated: true, userId, connectionId: `reveal-${userId}-${Math.random()}` }) as ConnectionContext;
const signedOut = () =>
  ({ isAuthenticated: false, connectionId: `reveal-anon-${Math.random()}` }) as unknown as ConnectionContext;

async function newClimber(label: string): Promise<string> {
  const id = `reveal-${label}-${uuidv4()}`;
  await db.insert(schema.users).values({ id, name: id, email: `${id}@test.invalid` });
  return id;
}

let boardCount = 0;
async function seedBoard(
  audience: Audience,
  options: { boardType?: string; gymId?: number; ownerId?: string } = {},
): Promise<{ uuid: string; slug: string; serial: string; boardType: string }> {
  boardCount += 1;
  const uuid = uuidv4();
  const slug = `reveal-${audience.replace(/_/g, '-')}-${boardCount}-${uuid.slice(0, 8)}`;
  const serial = `RVL${uuid.slice(0, 8).toUpperCase()}`;
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
    angle: 40,
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

beforeAll(async () => {
  vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '1');
  await db.insert(schema.users).values({ id: owner, name: 'sam-account', email: `${owner}@test.invalid` });
  await db
    .insert(schema.userProfiles)
    .values({ userId: owner, displayName: ownerName, avatarUrl: 'https://a.test/sam.png' });
});
afterAll(() => vi.unstubAllEnvs());
beforeEach(() => {
  resetAllRateLimits();
  resetSerialRevealBudgets();
});

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
            name: `Garage ${audience} ${boardCount}`,
            boardType: 'kilter',
            layoutId: 1,
            sizeId: 10,
            setIds: '1,2',
            angle: 40,
          },
        },
      ]);
      const serialized = JSON.stringify(match.candidateRequestCards);
      for (const secret of [board.slug, board.serial, 'Secret garage', '51.5', '-0.12', owner]) {
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
});
