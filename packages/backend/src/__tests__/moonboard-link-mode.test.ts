import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { pubsub } from '../pubsub';
import { socialBoardMutations, socialBoardQueries } from '../graphql/resolvers/social/boards';
import { boardPresenceMutations } from '../graphql/resolvers/board-presence/mutations';
import { SYSTEM_BOARD_OWNER_ID } from '../graphql/resolvers/board-presence/shared';
import { resetAllRateLimits } from '../utils/rate-limiter';

/**
 * MoonBoard link mode (#7220): the person's choice (`moonboard_link_mode`) and the
 * app's detection (`moonboard_link_detected`). The effective mode is the choice,
 * then the detection, then relay.
 */

const OWNER = 'link-mode-owner';
const STRANGER = 'link-mode-stranger';
const CLIMBER = 'link-mode-climber';

let connectionCounter = 0;
const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `conn-${userId}-${connectionCounter++}`, isAuthenticated: true, userId }) as ConnectionContext;

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

type LinkBoard = {
  uuid: string;
  moonboardLinkMode: string | null;
  moonboardLinkDetected: string | null;
  moonboardLinkModeEffective: string | null;
};

const CONFIG = { boardType: 'moonboard', layoutId: 3, sizeId: 1, setIds: '5,6,7,8,9,10' };
let placeCounter = 0;

const createBoard = (input: Record<string, unknown> = {}) =>
  socialBoardMutations.createBoard(
    null,
    { input: { ...CONFIG, name: 'Gym MoonBoard', locationName: `Wall ${placeCounter++}`, ...input } },
    authCtx(OWNER),
  ) as Promise<LinkBoard>;

const updateBoard = (input: Record<string, unknown>, userId = OWNER) =>
  socialBoardMutations.updateBoard(null, { input }, authCtx(userId)) as Promise<LinkBoard>;

const readBoard = (boardUuid: string) =>
  socialBoardQueries.board(null, { boardUuid }, authCtx(OWNER)) as Promise<LinkBoard | null>;

const rawRow = async (uuid: string) => {
  const result = await db.execute(sql`
    SELECT id, moonboard_link_mode, moonboard_link_detected, sync_frozen_at, updated_at
      FROM user_boards WHERE uuid = ${uuid}
  `);
  return Array.from(
    result as Iterable<{
      id: number;
      moonboard_link_mode: string | null;
      moonboard_link_detected: string | null;
      sync_frozen_at: unknown;
      updated_at: unknown;
    }>,
  )[0];
};

const detect = async (boardId: number, detected: string, userId = CLIMBER) =>
  boardPresenceMutations.reportMoonboardLinkDetected(null, { boardId, detected }, authCtx(userId));

/** A board the climber has selected or connected to (the presence stamp). */
const memberBoard = async (input: Record<string, unknown> = {}) => {
  const board = await createBoard(input);
  const row = await rawRow(board.uuid);
  await pubsub.stampBoardMembership(String(row.id), CLIMBER);
  return { board, boardId: Number(row.id) };
};

beforeEach(async () => {
  resetAllRateLimits();
  await db.execute(sql`
    TRUNCATE TABLE
      "community_roles", "gym_members", "gym_follows", "location_sync_gym_sources", "user_boards", "gyms"
    RESTART IDENTITY CASCADE
  `);
  await Promise.all([insertUser(OWNER), insertUser(STRANGER), insertUser(CLIMBER), insertUser(SYSTEM_BOARD_OWNER_ID)]);
});

describe('moonboard link mode: the person’s choice', () => {
  it('defaults to relay with nothing stored', async () => {
    const board = await createBoard();
    expect(board.moonboardLinkMode).toBeNull();
    expect(board.moonboardLinkDetected).toBeNull();
    expect(board.moonboardLinkModeEffective).toBe('relay');
  });

  it('round-trips a choice through create, update and clear', async () => {
    const board = await createBoard({ moonboardLinkMode: 'multi' });
    expect(board.moonboardLinkModeEffective).toBe('multi');

    await updateBoard({ boardUuid: board.uuid, moonboardLinkMode: 'relay' });
    expect((await readBoard(board.uuid))?.moonboardLinkMode).toBe('relay');

    await updateBoard({ boardUuid: board.uuid, moonboardLinkMode: null });
    const cleared = await readBoard(board.uuid);
    expect(cleared?.moonboardLinkMode).toBeNull();
    expect(cleared?.moonboardLinkModeEffective).toBe('relay');
  });

  it('leaves the choice alone when an update omits it', async () => {
    const board = await createBoard({ moonboardLinkMode: 'multi' });
    await updateBoard({ boardUuid: board.uuid, name: 'Renamed wall' });
    expect((await rawRow(board.uuid)).moonboard_link_mode).toBe('multi');
  });

  it('refuses an editor-less climber', async () => {
    const board = await createBoard();
    await expect(updateBoard({ boardUuid: board.uuid, moonboardLinkMode: 'multi' }, STRANGER)).rejects.toThrow(
      /Not authorized to update this board/,
    );
    expect((await rawRow(board.uuid)).moonboard_link_mode).toBeNull();
  });
});

describe('reportMoonboardLinkDetected', () => {
  it('fills the detected column without freezing sync or touching updated_at', async () => {
    const { board, boardId } = await memberBoard();
    const before = await rawRow(board.uuid);

    expect(await detect(boardId, 'multi')).toBe(true);
    const after = await rawRow(board.uuid);
    expect(after.moonboard_link_detected).toBe('multi');
    expect(after.sync_frozen_at).toBeNull();
    expect(String(after.updated_at)).toBe(String(before.updated_at));
    expect((await readBoard(board.uuid))?.moonboardLinkModeEffective).toBe('multi');
  });

  it('only ever moves toward relay', async () => {
    const { board, boardId } = await memberBoard();
    expect(await detect(boardId, 'multi')).toBe(true);
    expect(await detect(boardId, 'relay')).toBe(true);
    expect(await detect(boardId, 'multi')).toBe(false);
    expect((await rawRow(board.uuid)).moonboard_link_detected).toBe('relay');
  });

  it("never overrides a person's choice", async () => {
    const { board, boardId } = await memberBoard({ moonboardLinkMode: 'multi' });
    await detect(boardId, 'relay');
    const read = await readBoard(board.uuid);
    expect(read?.moonboardLinkMode).toBe('multi');
    expect(read?.moonboardLinkDetected).toBe('relay');
    expect(read?.moonboardLinkModeEffective).toBe('multi');
  });

  it('refuses a phone without a presence stamp', async () => {
    const board = await createBoard();
    const { id } = await rawRow(board.uuid);
    await expect(detect(Number(id), 'multi', STRANGER)).rejects.toThrow(/Not connected to this board/);
    expect((await rawRow(board.uuid)).moonboard_link_detected).toBeNull();
  });

  it('refuses shared per-config feed rows', async () => {
    const { board, boardId } = await memberBoard();
    await db.execute(sql`
      UPDATE user_boards SET owner_id = ${SYSTEM_BOARD_OWNER_ID}, slug = ${'presence-moonboard-test'}
       WHERE uuid = ${board.uuid}
    `);
    expect(await detect(boardId, 'multi')).toBe(false);
    expect((await rawRow(board.uuid)).moonboard_link_detected).toBeNull();
  });

  it('rejects values that are not link modes', async () => {
    const { boardId } = await memberBoard();
    await expect(detect(boardId, 'several')).rejects.toThrow();
  });
});
