/**
 * Real-DB coverage for `sessionInvitePreview` (#6004), the unauthenticated
 * query behind the www invite page and the app's join screen.
 *
 * Presence (the room manager) is mocked; every row is real. What this pins:
 *
 *  - the four states, including DORMANT: the durable row is active and the
 *    live roster is empty. `session` returns null there, which is the bug that
 *    made a running session read as "not found" while the host's phone slept.
 *  - what a stranger holding the link learns: a display name, never an email;
 *    a board or gym name only when that row is open to anyone; no ids, no
 *    roster; and nothing but the state for an ended or missing session.
 *  - null handling: no board attached, a board with no gym, no creator.
 *  - the resolver validates the id and takes the rate limit before reading.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const presence = vi.hoisted(() => ({ getSessionUsers: vi.fn() }));
vi.mock('../services/room-manager', () => ({
  roomManager: { getSessionUsers: (...args: unknown[]) => presence.getSessionUsers(...args) },
}));
vi.mock('../pubsub/index', () => ({ pubsub: {} }));
vi.mock('../services/distributed-state', () => ({ getDistributedState: () => null }));

// A spray wall's visibility lives in five side tables; the rule itself is
// covered by the spray suites. Here the answer is switched directly so the
// test can prove the preview ASKS, and obeys a "not readable".
const spray = vi.hoisted(() => ({ readableByAnyone: true }));
vi.mock('../graphql/resolvers/climbs/spray-read-access', () => ({
  isSprayBoardType: (boardType: string | null | undefined) => boardType === 'spray',
  sprayLayoutIsReadable: async (boardType: string | null | undefined) =>
    boardType !== 'spray' || spray.readableByAnyone,
}));

const rateLimit = vi.hoisted(() => ({ applyRateLimit: vi.fn(async () => {}) }));
vi.mock('../graphql/resolvers/shared/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../graphql/resolvers/shared/helpers')>();
  return { ...actual, applyRateLimit: rateLimit.applyRateLimit };
});

import { db } from '../db/client';
import { sessionQueries } from '../graphql/resolvers/sessions/queries';

const PREFIX = 'invite-preview';
const HOST_ID = `${PREFIX}-host`;
const HOST_EMAIL = `${PREFIX}-host@example.com`;
const EMAIL_NAMED_HOST_ID = `${PREFIX}-email-named-host`;
const NAMELESS_HOST_ID = `${PREFIX}-nameless-host`;

const GYM_PUBLIC_UUID = `${PREFIX}-gym-public`;
const GYM_PRIVATE_UUID = `${PREFIX}-gym-private`;

const SESSION = {
  live: `${PREFIX}-live`,
  dormant: `${PREFIX}-dormant`,
  ended: `${PREFIX}-ended`,
  endedSkewed: `${PREFIX}-ended-skewed`,
  inferred: `${PREFIX}-inferred`,
  noBoard: `${PREFIX}-no-board`,
  boardWithoutGym: `${PREFIX}-board-without-gym`,
  privateBoard: `${PREFIX}-private-board`,
  unlistedBoard: `${PREFIX}-unlisted-board`,
  deletedBoard: `${PREFIX}-deleted-board`,
  hiddenLocationBoard: `${PREFIX}-hidden-location-board`,
  privateGym: `${PREFIX}-private-gym`,
  sprayBoard: `${PREFIX}-spray-board`,
  sprayPathOnly: `${PREFIX}-spray-path-only`,
  emailNamedHost: `${PREFIX}-email-named-host`,
  namelessHost: `${PREFIX}-nameless-host`,
  noCreator: `${PREFIX}-no-creator`,
} as const;

const BOARD_PATH = 'kilter/1/10/1,20/40';

let boardIds: Record<
  'gym' | 'home' | 'private' | 'unlisted' | 'deleted' | 'hiddenLocation' | 'privateGym' | 'spray',
  number
>;
const anonymousContext = { connectionId: 'http-test', isAuthenticated: false } as unknown as ConnectionContext;

const preview = (sessionId: string) => sessionQueries.sessionInvitePreview({}, { sessionId }, anonymousContext);

const insertUser = async (id: string, email: string, name: string | null) => {
  await db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${email}, ${name}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
};

const insertGym = async (uuid: string, name: string, isPublic: boolean): Promise<number> => {
  const result = await db.execute(sql`
    INSERT INTO gyms (uuid, name, slug, owner_id, is_public, created_at, updated_at)
    VALUES (${uuid}, ${name}, ${uuid}, ${HOST_ID}, ${isPublic}, now(), now())
    RETURNING id
  `);
  return Number(Array.from(result as Iterable<{ id: number }>)[0].id);
};

type BoardSeed = {
  key: string;
  name: string;
  sizeId: number;
  boardType?: string;
  gymId?: number | null;
  isPublic?: boolean;
  isUnlisted?: boolean;
  hideLocation?: boolean;
  deleted?: boolean;
};

const insertBoard = async (seed: BoardSeed): Promise<number> => {
  const uuid = `${PREFIX}-board-${seed.key}`;
  const result = await db.execute(sql`
    INSERT INTO user_boards (
      uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name,
      gym_id, is_public, is_unlisted, hide_location, deleted_at
    )
    VALUES (
      ${uuid}, ${uuid}, ${HOST_ID}, ${seed.boardType ?? 'kilter'}, 1, ${seed.sizeId}, '1,20', ${seed.name},
      ${seed.gymId ?? null}, ${seed.isPublic ?? true}, ${seed.isUnlisted ?? false}, ${seed.hideLocation ?? false},
      ${seed.deleted ? sql`now()` : sql`NULL`}
    )
    RETURNING id
  `);
  return Number(Array.from(result as Iterable<{ id: number }>)[0].id);
};

type SessionSeed = {
  id: string;
  boardId?: number | null;
  createdBy?: string | null;
  status?: 'active' | 'ended';
  ended?: boolean;
};

const insertSession = async (seed: SessionSeed) => {
  await db.execute(sql`
    INSERT INTO board_sessions (id, board_path, created_by_user_id, name, board_id, status, ended_at, is_public)
    VALUES (
      ${seed.id}, ${BOARD_PATH}, ${seed.createdBy === undefined ? HOST_ID : seed.createdBy}, 'Tuesday projecting',
      ${seed.boardId ?? null}, ${seed.status ?? 'active'}, ${seed.ended ? sql`now()` : sql`NULL`}, false
    )
  `);
};

const cleanup = async () => {
  await db.execute(sql`DELETE FROM board_sessions WHERE id LIKE ${`${PREFIX}-%`}`);
  await db.execute(sql`DELETE FROM user_boards WHERE uuid LIKE ${`${PREFIX}-board-%`}`);
  await db.execute(sql`DELETE FROM gyms WHERE uuid IN (${GYM_PUBLIC_UUID}, ${GYM_PRIVATE_UUID})`);
  await db.execute(sql`DELETE FROM "users" WHERE id IN (${HOST_ID}, ${EMAIL_NAMED_HOST_ID}, ${NAMELESS_HOST_ID})`);
};

describe('sessionInvitePreview (real DB)', () => {
  beforeAll(async () => {
    await cleanup();

    await insertUser(HOST_ID, HOST_EMAIL, 'Account Name');
    await db.execute(sql`
      INSERT INTO user_profiles (user_id, display_name) VALUES (${HOST_ID}, '  Alex Honnold  ')
      ON CONFLICT (user_id) DO UPDATE SET display_name = excluded.display_name
    `);
    // An account whose stored name IS its email address, and no profile name.
    await insertUser(EMAIL_NAMED_HOST_ID, `${PREFIX}-leak@example.com`, `${PREFIX}-leak@example.com`);
    await insertUser(NAMELESS_HOST_ID, `${PREFIX}-nameless@example.com`, null);

    const publicGymId = await insertGym(GYM_PUBLIC_UUID, 'The Climbing Hangar', true);
    const privateGymId = await insertGym(GYM_PRIVATE_UUID, 'Garage Wall', false);

    const gymBoardId = await insertBoard({ key: 'gym', name: 'Hangar Kilter', sizeId: 10, gymId: publicGymId });
    const homeBoardId = await insertBoard({ key: 'home', name: 'Home Wall', sizeId: 11 });
    const privateBoardId = await insertBoard({
      key: 'private',
      name: 'Secret Board',
      sizeId: 12,
      gymId: publicGymId,
      isPublic: false,
    });
    const unlistedBoardId = await insertBoard({
      key: 'unlisted',
      name: 'Unlisted Board',
      sizeId: 13,
      gymId: publicGymId,
      isUnlisted: true,
    });
    const deletedBoardId = await insertBoard({
      key: 'deleted',
      name: 'Deleted Board',
      sizeId: 14,
      gymId: publicGymId,
      deleted: true,
    });
    const hiddenLocationBoardId = await insertBoard({
      key: 'hidden-location',
      name: 'No Address Board',
      sizeId: 15,
      gymId: publicGymId,
      hideLocation: true,
    });
    const privateGymBoardId = await insertBoard({
      key: 'private-gym',
      name: 'Garage Kilter',
      sizeId: 16,
      gymId: privateGymId,
    });
    const sprayBoardId = await insertBoard({
      key: 'spray',
      name: 'Basement Spray',
      sizeId: 17,
      boardType: 'spray',
      gymId: publicGymId,
    });

    boardIds = {
      gym: gymBoardId,
      home: homeBoardId,
      private: privateBoardId,
      unlisted: unlistedBoardId,
      deleted: deletedBoardId,
      hiddenLocation: hiddenLocationBoardId,
      privateGym: privateGymBoardId,
      spray: sprayBoardId,
    };
  });

  afterAll(async () => {
    await cleanup();
  });

  // The shared setup file truncates board_sessions before every test, so the
  // sessions are seeded here, after it, and the boards they point at once.
  beforeEach(async () => {
    presence.getSessionUsers.mockReset();
    presence.getSessionUsers.mockResolvedValue([]);
    rateLimit.applyRateLimit.mockClear();
    spray.readableByAnyone = true;

    await insertSession({ id: SESSION.live, boardId: boardIds.gym });
    await insertSession({ id: SESSION.dormant, boardId: boardIds.gym });
    await insertSession({ id: SESSION.ended, boardId: boardIds.gym, status: 'ended', ended: true });
    await insertSession({ id: SESSION.endedSkewed, boardId: boardIds.gym, ended: true });
    await insertSession({ id: SESSION.noBoard });
    await insertSession({ id: SESSION.boardWithoutGym, boardId: boardIds.home });
    await insertSession({ id: SESSION.privateBoard, boardId: boardIds.private });
    await insertSession({ id: SESSION.unlistedBoard, boardId: boardIds.unlisted });
    await insertSession({ id: SESSION.deletedBoard, boardId: boardIds.deleted });
    await insertSession({ id: SESSION.hiddenLocationBoard, boardId: boardIds.hiddenLocation });
    await insertSession({ id: SESSION.privateGym, boardId: boardIds.privateGym });
    await insertSession({ id: SESSION.sprayBoard, boardId: boardIds.spray });
    await insertSession({ id: SESSION.emailNamedHost, boardId: boardIds.gym, createdBy: EMAIL_NAMED_HOST_ID });
    await insertSession({ id: SESSION.namelessHost, boardId: boardIds.gym, createdBy: NAMELESS_HOST_ID });
    await insertSession({ id: SESSION.noCreator, boardId: boardIds.gym, createdBy: null });
    // An inferred session: rebuilt from one climber's ticks, no board path.
    await db.execute(sql`
      INSERT INTO board_sessions (id, board_path, created_by_user_id, status, origin)
      VALUES (${SESSION.inferred}, NULL, ${HOST_ID}, 'active', 'inferred')
    `);
  });

  describe('state', () => {
    it('is live when the session is running and someone is connected', async () => {
      presence.getSessionUsers.mockResolvedValue([{ id: 'connection-1', username: 'Alex' }]);

      expect(await preview(SESSION.live)).toEqual({
        sessionId: SESSION.live,
        state: 'live',
        hostName: 'Alex Honnold',
        boardName: 'Hangar Kilter',
        boardPath: BOARD_PATH,
        gymName: 'The Climbing Hangar',
      });
    });

    it('is dormant, not missing, when the durable row is active and the live roster is empty', async () => {
      presence.getSessionUsers.mockResolvedValue([]);

      expect(await preview(SESSION.dormant)).toEqual({
        sessionId: SESSION.dormant,
        state: 'dormant',
        hostName: 'Alex Honnold',
        boardName: 'Hangar Kilter',
        boardPath: BOARD_PATH,
        gymName: 'The Climbing Hangar',
      });
    });

    it('is ended for an ended row, returns the state alone, and never reads presence', async () => {
      presence.getSessionUsers.mockResolvedValue([{ id: 'straggler' }]);

      expect(await preview(SESSION.ended)).toEqual({
        sessionId: SESSION.ended,
        state: 'ended',
        hostName: null,
        boardName: null,
        boardPath: null,
        gymName: null,
      });
      expect(presence.getSessionUsers).not.toHaveBeenCalled();
    });

    it('is ended for a skewed row with endedAt set and status still active', async () => {
      expect((await preview(SESSION.endedSkewed)).state).toBe('ended');
    });

    it('is not_found for an id with no row, with the state alone', async () => {
      expect(await preview(`${PREFIX}-never-existed`)).toEqual({
        sessionId: `${PREFIX}-never-existed`,
        state: 'not_found',
        hostName: null,
        boardName: null,
        boardPath: null,
        gymName: null,
      });
      expect(presence.getSessionUsers).not.toHaveBeenCalled();
    });

    it('is not_found for an inferred session, which nobody started and nobody can join', async () => {
      const result = await preview(SESSION.inferred);

      expect(result.state).toBe('not_found');
      expect(result.hostName).toBeNull();
    });
  });

  describe('null board and gym', () => {
    it('returns the host and path with no board or gym name when no board is attached', async () => {
      expect(await preview(SESSION.noBoard)).toEqual({
        sessionId: SESSION.noBoard,
        state: 'dormant',
        hostName: 'Alex Honnold',
        boardName: null,
        boardPath: BOARD_PATH,
        gymName: null,
      });
    });

    it('returns the board name and a null gym for a board that belongs to no gym', async () => {
      const result = await preview(SESSION.boardWithoutGym);

      expect(result.boardName).toBe('Home Wall');
      expect(result.gymName).toBeNull();
    });
  });

  describe('what a stranger holding the link may learn', () => {
    it('returns exactly the six documented fields: no ids, no roster, no email', async () => {
      presence.getSessionUsers.mockResolvedValue([
        { id: 'connection-1', userId: HOST_ID, username: 'Alex', avatarUrl: 'https://example.com/alex.png' },
      ]);

      const result = await preview(SESSION.live);

      expect(Object.keys(result).sort()).toEqual([
        'boardName',
        'boardPath',
        'gymName',
        'hostName',
        'sessionId',
        'state',
      ]);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(HOST_ID);
      expect(serialized).not.toContain(HOST_EMAIL);
      expect(serialized).not.toContain('connection-1');
      expect(serialized).not.toContain('avatar');
    });

    it('prefers the profile display name over the account name, trimmed', async () => {
      expect((await preview(SESSION.live)).hostName).toBe('Alex Honnold');
    });

    it('drops an account name that is an email address', async () => {
      const result = await preview(SESSION.emailNamedHost);

      expect(result.hostName).toBeNull();
      expect(JSON.stringify(result)).not.toContain('@');
    });

    it('keeps a handle-style display name that merely contains an @', async () => {
      await db.execute(sql`UPDATE user_profiles SET display_name = '@alexclimbs' WHERE user_id = ${HOST_ID}`);
      try {
        expect((await preview(SESSION.live)).hostName).toBe('@alexclimbs');
      } finally {
        await db.execute(sql`UPDATE user_profiles SET display_name = '  Alex Honnold  ' WHERE user_id = ${HOST_ID}`);
      }
    });

    it('falls back past an email-shaped profile name to the account name', async () => {
      await db.execute(sql`UPDATE user_profiles SET display_name = 'alex@example.com' WHERE user_id = ${HOST_ID}`);
      try {
        expect((await preview(SESSION.live)).hostName).toBe('Account Name');
      } finally {
        await db.execute(sql`UPDATE user_profiles SET display_name = '  Alex Honnold  ' WHERE user_id = ${HOST_ID}`);
      }
    });

    it('returns a null host for an account with no name and for a session with no creator', async () => {
      expect((await preview(SESSION.namelessHost)).hostName).toBeNull();
      expect((await preview(SESSION.noCreator)).hostName).toBeNull();
    });

    it.each([
      ['private', SESSION.privateBoard],
      ['unlisted', SESSION.unlistedBoard],
      ['deleted', SESSION.deletedBoard],
    ])('names neither a %s board nor its gym', async (_label, sessionId) => {
      const result = await preview(sessionId);

      expect(result.state).toBe('dormant');
      expect(result.boardName).toBeNull();
      expect(result.gymName).toBeNull();
      // The path is what `session` already hands the same link holder, and the
      // app needs it to join.
      expect(result.boardPath).toBe(BOARD_PATH);
    });

    it('names the board but not the gym when the board hides its location', async () => {
      const result = await preview(SESSION.hiddenLocationBoard);

      expect(result.boardName).toBe('No Address Board');
      expect(result.gymName).toBeNull();
    });

    it('names the board but not a gym that is not public', async () => {
      const result = await preview(SESSION.privateGym);

      expect(result.boardName).toBe('Garage Kilter');
      expect(result.gymName).toBeNull();
    });

    it('names a spray wall only when an anonymous visitor could read it', async () => {
      spray.readableByAnyone = true;
      expect((await preview(SESSION.sprayBoard)).boardName).toBe('Basement Spray');

      spray.readableByAnyone = false;
      const hidden = await preview(SESSION.sprayBoard);
      expect(hidden.boardName).toBeNull();
      expect(hidden.gymName).toBeNull();
    });

    it('withholds the path of a hidden spray wall, attached or only named by the path', async () => {
      await db.execute(sql`
        INSERT INTO board_sessions (id, board_path, created_by_user_id, status)
        VALUES (${SESSION.sprayPathOnly}, 'spray/4242/1/1/40', ${HOST_ID}, 'active')
      `);

      spray.readableByAnyone = true;
      expect((await preview(SESSION.sprayBoard)).boardPath).toBe(BOARD_PATH);
      expect((await preview(SESSION.sprayPathOnly)).boardPath).toBe('spray/4242/1/1/40');

      spray.readableByAnyone = false;
      const attached = await preview(SESSION.sprayBoard);
      expect(attached.state).toBe('dormant');
      expect(attached.boardPath).toBeNull();

      const pathOnly = await preview(SESSION.sprayPathOnly);
      expect(pathOnly.state).toBe('dormant');
      expect(pathOnly.boardPath).toBeNull();
      expect(JSON.stringify(pathOnly)).not.toContain('4242');
    });

    it('answers for a session that is not shown in live listings, as joining by link already does', async () => {
      // Every seeded session has is_public = false.
      expect((await preview(SESSION.dormant)).state).toBe('dormant');
    });
  });

  describe('resolver gates', () => {
    it('takes the rate limit under its own operation name', async () => {
      await preview(SESSION.dormant);

      expect(rateLimit.applyRateLimit).toHaveBeenCalledWith(anonymousContext, 60, 'sessionInvitePreview');
    });

    it('rejects a malformed session id without reading presence', async () => {
      await expect(preview('bad id!')).rejects.toThrow();
      expect(presence.getSessionUsers).not.toHaveBeenCalled();
    });

    it('does not answer once the rate limit refuses', async () => {
      rateLimit.applyRateLimit.mockRejectedValueOnce(new Error('Rate limit exceeded'));

      await expect(preview(SESSION.live)).rejects.toThrow('Rate limit exceeded');
      expect(presence.getSessionUsers).not.toHaveBeenCalled();
    });
  });
});
