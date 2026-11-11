import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { eq, sql } from 'drizzle-orm';
import { DEFAULT_TNUT_CORNERS, MAX_TNUT_LAYOUT_BYTES, type TnutLayout } from '@boardsesh/spray-wall-geometry';
import { gymMembers, gyms, resourcePrivacy, sprayWallLedSetups, sprayWalls, userBoards } from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';

/**
 * A wall's LED setup against the real database. Two things can go wrong here that
 * matter: a value reaching a climber who should not see the wall, and a value
 * landing on another climber's phone that it should not contact.
 */

vi.mock('../storage/s3', () => ({ isS3Configured: vi.fn(() => true) }));
vi.mock('../events', () => ({ publishSocialEvent: vi.fn(async () => undefined) }));
vi.mock('../utils/rate-limiter', () => ({ checkRateLimit: vi.fn(), resetAllRateLimits: vi.fn() }));
vi.mock('../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: vi.fn().mockResolvedValue(undefined) }));

const { db } = await import('../db/client');
const { sprayWallMutations, sprayWallArchivedError } = await import('../graphql/resolvers/board/spray-walls');
const { socialBoardMutations } = await import('../graphql/resolvers/social/boards');
const { SPRAY_WALL_LED_EDIT_DENIED_CODE, sprayWallLedSetupMutations, sprayWallLedSetupQueries } =
  await import('../graphql/resolvers/board/spray-wall-led-setup');

const OWNER = 'led-owner';
const STRANGER = 'led-stranger';
const GYM_ADMIN = 'led-gym-admin';

const ctxFor = (userId: string | null): ConnectionContext =>
  ({
    connectionId: `conn-${userId ?? 'anon'}`,
    isAuthenticated: userId != null,
    userId,
  }) as unknown as ConnectionContext;

function layout(overrides: Partial<TnutLayout> = {}): TnutLayout {
  return {
    version: 1,
    pattern: 'custom',
    rows: 1,
    columns: 1,
    firstRowOffset: false,
    corners: structuredClone(DEFAULT_TNUT_CORNERS),
    holes: [
      { x: 0.25, y: 0.5 },
      { x: 0.75, y: 0.5 },
    ],
    photoKey: '[1200,900,[1,0,0,0,1,0,0,0,1]]',
    ...overrides,
  };
}

const read = (uuid: string, viewer: string | null) =>
  sprayWallLedSetupQueries.sprayWallLedSetup({}, { boardUuid: uuid }, ctxFor(viewer));
const save = (uuid: string, viewer: string | null, fields: Record<string, unknown>) =>
  sprayWallLedSetupMutations.saveSprayWallLedSetup({}, { input: { boardUuid: uuid, ...fields } }, ctxFor(viewer));

async function createWall(owner = OWNER): Promise<string> {
  const wall = (await sprayWallMutations.createSprayWall(
    {},
    { input: { name: `Wall ${uuidv4().slice(0, 6)}`, angle: 40 } },
    ctxFor(owner),
  )) as { uuid: string };
  return wall.uuid;
}

const makePublic = (uuid: string) => db.update(userBoards).set({ isPublic: true }).where(eq(userBoards.uuid, uuid));

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE TABLE "spray_wall_led_setups", "spray_walls", "user_boards", "gym_members", "gyms",
                   "board_climbs", "board_climb_holds", "board_climb_stats",
                   "board_layouts", "board_product_sizes", "board_product_sizes_layouts_sets",
                   "board_sets", "board_placement_roles", "board_placements", "board_holes"
    CASCADE
  `);
  await Promise.all([insertUser(OWNER), insertUser(STRANGER), insertUser(GYM_ADMIN)]);
});

describe('reading a wall’s LED setup', () => {
  it('reads as "no setup" for the owner of a wall nobody has set up', async () => {
    const uuid = await createWall();
    await expect(read(uuid, OWNER)).resolves.toEqual({ viewerCanEdit: true, setup: null });
  });

  it('gives any climber on a public wall the setup, but not the right to change it', async () => {
    const uuid = await createWall();
    await makePublic(uuid);
    await save(uuid, OWNER, { enabled: true, controllerUrl: 'http://wled.local' });

    const seen = await read(uuid, STRANGER);
    expect(seen?.viewerCanEdit).toBe(false);
    expect(seen?.setup).toMatchObject({
      boardUuid: uuid,
      controllerType: 'wled',
      controllerUrl: 'http://wled.local',
      enabled: true,
      layout: null,
    });
  });

  it('needs an account to read, even on a public wall', async () => {
    const uuid = await createWall();
    await makePublic(uuid);
    await save(uuid, OWNER, { enabled: true, controllerUrl: 'http://wled.local' });
    await expect(read(uuid, null)).rejects.toThrow(/auth/i);
  });

  it('answers a private wall to a stranger exactly as it answers a wall that does not exist', async () => {
    const uuid = await createWall();
    await save(uuid, OWNER, { enabled: true, controllerUrl: 'http://wled.local' });

    await expect(read(uuid, STRANGER)).resolves.toBeNull();
    await expect(read(uuid.replace(/^.{8}/, '00000000'), STRANGER)).resolves.toBeNull();
    expect((await read(uuid, OWNER))?.setup?.enabled).toBe(true);
  });

  it('opens an unlisted wall to a viewer who holds its uuid, the same as sprayWall', async () => {
    const uuid = await createWall();
    await db.update(userBoards).set({ isUnlisted: true }).where(eq(userBoards.uuid, uuid));
    await save(uuid, OWNER, { enabled: true, controllerUrl: 'http://wled.local' });
    expect((await read(uuid, STRANGER))?.setup?.controllerUrl).toBe('http://wled.local');
  });

  it('answers a gym member on the wall’s private gym wall', async () => {
    const uuid = await createWall();
    const [gym] = await db
      .insert(gyms)
      .values({ uuid: uuidv4(), slug: 'led-gym', ownerId: OWNER, name: 'LED gym', isPublic: true })
      .returning();
    await db.update(userBoards).set({ gymId: gym.id }).where(eq(userBoards.uuid, uuid));
    await db.insert(gymMembers).values({ gymId: gym.id, userId: STRANGER, role: 'member' });
    await save(uuid, OWNER, { enabled: true, controllerUrl: 'http://wled.local' });

    const seen = await read(uuid, STRANGER);
    expect(seen?.setup?.enabled).toBe(true);
    expect(seen?.viewerCanEdit).toBe(false);
  });

  it('is null on a board that is not a spray wall', async () => {
    const boardUuid = uuidv4();
    await db.insert(userBoards).values({
      uuid: boardUuid,
      slug: `kilter-${boardUuid.slice(0, 8)}`,
      ownerId: OWNER,
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 7,
      setIds: '1,2',
      name: 'Kilter at home',
    });
    await expect(read(boardUuid, OWNER)).resolves.toBeNull();
  });

  it('refuses a uuid that is not one', async () => {
    await expect(read('not-a-uuid', OWNER)).rejects.toThrow();
  });
});

describe('saving a wall’s LED setup', () => {
  it('keeps each field through saves that touch only another', async () => {
    const uuid = await createWall();
    await save(uuid, OWNER, { enabled: true, controllerUrl: 'http://wled.local' });
    await save(uuid, OWNER, { layout: layout() });
    await save(uuid, OWNER, { enabled: false });

    const setup = (await read(uuid, OWNER))?.setup;
    expect(setup?.enabled).toBe(false);
    expect(setup?.controllerUrl).toBe('http://wled.local');
    expect(setup?.layout).toMatchObject({ photoKey: layout().photoKey, holes: layout().holes });
  });

  it('stores only what the layout reader keeps, and the normalised address', async () => {
    const uuid = await createWall();
    await save(uuid, OWNER, {
      controllerUrl: '  http://WLED.local/  ',
      layout: { ...layout(), smuggled: 'value' },
    });
    const setup = (await read(uuid, OWNER))?.setup;
    expect(setup?.controllerUrl).toBe('http://wled.local');
    expect(setup?.layout).not.toHaveProperty('smuggled');
  });

  it('refuses a climber who cannot edit a wall they can read, without changing the row', async () => {
    const uuid = await createWall();
    await makePublic(uuid);
    await save(uuid, OWNER, { enabled: true, controllerUrl: 'http://wled.local' });

    await expect(save(uuid, STRANGER, { controllerUrl: 'http://192.168.1.2' })).rejects.toMatchObject({
      extensions: { code: SPRAY_WALL_LED_EDIT_DENIED_CODE },
    });
    expect((await read(uuid, OWNER))?.setup?.controllerUrl).toBe('http://wled.local');
  });

  it('lets a gym admin save, as Edit board does', async () => {
    const uuid = await createWall();
    const [gym] = await db
      .insert(gyms)
      .values({ uuid: uuidv4(), slug: 'led-admin-gym', ownerId: GYM_ADMIN, name: 'LED admin gym', isPublic: true })
      .returning();
    await db.update(userBoards).set({ gymId: gym.id, isPublic: true }).where(eq(userBoards.uuid, uuid));

    await save(uuid, GYM_ADMIN, { enabled: true });
    const seen = await read(uuid, GYM_ADMIN);
    expect(seen?.viewerCanEdit).toBe(true);
    expect(seen?.setup?.enabled).toBe(true);
  });

  it('answers not-found to a stranger on a private wall, so a write is not an oracle', async () => {
    const uuid = await createWall();
    await expect(save(uuid, STRANGER, { enabled: true })).rejects.toMatchObject({
      extensions: { code: 'SPRAY_WALL_NOT_FOUND' },
    });
  });

  it('refuses a signed-out caller', async () => {
    const uuid = await createWall();
    await expect(save(uuid, null, { enabled: true })).rejects.toThrow(/auth/i);
  });

  it.each([
    'http://8.8.8.8',
    'http://example.com',
    'http://user:pw@wled.local',
    'http://wled.local?x=1',
    'http://wled.local#x',
    'http://[2001:db8::1]',
  ])('refuses the address %s and writes nothing', async (controllerUrl) => {
    const uuid = await createWall();
    await expect(save(uuid, OWNER, { controllerUrl })).rejects.toThrow(/controllerUrl/);
    await expect(read(uuid, OWNER)).resolves.toEqual({ viewerCanEdit: true, setup: null });
  });

  it('accepts clearing the address', async () => {
    const uuid = await createWall();
    await save(uuid, OWNER, { controllerUrl: 'http://wled.local' });
    await save(uuid, OWNER, { controllerUrl: '' });
    expect((await read(uuid, OWNER))?.setup?.controllerUrl).toBe('');
  });

  it('refuses a layout over the byte limit, and an invalid one', async () => {
    const uuid = await createWall();
    const oversized = layout({ photoKey: 'x'.repeat(MAX_TNUT_LAYOUT_BYTES) });
    await expect(save(uuid, OWNER, { layout: oversized })).rejects.toThrow(/too large/);

    const overHoleCap = layout({ holes: Array.from({ length: 3001 }, () => ({ x: 0.5, y: 0.5 })) });
    await expect(save(uuid, OWNER, { layout: overHoleCap })).rejects.toThrow(/valid/);
    await expect(save(uuid, OWNER, { layout: { version: 2 } })).rejects.toThrow(/valid/);
    await expect(read(uuid, OWNER)).resolves.toEqual({ viewerCanEdit: true, setup: null });
  });

  it('refuses a save with nothing in it', async () => {
    const uuid = await createWall();
    await expect(save(uuid, OWNER, {})).rejects.toThrow(/Nothing to save/);
  });

  it('refuses an archived wall, and tells its owner they can no longer change it', async () => {
    const uuid = await createWall();
    await db.update(sprayWalls).set({ archivedAt: new Date() }).where(eq(sprayWalls.boardUuid, uuid));
    await expect(save(uuid, OWNER, { enabled: true })).rejects.toThrow(sprayWallArchivedError().message);
    expect((await read(uuid, OWNER))?.viewerCanEdit).toBe(false);
  });

  it('goes away with the board', async () => {
    const uuid = await createWall();
    await save(uuid, OWNER, { enabled: true });
    // `spray_walls.board_uuid` restricts a board delete, so the wall row goes first.
    await db.delete(sprayWalls).where(eq(sprayWalls.boardUuid, uuid));
    await db.delete(userBoards).where(eq(userBoards.uuid, uuid));
    await expect(db.select().from(sprayWallLedSetups)).resolves.toEqual([]);
  });

  it('reads as nothing once the wall is deleted', async () => {
    const uuid = await createWall();
    await save(uuid, OWNER, { enabled: true });
    await socialBoardMutations.deleteBoard({}, { boardUuid: uuid }, ctxFor(OWNER));
    await expect(read(uuid, OWNER)).resolves.toBeNull();
  });

  it('honours a private resource policy over a public flag', async () => {
    const uuid = await createWall();
    await makePublic(uuid);
    await db.insert(resourcePrivacy).values({ kind: 'board', resourceId: uuid, audience: 'only_me' });
    await save(uuid, OWNER, { enabled: true });
    await expect(read(uuid, STRANGER)).resolves.toBeNull();
  });
});
