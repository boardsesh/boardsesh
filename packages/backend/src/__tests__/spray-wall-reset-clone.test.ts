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
const { climbQueries } = await import('../graphql/resolvers/climbs/queries');
const { tickQueries } = await import('../graphql/resolvers/ticks/queries');
const { syncQueries } = await import('../graphql/resolvers/sync/queries');
const { assertBoardCapNotReached, MAX_BOARDS_PER_ACCOUNT } = await import('../graphql/resolvers/social/board-limits');
const { socialGymQueries } = await import('../graphql/resolvers/social/gyms');
const { socialGymKioskQueries, socialGymKioskMutations } = await import('../graphql/resolvers/social/gym-kiosks');
const { newClimbSubscriptionResolvers } = await import('../graphql/resolvers/social/new-climb-subscriptions');

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
                   "boardsesh_ticks", "feed_items", "new_climb_subscriptions"
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
    expect(byUuid.get(clone.uuid)?.archivedAt).toBeNull();
    expect(byUuid.get(clone.uuid)?.resetOfWallUuid).toBe(source.uuid);
  });
});

describe('the archive fields', () => {
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
    // Old to new only: the new wall's link does not hand out the old wall's.
    expect((await readWall(clone.uuid, STRANGER))?.resetOfWallUuid).toBeNull();
    expect((await readWall(clone.uuid, OWNER))?.resetOfWallUuid).toBe(source.uuid);
  });

  it('carries nobody forward from a public old wall to an unlisted successor', async () => {
    // Public AND unlisted is reachable through the API; its viewers needed no link.
    const { wall: source } = await createPublishedWall(OWNER, { isPublic: true, isUnlisted: true });
    const clone = await resetWall(source.uuid, OWNER);
    await sprayWallMutations.updateSprayWall(
      {},
      { input: { uuid: clone.uuid, isPublic: false, isUnlisted: true } },
      ctxFor(OWNER),
    );
    await publishFirstVersion(clone.uuid, OWNER);

    expect((await readWall(source.uuid, STRANGER))?.replacedByWallUuid).toBeNull();
    expect((await readWall(source.uuid, OWNER))?.replacedByWallUuid).toBe(clone.uuid);
  });
});

describe('the clone’s audience at first publish', () => {
  it('narrows to the old wall’s current audience when the owner narrowed it mid-reset', async () => {
    const { wall: source } = await createPublishedWall(OWNER, { isPublic: true });
    const clone = await resetWall(source.uuid, OWNER);
    // The owner makes the old wall private before finishing the new one.
    await sprayWallMutations.updateSprayWall({}, { input: { uuid: source.uuid, isPublic: false } }, ctxFor(OWNER));
    await publishFirstVersion(clone.uuid, OWNER);

    const published = await wallRow(clone.uuid);
    expect(published.is_public).toBe(false);
    expect(published.is_unlisted).toBe(false);
  });

  it('narrows public to unlisted, and never widens', async () => {
    const { wall: source } = await createPublishedWall(OWNER, { isPublic: true });
    const clone = await resetWall(source.uuid, OWNER);
    await sprayWallMutations.updateSprayWall(
      {},
      { input: { uuid: source.uuid, isPublic: false, isUnlisted: true } },
      ctxFor(OWNER),
    );
    await publishFirstVersion(clone.uuid, OWNER);
    const published = await wallRow(clone.uuid);
    expect(published.is_public).toBe(false);
    expect(published.is_unlisted).toBe(true);
  });

  it('applies the parked audience when the old wall is unchanged', async () => {
    const { wall: source } = await createPublishedWall(OWNER, { isPublic: true });
    const clone = await resetWall(source.uuid, OWNER);
    await publishFirstVersion(clone.uuid, OWNER);
    expect((await wallRow(clone.uuid)).is_public).toBe(true);
  });

  it('bounds the clone by a deleted old wall’s last flags, and archives nothing', async () => {
    const { wall: source } = await createPublishedWall(OWNER, { isPublic: true });
    const clone = await resetWall(source.uuid, OWNER);
    await sprayWallMutations.deleteSprayWall({}, { uuid: source.uuid }, ctxFor(OWNER));
    await publishFirstVersion(clone.uuid, OWNER);

    expect((await wallRow(clone.uuid)).is_public).toBe(true);
    const [deleted] = (await db.execute(sql`
      SELECT archived_at, deleted_at FROM spray_walls WHERE board_uuid = ${source.uuid}
    `)) as unknown as Array<{ archived_at: Date | null; deleted_at: Date | null }>;
    expect(deleted.deleted_at).not.toBeNull();
    expect(deleted.archived_at).toBeNull();
  });
});

describe('archive through commitSprayWallVersion', () => {
  it('archives the old wall when the clone’s first version lands as a commit', async () => {
    const { wall: source } = await createPublishedWall(OWNER);
    const clone = await resetWall(source.uuid, OWNER);
    const version = (await sprayWallMutations.createSprayWallVersion(
      {},
      { input: { wallUuid: clone.uuid, photoId: registerUploadedPhoto(clone.uuid) } },
      ctxFor(OWNER),
    )) as { id: string };
    await sprayWallMutations.commitSprayWallVersion(
      {},
      {
        input: {
          wallUuid: clone.uuid,
          versionId: version.id,
          kept: [],
          removed: [],
          added: [{ detection: { cx: 100, cy: 120, r: 24 } }],
        },
      },
      ctxFor(OWNER),
    );

    expect((await wallRow(source.uuid)).archived_at).not.toBeNull();
    expect((await readWall(source.uuid, OWNER))?.replacedByWallUuid).toBe(clone.uuid);
  });
});

describe('what carries over, and to whom', () => {
  it('carries no stranger follow, pin or subscription to a private successor', async () => {
    const { wall: source } = await createPublishedWall(OWNER, { isPublic: true });
    await socialBoardMutations.followBoard({}, { input: { boardUuid: source.uuid } }, ctxFor(STRANGER));
    await socialBoardMutations.pinBoard({}, { input: { boardUuid: source.uuid } }, ctxFor(STRANGER));
    await newClimbSubscriptionResolvers.Mutation.subscribeNewClimbs(
      {},
      { input: { boardType: 'spray', layoutId: source.layoutId } },
      ctxFor(STRANGER),
    );
    const clone = await resetWall(source.uuid, OWNER);
    await sprayWallMutations.updateSprayWall({}, { input: { uuid: clone.uuid, isPublic: false } }, ctxFor(OWNER));
    await publishFirstVersion(clone.uuid, OWNER);

    const carried = (await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM board_follows WHERE board_uuid = ${clone.uuid}) AS follows,
        (SELECT count(*)::int FROM user_board_activity
          WHERE board_uuid = ${clone.uuid} AND pinned_at IS NOT NULL) AS pins,
        (SELECT count(*)::int FROM new_climb_subscriptions
          WHERE board_type = 'spray' AND layout_id = ${clone.layoutId}) AS subscriptions
    `)) as unknown as Array<{ follows: number; pins: number; subscriptions: number }>;
    expect(carried[0]).toEqual({ follows: 0, pins: 0, subscriptions: 0 });
  });

  it('carries a new-climb subscription to a public successor', async () => {
    const { wall: source } = await createPublishedWall(OWNER, { isPublic: true });
    await newClimbSubscriptionResolvers.Mutation.subscribeNewClimbs(
      {},
      { input: { boardType: 'spray', layoutId: source.layoutId } },
      ctxFor(STRANGER),
    );
    const clone = await resetWall(source.uuid, OWNER);
    await publishFirstVersion(clone.uuid, OWNER);

    const subscribers = (await db.execute(sql`
      SELECT user_id FROM new_climb_subscriptions WHERE board_type = 'spray' AND layout_id = ${clone.layoutId}
    `)) as unknown as Array<{ user_id: string }>;
    expect(subscribers.map((row) => row.user_id)).toEqual([STRANGER]);
  });

  it('carries a gym member’s pin to a private gym successor', async () => {
    const gym = await gymWith(GYM_ADMIN, 'member');
    const { wall: source } = await createPublishedWall(OWNER);
    await db.execute(sql`UPDATE user_boards SET gym_id = ${gym.id} WHERE uuid = ${source.uuid}`);
    await socialBoardMutations.pinBoard({}, { input: { boardUuid: source.uuid } }, ctxFor(GYM_ADMIN));
    const clone = await resetWall(source.uuid, OWNER);
    await publishFirstVersion(clone.uuid, OWNER);

    const pins = (await db.execute(sql`
      SELECT user_id FROM user_board_activity WHERE board_uuid = ${clone.uuid} AND pinned_at IS NOT NULL
    `)) as unknown as Array<{ user_id: string }>;
    expect(pins.map((row) => row.user_id)).toEqual([GYM_ADMIN]);
  });

  it('carries nothing to a stranger when the successor is unlisted', async () => {
    const { wall: source } = await createPublishedWall(OWNER, { isUnlisted: true });
    await socialBoardMutations.pinBoard({}, { input: { boardUuid: source.uuid } }, ctxFor(STRANGER));
    const clone = await resetWall(source.uuid, OWNER);
    await publishFirstVersion(clone.uuid, OWNER);

    const pins = (await db.execute(sql`
      SELECT user_id FROM user_board_activity WHERE board_uuid = ${clone.uuid} AND pinned_at IS NOT NULL
    `)) as unknown as Array<{ user_id: string }>;
    expect(pins).toEqual([]);
  });
});

describe('after the archive', () => {
  it('keeps the old wall archived when the published successor is deleted', async () => {
    const { source, clone } = await archivedWallWithClimb();
    await sprayWallMutations.deleteSprayWall({}, { uuid: clone.uuid }, ctxFor(OWNER));

    expect((await wallRow(source.uuid)).archived_at).not.toBeNull();
    expect((await readWall(source.uuid, OWNER))?.replacedByWallUuid).toBeNull();
  });

  it('offers a collaborator no climb edit either', async () => {
    const { source } = await archivedWallWithClimb({ isPublic: true, climbEditPolicy: 'COLLABORATORS' });
    expect((await readWall(source.uuid, STRANGER))?.viewerCanEditClimbs).toBe(false);
  });

  it('still takes the writes that do not change what the wall is', async () => {
    const { source } = await archivedWallWithClimb();
    await expect(
      sprayWallMutations.updateSprayWall({}, { input: { uuid: source.uuid, name: 'Old garage' } }, ctxFor(OWNER)),
    ).resolves.toMatchObject({ uuid: source.uuid });
    await expect(
      sprayWallMutations.setSprayWallRenderSettings(
        {},
        { input: { uuid: source.uuid, renderSettings: null } },
        ctxFor(OWNER),
      ),
    ).resolves.toMatchObject({ uuid: source.uuid });
    await expect(sprayWallMutations.deleteSprayWall({}, { uuid: source.uuid }, ctxFor(OWNER))).resolves.toBe(true);
  });

  it('keeps every reader of its climbs working: search, climb, logbook, render, layout lookup and sync', async () => {
    // A public wall so a stranger reads it too. If someone ever adds
    // `archived_at IS NULL` to the spray climb visibility predicates, this goes red.
    const { source, climb } = await archivedWallWithClimb({ isPublic: true });
    await tickMutations.saveTick(
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
    );

    const searchInput = {
      boardName: 'spray',
      layoutId: source.layoutId,
      sizeId: source.layoutId,
      setIds: '1',
      angle: 40,
    };
    for (const viewer of [OWNER, STRANGER, null]) {
      const search = (await climbQueries.searchClimbs({}, { input: searchInput }, ctxFor(viewer))) as {
        _cachedClimbs?: unknown[];
        params?: { layout_id: number };
      };
      // A gated wall answers a pre-baked empty page; a readable one a real context.
      expect(search._cachedClimbs, `search as ${viewer}`).toBeUndefined();

      expect(
        await climbQueries.climb({}, { ...searchInput, climbUuid: climb.uuid }, ctxFor(viewer)),
        `climb as ${viewer}`,
      ).not.toBeNull();
      expect(
        await sprayWallQueries.sprayWallByLayout({}, { layoutId: source.layoutId }, ctxFor(viewer)),
      ).not.toBeNull();
      expect(await sprayWallQueries.sprayWallRenderData({}, { uuid: source.uuid }, ctxFor(viewer))).not.toBeNull();
    }

    const logbook = (await tickQueries.userTicks(
      undefined,
      { userId: OWNER, boardType: 'spray' },
      ctxFor(STRANGER),
    )) as Array<{ climbUuid: string }>;
    expect(logbook.map((tick) => tick.climbUuid)).toContain(climb.uuid);

    const climbSync = await syncQueries.syncClimbs(
      {},
      { boardType: 'spray', layoutId: source.layoutId, sizeId: source.layoutId, cursor: null, limit: 50 },
      ctxFor(STRANGER),
    );
    expect(climbSync.documents.length).toBeGreaterThan(0);
    const wallSync = await syncQueries.syncSprayWalls(
      undefined,
      { boardType: 'spray', layoutId: source.layoutId, sizeId: source.layoutId, cursor: null, limit: 500 },
      ctxFor(OWNER),
    );
    expect(wallSync.documents.length).toBeGreaterThan(0);
  });
});

describe('counts and surfaces that only want live walls', () => {
  it('leaves archived walls out of the account board cap', async () => {
    // 48 other boards, the archived wall and its successor: 50 rows, 49 live.
    await db.execute(sql`
      INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, created_at, updated_at)
      SELECT gen_random_uuid()::text, gen_random_uuid()::text, ${OWNER}, 'kilter', 1, 10, '1', 'Filler', now(), now()
      FROM generate_series(1, ${MAX_BOARDS_PER_ACCOUNT - 2})
    `);
    await archivedWallWithClimb();
    await expect(assertBoardCapNotReached(OWNER)).resolves.toBeUndefined();

    await db.execute(sql`
      INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, created_at, updated_at)
      VALUES (gen_random_uuid()::text, gen_random_uuid()::text, ${OWNER}, 'kilter', 1, 10, '1', 'One more', now(), now())
    `);
    await expect(assertBoardCapNotReached(OWNER)).rejects.toMatchObject({
      extensions: { code: 'BOARD_LIMIT_REACHED' },
    });
  });

  it('counts a reset as one board on the gym, and keeps the archived wall off its kiosk', async () => {
    const gym = await gymWith(GYM_ADMIN, 'member');
    const { wall: source } = await createPublishedWall(OWNER, { isPublic: true });
    await db.execute(sql`UPDATE user_boards SET gym_id = ${gym.id} WHERE uuid = ${source.uuid}`);
    const kioskUuid = uuidv4();
    await db.execute(sql`
      INSERT INTO gym_kiosks (uuid, gym_id, slug, name, layout, created_at, updated_at)
      VALUES (${kioskUuid}, ${gym.id}, 'main', 'Main', ${JSON.stringify({
        version: 1,
        boards: [{ boardUuid: source.uuid }],
        leaderboard: null,
      })}::jsonb, now(), now())
    `);
    const kioskBoards = async () =>
      (
        (await socialGymKioskQueries.gymKiosk({}, { gymSlug: gym.uuid, kioskSlug: 'main' }, ctxFor(null))) as {
          boards: Array<{ boardUuid: string }>;
        } | null
      )?.boards.map((board) => board.boardUuid);
    expect(await kioskBoards()).toEqual([source.uuid]);

    const clone = await resetWall(source.uuid, OWNER);
    await publishFirstVersion(clone.uuid, OWNER);

    const gymView = (await socialGymQueries.gym({}, { gymUuid: gym.uuid }, ctxFor(null))) as { boardCount: number };
    expect(gymView.boardCount).toBe(1);
    expect(await kioskBoards()).toEqual([]);

    // …and a layout write cannot put it back.
    await expect(
      socialGymKioskMutations.updateGymKiosk(
        {},
        { input: { kioskUuid, layout: { version: 1, boards: [{ boardUuid: source.uuid }], leaderboard: null } } },
        ctxFor(OWNER),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    await expect(
      socialGymKioskMutations.updateGymKiosk(
        {},
        { input: { kioskUuid, layout: { version: 1, boards: [{ boardUuid: clone.uuid }], leaderboard: null } } },
        ctxFor(OWNER),
      ),
    ).resolves.toBeTruthy();
  });
});

describe('review follow-ups: hidden walls, explicit choices, ordering', () => {
  const setVisibility = (wallUuid: string, visibility: { isPublic?: boolean; isUnlisted?: boolean }) =>
    sprayWallMutations.updateSprayWall({}, { input: { uuid: wallUuid, ...visibility } }, ctxFor(OWNER));
  const hide = (wallUuid: string) =>
    db.execute(sql`UPDATE spray_walls SET hidden_at = now() WHERE board_uuid = ${wallUuid}`);

  it('refuses to reset a wall an admin hid', async () => {
    const { wall } = await createPublishedWall(OWNER, { isPublic: true });
    await hide(wall.uuid);
    await expect(resetWall(wall.uuid, OWNER)).rejects.toMatchObject({
      extensions: { code: 'SPRAY_WALL_RESET_HIDDEN' },
    });
  });

  it('publishes a private clone when the old wall was hidden after the reset started', async () => {
    const { wall: source } = await createPublishedWall(OWNER, { isPublic: true });
    await socialBoardMutations.followBoard({}, { input: { boardUuid: source.uuid } }, ctxFor(STRANGER));
    const clone = await resetWall(source.uuid, OWNER);
    await hide(source.uuid);
    await publishFirstVersion(clone.uuid, OWNER);

    const published = await wallRow(clone.uuid);
    expect(published.is_public).toBe(false);
    expect(published.is_unlisted).toBe(false);
  });

  it('carries no follow when the narrowed audience is private', async () => {
    const { wall: source } = await createPublishedWall(OWNER, { isPublic: true });
    await socialBoardMutations.followBoard({}, { input: { boardUuid: source.uuid } }, ctxFor(STRANGER));
    const clone = await resetWall(source.uuid, OWNER);
    await setVisibility(source.uuid, { isPublic: false });
    await publishFirstVersion(clone.uuid, OWNER);

    const follows = (await db.execute(sql`
      SELECT count(*)::int AS follows FROM board_follows WHERE board_uuid = ${clone.uuid}
    `)) as unknown as Array<{ follows: number }>;
    expect(follows[0].follows).toBe(0);
  });

  it('does not widen the clone when the old wall got wider mid-reset', async () => {
    const { wall: source } = await createPublishedWall(OWNER, { isUnlisted: true });
    const clone = await resetWall(source.uuid, OWNER);
    await setVisibility(source.uuid, { isPublic: true, isUnlisted: false });
    await publishFirstVersion(clone.uuid, OWNER);

    const published = await wallRow(clone.uuid);
    expect(published.is_public).toBe(false);
    expect(published.is_unlisted).toBe(true);
  });

  it('ranks public-and-unlisted below public', async () => {
    const { wall: source } = await createPublishedWall(OWNER, { isPublic: true });
    const clone = await resetWall(source.uuid, OWNER);
    await setVisibility(source.uuid, { isUnlisted: true });
    await publishFirstVersion(clone.uuid, OWNER);

    const published = await wallRow(clone.uuid);
    expect(published.is_public).toBe(true);
    expect(published.is_unlisted).toBe(true);
  });

  it('keeps the parked pair on a tie', async () => {
    const { wall: source } = await createPublishedWall(OWNER, { isUnlisted: true });
    const clone = await resetWall(source.uuid, OWNER);
    // Stated again, unchanged: same reach as the parked pair.
    await setVisibility(source.uuid, { isPublic: false, isUnlisted: true });
    await publishFirstVersion(clone.uuid, OWNER);

    const published = await wallRow(clone.uuid);
    expect(published.is_public).toBe(false);
    expect(published.is_unlisted).toBe(true);
  });

  it('bounds the clone by the narrowed flags when the old wall is narrowed and then deleted', async () => {
    const { wall: source } = await createPublishedWall(OWNER, { isPublic: true });
    const clone = await resetWall(source.uuid, OWNER);
    await setVisibility(source.uuid, { isPublic: false });
    await sprayWallMutations.deleteSprayWall({}, { uuid: source.uuid }, ctxFor(OWNER));
    await publishFirstVersion(clone.uuid, OWNER);

    expect((await wallRow(clone.uuid)).is_public).toBe(false);
  });

  it('lets an explicit choice on the clone stand, whichever wall is edited first', async () => {
    // Clone first, then the old wall.
    const { wall: firstSource } = await createPublishedWall(OWNER, { isUnlisted: true });
    const firstClone = await resetWall(firstSource.uuid, OWNER);
    await setVisibility(firstClone.uuid, { isPublic: true, isUnlisted: false });
    await setVisibility(firstSource.uuid, { isPublic: false, isUnlisted: false });
    await publishFirstVersion(firstClone.uuid, OWNER);

    // The old wall first, then the clone.
    const { wall: secondSource } = await createPublishedWall(OWNER, { isUnlisted: true });
    const secondClone = await resetWall(secondSource.uuid, OWNER);
    await setVisibility(secondSource.uuid, { isPublic: false, isUnlisted: false });
    await setVisibility(secondClone.uuid, { isPublic: true, isUnlisted: false });
    await publishFirstVersion(secondClone.uuid, OWNER);

    for (const clone of [firstClone, secondClone]) {
      const published = await wallRow(clone.uuid);
      expect(published.is_public, clone.uuid).toBe(true);
      expect(published.is_unlisted, clone.uuid).toBe(false);
      expect(published.pending_is_public).toBeNull();
    }
  });
});

describe('sprayWallHoldUsage', () => {
  const usage = (wallUuid: string, holdIds: number[], userId: string) =>
    sprayWallQueries.sprayWallHoldUsage({}, { wallUuid, holdIds }, ctxFor(userId)) as Promise<
      Array<{ holdId: number; publishedClimbCount: number; draftClimbCount: number }>
    >;

  it('counts published and draft climbs per hold, zeros included, once per hold', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const [usedHold, draftOnlyHold, unusedHold] = holdIds;
    await saveClimbOn(wall, [usedHold]);
    await saveClimbOn(wall, [usedHold, draftOnlyHold], true);

    expect(await usage(wall.uuid, [usedHold, draftOnlyHold, unusedHold, usedHold], OWNER)).toEqual([
      { holdId: usedHold, publishedClimbCount: 1, draftClimbCount: 1 },
      { holdId: draftOnlyHold, publishedClimbCount: 0, draftClimbCount: 1 },
      { holdId: unusedHold, publishedClimbCount: 0, draftClimbCount: 0 },
    ]);
  });

  it('refuses an archived wall', async () => {
    const { source, holdIds } = await archivedWallWithClimb();
    await expect(usage(source.uuid, holdIds, OWNER)).rejects.toMatchObject({
      extensions: { code: 'SPRAY_WALL_ARCHIVED' },
    });
  });

  it('refuses a stranger, on a public wall or a private one', async () => {
    // The edit gate every hold writer uses (`loadEditableWall`), refusal and all.
    for (const visibility of [{ isPublic: true }, {}]) {
      const { wall, holdIds } = await createPublishedWall(OWNER, visibility);
      await expect(usage(wall.uuid, holdIds, STRANGER)).rejects.toThrow(/not authorized/i);
    }
  });

  it('refuses a gym member who can set climbs on the wall but not edit its holds', async () => {
    const gym = await gymWith(GYM_ADMIN, 'member');
    const { wall, holdIds } = await createPublishedWall(OWNER);
    await db.execute(sql`UPDATE user_boards SET gym_id = ${gym.id} WHERE uuid = ${wall.uuid}`);
    // A member sees the wall (and may set climbs on it)…
    expect(await readWall(wall.uuid, GYM_ADMIN)).not.toBeNull();
    // …but `canEditBoard` is the owner, a gym owner/admin, or a community leader.
    await expect(usage(wall.uuid, holdIds, GYM_ADMIN)).rejects.toThrow(/not authorized/i);
  });

  it('counts only this wall’s climbs, so another wall’s hold ids come back as zeros', async () => {
    const { wall } = await createPublishedWall(OWNER);
    // Hold ids are global (`spray_hold_catalog_id_seq`), so a client could ask
    // about a hold on a different wall. Its climbs must not leak through.
    const { wall: otherWall, holdIds: otherHoldIds } = await createPublishedWall(OWNER);
    await saveClimbOn(otherWall, [otherHoldIds[0]]);
    await saveClimbOn(otherWall, [otherHoldIds[1]], true);

    expect(await usage(wall.uuid, otherHoldIds.slice(0, 2), OWNER)).toEqual([
      { holdId: otherHoldIds[0], publishedClimbCount: 0, draftClimbCount: 0 },
      { holdId: otherHoldIds[1], publishedClimbCount: 0, draftClimbCount: 0 },
    ]);
    // The same ids, asked about on their own wall, do count.
    expect(await usage(otherWall.uuid, otherHoldIds.slice(0, 2), OWNER)).toEqual([
      { holdId: otherHoldIds[0], publishedClimbCount: 1, draftClimbCount: 0 },
      { holdId: otherHoldIds[1], publishedClimbCount: 0, draftClimbCount: 1 },
    ]);
  });

  it('caps how many holds one call may ask about', async () => {
    const { wall } = await createPublishedWall(OWNER);
    const tooMany = Array.from({ length: 501 }, (_, index) => index + 1);
    await expect(usage(wall.uuid, tooMany, OWNER)).rejects.toThrow();
  });
});
