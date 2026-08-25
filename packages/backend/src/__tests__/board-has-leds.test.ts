import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { socialBoardMutations, socialBoardQueries } from '../graphql/resolvers/social/boards';
import { resetAllRateLimits } from '../utils/rate-limiter';

/**
 * `user_boards.has_leds` — the capability flag behind "choose an active climb on
 * a board without LEDs" (#4585).
 *
 * The default matters more than the flag: 79% of production board rows have no
 * serial number, and an LED wall that wrongly reads as having none loses its
 * Bluetooth connect button for every climber at that gym. So the column is
 * `NOT NULL DEFAULT true` with no backfill, and only an explicit `false` from an
 * editor changes anything.
 */

const OWNER = 'has-leds-owner';

let connectionCounter = 0;
const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `conn-${userId}-${connectionCounter++}`, isAuthenticated: true, userId }) as ConnectionContext;

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

type CreatedBoard = { uuid: string; name: string; hasLeds: boolean };

/** A real catalogue configuration — createBoard validates it against the board data. */
const CONFIG = { boardType: 'moonboard', layoutId: 3, sizeId: 1, setIds: '5,6,7,8,9,10' };

// The duplicate guard is "same config AND same place", so each board in a test
// needs its own place rather than its own (invalid) configuration.
let placeCounter = 0;

const createBoard = (input: Record<string, unknown> = {}) =>
  socialBoardMutations.createBoard(
    null,
    {
      input: {
        ...CONFIG,
        name: 'Gym MoonBoard',
        locationName: `Wall ${placeCounter++}`,
        ...input,
      },
    },
    authCtx(OWNER),
  ) as Promise<CreatedBoard>;

const updateBoard = (input: Record<string, unknown>) =>
  socialBoardMutations.updateBoard(null, { input }, authCtx(OWNER)) as Promise<CreatedBoard>;

const readBoard = (boardUuid: string) =>
  socialBoardQueries.board(null, { boardUuid }, authCtx(OWNER)) as Promise<CreatedBoard | null>;

const rawHasLeds = async (uuid: string): Promise<boolean> => {
  const result = await db.execute(sql`SELECT has_leds FROM user_boards WHERE uuid = ${uuid}`);
  return Array.from(result as Iterable<{ has_leds: boolean }>)[0].has_leds;
};

beforeEach(async () => {
  resetAllRateLimits();
  await db.execute(sql`
    TRUNCATE TABLE
      "community_roles", "gym_members", "gym_follows", "location_sync_gym_sources", "user_boards", "gyms"
    RESTART IDENTITY CASCADE
  `);
  await insertUser(OWNER);
});

describe('user_boards.has_leds', () => {
  it('defaults to true, so no existing wall loses its Bluetooth affordance', async () => {
    const board = await createBoard();
    expect(board.hasLeds).toBe(true);
    expect(await rawHasLeds(board.uuid)).toBe(true);
  });

  it('honours an explicit false at create time', async () => {
    const board = await createBoard({ hasLeds: false });
    expect(board.hasLeds).toBe(false);
    expect(await rawHasLeds(board.uuid)).toBe(false);
  });

  it('flips through updateBoard and round-trips through the board projection', async () => {
    const board = await createBoard();
    await updateBoard({ boardUuid: board.uuid, hasLeds: false });
    expect(await rawHasLeds(board.uuid)).toBe(false);
    expect((await readBoard(board.uuid))?.hasLeds).toBe(false);

    await updateBoard({ boardUuid: board.uuid, hasLeds: true });
    expect((await readBoard(board.uuid))?.hasLeds).toBe(true);
  });

  it('leaves the flag alone when the update omits it', async () => {
    // Every web board edit submits its whole field set, so an omitted field must
    // never be read as "set it back to the default".
    const board = await createBoard({ hasLeds: false });
    await updateBoard({ boardUuid: board.uuid, name: 'Renamed wall' });
    expect(await rawHasLeds(board.uuid)).toBe(false);
  });

  it('lands on the row a gym kiosk embeds — the same uuid every climber adopts', async () => {
    // The presence channel is the active board's own row, so the flag is only
    // meaningful on the shared row. Pin that the uuid the flag is set through is
    // the uuid the board reads back under.
    const board = await createBoard({ hasLeds: false });
    const read = await readBoard(board.uuid);
    expect(read?.uuid).toBe(board.uuid);
    expect(read?.hasLeds).toBe(false);
  });
});
