import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { socialBoardMutations } from '../graphql/resolvers/social/boards';
import { socialGymMutations } from '../graphql/resolvers/social/gyms';
import { resetAllRateLimits } from '../utils/rate-limiter';

/**
 * Real-DB coverage for board/gym mutations on a database WITHOUT PostGIS.
 *
 * IMPORTANT: this file only tests anything because the per-worker backend test
 * DB is a plain `postgres` image and `schema-sql.ts` declares `user_boards` and
 * `gyms` with latitude/longitude but no `location` column — it IS the
 * no-PostGIS deployment #4218 reports. If PostGIS is ever added to the test
 * image, every case here passes vacuously and this file must be rewritten to
 * drop the column (or stub the write) explicitly.
 *
 * On main, updateBoard/updateGym/createGym issued unguarded
 * `UPDATE ... SET location = ST_MakePoint(...)` statements, so saving an edit
 * with coordinates threw (42704 `type "geography" does not exist` here, 42703
 * undefined-column where the type exists but the column doesn't) after the row
 * had already been updated: the user saw a failure for a save that had landed.
 * Five of the six cases below fail against main.
 */

const OWNER = 'geo-degrade-owner';

const BOARD_CONFIG = { boardType: 'moonboard', layoutId: 3, sizeId: 1, setIds: '5,6,7' };

let connectionCounter = 0;
const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `conn-${userId}-${connectionCounter++}`, isAuthenticated: true, userId }) as ConnectionContext;

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

type BoardRow = { uuid: string; name: string };
type GymRow = { uuid: string; name: string };

const createBoard = (input: Record<string, unknown>) =>
  socialBoardMutations.createBoard(
    null,
    { input: { ...BOARD_CONFIG, name: 'A board', ...input } },
    authCtx(OWNER),
  ) as Promise<BoardRow>;

const updateBoard = (input: Record<string, unknown>) =>
  socialBoardMutations.updateBoard(null, { input }, authCtx(OWNER)) as Promise<BoardRow>;

const createGym = (input: Record<string, unknown>) =>
  socialGymMutations.createGym(null, { input: { name: 'A gym', ...input } }, authCtx(OWNER)) as Promise<GymRow>;

const updateGym = (input: Record<string, unknown>) =>
  socialGymMutations.updateGym(null, { input }, authCtx(OWNER)) as Promise<GymRow>;

type Coordinates = { latitude: number | null; longitude: number | null };

async function storedCoordinates(table: 'user_boards' | 'gyms', uuid: string): Promise<Coordinates> {
  const result =
    table === 'user_boards'
      ? await db.execute(sql`SELECT latitude, longitude FROM user_boards WHERE uuid = ${uuid}`)
      : await db.execute(sql`SELECT latitude, longitude FROM gyms WHERE uuid = ${uuid}`);
  const row = Array.from(result as Iterable<Coordinates>)[0];
  return {
    latitude: row.latitude == null ? null : Number(row.latitude),
    longitude: row.longitude == null ? null : Number(row.longitude),
  };
}

beforeEach(async () => {
  resetAllRateLimits();
  await db.execute(sql`
    TRUNCATE TABLE
      "community_roles", "gym_members", "gym_follows", "location_sync_gym_sources", "user_boards", "gyms"
    RESTART IDENTITY CASCADE
  `);
  await insertUser(OWNER);
});

describe('location geography writes degrade without PostGIS', () => {
  it('updateBoard saves new coordinates instead of failing on the missing column', async () => {
    const board = await createBoard({ name: 'Klimmuur MoonBoard' });

    const updated = await updateBoard({ boardUuid: board.uuid, latitude: 47.0, longitude: 8.0 });

    expect(updated.uuid).toBe(board.uuid);
    expect(await storedCoordinates('user_boards', board.uuid)).toEqual({ latitude: 47.0, longitude: 8.0 });
  });

  it('updateBoard clears coordinates without failing', async () => {
    const board = await createBoard({ name: 'Klimmuur MoonBoard', latitude: 47.0, longitude: 8.0 });

    await updateBoard({ boardUuid: board.uuid, latitude: null, longitude: null });

    expect(await storedCoordinates('user_boards', board.uuid)).toEqual({ latitude: null, longitude: null });
  });

  it('updateBoard changing only longitude keeps the stored latitude', async () => {
    const board = await createBoard({ name: 'Klimmuur MoonBoard', latitude: 47.0, longitude: 8.0 });

    await updateBoard({ boardUuid: board.uuid, longitude: 8.5 });

    expect(await storedCoordinates('user_boards', board.uuid)).toEqual({ latitude: 47.0, longitude: 8.5 });
  });

  it('createGym with coordinates resolves', async () => {
    const gym = await createGym({ name: 'Boulder Space', latitude: 47.0, longitude: 8.0 });

    expect(await storedCoordinates('gyms', gym.uuid)).toEqual({ latitude: 47.0, longitude: 8.0 });
  });

  it('updateGym saves new coordinates instead of failing', async () => {
    const gym = await createGym({ name: 'Boulder Space' });

    await updateGym({ gymUuid: gym.uuid, latitude: 47.1, longitude: 8.1 });

    expect(await storedCoordinates('gyms', gym.uuid)).toEqual({ latitude: 47.1, longitude: 8.1 });
  });

  it('createBoard with coordinates still resolves after the refactor', async () => {
    const board = await createBoard({ name: 'Klimmuur MoonBoard', latitude: 47.0, longitude: 8.0 });

    expect(await storedCoordinates('user_boards', board.uuid)).toEqual({ latitude: 47.0, longitude: 8.0 });
  });
});
