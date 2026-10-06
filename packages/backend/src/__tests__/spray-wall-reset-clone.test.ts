import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';

/**
 * Archive and reset, end to end against the real database
 * (docs/spray-walls.md, "Archive and reset").
 *
 * `resetSprayWall` clones a published wall's settings into a new, unfinished
 * wall. The clone's first publish archives the old wall and carries its follows
 * and pins over. An archived wall is read-only for climbs and holds, leaves every
 * picker, and stays readable everywhere else.
 *
 * Storage is the only stub, as in `spray-wall-api.test.ts`.
 */

const { storedPhotoMetadata } = vi.hoisted(() => ({
  storedPhotoMetadata: new Map<string, { width: string; height: string }>(),
}));

vi.mock('../storage/s3', () => ({
  isS3Configured: vi.fn(() => true),
  presignGetObject: vi.fn(async (_bucket: string, key: string) => ({
    url: `https://private.example/${key}?X-Amz-Signature=stub`,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  })),
  getS3ObjectMetadata: vi.fn(async (_bucket: string, key: string) => {
    const metadata = storedPhotoMetadata.get(key);
    return metadata ? { contentType: 'image/jpeg', contentLength: 1024, lastModified: new Date(), metadata } : null;
  }),
  getS3ObjectMetadataStrict: vi.fn(async (_bucket: string, key: string) => {
    const metadata = storedPhotoMetadata.get(key);
    return metadata ? { contentType: 'image/jpeg', contentLength: 1024, lastModified: new Date(), metadata } : null;
  }),
  uploadToS3: vi.fn(async (_bucket: string, _body: Buffer, key: string) => ({ key })),
  copyObjectBetweenBuckets: vi.fn(
    async (_source: string, sourceKey: string, _destination: string, destinationKey: string) =>
      storedPhotoMetadata.has(sourceKey) ? { key: destinationKey } : null,
  ),
  deleteFromS3: vi.fn(async () => undefined),
  getPublicUrl: vi.fn((_bucket: string, key: string) => `https://media.example/${key}`),
}));

vi.mock('../events', () => ({
  publishSocialEvent: vi.fn(async () => undefined),
}));

vi.mock('../lib/web-revalidate', () => ({
  notifyClimbRevalidated: vi.fn(async () => undefined),
}));

vi.mock('../utils/rate-limiter', () => ({
  checkRateLimit: vi.fn(),
  resetAllRateLimits: vi.fn(),
}));

vi.mock('../utils/redis-rate-limiter', () => ({
  checkRateLimitRedis: vi.fn().mockResolvedValue(undefined),
}));

const { db } = await import('../db/client');
const { sprayWallQueries, sprayWallMutations } = await import('../graphql/resolvers/board/spray-walls');
const { climbMutations } = await import('../graphql/resolvers/climbs/mutations');
const { tickMutations } = await import('../graphql/resolvers/ticks/mutations');
const { socialBoardQueries, socialBoardMutations } = await import('../graphql/resolvers/social/boards');
const { sprayWallPhotoKey } = await import('../handlers/spray-wall-photos');
const { MAX_ARCHIVED_SPRAY_WALLS_PER_USER } = await import('@boardsesh/board-config');

const OWNER = 'reset-owner';
const STRANGER = 'reset-stranger';
const GYM_ADMIN = 'reset-gym-admin';
const ALL_USERS = [OWNER, STRANGER, GYM_ADMIN];

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

type WallPayload = {
  uuid: string;
  layoutId: number;
  holdCount: number;
  currentVersion: { id: string } | null;
  versions: Array<{ id: string }>;
  archivedAt: string | null;
  resetOfWallUuid: string | null;
  replacedByWallUuid: string | null;
  holdsLocked: boolean;
  viewerCanEditClimbs: boolean;
};

function registerUploadedPhoto(wallUuid: string): string {
  const photoId = uuidv4();
  storedPhotoMetadata.set(sprayWallPhotoKey(wallUuid, photoId), { width: '1200', height: '900' });
  return photoId;
}

async function createWall(owner: string, overrides: Record<string, unknown> = {}): Promise<WallPayload> {
  return (await sprayWallMutations.createSprayWall(
    {},
    { input: { name: `Wall ${uuidv4().slice(0, 6)}`, angle: 40, ...overrides } },
    ctxFor(owner),
  )) as WallPayload;
}

/** Photo, draft, three holds, publish: the wizard's first publish of any wall. */
async function publishFirstVersion(wallUuid: string, owner: string): Promise<number[]> {
  const version = (await sprayWallMutations.createSprayWallVersion(
    {},
    { input: { wallUuid, photoId: registerUploadedPhoto(wallUuid), anchors: ANCHORS } },
    ctxFor(owner),
  )) as { id: string };
  const holds = (await sprayWallMutations.upsertSprayWallHolds(
    {},
    {
      input: {
        wallUuid,
        versionId: version.id,
        holds: [
          { cx: 100, cy: 120, r: 24 },
          { cx: 300, cy: 400, r: 30 },
          { cx: 520, cy: 560, r: 18 },
        ],
      },
    },
    ctxFor(owner),
  )) as Array<{ id: number }>;
  await sprayWallMutations.publishSprayWallVersion({}, { input: { versionId: version.id } }, ctxFor(owner));
  return holds.map((hold) => hold.id);
}

async function createPublishedWall(
  owner: string,
  overrides: Record<string, unknown> = {},
): Promise<{ wall: WallPayload; holdIds: number[] }> {
  const wall = await createWall(owner, overrides);
  const holdIds = await publishFirstVersion(wall.uuid, owner);
  return { wall, holdIds };
}

const resetWall = (wallUuid: string, userId: string) =>
  sprayWallMutations.resetSprayWall({}, { input: { wallUuid } }, ctxFor(userId)) as Promise<WallPayload>;

const readWall = (wallUuid: string, userId: string | null) =>
  sprayWallQueries.sprayWall({}, { uuid: wallUuid }, ctxFor(userId)) as Promise<WallPayload | null>;

function framesFor(holdIds: number[]): string {
  return holdIds.map((holdId, index) => `p${holdId}r${[1, 2, 3][index] ?? 2}`).join('');
}

function saveClimbOn(wall: WallPayload, holdIds: number[], isDraft = false) {
  return climbMutations.saveClimb(
    {},
    {
      input: {
        boardType: 'spray',
        layoutId: wall.layoutId,
        name: `Problem ${uuidv4().slice(0, 6)}`,
        isDraft,
        frames: framesFor(holdIds),
        angle: 40,
        userGrade: '6b/V4',
      },
    },
    ctxFor(OWNER),
  ) as Promise<{ uuid: string }>;
}

async function wallRow(wallUuid: string) {
  const [row] = (await db.execute(sql`
    SELECT sw.id, sw.archived_at, sw.reset_from_wall_id, sw.current_version_id, sw.hold_count,
           sw.pending_is_public, sw.pending_is_unlisted, sw.render_settings, sw.climb_edit_policy,
           ub.name, ub.slug, ub.description, ub.angle, ub.gym_id, ub.location_name, ub.latitude, ub.longitude,
           ub.hide_location, ub.is_public, ub.is_unlisted
    FROM spray_walls sw JOIN user_boards ub ON ub.uuid = sw.board_uuid
    WHERE sw.board_uuid = ${wallUuid}
  `)) as unknown as Array<Record<string, unknown>>;
  return row;
}

async function gymWith(member: string, role: 'admin' | 'member'): Promise<{ uuid: string; id: number }> {
  const gymUuid = uuidv4();
  await db.execute(sql`
    INSERT INTO gyms (uuid, name, slug, owner_id, is_public, created_at, updated_at)
    VALUES (${gymUuid}, 'Reset Gym', ${gymUuid}, ${OWNER}, true, now(), now())
  `);
  const [gym] = (await db.execute(sql`SELECT id FROM gyms WHERE uuid = ${gymUuid}`)) as unknown as Array<{
    id: number;
  }>;
  await db.execute(sql`
    INSERT INTO gym_members (gym_id, user_id, role, created_at)
    VALUES (${gym.id}, ${member}, ${role}, now())
  `);
  return { uuid: gymUuid, id: Number(gym.id) };
}

/** A reset carried all the way through: the clone is published, the source archived. */
async function archivedWallWithClimb(overrides: Record<string, unknown> = {}) {
  const { wall: source, holdIds } = await createPublishedWall(OWNER, overrides);
  const climb = await saveClimbOn(source, holdIds);
  const draftClimb = await saveClimbOn(source, holdIds.slice(0, 2), true);
  const clone = await resetWall(source.uuid, OWNER);
  await publishFirstVersion(clone.uuid, OWNER);
  return { source, holdIds, climb, draftClimb, clone };
}

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE TABLE "spray_walls", "user_boards", "gym_members", "gyms",
                   "board_climbs", "board_climb_holds", "board_climb_stats",
                   "board_layouts", "board_product_sizes", "board_product_sizes_layouts_sets",
                   "board_holes", "board_placements", "board_difficulty_grades",
                   "boardsesh_ticks", "feed_items"
    RESTART IDENTITY CASCADE
  `);
  await db.execute(sql`ALTER SEQUENCE spray_wall_catalog_id_seq RESTART WITH 1`);
  await db.execute(sql`ALTER SEQUENCE spray_hold_catalog_id_seq RESTART WITH 1`);
  await Promise.all(
    ALL_USERS.map((id) =>
      db.execute(sql`
        INSERT INTO "users" (id, email, name, created_at, updated_at)
        VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
        ON CONFLICT (id) DO NOTHING
      `),
    ),
  );
  await db.execute(sql`
    INSERT INTO board_difficulty_grades (board_type, difficulty, boulder_name, route_name, is_listed)
    VALUES ('spray', 18, '6b/V4', '7a/5.11d', true)
    ON CONFLICT (board_type, difficulty) DO NOTHING
  `);
  storedPhotoMetadata.clear();
});

describe('resetSprayWall: who and what', () => {
  it('is the owner’s alone: a gym admin is refused by name, a stranger cannot see a private wall', async () => {
    const gym = await gymWith(GYM_ADMIN, 'admin');
    const { wall } = await createPublishedWall(OWNER);
    await db.execute(sql`UPDATE user_boards SET gym_id = ${gym.id} WHERE uuid = ${wall.uuid}`);

    await expect(resetWall(wall.uuid, GYM_ADMIN)).rejects.toMatchObject({
      extensions: { code: 'SPRAY_WALL_RESET_OWNER_ONLY' },
    });
    await expect(resetWall(wall.uuid, STRANGER)).rejects.toMatchObject({
      extensions: { code: 'SPRAY_WALL_NOT_FOUND' },
    });

    const { wall: publicWall } = await createPublishedWall(OWNER, { isPublic: true });
    await expect(resetWall(publicWall.uuid, STRANGER)).rejects.toMatchObject({
      extensions: { code: 'SPRAY_WALL_RESET_OWNER_ONLY' },
    });
  });

  it('refuses an unpublished, an archived or a deleted wall', async () => {
    const unpublished = await createWall(OWNER);
    await expect(resetWall(unpublished.uuid, OWNER)).rejects.toMatchObject({
      extensions: { code: 'SPRAY_WALL_RESET_SOURCE_UNPUBLISHED' },
    });

    const { source } = await archivedWallWithClimb();
    await expect(resetWall(source.uuid, OWNER)).rejects.toMatchObject({
      extensions: { code: 'SPRAY_WALL_ARCHIVED' },
    });

    const { wall: deleted } = await createPublishedWall(OWNER);
    await sprayWallMutations.deleteSprayWall({}, { uuid: deleted.uuid }, ctxFor(OWNER));
    await expect(resetWall(deleted.uuid, OWNER)).rejects.toMatchObject({
      extensions: { code: 'SPRAY_WALL_NOT_FOUND' },
    });
  });

  it('returns the same unfinished clone when called again', async () => {
    const { wall } = await createPublishedWall(OWNER);
    const first = await resetWall(wall.uuid, OWNER);
    const second = await resetWall(wall.uuid, OWNER);
    expect(second.uuid).toBe(first.uuid);

    const clones = (await db.execute(sql`
      SELECT count(*)::int AS clones FROM spray_walls
      WHERE reset_from_wall_id = (SELECT id FROM spray_walls WHERE board_uuid = ${wall.uuid})
    `)) as unknown as Array<{ clones: number }>;
    expect(clones[0].clones).toBe(1);
  });

  it('copies the settings and nothing else', async () => {
    const gym = await gymWith(GYM_ADMIN, 'member');
    const { wall } = await createPublishedWall(OWNER, {
      name: 'Garage 45',
      description: 'The one by the bins',
      locationName: 'Home',
      latitude: 51.5,
      longitude: -0.12,
      hideLocation: true,
      isUnlisted: true,
      climbEditPolicy: 'COLLABORATORS',
    });
    await db.execute(sql`UPDATE user_boards SET gym_id = ${gym.id} WHERE uuid = ${wall.uuid}`);
    await db.execute(sql`
      UPDATE spray_walls SET render_settings = '{"mode":"classic","boardsesh":{}}'::jsonb
      WHERE board_uuid = ${wall.uuid}
    `);

    const clone = await resetWall(wall.uuid, OWNER);
    const source = await wallRow(wall.uuid);
    const copied = await wallRow(clone.uuid);

    for (const column of [
      'name',
      'description',
      'angle',
      'gym_id',
      'location_name',
      'latitude',
      'longitude',
      'hide_location',
      'render_settings',
      'climb_edit_policy',
    ]) {
      expect(copied[column], column).toEqual(source[column]);
    }
    expect(copied.slug).not.toBe(source.slug);
    expect(copied.reset_from_wall_id).toBe(source.id);
    expect(copied.archived_at).toBeNull();
    // The audience is parked until the first publish, like any new wall.
    expect(copied.is_unlisted).toBe(false);
    expect(copied.pending_is_unlisted).toBe(true);
    expect(copied.pending_is_public).toBe(false);

    // No photo, no versions, no holds.
    expect(copied.current_version_id).toBeNull();
    expect(copied.hold_count).toBe(0);
    expect(clone.currentVersion).toBeNull();
    expect(clone.versions).toEqual([]);
    expect(clone.resetOfWallUuid).toBe(wall.uuid);
    const holds = (await db.execute(sql`
      SELECT count(*)::int AS holds FROM spray_wall_holds WHERE wall_id = ${copied.id}
    `)) as unknown as Array<{ holds: number }>;
    expect(holds[0].holds).toBe(0);
  });

  it('refuses a reset past the archived-wall cap, counting unfinished clones', async () => {
    const { wall } = await createPublishedWall(OWNER);
    // Stand-ins for walls already archived: archived walls do not count toward
    // the live cap, so creating and archiving them one at a time stays legal.
    for (let index = 0; index < MAX_ARCHIVED_SPRAY_WALLS_PER_USER - 1; index++) {
      const filler = await createWall(OWNER);
      await db.execute(sql`UPDATE spray_walls SET archived_at = now() WHERE board_uuid = ${filler.uuid}`);
    }
    // 49 archived plus this unfinished clone is 50.
    await resetWall(wall.uuid, OWNER);

    const { wall: another } = await createPublishedWall(OWNER);
    await expect(resetWall(another.uuid, OWNER)).rejects.toMatchObject({
      extensions: { code: 'SPRAY_WALL_ARCHIVE_LIMIT_REACHED' },
    });
  });
});

describe('the clone’s first publish', () => {
  it('archives the old wall and carries its follows and pins over', async () => {
    const { wall: source } = await createPublishedWall(OWNER, { isPublic: true });
    await socialBoardMutations.followBoard({}, { input: { boardUuid: source.uuid } }, ctxFor(STRANGER));
    await socialBoardMutations.pinBoard({}, { input: { boardUuid: source.uuid } }, ctxFor(STRANGER));
    await socialBoardMutations.pinBoard({}, { input: { boardUuid: source.uuid } }, ctxFor(OWNER));

    const clone = await resetWall(source.uuid, OWNER);
    // The owner opening the clone in the wizard writes an unpinned activity row;
    // the pin still has to land on it.
    await socialBoardMutations.recordBoardOpened({}, { input: { boardUuid: clone.uuid } }, ctxFor(OWNER));
    expect((await wallRow(source.uuid)).archived_at).toBeNull();

    await publishFirstVersion(clone.uuid, OWNER);

    expect((await wallRow(source.uuid)).archived_at).not.toBeNull();
    expect((await wallRow(clone.uuid)).is_public).toBe(true);

    const follows = (await db.execute(sql`
      SELECT user_id FROM board_follows WHERE board_uuid = ${clone.uuid}
    `)) as unknown as Array<{ user_id: string }>;
    expect(follows.map((row) => row.user_id)).toEqual([STRANGER]);
    const pins = (await db.execute(sql`
      SELECT user_id FROM user_board_activity WHERE board_uuid = ${clone.uuid} AND pinned_at IS NOT NULL
      ORDER BY user_id
    `)) as unknown as Array<{ user_id: string }>;
    expect(pins.map((row) => row.user_id).sort()).toEqual([OWNER, STRANGER].sort());

    const archived = await readWall(source.uuid, OWNER);
    expect(archived?.archivedAt).not.toBeNull();
    expect(archived?.replacedByWallUuid).toBe(clone.uuid);
    expect(archived?.holdsLocked).toBe(true);
  });

  it('leaves the old wall live and listable when the clone is abandoned', async () => {
    const { wall: source } = await createPublishedWall(OWNER);
    const clone = await resetWall(source.uuid, OWNER);

    expect((await wallRow(source.uuid)).archived_at).toBeNull();
    const mine = (await socialBoardQueries.myBoards({}, { input: { limit: 50, offset: 0 } }, ctxFor(OWNER))) as {
      boards: Array<{ uuid: string }>;
    };
    expect(mine.boards.map((board) => board.uuid)).toContain(source.uuid);
    expect(mine.boards.map((board) => board.uuid)).not.toContain(clone.uuid);

    const read = await readWall(source.uuid, OWNER);
    expect(read?.archivedAt).toBeNull();
    expect(read?.replacedByWallUuid).toBeNull();
  });

  it('leaves the old wall live when the unfinished clone is deleted, and a new reset starts fresh', async () => {
    const { wall: source } = await createPublishedWall(OWNER);
    const clone = await resetWall(source.uuid, OWNER);
    await sprayWallMutations.deleteSprayWall({}, { uuid: clone.uuid }, ctxFor(OWNER));

    expect((await wallRow(source.uuid)).archived_at).toBeNull();
    const again = await resetWall(source.uuid, OWNER);
    expect(again.uuid).not.toBe(clone.uuid);
  });
});

describe('an archived wall is read-only', () => {
  it('refuses new and edited climbs, but still takes ticks and draft deletes', async () => {
    const { source, holdIds, climb, draftClimb } = await archivedWallWithClimb();
    const archivedCode = { extensions: { code: 'SPRAY_WALL_ARCHIVED' } };

    await expect(saveClimbOn(source, holdIds)).rejects.toMatchObject(archivedCode);
    await expect(
      climbMutations.updateClimb(
        {},
        { input: { uuid: climb.uuid, boardType: 'spray', name: 'Renamed' } },
        ctxFor(OWNER),
      ),
    ).rejects.toMatchObject(archivedCode);
    await expect(
      climbMutations.updateClimb(
        {},
        { input: { uuid: draftClimb.uuid, boardType: 'spray', isDraft: false, userGrade: '6b/V4' } },
        ctxFor(OWNER),
      ),
    ).rejects.toMatchObject(archivedCode);

    await expect(
      tickMutations.saveTick(
        {},
        {
          input: {
            climbUuid: climb.uuid,
            boardType: 'spray',
            angle: 40,
            status: 'send',
            attemptCount: 1,
            isMirror: false,
            isBenchmark: false,
            comment: '',
            climbedAt: new Date().toISOString(),
          },
        },
        ctxFor(OWNER),
      ),
    ).resolves.toBeTruthy();
    await expect(
      climbMutations.deleteDraftClimb({}, { uuid: draftClimb.uuid, boardType: 'spray' }, ctxFor(OWNER)),
    ).resolves.toBe(true);
  });

  it('refuses every hold and version writer, but a draft can still be discarded', async () => {
    const { wall: source, holdIds } = await createPublishedWall(OWNER);
    const published = await readWall(source.uuid, OWNER);
    // A hold-edit draft opened before the reset, so there is something to write to.
    const draft = (await sprayWallMutations.createSprayWallVersion(
      {},
      { input: { wallUuid: source.uuid, sourceVersionId: published?.currentVersion?.id } },
      ctxFor(OWNER),
    )) as { id: string };
    const clone = await resetWall(source.uuid, OWNER);
    await publishFirstVersion(clone.uuid, OWNER);
    const archivedCode = { extensions: { code: 'SPRAY_WALL_ARCHIVED' } };

    await expect(
      sprayWallMutations.upsertSprayWallHolds(
        {},
        { input: { wallUuid: source.uuid, versionId: draft.id, holds: [{ cx: 400, cy: 300, r: 20 }] } },
        ctxFor(OWNER),
      ),
    ).rejects.toMatchObject(archivedCode);
    await expect(
      sprayWallMutations.removeSprayWallHolds(
        {},
        { input: { wallUuid: source.uuid, versionId: draft.id, holdIds: [holdIds[0]] } },
        ctxFor(OWNER),
      ),
    ).rejects.toMatchObject(archivedCode);
    await expect(
      sprayWallMutations.commitSprayWallVersion(
        {},
        { input: { wallUuid: source.uuid, versionId: draft.id, kept: [], removed: [], added: [] } },
        ctxFor(OWNER),
      ),
    ).rejects.toMatchObject(archivedCode);
    await expect(
      sprayWallMutations.publishSprayWallVersion({}, { input: { versionId: draft.id } }, ctxFor(OWNER)),
    ).rejects.toMatchObject(archivedCode);

    await expect(
      sprayWallMutations.discardSprayWallVersion({}, { input: { versionId: draft.id } }, ctxFor(OWNER)),
    ).resolves.toBe(true);
    await expect(
      sprayWallMutations.createSprayWallVersion(
        {},
        { input: { wallUuid: source.uuid, photoId: registerUploadedPhoto(source.uuid), anchors: ANCHORS } },
        ctxFor(OWNER),
      ),
    ).rejects.toMatchObject(archivedCode);

    // Renaming is not a change to what the wall is.
    await expect(
      sprayWallMutations.updateSprayWall({}, { input: { uuid: source.uuid, name: 'Old garage' } }, ctxFor(OWNER)),
    ).resolves.toMatchObject({ uuid: source.uuid });
  });

  it('offers nobody a climb edit', async () => {
    const { source } = await archivedWallWithClimb({ climbEditPolicy: 'COLLABORATORS' });
    expect((await readWall(source.uuid, OWNER))?.viewerCanEditClimbs).toBe(false);
  });
});

describe('where an archived wall shows up', () => {
  it('leaves myBoards, searchBoards and both gym listings, the owner’s included', async () => {
    const gym = await gymWith(GYM_ADMIN, 'member');
    const { wall: source } = await createPublishedWall(OWNER, { isPublic: true, name: 'Archived crag' });
    await db.execute(sql`UPDATE user_boards SET gym_id = ${gym.id} WHERE uuid = ${source.uuid}`);
    const clone = await resetWall(source.uuid, OWNER);
    await publishFirstVersion(clone.uuid, OWNER);

    for (const userId of [OWNER, STRANGER]) {
      const searched = (await socialBoardQueries.searchBoards(
        {},
        { input: { query: 'Archived crag', limit: 20, offset: 0 } },
        ctxFor(userId),
      )) as { boards: Array<{ uuid: string }>; totalCount: number };
      expect(searched.boards.map((board) => board.uuid)).toEqual([clone.uuid]);
      expect(searched.totalCount).toBe(1);

      const gymBoards = (await socialBoardQueries.gymBoards({}, { gymUuid: gym.uuid }, ctxFor(userId))) as Array<{
        uuid: string;
      }>;
      expect(gymBoards.map((board) => board.uuid)).toEqual([clone.uuid]);

      const gymWalls = (await sprayWallQueries.gymSprayWalls({}, { gymUuid: gym.uuid }, ctxFor(userId))) as Array<{
        uuid: string;
      }>;
      expect(gymWalls.map((wall) => wall.uuid)).toEqual([clone.uuid]);
    }

    const mine = (await socialBoardQueries.myBoards({}, { input: { limit: 50, offset: 0 } }, ctxFor(OWNER))) as {
      boards: Array<{ uuid: string }>;
      totalCount: number;
    };
    expect(mine.boards.map((board) => board.uuid)).toEqual([clone.uuid]);
    expect(mine.totalCount).toBe(1);
  });

  it('is still returned by sprayWall and mySprayWalls, with its archive fields', async () => {
    const { source, clone } = await archivedWallWithClimb();

    const read = await readWall(source.uuid, OWNER);
    expect(read?.archivedAt).toEqual(expect.any(String));
    expect(read?.replacedByWallUuid).toBe(clone.uuid);

    const mine = (await sprayWallQueries.mySprayWalls({}, {}, ctxFor(OWNER))) as WallPayload[];
    const byUuid = new Map(mine.map((wall) => [wall.uuid, wall]));
    expect(byUuid.get(source.uuid)?.archivedAt).toEqual(expect.any(String));
    expect(byUuid.get(source.uuid)?.replacedByWallUuid).toBe(clone.uuid);
    expect(byUuid.get(source.uuid)?.holdsLocked).toBe(true);
    expect(byUuid.get(clone.uuid)?.archivedAt).toBeNull();
    expect(byUuid.get(clone.uuid)?.resetOfWallUuid).toBe(source.uuid);
    expect(byUuid.get(clone.uuid)?.holdsLocked).toBe(false);
  });
});

describe('the archive fields', () => {
  it('holdsLocked is true with a published climb and false with only a draft', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);
    expect((await readWall(wall.uuid, OWNER))?.holdsLocked).toBe(false);

    await saveClimbOn(wall, holdIds, true);
    expect((await readWall(wall.uuid, OWNER))?.holdsLocked).toBe(false);

    await saveClimbOn(wall, holdIds);
    expect((await readWall(wall.uuid, OWNER))?.holdsLocked).toBe(true);
  });

  it('replacedByWallUuid is hidden from a viewer who cannot see the successor', async () => {
    const { wall: source } = await createPublishedWall(OWNER, { isPublic: true });
    const clone = await resetWall(source.uuid, OWNER);
    // The owner keeps the new wall to themselves.
    await sprayWallMutations.updateSprayWall({}, { input: { uuid: clone.uuid, isPublic: false } }, ctxFor(OWNER));
    await publishFirstVersion(clone.uuid, OWNER);

    expect((await readWall(source.uuid, STRANGER))?.replacedByWallUuid).toBeNull();
    expect((await readWall(source.uuid, null))?.replacedByWallUuid).toBeNull();
    expect((await readWall(source.uuid, OWNER))?.replacedByWallUuid).toBe(clone.uuid);
  });

  it('carries an unlisted share link forward to an unlisted successor', async () => {
    const { wall: source } = await createPublishedWall(OWNER, { isUnlisted: true });
    const clone = await resetWall(source.uuid, OWNER);
    await publishFirstVersion(clone.uuid, OWNER);

    // The crew opened the old wall by its link; the new one is unlisted too.
    const viaLink = await readWall(source.uuid, STRANGER);
    expect(viaLink?.replacedByWallUuid).toBe(clone.uuid);
    expect((await readWall(clone.uuid, STRANGER))?.resetOfWallUuid).toBe(source.uuid);
  });
});
