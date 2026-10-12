/**
 * Real-DB coverage for what an Unlisted home board's link opens, and what a
 * numeric board id does not.
 *
 * A board's uuid and its `/b/<slug>` path are its link: holding either opens the
 * board, its presence, its live sessions and a session on it, signed in or not.
 * `user_boards.id` is a bigserial anyone can count, so a read keyed on the id
 * alone takes the no-link reading, where an Unlisted board is NOT_FOUND to
 * everyone who does not hold it already. The caller unlocks the link reading by
 * presenting the board's own uuid alongside the id.
 *
 * Each case runs against both shapes an Unlisted board can have: the legacy
 * booleans (`is_public` and `is_unlisted` both true, no policy row) and the shape
 * the current audience control writes (`is_public = false` plus a
 * `resource_privacy` row), which the second fixture builds through the real
 * `updateResourcePrivacy` mutation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { eq, inArray, like } from 'drizzle-orm';
import type {
  BoardPresenceEvent,
  BoardPresenceClimb,
  BoardPresenceStats,
  BoardQueuePreview,
  ClimbQueueItemInput,
  ConnectionContext,
} from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { pubsub } from '../pubsub/index';
import { roomManager } from '../services/room-manager';
import type { QueueState } from '../services/room-manager/types';
import { socialBoardQueries } from '../graphql/resolvers/social/boards';
import { boardPresenceQueries } from '../graphql/resolvers/board-presence/queries';
import { boardPresenceMutations } from '../graphql/resolvers/board-presence/mutations';
import { boardPresenceSubscriptions } from '../graphql/resolvers/board-presence/subscription';
import {
  boardQueuePreviewQueries,
  boardQueuePreviewSubscriptions,
} from '../graphql/resolvers/board-presence/queue-preview';
import { liveSessionQueries } from '../graphql/resolvers/sessions/live-sessions';
import { sessionMutations } from '../graphql/resolvers/sessions/mutations';
import { privacyMutations } from '../graphql/resolvers/privacy';
import { lockAndAssertBoardSerialAvailable } from '../graphql/resolvers/board-serial-write-lock';
import { projectSessionBoardPath } from '../services/board-session-privacy';
import { getBoardQueuePreviewSnapshot } from '../services/board-queue-preview';
import { sessionSubscriptions } from '../graphql/resolvers/sessions/subscriptions';
import { buildSessionPayload } from '../graphql/resolvers/sessions/helpers';
import * as sharedHelpers from '../graphql/resolvers/shared/helpers';
import * as presenceStats from '../graphql/resolvers/board-presence/stats';

vi.mock('../graphql/resolvers/shared/helpers', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return { ...original, applyRateLimit: vi.fn().mockResolvedValue(undefined) };
});

const PREFIX = 'ubl-';
const OWNER = `${PREFIX}owner`;
const STRANGER = `${PREFIX}stranger`;
const OTHER_STRANGER = `${PREFIX}other-stranger`;
const GRANTEE = `${PREFIX}grantee`;
const ALL_USERS = [OWNER, STRANGER, OTHER_STRANGER, GRANTEE];

let counter = 0;
const authCtx = (userId: string): ConnectionContext =>
  ({
    connectionId: `${PREFIX}conn-${counter++}`,
    transport: 'http',
    isAuthenticated: true,
    userId,
  }) as ConnectionContext;
const anonCtx = (): ConnectionContext =>
  ({ connectionId: `${PREFIX}anon-${counter++}`, transport: 'http', isAuthenticated: false }) as ConnectionContext;

type Board = { id: number; uuid: string; slug: string; name: string };

async function insertBoard(name: string, flags: { isPublic: boolean; isUnlisted?: boolean }): Promise<Board> {
  const uuid = uuidv4();
  const slug = `${PREFIX}${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${counter++}`;
  const [row] = await db
    .insert(dbSchema.userBoards)
    .values({
      uuid,
      slug,
      ownerId: OWNER,
      // Tension: a signed-in Kilter presence subscription would start the Kilter poller.
      boardType: 'tension',
      layoutId: 9,
      sizeId: 100 + counter++,
      setIds: '1',
      name,
      isPublic: flags.isPublic,
      isUnlisted: flags.isUnlisted ?? false,
    })
    .returning({ id: dbSchema.userBoards.id });
  return { id: Number(row.id), uuid, slug, name };
}

/** The owner picks an audience with the current control: the real write path. */
async function chooseAudience(board: Board, audience: 'unlisted' | 'invite_only'): Promise<void> {
  vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '1');
  await privacyMutations.updateResourcePrivacy(
    undefined,
    { input: { kind: 'board', resourceId: board.uuid, audience } },
    authCtx(OWNER),
  );
}

const UNLISTED_SHAPES = [
  ['legacy booleans', (name: string) => insertBoard(name, { isPublic: true, isUnlisted: true })],
  [
    'current audience control',
    async (name: string) => {
      const board = await insertBoard(name, { isPublic: false });
      await chooseAudience(board, 'unlisted');
      return board;
    },
  ],
] as const;

async function makeInviteOnlyBoard(name: string): Promise<Board> {
  const board = await insertBoard(name, { isPublic: false });
  await chooseAudience(board, 'invite_only');
  return board;
}

async function grant(board: Board, userId: string): Promise<void> {
  await db
    .insert(dbSchema.resourceGrants)
    .values({ kind: 'board', resourceId: board.uuid, userId, status: 'approved', invitedBy: OWNER });
}

/** Every read keyed on a numeric board id, each taking the optional uuid. */
const ID_KEYED_READS: ReadonlyArray<
  readonly [string, (boardId: number, boardUuid: string | undefined, ctx: ConnectionContext) => Promise<unknown>]
> = [
  [
    'boardConnection',
    (boardId, boardUuid, ctx) => boardPresenceQueries.boardConnection(undefined, { boardId, boardUuid }, ctx),
  ],
  [
    'boardRecentClimbs',
    (boardId, boardUuid, ctx) => boardPresenceQueries.boardRecentClimbs(undefined, { boardId, boardUuid }, ctx),
  ],
  [
    'boardRecentHistory',
    (boardId, boardUuid, ctx) => boardPresenceQueries.boardRecentHistory(undefined, { boardId, boardUuid }, ctx),
  ],
  [
    'boardHistoryPage',
    (boardId, boardUuid, ctx) =>
      boardPresenceQueries.boardHistoryPage(undefined, { boardId, boardUuid, limit: 5 }, ctx),
  ],
  [
    'boardHistory',
    (boardId, boardUuid, ctx) => boardPresenceQueries.boardHistory(undefined, { boardId, boardUuid, limit: 5 }, ctx),
  ],
  [
    'boardClimbRecentSenders',
    (boardId, boardUuid, ctx) =>
      boardPresenceQueries.boardClimbRecentSenders(
        undefined,
        { boardId, boardUuid, climbUuid: `${PREFIX}climb`, angle: 40 },
        ctx,
      ),
  ],
  [
    'boardPresenceStats',
    (boardId, boardUuid, ctx) => boardPresenceQueries.boardPresenceStats(undefined, { boardId, boardUuid }, ctx),
  ],
  [
    'boardQueuePreview',
    (boardId, boardUuid, ctx) => boardQueuePreviewQueries.boardQueuePreview(undefined, { boardId, boardUuid }, ctx),
  ],
  [
    'boardLiveSessions',
    (boardId, boardUuid, ctx) => liveSessionQueries.boardLiveSessions(undefined, { boardId, boardUuid }, ctx),
  ],
  ['boardNowPlaying', (boardId, boardUuid, ctx) => openSubscription('now-playing', boardId, boardUuid, ctx)],
  [
    'boardQueuePreview subscription',
    (boardId, boardUuid, ctx) => openSubscription('queue-preview', boardId, boardUuid, ctx),
  ],
];

/**
 * Open a board subscription far enough to know its gate's answer: the gate
 * throws on the first `next()`, and a passed gate goes on to subscribe its
 * pub/sub channel. Closes the stream either way.
 */
async function openSubscription(
  kind: 'now-playing' | 'queue-preview',
  boardId: number,
  boardUuid: string | undefined,
  ctx: ConnectionContext,
): Promise<'subscribed'> {
  const channel =
    kind === 'now-playing'
      ? vi.spyOn(pubsub, 'subscribeBoardPresence')
      : vi.spyOn(pubsub, 'subscribeBoardQueuePreview');
  channel.mockClear();
  const iterator =
    kind === 'now-playing'
      ? boardPresenceSubscriptions.boardNowPlaying.subscribe(undefined, { boardId, boardUuid }, ctx)
      : boardQueuePreviewSubscriptions.boardQueuePreview.subscribe(undefined, { boardId, boardUuid }, ctx);
  const pending = iterator.next();
  const gateFailed = pending.then(
    () => null,
    (error: unknown) => error,
  );
  const outcome = await Promise.race([
    gateFailed,
    vi.waitFor(() => expect(channel).toHaveBeenCalled(), { timeout: 2_000 }).then(() => 'subscribed' as const),
  ]);
  if (outcome !== 'subscribed') throw outcome;
  await iterator.return(undefined);
  await pending;
  return 'subscribed';
}

beforeEach(async () => {
  await db.delete(dbSchema.contentPrivacy).where(like(dbSchema.contentPrivacy.entityId, `${PREFIX}%`));
  await db.delete(dbSchema.boardClimbs).where(like(dbSchema.boardClimbs.uuid, `${PREFIX}%`));
  // Spray walls restrict board deletion; retire only this suite's fixtures first.
  await db.delete(dbSchema.sprayWalls).where(
    inArray(
      dbSchema.sprayWalls.boardUuid,
      db
        .select({ uuid: dbSchema.userBoards.uuid })
        .from(dbSchema.userBoards)
        .where(like(dbSchema.userBoards.ownerId, `${PREFIX}%`)),
    ),
  );
  await db.delete(dbSchema.users).where(like(dbSchema.users.id, `${PREFIX}%`));
  await db
    .insert(dbSchema.users)
    .values(ALL_USERS.map((id) => ({ id, email: `${id}@test.com`, name: `Account ${id}` })))
    .onConflictDoNothing();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe.each(UNLISTED_SHAPES)('an Unlisted home board (%s)', (_shape, makeUnlistedBoard) => {
  it('never turns a known controller serial into the hidden UUID, while owners and grantees retain it', async () => {
    const board = await makeUnlistedBoard('Serial Hidden Wall');
    const serialNumber = 'SERIAL123';
    await db.update(dbSchema.userBoards).set({ serialNumber }).where(eq(dbSchema.userBoards.id, board.id));
    expect(
      await socialBoardQueries.boardsBySerialNumbers(null, { serialNumbers: [serialNumber] }, authCtx(STRANGER)),
    ).toEqual([]);
    const [anonymous] = await socialBoardQueries.boardsBySerialNumbers(
      null,
      { serialNumbers: [serialNumber] },
      anonCtx(),
    );
    expect(anonymous).toMatchObject({
      uuid: '',
      slug: '',
      boardId: null,
      name: 'tension',
      ownerId: '',
      description: null,
    });
    expect(JSON.stringify(anonymous)).not.toContain(board.uuid);
    expect(JSON.stringify(anonymous)).not.toContain(board.slug);
    expect(JSON.stringify(anonymous)).not.toContain(board.name);
    await grant(board, GRANTEE);
    for (const userId of [OWNER, GRANTEE]) {
      const [authorized] = await socialBoardQueries.boardsBySerialNumbers(
        null,
        { serialNumbers: [serialNumber] },
        authCtx(userId),
      );
      expect(authorized).toMatchObject({ uuid: board.uuid, boardId: board.id, name: board.name });
    }
  });

  it('gives a stranger no link from serial candidates, a remembered serial or the duplicate-serial error', async () => {
    const board = await makeUnlistedBoard('Serial Candidate Wall');
    const [stored] = await db.select().from(dbSchema.userBoards).where(eq(dbSchema.userBoards.id, board.id));
    const config = {
      boardType: stored.boardType,
      layoutId: Number(stored.layoutId),
      sizeId: Number(stored.sizeId),
      setIds: stored.setIds,
    };
    const sharedSerial = `SHARED${counter++}`;
    await db
      .update(dbSchema.userBoards)
      .set({ serialNumber: sharedSerial, locationName: 'Owner garage' })
      .where(eq(dbSchema.userBoards.id, board.id));
    // The stranger registers their own wall on the same controller serial
    // (createBoard's allowDuplicateSerial), which forces the candidate list.
    await db.insert(dbSchema.userBoards).values({
      uuid: uuidv4(),
      slug: `${PREFIX}stranger-dup-${counter++}`,
      ownerId: STRANGER,
      boardType: config.boardType,
      layoutId: config.layoutId,
      sizeId: config.sizeId + 1,
      setIds: config.setIds,
      name: 'Stranger duplicate',
      isPublic: true,
      serialNumber: sharedSerial,
    });
    await grant(board, GRANTEE);

    const candidatesFor = async (userId: string) => {
      const result = await boardPresenceMutations.resolveBoardCandidatesForSerial(
        undefined,
        { serial: sharedSerial, ...config },
        authCtx(userId),
      );
      return result.candidates ?? [];
    };
    const strangerCandidates = await candidatesFor(STRANGER);
    const hiddenCandidate = strangerCandidates.find((candidate) => candidate.boardId === board.id);
    expect(hiddenCandidate).toMatchObject({
      boardUuid: '',
      boardName: config.boardType,
      locationName: null,
      gymName: null,
      isOwnedByMe: false,
    });
    for (const secret of [board.uuid, board.slug, board.name, 'Owner garage']) {
      expect(JSON.stringify(strangerCandidates)).not.toContain(secret);
    }
    for (const userId of [OWNER, GRANTEE]) {
      const held = (await candidatesFor(userId)).find((candidate) => candidate.boardId === board.id);
      expect(held).toMatchObject({ boardUuid: board.uuid, boardName: board.name });
    }

    // One board on the serial: the stranger's connect binds to it, and the
    // remembered pointer stays server-side.
    const soloSerial = `SOLO${counter++}`;
    await db.update(dbSchema.userBoards).set({ serialNumber: soloSerial }).where(eq(dbSchema.userBoards.id, board.id));
    for (const userId of [OTHER_STRANGER, GRANTEE]) {
      const resolved = await boardPresenceMutations.resolveBoardCandidatesForSerial(
        undefined,
        { serial: soloSerial, ...config },
        authCtx(userId),
      );
      expect(resolved.board?.boardId).toBe(board.id);
    }
    const [outsider] = await socialBoardQueries.myBoardSerialConfigs(
      null,
      { serialNumbers: [soloSerial] },
      authCtx(OTHER_STRANGER),
    );
    expect(outsider).toMatchObject({ serialNumber: soloSerial, boardUuid: null, boardSlug: null });
    const [approved] = await socialBoardQueries.myBoardSerialConfigs(
      null,
      { serialNumbers: [soloSerial] },
      authCtx(GRANTEE),
    );
    expect(approved).toMatchObject({ boardUuid: board.uuid, boardSlug: board.slug });

    // Registering another board on that serial and configuration is refused
    // without naming the existing one to someone who cannot open it.
    const duplicateError = async (userId: string) => {
      try {
        await db.transaction((tx) =>
          lockAndAssertBoardSerialAvailable(tx, { serialNumber: soloSerial, ...config }, userId),
        );
      } catch (error) {
        return error as { extensions?: Record<string, unknown> };
      }
      throw new Error('expected BOARD_SERIAL_EXISTS');
    };
    const refused = await duplicateError(STRANGER);
    expect(refused.extensions?.code).toBe('BOARD_SERIAL_EXISTS');
    expect(refused.extensions).not.toHaveProperty('boardUuid');
    expect(refused.extensions).not.toHaveProperty('slug');
    expect(refused.extensions).not.toHaveProperty('name');
    expect((await duplicateError(GRANTEE)).extensions).toMatchObject({
      code: 'BOARD_SERIAL_EXISTS',
      boardUuid: board.uuid,
      slug: board.slug,
      name: board.name,
    });
  });

  it('keeps the changed link only for its actual actor, including creator snapshots and payload rereads', async () => {
    const board = await makeUnlistedBoard('Changed Path Wall');
    const path = `/b/${board.slug}/40`;
    const sessionId = uuidv4();
    await db
      .insert(dbSchema.boardSessions)
      .values({ id: sessionId, boardPath: path, createdByUserId: STRANGER, isPublic: true });
    vi.spyOn(sharedHelpers, 'requireSessionMember').mockResolvedValue(undefined);
    const creatorContext = { ...authCtx(STRANGER), participantId: 'creator-participant', sessionId };
    const actorContext = { ...authCtx(OTHER_STRANGER), participantId: 'actual-actor-participant', sessionId };
    const creator = sessionSubscriptions.sessionUpdates.subscribe(null, { sessionId }, creatorContext);
    const actor = sessionSubscriptions.sessionUpdates.subscribe(null, { sessionId }, actorContext);
    try {
      expect((await creator.next()).value).toMatchObject({
        sessionUpdates: { boardPath: expect.stringMatching(/^\/tension\/9\//) },
      });
      expect((await actor.next()).value).toMatchObject({
        sessionUpdates: { boardPath: expect.stringMatching(/^\/tension\/9\//) },
      });
      const creatorDelta = creator.next();
      const actorDelta = actor.next();
      pubsub.publishSessionEvent(sessionId, {
        __typename: 'SessionBoardPathChanged',
        boardPath: path,
        changedByParticipantId: actorContext.participantId,
      });
      expect((await creatorDelta).value).toMatchObject({
        sessionUpdates: { boardPath: expect.stringMatching(/^\/tension\/9\//) },
      });
      expect((await actorDelta).value).toMatchObject({ sessionUpdates: { boardPath: path } });
      const payload = await buildSessionPayload(sessionId, creatorContext, {
        users: [],
        queueState: null,
        lastConnectedBoardSerial: null,
        isLeader: false,
      });
      expect(payload.boardPath).toMatch(/^\/tension\/9\//);
      const presented = await buildSessionPayload(sessionId, creatorContext, {
        users: [],
        queueState: null,
        lastConnectedBoardSerial: null,
        isLeader: false,
        boardPath: path,
      });
      expect(presented.boardPath).toBe(path);
    } finally {
      await creator.return(undefined);
      await actor.return(undefined);
    }
  });

  it('opens by its uuid and by its slug for anyone, signed out included, with its presence channel', async () => {
    const board = await makeUnlistedBoard('Link Wall');
    for (const ctx of [anonCtx(), authCtx(STRANGER)]) {
      const byUuid = await socialBoardQueries.board(null, { boardUuid: board.uuid }, ctx);
      expect(byUuid?.name).toBe('Link Wall');
      expect(byUuid?.boardId).toBe(board.id);

      const bySlug = await socialBoardQueries.boardBySlug(null, { slug: board.slug }, ctx);
      expect(bySlug?.name).toBe('Link Wall');
      expect(bySlug?.boardId).toBe(board.id);

      const resolved = await boardPresenceMutations.resolveBoardForUuid(undefined, { boardUuid: board.uuid }, ctx);
      expect(resolved.boardId).toBe(board.id);
      expect(resolved.boardName).toBe('Link Wall');

      const leaderboard = await socialBoardQueries.boardLeaderboard(null, { input: { boardUuid: board.uuid } }, ctx);
      expect(leaderboard.boardUuid).toBe(board.uuid);
    }
  });

  it.each(ID_KEYED_READS)('%s reads as not found for the numeric id alone', async (_name, read) => {
    const board = await makeUnlistedBoard('Counted Wall');
    for (const ctx of [anonCtx(), authCtx(STRANGER)]) {
      await expect(read(board.id, undefined, ctx)).rejects.toThrow('Board not found');
    }
  });

  it.each(ID_KEYED_READS)("%s ignores another board's uuid", async (_name, read) => {
    const board = await makeUnlistedBoard('Guarded Wall');
    const elsewhere = await insertBoard('Public Elsewhere', { isPublic: true });
    for (const ctx of [anonCtx(), authCtx(STRANGER)]) {
      await expect(read(board.id, elsewhere.uuid, ctx)).rejects.toThrow('Board not found');
    }
  });

  it.each(ID_KEYED_READS)('%s opens when the caller also presents the board uuid', async (_name, read) => {
    const board = await makeUnlistedBoard('Shared Wall');
    for (const ctx of [anonCtx(), authCtx(STRANGER)]) {
      await read(board.id, board.uuid, ctx);
    }
  });

  it.each(ID_KEYED_READS)('%s stays open to the owner by the id alone', async (_name, read) => {
    const board = await makeUnlistedBoard('Owned Wall');
    await read(board.id, undefined, authCtx(OWNER));
  });

  it('starts a session for a stranger holding its slug path, never through an attached board id', async () => {
    const board = await makeUnlistedBoard('Session Wall');
    const elsewhere = await insertBoard('Public Session Wall', { isPublic: true });
    const input = (boardPath: string, boardIds?: number[]) => ({
      boardPath,
      boardIds,
      latitude: 0,
      longitude: 0,
      discoverable: false,
    });

    const created = await sessionMutations.createSession(
      null,
      { input: input(`/b/${board.slug}/40`) },
      authCtx(STRANGER),
    );
    const [row] = await db
      .select({ boardId: dbSchema.boardSessions.boardId })
      .from(dbSchema.boardSessions)
      .where(eq(dbSchema.boardSessions.id, created.id));
    expect(Number(row.boardId)).toBe(board.id);

    // The id of a board is no link: attaching it to another board's session fails.
    await expect(
      sessionMutations.createSession(null, { input: input(`/b/${elsewhere.slug}/40`, [board.id]) }, authCtx(STRANGER)),
    ).rejects.toThrow('One or more board IDs do not exist');
    // ...unless it is the very board the path presented.
    await expect(
      sessionMutations.createSession(null, { input: input(`/b/${board.slug}/40`, [board.id]) }, authCtx(STRANGER)),
    ).resolves.toMatchObject({ id: expect.any(String) });
  });

  it('keeps the slug only for a caller who presented it or holds current board standing', async () => {
    const board = await makeUnlistedBoard('Crew Wall');
    const path = `/b/${board.slug}/40`;
    const geometry = '/tension/9/';

    expect(await projectSessionBoardPath(path, STRANGER)).toMatch(/^\/tension\/9\//);
    expect(await projectSessionBoardPath(path, OTHER_STRANGER, { presentedByViewer: true })).toBe(path);
    expect(await projectSessionBoardPath(path, OWNER)).toBe(path);
    for (const viewer of [OTHER_STRANGER, null]) {
      const projected = await projectSessionBoardPath(path, viewer);
      expect(projected.startsWith(geometry)).toBe(true);
      expect(projected).not.toContain(board.slug);
    }
  });
});

describe('walking board ids', () => {
  it('keeps current Only-me location private even when legacy public/hideLocation fields name it', async () => {
    const board = await insertBoard('Public Location Policy', { isPublic: true });
    await db
      .update(dbSchema.userBoards)
      .set({ serialNumber: 'SERIALLOC', hideLocation: false, locationName: 'Owner home address' })
      .where(eq(dbSchema.userBoards.id, board.id));
    await db
      .insert(dbSchema.resourcePrivacy)
      .values({ kind: 'board', resourceId: board.uuid, audience: 'public', locationAudience: 'only_me' });
    const [anonymous] = await socialBoardQueries.boardsBySerialNumbers(
      null,
      { serialNumbers: ['SERIALLOC'] },
      anonCtx(),
    );
    expect(anonymous).toMatchObject({ uuid: board.uuid, name: board.name, locationName: null });
    await grant(board, GRANTEE);
    const [approved] = await socialBoardQueries.boardsBySerialNumbers(
      null,
      { serialNumbers: ['SERIALLOC'] },
      authCtx(GRANTEE),
    );
    expect(approved.locationName).toBeNull();
    const [owner] = await socialBoardQueries.boardsBySerialNumbers(
      null,
      { serialNumbers: ['SERIALLOC'] },
      authCtx(OWNER),
    );
    expect(owner.locationName).toBe('Owner home address');
    await db
      .update(dbSchema.resourcePrivacy)
      .set({ locationAudience: 'public' })
      .where(eq(dbSchema.resourcePrivacy.resourceId, board.uuid));
    const [visible] = await socialBoardQueries.boardsBySerialNumbers(null, { serialNumbers: ['SERIALLOC'] }, anonCtx());
    expect(visible.locationName).toBe('Owner home address');
  });

  it('finds no Unlisted or Invite-only board through any id-keyed read', async () => {
    const publicBoard = await insertBoard('Open Wall', { isPublic: true });
    const legacyUnlisted = await UNLISTED_SHAPES[0][1]('Legacy Link Wall');
    const currentUnlisted = await UNLISTED_SHAPES[1][1]('Current Link Wall');
    const inviteOnly = await makeInviteOnlyBoard('Invite Wall');
    const hidden = [legacyUnlisted, currentUnlisted, inviteOnly];
    const ids = [publicBoard, ...hidden].map((board) => board.id);

    const opened = new Set<number>();
    const responses: string[] = [];
    for (let boardId = Math.min(...ids) - 1; boardId <= Math.max(...ids) + 1; boardId++) {
      if (boardId <= 0) continue;
      for (const ctx of [anonCtx(), authCtx(STRANGER)]) {
        for (const [, read] of ID_KEYED_READS) {
          try {
            responses.push(JSON.stringify((await read(boardId, undefined, ctx)) ?? null));
            opened.add(boardId);
          } catch (error) {
            expect(String(error)).toContain('Board not found');
          }
        }
      }
    }

    expect([...opened]).toEqual([publicBoard.id]);
    const everything = responses.join('\n');
    for (const board of hidden) {
      expect(everything).not.toContain(board.uuid);
      expect(everything).not.toContain(board.slug);
      expect(everything).not.toContain(board.name);
    }
  });
});

describe('an Invite-only home board', () => {
  it('stays not found to a stranger holding its uuid, its slug or its id', async () => {
    const board = await makeInviteOnlyBoard('Members Wall');
    for (const ctx of [anonCtx(), authCtx(STRANGER)]) {
      expect(await socialBoardQueries.board(null, { boardUuid: board.uuid }, ctx)).toBeNull();
      expect(await socialBoardQueries.boardBySlug(null, { slug: board.slug }, ctx)).toBeNull();
      await expect(
        boardPresenceMutations.resolveBoardForUuid(undefined, { boardUuid: board.uuid }, ctx),
      ).rejects.toThrow('Board not found');
      for (const [, read] of ID_KEYED_READS) {
        await expect(read(board.id, board.uuid, ctx)).rejects.toThrow('Board not found');
      }
    }
    await expect(
      sessionMutations.createSession(
        null,
        { input: { boardPath: `/b/${board.slug}/40`, latitude: 0, longitude: 0, discoverable: false } },
        authCtx(STRANGER),
      ),
    ).rejects.toThrow('Board not found');
  });

  it('opens to an approved grantee by its link and by the id alone', async () => {
    const board = await makeInviteOnlyBoard('Granted Wall');
    await grant(board, GRANTEE);
    const ctx = authCtx(GRANTEE);
    expect((await socialBoardQueries.board(null, { boardUuid: board.uuid }, ctx))?.boardId).toBe(board.id);
    expect((await socialBoardQueries.boardBySlug(null, { slug: board.slug }, ctx))?.name).toBe('Granted Wall');
    for (const [, read] of ID_KEYED_READS) {
      await read(board.id, undefined, authCtx(GRANTEE));
    }
  });
});

/** The same current/legacy Unlisted policies on an actual spray wall. */
async function makeSprayBoard(makeBoard: (name: string) => Promise<Board>, name: string): Promise<Board> {
  const board = await makeBoard(name);
  const layoutId = 940_000 + counter++;
  await db
    .update(dbSchema.userBoards)
    .set({ boardType: 'spray', layoutId, sizeId: layoutId, setIds: '1', hasLeds: false })
    .where(eq(dbSchema.userBoards.id, board.id));
  await db.insert(dbSchema.sprayWalls).values({ boardUuid: board.uuid, layoutId });
  return board;
}

async function makeSprayClimbDisplay(board: Board): Promise<BoardPresenceClimb> {
  const [wall] = await db.select().from(dbSchema.userBoards).where(eq(dbSchema.userBoards.id, board.id));
  const climbUuid = `${PREFIX}spray-details-${counter++}`;
  await db.insert(dbSchema.boardClimbs).values({
    uuid: climbUuid,
    boardType: 'spray',
    layoutId: wall.layoutId,
    userId: OWNER,
    name: 'Held wall project',
    frames: 'p1r1',
    isDraft: false,
    isListed: true,
  });
  return { climbUuid, name: 'Held wall project', frames: 'p1r1', sentAt: new Date().toISOString(), seq: 1 };
}

const REPORT_CLIMB: ClimbQueueItemInput = {
  uuid: 'unlisted-spray-report',
  climb: {
    uuid: 'unlisted-spray-catalog-climb',
    name: 'Catalog climb',
    frames: 'p1r1',
    setter_username: 'setter',
    angle: 40,
    ascensionist_count: 0,
    difficulty: 'V1',
    quality_average: '3',
    stars: 3,
    difficulty_error: '0',
  },
};

describe.each(UNLISTED_SHAPES)('an Unlisted spray wall (%s)', (_shape, makeUnlistedBoard) => {
  it.each(ID_KEYED_READS)('%s accepts only the held matching UUID while the wall is unhidden', async (_name, read) => {
    const board = await makeSprayBoard(makeUnlistedBoard, 'Spray Shared Wall');
    const elsewhere = await makeSprayBoard(makeUnlistedBoard, 'Other Spray Wall');
    for (const ctx of [anonCtx(), authCtx(STRANGER)]) {
      await expect(read(board.id, undefined, ctx)).rejects.toThrow('Board not found');
      await expect(read(board.id, elsewhere.uuid, ctx)).rejects.toThrow('Board not found');
      await read(board.id, board.uuid, ctx);
    }
  });

  it('opens its leaderboard by its uuid for anyone, and only to its owner once hidden', async () => {
    const board = await makeSprayBoard(makeUnlistedBoard, 'Spray Leaderboard Wall');
    for (const ctx of [anonCtx(), authCtx(STRANGER), authCtx(OWNER)]) {
      await expect(
        socialBoardQueries.boardLeaderboard(null, { input: { boardUuid: board.uuid } }, ctx),
      ).resolves.toMatchObject({ boardUuid: board.uuid });
    }
    await db
      .update(dbSchema.sprayWalls)
      .set({ hiddenAt: new Date() })
      .where(eq(dbSchema.sprayWalls.boardUuid, board.uuid));
    for (const ctx of [anonCtx(), authCtx(STRANGER)]) {
      await expect(
        socialBoardQueries.boardLeaderboard(null, { input: { boardUuid: board.uuid } }, ctx),
      ).rejects.toThrow('Board not found');
    }
    await expect(
      socialBoardQueries.boardLeaderboard(null, { input: { boardUuid: board.uuid } }, authCtx(OWNER)),
    ).resolves.toMatchObject({ boardUuid: board.uuid });
  });

  it('never stamps membership through a retained UUID after admin hiding, while its owner keeps access', async () => {
    const board = await makeSprayBoard(makeUnlistedBoard, 'Hidden Spray Wall');
    await db
      .update(dbSchema.sprayWalls)
      .set({ hiddenAt: new Date() })
      .where(eq(dbSchema.sprayWalls.boardUuid, board.uuid));
    const stamp = vi.spyOn(pubsub, 'stampBoardMembership');
    for (const ctx of [anonCtx(), authCtx(STRANGER)]) {
      await expect(
        boardPresenceMutations.resolveBoardForUuid(undefined, { boardUuid: board.uuid }, ctx),
      ).rejects.toThrow('Board not found');
    }
    expect(stamp).not.toHaveBeenCalled();
    await expect(
      boardPresenceMutations.resolveBoardForUuid(undefined, { boardUuid: board.uuid }, authCtx(OWNER)),
    ).resolves.toMatchObject({ boardId: board.id });
  });

  it('rejects a previously stamped member before report side effects once the spray wall is hidden', async () => {
    const board = await makeSprayBoard(makeUnlistedBoard, 'Stale Spray Membership');
    const ctx = authCtx(STRANGER);
    await boardPresenceMutations.resolveBoardForUuid(undefined, { boardUuid: board.uuid }, ctx);
    vi.spyOn(pubsub, 'getBoardReportGate').mockResolvedValue({
      isMember: true,
      firstSeenMs: Date.now() - 120_000,
      lastReport: null,
      currentWriter: null,
    });
    const commit = vi.spyOn(pubsub, 'commitBoardClimb');
    await db
      .update(dbSchema.sprayWalls)
      .set({ hiddenAt: new Date() })
      .where(eq(dbSchema.sprayWalls.boardUuid, board.uuid));
    await expect(
      boardPresenceMutations.reportBoardClimb(undefined, { boardId: board.id, climb: REPORT_CLIMB, angle: 40 }, ctx),
    ).rejects.toThrow('Board not found');
    expect(commit).not.toHaveBeenCalled();
    expect(
      await db.select().from(dbSchema.boardClimbEvents).where(eq(dbSchema.boardClimbEvents.boardId, board.id)),
    ).toEqual([]);
  });

  it('keeps published spray climb details for a holder of the exact wall UUID', async () => {
    const board = await makeSprayBoard(makeUnlistedBoard, 'Spray Climb Details');
    const display = await makeSprayClimbDisplay(board);
    await db.insert(dbSchema.boardClimbEvents).values({
      boardId: board.id,
      boardType: 'spray',
      climbUuid: display.climbUuid,
      name: display.name,
      frames: display.frames,
      angle: 40,
      seq: display.seq,
      confirmedAt: display.sentAt,
    });
    vi.spyOn(pubsub, 'getRecentBoardClimbs').mockResolvedValue([display]);
    for (const ctx of [anonCtx(), authCtx(STRANGER), authCtx(OWNER)]) {
      const args = { boardId: board.id, boardUuid: board.uuid };
      const responses = await Promise.all([
        boardPresenceQueries.boardRecentClimbs(undefined, args, ctx),
        boardPresenceQueries.boardRecentHistory(undefined, args, ctx),
        boardPresenceQueries.boardHistory(undefined, args, ctx),
        boardPresenceQueries.boardHistoryPage(undefined, args, ctx).then((page) => page.entries),
      ]);
      for (const returned of responses)
        expect(returned[0]).toMatchObject({ name: display.name, frames: display.frames });
    }
  });

  it('keeps draft, item privacy, other-wall content and private sender gates separate from the held link', async () => {
    const board = await makeSprayBoard(makeUnlistedBoard, 'Spray Separate Gates');
    const elsewhere = await makeSprayBoard(makeUnlistedBoard, 'Spray Different Layout');
    const publicClimb = await makeSprayClimbDisplay(board);
    const privateClimb = await makeSprayClimbDisplay(board);
    const draft = await makeSprayClimbDisplay(board);
    const otherWall = await makeSprayClimbDisplay(elsewhere);
    await db.insert(dbSchema.contentPrivacy).values({
      entityType: 'climb',
      entityId: privateClimb.climbUuid,
      ownerId: OWNER,
      audience: 'only_me',
    });
    await db.update(dbSchema.boardClimbs).set({ isDraft: true }).where(eq(dbSchema.boardClimbs.uuid, draft.climbUuid));
    await db.insert(dbSchema.userProfiles).values({ userId: OTHER_STRANGER, isPrivate: true });
    vi.spyOn(pubsub, 'getRecentBoardClimbs').mockResolvedValue([
      { ...publicClimb, sentByUserId: OTHER_STRANGER, sentByDisplayName: 'Private Sender' },
      privateClimb,
      draft,
      otherWall,
    ]);
    for (const ctx of [anonCtx(), authCtx(STRANGER)]) {
      const [visible, ...concealed] = await boardPresenceQueries.boardRecentClimbs(
        undefined,
        { boardId: board.id, boardUuid: board.uuid },
        ctx,
      );
      expect(visible).toMatchObject({ name: publicClimb.name, frames: publicClimb.frames, sentByDisplayName: null });
      for (const returned of concealed) expect(returned).toMatchObject({ name: null, frames: null });
    }
  });

  it.each(['BoardClimbSet', 'BoardHistoryUpdated'] as const)(
    'keeps authorized spray details through a populated %s event',
    async (kind) => {
      const board = await makeSprayBoard(makeUnlistedBoard, 'Spray Live Details');
      const display = await makeSprayClimbDisplay(board);
      let emit: ((event: BoardPresenceEvent) => void) | undefined;
      vi.spyOn(pubsub, 'subscribeBoardPresence').mockImplementation(async (_boardId, listener) => {
        emit = listener;
        return () => {};
      });
      const iterator = boardPresenceSubscriptions.boardNowPlaying.subscribe(
        undefined,
        { boardId: board.id, boardUuid: board.uuid },
        anonCtx(),
      );
      try {
        const pending = iterator.next();
        await vi.waitFor(() => expect(emit).toBeDefined());
        emit?.(
          kind === 'BoardClimbSet'
            ? { __typename: kind, climb: display }
            : { __typename: kind, climbs: [display], seq: display.seq },
        );
        const event = (await pending).value?.boardNowPlaying;
        const returned =
          event?.__typename === 'BoardClimbSet'
            ? event.climb
            : event?.__typename === 'BoardHistoryUpdated'
              ? event.climbs[0]
              : null;
        expect(returned).toMatchObject({ name: display.name, frames: display.frames });
      } finally {
        await iterator.return(undefined);
      }
    },
  );

  it('rebuilds populated queue seeds and wake-ups for the holder without publishing capability-derived details', async () => {
    const board = await makeSprayBoard(makeUnlistedBoard, 'Spray Queue Details');
    const display = await makeSprayClimbDisplay(board);
    const sessionId = uuidv4();
    await db.insert(dbSchema.boardSessions).values({
      id: sessionId,
      boardId: board.id,
      boardPath: `/b/${board.slug}/40`,
      createdByUserId: OWNER,
      isPublic: true,
      status: 'active',
      lastActivity: new Date(),
    });
    const current = {
      uuid: `${PREFIX}queue-current`,
      climb: { ...REPORT_CLIMB.climb, uuid: display.climbUuid, benchmark_difficulty: null },
    };
    const queueState: QueueState = {
      version: 1,
      sequence: 1,
      stateHash: 'test',
      stateHashOrdered: 'test',
      queue: [current],
      currentClimbQueueItem: current,
    };
    vi.spyOn(pubsub, 'getBoardSession').mockResolvedValue(sessionId);
    vi.spyOn(roomManager, 'getQueueState').mockResolvedValue(queueState);
    let emit: ((preview: BoardQueuePreview) => void) | undefined;
    vi.spyOn(pubsub, 'subscribeBoardQueuePreview').mockImplementation(async (_boardId, listener) => {
      emit = listener;
      return () => {};
    });
    const args = { boardId: board.id, boardUuid: board.uuid };
    const fromQuery = await boardQueuePreviewQueries.boardQueuePreview(undefined, args, anonCtx());
    expect(fromQuery?.current).toMatchObject({ name: current.climb.name, frames: display.frames });
    expect((await getBoardQueuePreviewSnapshot(board.id))?.current).toMatchObject({ name: null, frames: null });
    const iterator = boardQueuePreviewSubscriptions.boardQueuePreview.subscribe(undefined, args, anonCtx());
    try {
      expect((await iterator.next()).value?.boardQueuePreview.current).toMatchObject({
        name: current.climb.name,
        frames: display.frames,
      });
      const pending = iterator.next();
      emit?.({ boardId: board.id, current: null, upNext: [], queueLength: 0, updatedAt: display.sentAt });
      expect((await pending).value?.boardQueuePreview.current).toMatchObject({
        name: current.climb.name,
        frames: display.frames,
      });
      await db.insert(dbSchema.contentPrivacy).values({
        entityType: 'climb',
        entityId: display.climbUuid,
        ownerId: OWNER,
        audience: 'only_me',
      });
      const restricted = iterator.next();
      emit?.(fromQuery!);
      expect((await restricted).value?.boardQueuePreview.current).toMatchObject({ name: null, frames: null });
    } finally {
      await iterator.return(undefined);
    }
  });

  it.each(['cached query', 'live event'] as const)(
    'removes a now-draft hardest-send name from the %s without changing aggregate grades',
    async (kind) => {
      const board = await makeSprayBoard(makeUnlistedBoard, 'Spray Cached Hardest');
      const display = await makeSprayClimbDisplay(board);
      const cached: BoardPresenceStats = {
        climbsSentCount: 3,
        distinctClimbersCount: 2,
        hardestGrade: 'V2',
        hardestSend: {
          climbUuid: display.climbUuid,
          climbOwnerId: OWNER,
          name: display.name,
          grade: 'V2',
          sentByUserId: null,
          sentAt: display.sentAt,
        },
      };
      vi.spyOn(presenceStats, 'getCachedBoardPresenceStats').mockResolvedValue(cached);
      const args = { boardId: board.id, boardUuid: board.uuid };
      expect((await boardPresenceQueries.boardPresenceStats(undefined, args, anonCtx())).hardestSend?.name).toBe(
        display.name,
      );
      await db
        .update(dbSchema.boardClimbs)
        .set({ isDraft: true })
        .where(eq(dbSchema.boardClimbs.uuid, display.climbUuid));
      let projected: BoardPresenceStats | undefined;
      if (kind === 'cached query') {
        projected = await boardPresenceQueries.boardPresenceStats(undefined, args, anonCtx());
      } else {
        let emit: ((event: BoardPresenceEvent) => void) | undefined;
        vi.spyOn(pubsub, 'subscribeBoardPresence').mockImplementation(async (_boardId, listener) => {
          emit = listener;
          return () => {};
        });
        const iterator = boardPresenceSubscriptions.boardNowPlaying.subscribe(undefined, args, anonCtx());
        try {
          const pending = iterator.next();
          await vi.waitFor(() => expect(emit).toBeDefined());
          emit?.({ __typename: 'BoardStatsUpdated', stats: cached, seq: 2 });
          const event = (await pending).value?.boardNowPlaying;
          if (event?.__typename === 'BoardStatsUpdated') projected = event.stats;
        } finally {
          await iterator.return(undefined);
        }
      }
      expect(projected).toMatchObject({
        climbsSentCount: 3,
        distinctClimbersCount: 2,
        hardestGrade: 'V2',
        hardestSend: null,
      });
    },
  );

  it('preserves missing-catalog aggregate grades without replaying a cached hardest-send name', async () => {
    const board = await makeSprayBoard(makeUnlistedBoard, 'Spray Unknown Hardest');
    const cached: BoardPresenceStats = {
      climbsSentCount: 3,
      distinctClimbersCount: 2,
      hardestGrade: 'V2',
      hardestSend: {
        climbUuid: `${PREFIX}missing-climb`,
        name: 'Stale copied name',
        grade: 'V2',
        sentByUserId: null,
        sentAt: new Date().toISOString(),
      },
    };
    vi.spyOn(presenceStats, 'getCachedBoardPresenceStats').mockResolvedValue(cached);
    expect(
      await boardPresenceQueries.boardPresenceStats(undefined, { boardId: board.id, boardUuid: board.uuid }, anonCtx()),
    ).toMatchObject({
      climbsSentCount: 3,
      distinctClimbersCount: 2,
      hardestGrade: 'V2',
      hardestSend: { climbUuid: cached.hardestSend?.climbUuid, grade: 'V2', name: null },
    });
  });

  it('names the current spray wall on its live sessions only for the matching UUID holder', async () => {
    const board = await makeSprayBoard(makeUnlistedBoard, 'Spray Live Wall');
    const sessionId = uuidv4();
    await db.insert(dbSchema.boardSessions).values({
      id: sessionId,
      boardId: board.id,
      boardPath: `/b/${board.slug}/40`,
      createdByUserId: OWNER,
      isPublic: true,
      status: 'active',
      lastActivity: new Date(),
    });
    vi.spyOn(roomManager, 'getSessionConnectionLiveness').mockResolvedValue(
      new Map([[sessionId, { liveConnectionCount: 1, redisKeyExists: true }]]),
    );
    vi.spyOn(pubsub, 'getBoardSession').mockResolvedValue(null);
    vi.spyOn(pubsub, 'getSessionBoard').mockResolvedValue(null);
    vi.spyOn(roomManager, 'getSessionUsers').mockResolvedValue([]);
    for (const ctx of [anonCtx(), authCtx(STRANGER)]) {
      const sessions = await liveSessionQueries.boardLiveSessions(
        undefined,
        { boardId: board.id, boardUuid: board.uuid },
        ctx,
      );
      expect(sessions).toHaveLength(1);
      expect(sessions[0].board).toMatchObject({ uuid: board.uuid, name: board.name });
    }
  });

  it.each(['now-playing', 'queue-preview'] as const)(
    'withdraws an open %s stream when the held spray wall is hidden',
    async (kind) => {
      const board = await makeSprayBoard(makeUnlistedBoard, 'Spray Stream Wall');
      let emitPresence: ((event: BoardPresenceEvent) => void) | undefined;
      let emitPreview: ((event: BoardQueuePreview) => void) | undefined;
      vi.spyOn(pubsub, 'subscribeBoardPresence').mockImplementation(async (_boardId, listener) => {
        emitPresence = listener;
        return () => {};
      });
      vi.spyOn(pubsub, 'subscribeBoardQueuePreview').mockImplementation(async (_boardId, listener) => {
        emitPreview = listener;
        return () => {};
      });
      const ctx = anonCtx();
      const args = { boardId: board.id, boardUuid: board.uuid };
      const iterator =
        kind === 'now-playing'
          ? boardPresenceSubscriptions.boardNowPlaying.subscribe(undefined, args, ctx)
          : boardQueuePreviewSubscriptions.boardQueuePreview.subscribe(undefined, args, ctx);
      try {
        const pending = iterator.next();
        await vi.waitFor(() => expect(kind === 'now-playing' ? emitPresence : emitPreview).toBeDefined());
        await db
          .update(dbSchema.sprayWalls)
          .set({ hiddenAt: new Date() })
          .where(eq(dbSchema.sprayWalls.boardUuid, board.uuid));
        const emptyPreview = {
          boardId: board.id,
          current: null,
          upNext: [],
          queueLength: 0,
          updatedAt: new Date().toISOString(),
        };
        if (kind === 'now-playing')
          emitPresence?.({ __typename: 'BoardClimbCleared', clearedAt: new Date().toISOString(), seq: 1 });
        else emitPreview?.(emptyPreview);
        const result = await pending;
        if (kind === 'now-playing') expect(result.done).toBe(true);
        else {
          expect(result.value).toMatchObject({
            boardQueuePreview: { boardId: board.id, current: null, upNext: [], queueLength: 0 },
          });
          expect((await iterator.next()).done).toBe(true);
        }
      } finally {
        await iterator.return(undefined);
      }
    },
  );
});
