import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';

/**
 * Reporting a wall, hiding it, and clearing the photographs of a deleted one
 * (SW-17, epic #5346).
 *
 * Three things are worth a test here, and they are the three that could hurt
 * somebody:
 *
 *  - **The hidden gate.** A hidden wall has to read exactly like a private one
 *    for everybody but its owner. Not "mostly": the by-uuid read, the by-layout
 *    read and the climb-visibility predicate are three separate implementations
 *    of one rule, and each is asserted separately — an owner still sees their
 *    wall and its climbs, a stranger who had the uuid gets nothing.
 *  - **The retention threshold.** A wall deleted 31 days ago loses its photos; a
 *    wall deleted yesterday keeps them. Driven with an injected clock rather
 *    than a real 30-day wait, and asserted on BOTH sides, because a purge that
 *    fires early deletes photographs nobody agreed to lose.
 *  - **Reporting.** Any signed-in climber who can see a wall, once — a second
 *    report is the same report, and a wall a viewer cannot see is "not found",
 *    not a different error, so a report is never an oracle for which uuids exist.
 *
 * Storage is the only stub: there is no R2 in CI, so the object listing and
 * delete are scripted and everything else is real rows.
 */

const { presignedUrls, storedPhotoMetadata, storedObjects, deletedObjects } = vi.hoisted(() => ({
  presignedUrls: [] as string[],
  storedPhotoMetadata: new Map<string, { width: string; height: string }>(),
  storedObjects: new Map<string, Set<string>>(),
  deletedObjects: [] as Array<{ bucket: string; key: string }>,
}));

vi.mock('../storage/s3', () => ({
  isS3Configured: vi.fn(() => true),
  presignGetObject: vi.fn(async (_bucket: string, key: string) => {
    const url = `https://private.example/${key}?X-Amz-Signature=stub`;
    presignedUrls.push(url);
    return { url, expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() };
  }),
  getS3ObjectMetadata: vi.fn(async (_bucket: string, key: string) => {
    const metadata = storedPhotoMetadata.get(key);
    return metadata ? { contentType: 'image/jpeg', contentLength: 1024, lastModified: new Date(), metadata } : null;
  }),
  uploadToS3: vi.fn(async (_bucket: string, _body: Buffer, key: string) => ({ key })),
  listS3Objects: vi.fn(async (bucket: string, prefix: string) =>
    [...(storedObjects.get(bucket) ?? [])]
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ key, size: 1024, lastModified: new Date() })),
  ),
  deleteFromS3: vi.fn(async (bucket: string, key: string) => {
    storedObjects.get(bucket)?.delete(key);
    deletedObjects.push({ bucket, key });
  }),
}));

vi.mock('../events', () => ({ publishSocialEvent: vi.fn(async () => undefined) }));
vi.mock('../lib/web-revalidate', () => ({ notifyClimbRevalidated: vi.fn(async () => undefined) }));
vi.mock('../utils/rate-limiter', () => ({ checkRateLimit: vi.fn(), resetAllRateLimits: vi.fn() }));
vi.mock('../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: vi.fn().mockResolvedValue(undefined) }));

const { db } = await import('../db/client');
const { sprayWallQueries, sprayWallMutations } = await import('../graphql/resolvers/board/spray-walls');
const { sprayWallModerationMutations, sprayWallModerationQueries, purgeDeletedSprayWallPhotos } =
  await import('../graphql/resolvers/board/spray-wall-moderation');
const { climbMutations } = await import('../graphql/resolvers/climbs/mutations');
const { climbQueries } = await import('../graphql/resolvers/climbs/queries');
const { sprayWallPhotoKey } = await import('../handlers/spray-wall-photos');
const { SPRAY_WALL_PHOTO_RETENTION_DAYS } = await import('@boardsesh/board-config');

const OWNER = 'sw17-owner';
const STRANGER = 'sw17-stranger';
const ADMIN = 'sw17-admin';
const ALL_USERS = [OWNER, STRANGER, ADMIN];

const ANCHORS: [number, number][] = [
  [100, 80],
  [900, 120],
  [880, 700],
  [120, 660],
];

const ctxFor = (userId: string | null): ConnectionContext =>
  ({
    connectionId: `conn-${userId ?? 'anon'}`,
    isAuthenticated: userId != null,
    userId: userId ?? null,
  }) as unknown as ConnectionContext;

/** An HTTP context that has already cleared the cron secret, for the purge mutation. */
const cronCtx = (): ConnectionContext =>
  ({
    connectionId: 'conn-cron',
    isAuthenticated: false,
    userId: null,
    transport: 'http',
    isCronAuthenticated: true,
  }) as unknown as ConnectionContext;

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

function registerUploadedPhoto(wallUuid: string): string {
  const photoId = uuidv4();
  const key = sprayWallPhotoKey(wallUuid, photoId);
  storedPhotoMetadata.set(key, { width: '1200', height: '900' });
  for (const bucket of ['private', 'media']) {
    if (!storedObjects.has(bucket)) storedObjects.set(bucket, new Set());
  }
  storedObjects.get('private')!.add(key);
  // The thumbnail variant the photo handler writes alongside the base object.
  storedObjects.get('private')!.add(`${key}@280.jpg`);
  return photoId;
}

type CreatedWall = { uuid: string; layoutId: number };

async function createPublishedWall(overrides: Record<string, unknown> = {}) {
  const wall = (await sprayWallMutations.createSprayWall(
    {},
    { input: { name: `Wall ${uuidv4().slice(0, 6)}`, angle: 40, ...overrides } },
    ctxFor(OWNER),
  )) as CreatedWall;

  const photoId = registerUploadedPhoto(wall.uuid);
  const version = (await sprayWallMutations.createSprayWallVersion(
    {},
    { input: { wallUuid: wall.uuid, photoId, anchors: ANCHORS } },
    ctxFor(OWNER),
  )) as { id: string };

  const holds = (await sprayWallMutations.upsertSprayWallHolds(
    {},
    {
      input: {
        wallUuid: wall.uuid,
        versionId: version.id,
        holds: [
          { cx: 100, cy: 120, r: 24 },
          { cx: 300, cy: 400, r: 30 },
          { cx: 520, cy: 560, r: 18 },
        ],
      },
    },
    ctxFor(OWNER),
  )) as Array<{ id: number }>;

  await sprayWallMutations.publishSprayWallVersion({}, { input: { versionId: version.id } }, ctxFor(OWNER));
  return { wall, versionId: version.id, holdIds: holds.map((hold) => hold.id) };
}

async function setClimbOnWall(wall: CreatedWall, holdIds: number[]): Promise<string> {
  const frames = holdIds.map((holdId, index) => `p${holdId}r${[1, 2, 3][index] ?? 2}`).join('');
  const saved = (await climbMutations.saveClimb(
    {},
    {
      input: {
        boardType: 'spray',
        layoutId: wall.layoutId,
        name: 'Garage classic',
        isDraft: false,
        frames,
        angle: 40,
        userGrade: '6b/V4',
      },
    },
    ctxFor(OWNER),
  )) as { uuid: string };
  return saved.uuid;
}

/** Backdate a wall's soft delete so the retention threshold can be driven. */
async function deleteWallDaysAgo(wallUuid: string, days: number): Promise<void> {
  await sprayWallMutations.deleteSprayWall({}, { uuid: wallUuid }, ctxFor(OWNER));
  await db.execute(sql`
    UPDATE spray_walls SET deleted_at = now() - (${days} || ' days')::interval WHERE board_uuid = ${wallUuid}
  `);
}

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE TABLE "spray_walls", "user_boards", "gym_members", "gyms",
                   "board_climbs", "board_climb_holds", "board_climb_stats",
                   "board_layouts", "board_product_sizes", "board_product_sizes_layouts_sets",
                   "board_holes", "board_placements", "board_difficulty_grades",
                   "community_roles", "boardsesh_ticks", "feed_items"
    RESTART IDENTITY CASCADE
  `);
  await db.execute(sql`ALTER SEQUENCE spray_wall_catalog_id_seq RESTART WITH 1`);
  await db.execute(sql`ALTER SEQUENCE spray_hold_catalog_id_seq RESTART WITH 1`);

  await Promise.all(ALL_USERS.map(insertUser));
  await db.execute(sql`
    INSERT INTO community_roles (user_id, role, board_type, created_at)
    VALUES (${ADMIN}, 'admin', NULL, now())
  `);
  await db.execute(sql`
    INSERT INTO board_difficulty_grades (board_type, difficulty, boulder_name, route_name, is_listed)
    VALUES ('spray', 10, '4a/V0', '5b/5.9', true),
           ('spray', 18, '6b/V4', '7a/5.11d', true)
    ON CONFLICT (board_type, difficulty) DO NOTHING
  `);

  presignedUrls.length = 0;
  deletedObjects.length = 0;
  storedPhotoMetadata.clear();
  storedObjects.clear();

  const storage = await import('../storage/s3');
  vi.mocked(storage.isS3Configured).mockReset();
  vi.mocked(storage.isS3Configured).mockReturnValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('reporting a wall', () => {
  it('records one report per climber and answers the second the same way', async () => {
    const { wall } = await createPublishedWall({ isPublic: true });

    const first = await sprayWallModerationMutations.reportSprayWall(
      {},
      { input: { wallUuid: wall.uuid, reason: 'INAPPROPRIATE' } },
      ctxFor(STRANGER),
    );
    const second = await sprayWallModerationMutations.reportSprayWall(
      {},
      { input: { wallUuid: wall.uuid, reason: 'PERSONAL_INFO' } },
      ctxFor(STRANGER),
    );

    expect(first).toEqual({ status: 'CREATED' });
    expect(second).toEqual({ status: 'ALREADY_REPORTED' });

    const queue = (await sprayWallModerationQueries.sprayWallReports({}, { uuid: null }, ctxFor(ADMIN))) as Array<{
      wallUuid: string;
      reason: string;
      hidden: boolean;
    }>;
    expect(queue).toEqual([{ ...queue[0], wallUuid: wall.uuid, reason: 'INAPPROPRIATE', hidden: false }]);
  });

  it('reports a wall the viewer cannot see as not found, exactly like an unknown uuid', async () => {
    const { wall } = await createPublishedWall({ isPublic: false, isUnlisted: false });

    // Called inside the assertion, not hoisted into a pair of variables: a
    // rejected promise nobody is awaiting yet is an unhandled rejection, and
    // Vitest fails the RUN on one even when every test passed.
    await expect(
      sprayWallModerationMutations.reportSprayWall(
        {},
        { input: { wallUuid: wall.uuid, reason: 'OTHER' } },
        ctxFor(STRANGER),
      ),
    ).rejects.toThrow('Spray wall not found');
    await expect(
      sprayWallModerationMutations.reportSprayWall(
        {},
        { input: { wallUuid: uuidv4(), reason: 'OTHER' } },
        ctxFor(STRANGER),
      ),
    ).rejects.toThrow('Spray wall not found');
  });

  it('refuses the admin switch to a climber who is not an admin', async () => {
    const { wall } = await createPublishedWall({ isPublic: true });
    await expect(
      sprayWallModerationMutations.setSprayWallHidden({}, { input: { uuid: wall.uuid, hidden: true } }, ctxFor(OWNER)),
    ).rejects.toThrow(/admin/i);
  });
});

describe('a hidden wall', () => {
  it('reads as private to a stranger and stays visible to its owner', async () => {
    const { wall, holdIds } = await createPublishedWall({ isPublic: true });
    const climbUuid = await setClimbOnWall(wall, holdIds);

    // Before: an ordinary public wall, visible to anybody.
    expect(await sprayWallQueries.sprayWall({}, { uuid: wall.uuid }, ctxFor(STRANGER))).not.toBeNull();

    await sprayWallModerationMutations.setSprayWallHidden(
      {},
      { input: { uuid: wall.uuid, hidden: true } },
      ctxFor(ADMIN),
    );

    // The stranger loses all three doors: the uuid read, the layout read, and the
    // climbs. Each is a separate implementation of the same rule.
    expect(await sprayWallQueries.sprayWall({}, { uuid: wall.uuid }, ctxFor(STRANGER))).toBeNull();
    expect(await sprayWallQueries.sprayWallByLayout({}, { layoutId: wall.layoutId }, ctxFor(STRANGER))).toBeNull();
    const climbArgs = {
      boardName: 'spray',
      layoutId: wall.layoutId,
      sizeId: wall.layoutId,
      setIds: '1',
      angle: 40,
      climbUuid,
    };
    expect(await climbQueries.climb({}, climbArgs, ctxFor(STRANGER))).toBeNull();

    // The owner keeps everything, and gets the notice the banner renders off.
    const owned = (await sprayWallQueries.sprayWall({}, { uuid: wall.uuid }, ctxFor(OWNER))) as {
      hiddenAt: string | null;
    } | null;
    expect(owned?.hiddenAt).toEqual(expect.any(String));
    expect(await climbQueries.climb({}, climbArgs, ctxFor(OWNER))).not.toBeNull();
  });

  it('comes back for everyone when the flag is cleared, and answers its reports either way', async () => {
    const { wall } = await createPublishedWall({ isPublic: true });
    await sprayWallModerationMutations.reportSprayWall(
      {},
      { input: { wallUuid: wall.uuid, reason: 'NOT_A_WALL' } },
      ctxFor(STRANGER),
    );

    await sprayWallModerationMutations.setSprayWallHidden(
      {},
      { input: { uuid: wall.uuid, hidden: true } },
      ctxFor(ADMIN),
    );
    // Acting on the wall clears the queue whichever way the admin went; leaving
    // the rows pending would put the wall back in front of the next admin forever.
    expect(await sprayWallModerationQueries.sprayWallReports({}, { uuid: null }, ctxFor(ADMIN))).toEqual([]);

    await sprayWallModerationMutations.setSprayWallHidden(
      {},
      { input: { uuid: wall.uuid, hidden: false } },
      ctxFor(ADMIN),
    );
    expect(await sprayWallQueries.sprayWall({}, { uuid: wall.uuid }, ctxFor(STRANGER))).not.toBeNull();
    const owned = (await sprayWallQueries.sprayWall({}, { uuid: wall.uuid }, ctxFor(OWNER))) as {
      hiddenAt: string | null;
    };
    expect(owned.hiddenAt).toBeNull();
  });

  it('stops honouring the share link an unlisted wall handed out', async () => {
    const { wall } = await createPublishedWall({ isPublic: false, isUnlisted: true });
    // The whole point of unlisted: the uuid IS the capability.
    expect(await sprayWallQueries.sprayWall({}, { uuid: wall.uuid }, ctxFor(STRANGER))).not.toBeNull();

    await sprayWallModerationMutations.setSprayWallHidden(
      {},
      { input: { uuid: wall.uuid, hidden: true } },
      ctxFor(ADMIN),
    );

    // Hiding has to take a wall off the internet, so it outranks the capability.
    expect(await sprayWallQueries.sprayWall({}, { uuid: wall.uuid }, ctxFor(STRANGER))).toBeNull();
  });
});

describe('the photo purge', () => {
  it('clears a wall deleted past the window and leaves one deleted yesterday alone', async () => {
    const stale = await createPublishedWall();
    const fresh = await createPublishedWall();
    await deleteWallDaysAgo(stale.wall.uuid, SPRAY_WALL_PHOTO_RETENTION_DAYS + 1);
    await deleteWallDaysAgo(fresh.wall.uuid, 1);

    const result = await purgeDeletedSprayWallPhotos({ now: new Date() });

    expect(result).toMatchObject({ wallsPurged: 1, wallsConsidered: 1 });
    expect(result.objectsDeleted).toBe(2);
    expect(deletedObjects.every((object) => object.key.startsWith(`spray-walls/${stale.wall.uuid}/`))).toBe(true);

    const keys = await db.execute<{ photo_key: string | null; board_uuid: string }>(sql`
      SELECT v.photo_key, w.board_uuid
      FROM spray_wall_versions v JOIN spray_walls w ON w.id = v.wall_id
    `);
    const byWall = new Map([...keys].map((row) => [row.board_uuid, row.photo_key]));
    expect(byWall.get(stale.wall.uuid)).toBeNull();
    expect(byWall.get(fresh.wall.uuid)).toEqual(expect.any(String));
  });

  it('does not fire one day early', async () => {
    const wall = await createPublishedWall();
    // One day inside the window. Asserted separately from the pair above so a
    // purge widened to 29 days reds here rather than passing on "31 > 30".
    await deleteWallDaysAgo(wall.wall.uuid, SPRAY_WALL_PHOTO_RETENTION_DAYS - 1);

    const result = await purgeDeletedSprayWallPhotos({ now: new Date() });

    expect(result).toMatchObject({ wallsPurged: 0, objectsDeleted: 0, wallsConsidered: 0 });
    expect(deletedObjects).toEqual([]);
  });

  it('leaves the wall, its holds and its climbs behind — only the photographs go', async () => {
    const { wall, holdIds } = await createPublishedWall();
    const climbUuid = await setClimbOnWall(wall, holdIds);
    await deleteWallDaysAgo(wall.uuid, SPRAY_WALL_PHOTO_RETENTION_DAYS + 5);

    await purgeDeletedSprayWallPhotos({ now: new Date() });

    const [counts] = [
      ...(await db.execute<{ walls: number; holds: number; climbs: number }>(sql`
        SELECT
          (SELECT count(*)::int FROM spray_walls WHERE board_uuid = ${wall.uuid}) AS walls,
          (SELECT count(*)::int FROM spray_wall_holds) AS holds,
          (SELECT count(*)::int FROM board_climbs WHERE uuid = ${climbUuid}) AS climbs
      `)),
    ];
    expect(counts).toEqual({ walls: 1, holds: holdIds.length, climbs: 1 });
  });

  it('does not re-list a wall it already cleared', async () => {
    const { wall } = await createPublishedWall();
    await deleteWallDaysAgo(wall.uuid, SPRAY_WALL_PHOTO_RETENTION_DAYS + 2);

    await purgeDeletedSprayWallPhotos({ now: new Date() });
    deletedObjects.length = 0;
    const second = await purgeDeletedSprayWallPhotos({ now: new Date() });

    // The row is never deleted, so a wall purged on an earlier run stays a
    // candidate forever; without the photo-key filter every run would re-list an
    // empty prefix for every wall ever deleted.
    expect(second).toMatchObject({ wallsPurged: 0, wallsConsidered: 0 });
    expect(deletedObjects).toEqual([]);
  });

  it('refuses the purge mutation without cron authentication', async () => {
    await expect(
      sprayWallModerationMutations.purgeDeletedSprayWallPhotos({}, { limit: null }, ctxFor(ADMIN)),
    ).rejects.toThrow('Cron authentication required');
    await expect(
      sprayWallModerationMutations.purgeDeletedSprayWallPhotos({}, { limit: null }, cronCtx()),
    ).resolves.toMatchObject({ wallsPurged: 0 });
  });
});
