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
import { eq, like } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { pubsub } from '../pubsub/index';
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
import { projectSessionBoardPath } from '../services/board-session-privacy';

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

  it("keeps the slug path for the session's creator and for a joiner who sent it, geometry for others", async () => {
    const board = await makeUnlistedBoard('Crew Wall');
    const path = `/b/${board.slug}/40`;
    const geometry = '/tension/9/';

    expect(await projectSessionBoardPath(path, STRANGER, { sessionCreatorId: STRANGER })).toBe(path);
    expect(await projectSessionBoardPath(path, OTHER_STRANGER, { presentedByViewer: true })).toBe(path);
    expect(await projectSessionBoardPath(path, OWNER)).toBe(path);
    for (const viewer of [OTHER_STRANGER, null]) {
      const projected = await projectSessionBoardPath(path, viewer, { sessionCreatorId: STRANGER });
      expect(projected.startsWith(geometry)).toBe(true);
      expect(projected).not.toContain(board.slug);
    }
  });
});

describe('walking board ids', () => {
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
