import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';

/**
 * The spray wall hold lock and the retired in-place reset, against the real
 * database.
 *
 * The rules (docs/spray-walls.md, "Holds lock at the first published climb" and
 * "What an older app gets back"):
 *
 *  - a wall's holds are free to edit until its first PUBLISHED climb; after that
 *    every hold add, move and remove is refused with SPRAY_WALL_HOLDS_LOCKED.
 *    Draft climbs do not lock the wall;
 *  - a new photo on a published wall, `proposeSprayWallReset`, and publishing a
 *    reset-purpose draft are refused with SPRAY_WALL_RESET_RETIRED. A leftover
 *    reset draft can still be discarded;
 *  - a wall's FIRST publish works through both `publishSprayWallVersion` and
 *    `commitSprayWallVersion`, for a wizard wall and for a reset clone;
 *  - climbs that lost a hold to an old reset leave the wall's lists and search,
 *    and still open by uuid;
 *  - the retired reads answer their safe empty values.
 *
 * Storage is the only stub — there is no R2 in CI — and everything else is real
 * rows.
 */

const { presignedUrls, storedPhotoMetadata, publishedEvents, publicBucketObjects } = vi.hoisted(() => ({
  presignedUrls: [] as string[],
  storedPhotoMetadata: new Map<string, { width: string; height: string }>(),
  publishedEvents: [] as Array<{ type: string; metadata?: Record<string, unknown> }>,
  /** destination key → source key, for the public-promotion path (SW-14). */
  publicBucketObjects: new Map<string, string>(),
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
  // The public-promotion path a wall takes when it is made public.
  // `storedPhotoMetadata` is what exists in the private bucket, so a copy of a
  // key nothing uploaded answers null exactly like the real one does.
  copyObjectBetweenBuckets: vi.fn(
    async (_source: string, sourceKey: string, _destination: string, destinationKey: string) => {
      if (!storedPhotoMetadata.has(sourceKey)) return null;
      publicBucketObjects.set(destinationKey, sourceKey);
      return { key: destinationKey };
    },
  ),
  deleteFromS3: vi.fn(async (_bucket: string, key: string) => {
    publicBucketObjects.delete(key);
  }),
  getPublicUrl: vi.fn((_bucket: string, key: string) => `https://media.example/${key}`),
}));

vi.mock('../events', () => ({
  publishSocialEvent: vi.fn(async (event: { type: string; metadata?: Record<string, unknown> }) => {
    publishedEvents.push(event);
  }),
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
const { climbQueries } = await import('../graphql/resolvers/climbs/queries');
const { resolvers } = await import('../graphql/resolvers/index');
const { sprayWallPhotoKey } = await import('../handlers/spray-wall-photos');
const { searchClimbs } = await import('../db/queries/climbs/search-climbs');

const OWNER = 'swr-owner';
const STRANGER = 'swr-stranger';
const ALL_USERS = [OWNER, STRANGER];

/** A square-ish quad standing in for the four wall corners in a photo. */
const ANCHORS: [number, number][] = [
  [100, 80],
  [900, 120],
  [880, 700],
  [120, 660],
];

/** The three holds every wall in this file starts with. */
const BASE_HOLDS = [
  { cx: 100, cy: 120, r: 24 },
  { cx: 300, cy: 400, r: 30 },
  { cx: 520, cy: 560, r: 18 },
];

const ctxFor = (userId: string | null): ConnectionContext =>
  ({
    connectionId: `conn-${userId ?? 'anon'}`,
    isAuthenticated: userId != null,
    userId: userId ?? null,
  }) as unknown as ConnectionContext;

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

/** Stand in for POST /api/spray-wall-photos: register the metadata the handler would have written. */
function registerUploadedPhoto(wallUuid: string, size = { width: 1200, height: 900 }): string {
  const photoId = uuidv4();
  storedPhotoMetadata.set(sprayWallPhotoKey(wallUuid, photoId), {
    width: String(size.width),
    height: String(size.height),
  });
  return photoId;
}

type CreatedWall = { uuid: string; layoutId: number; sizeId: number };

/** The whole owner-side flow: wall, photo, draft version, three holds, publish. */
async function createPublishedWall(
  owner: string,
  overrides: Record<string, unknown> = {},
): Promise<{ wall: CreatedWall; holdIds: number[] }> {
  const wall = (await sprayWallMutations.createSprayWall(
    {},
    { input: { name: `Wall ${uuidv4().slice(0, 6)}`, angle: 40, ...overrides } },
    ctxFor(owner),
  )) as CreatedWall;

  const photoId = registerUploadedPhoto(wall.uuid);
  const version = (await sprayWallMutations.createSprayWallVersion(
    {},
    { input: { wallUuid: wall.uuid, photoId, anchors: ANCHORS } },
    ctxFor(owner),
  )) as { id: string };

  const holds = (await sprayWallMutations.upsertSprayWallHolds(
    {},
    { input: { wallUuid: wall.uuid, versionId: version.id, holds: BASE_HOLDS } },
    ctxFor(owner),
  )) as Array<{ id: number }>;

  await sprayWallMutations.publishSprayWallVersion({}, { input: { versionId: version.id } }, ctxFor(owner));
  return { wall, holdIds: holds.map((hold) => hold.id) };
}

/** Open a hold-edit draft on the published photo and hand back its version id. */
async function openHoldEditDraft(wall: CreatedWall, owner = OWNER): Promise<string> {
  const read = (await sprayWallQueries.sprayWall({}, { uuid: wall.uuid }, ctxFor(owner))) as {
    currentVersion: { id: string } | null;
  };
  const version = (await sprayWallMutations.createSprayWallVersion(
    {},
    { input: { wallUuid: wall.uuid, sourceVersionId: read.currentVersion?.id } },
    ctxFor(owner),
  )) as { id: string };
  return version.id;
}

/** The wall as its owner reads it. */
async function readWall(wall: CreatedWall) {
  return (await sprayWallQueries.sprayWall({}, { uuid: wall.uuid }, ctxFor(OWNER))) as {
    currentVersion: { id: string; number: number } | null;
    holdCount: number;
    holdsLocked: boolean;
    climbEditPolicy: string;
    viewerCanEditClimbs: boolean;
  };
}

/** `frames` for a spray climb: start, hand, finish on the given holds. */
function framesFor(holdIds: number[]): string {
  const roles = [1, 2, 3];
  return holdIds.map((holdId, index) => `p${holdId}r${roles[index] ?? 2}`).join('');
}

async function saveClimbOn(
  wall: CreatedWall,
  name: string,
  holdIds: number[],
  extra: Record<string, unknown> = {},
): Promise<string> {
  const saved = (await climbMutations.saveClimb(
    {},
    {
      input: {
        boardType: 'spray',
        layoutId: wall.layoutId,
        name,
        isDraft: false,
        frames: framesFor(holdIds),
        angle: 40,
        userGrade: '6b/V4',
        ...extra,
      },
    },
    ctxFor(OWNER),
  )) as { uuid: string };
  return saved.uuid;
}

async function missingFor(uuid: string): Promise<number | null> {
  const [row] = (await db.execute(
    sql`SELECT missing_hold_count FROM board_climbs WHERE uuid = ${uuid}`,
  )) as unknown as Array<{ missing_hold_count: number | null }>;
  return row.missing_hold_count;
}

/** A spray wall's climb list, straight through the real search SQL. */
async function searchNames(wall: CreatedWall, name?: string): Promise<string[]> {
  const result = await searchClimbs(
    { board_name: 'spray', layout_id: wall.layoutId, size_id: wall.sizeId, set_ids: [1], angle: 40 },
    { page: 0, pageSize: 50, sortBy: 'name', sortOrder: 'asc', ...(name ? { name } : {}) },
    OWNER,
  );
  return result.climbs.map((climb) => climb.name).sort();
}

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE TABLE "spray_walls", "user_boards", "gym_members", "gyms",
                   "board_climbs", "board_climb_holds", "board_climb_stats",
                   "board_layouts", "board_product_sizes", "board_product_sizes_layouts_sets",
                   "board_holes", "board_placements", "board_difficulty_grades",
                   "boardsesh_ticks", "user_follows"
    RESTART IDENTITY CASCADE
  `);
  // Standalone sequences: `TRUNCATE … RESTART IDENTITY` does not touch them, and a
  // reused worker database starts somewhere in the thousands.
  await db.execute(sql`ALTER SEQUENCE spray_wall_catalog_id_seq RESTART WITH 1`);
  await db.execute(sql`ALTER SEQUENCE spray_hold_catalog_id_seq RESTART WITH 1`);

  await Promise.all(ALL_USERS.map(insertUser));

  await db.execute(sql`
    INSERT INTO board_difficulty_grades (board_type, difficulty, boulder_name, route_name, is_listed)
    VALUES ('spray', 10, '4a/V0', '5b/5.9', true),
           ('spray', 18, '6b/V4', '7a/5.11d', true)
    ON CONFLICT (board_type, difficulty) DO NOTHING
  `);

  presignedUrls.length = 0;
  publishedEvents.length = 0;
  storedPhotoMetadata.clear();
  publicBucketObjects.clear();

  const storage = await import('../storage/s3');
  vi.mocked(storage.isS3Configured).mockReset();
  vi.mocked(storage.isS3Configured).mockReturnValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

const HOLDS_LOCKED = {
  message: 'Holds are locked once a wall has climbs. Update Boardsesh, then use Reset wall to change them.',
  extensions: { code: 'SPRAY_WALL_HOLDS_LOCKED' },
};
const RESET_RETIRED = {
  message: 'Resets changed. Update Boardsesh, then use Reset wall.',
  extensions: { code: 'SPRAY_WALL_RESET_RETIRED' },
};

const upsertHold = (wall: CreatedWall, versionId: string) =>
  sprayWallMutations.upsertSprayWallHolds(
    {},
    { input: { wallUuid: wall.uuid, versionId, holds: [{ cx: 700, cy: 200, r: 22 }] } },
    ctxFor(OWNER),
  );

const removeHold = (wall: CreatedWall, versionId: string, holdId: number) =>
  sprayWallMutations.removeSprayWallHolds(
    {},
    { input: { wallUuid: wall.uuid, versionId, holdIds: [holdId] } },
    ctxFor(OWNER),
  );

const publishVersion = (versionId: string) =>
  sprayWallMutations.publishSprayWallVersion({}, { input: { versionId } }, ctxFor(OWNER));

/** `commitSprayWallVersion` the way an older app calls it, decisions included. */
const commitVersion = (wall: CreatedWall, versionId: string) =>
  sprayWallMutations.commitSprayWallVersion(
    {},
    {
      input: {
        wallUuid: wall.uuid,
        versionId,
        kept: [],
        removed: [],
        added: [{ detection: { cx: 640, cy: 480, r: 20, source: 'MANUAL' } }],
        fullReset: true,
      },
    },
    ctxFor(OWNER),
  );

/** A fresh wall with an uploaded first photo, and that photo's draft version id. */
async function wizardWallWithDraft(): Promise<{ wall: CreatedWall; versionId: string; holdIds: number[] }> {
  const wall = (await sprayWallMutations.createSprayWall(
    {},
    { input: { name: `Wizard ${uuidv4().slice(0, 6)}`, angle: 40 } },
    ctxFor(OWNER),
  )) as CreatedWall;
  const version = (await sprayWallMutations.createSprayWallVersion(
    {},
    { input: { wallUuid: wall.uuid, photoId: registerUploadedPhoto(wall.uuid), anchors: ANCHORS } },
    ctxFor(OWNER),
  )) as { id: string };
  const holds = (await sprayWallMutations.upsertSprayWallHolds(
    {},
    { input: { wallUuid: wall.uuid, versionId: version.id, holds: BASE_HOLDS } },
    ctxFor(OWNER),
  )) as Array<{ id: number }>;
  return { wall, versionId: version.id, holdIds: holds.map((hold) => hold.id) };
}

async function wallIdOf(wall: CreatedWall): Promise<number> {
  const [row] = (await db.execute(
    sql`SELECT id FROM spray_walls WHERE layout_id = ${wall.layoutId}`,
  )) as unknown as Array<{ id: string | number }>;
  return Number(row.id);
}

async function removedVersionOf(holdId: number): Promise<number | null> {
  const [row] = (await db.execute(
    sql`SELECT removed_version_id FROM spray_wall_holds WHERE hold_id = ${holdId}`,
  )) as unknown as Array<{ removed_version_id: string | number | null }>;
  return row.removed_version_id == null ? null : Number(row.removed_version_id);
}

describe('the hold lock', () => {
  it('refuses every hold writer once the wall has a published climb', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);
    // Opened while the wall had no climbs, so there is a draft to write to.
    const draftId = await openHoldEditDraft(wall);
    await saveClimbOn(wall, 'Alpha', [holdIds[0], holdIds[1]]);
    expect((await readWall(wall)).holdsLocked).toBe(true);

    await expect(upsertHold(wall, draftId)).rejects.toMatchObject(HOLDS_LOCKED);
    await expect(removeHold(wall, draftId, holdIds[2])).rejects.toMatchObject(HOLDS_LOCKED);
    await expect(publishVersion(draftId)).rejects.toMatchObject(HOLDS_LOCKED);

    // Nothing moved: the draft drew nothing and took nothing off.
    expect(await removedVersionOf(holdIds[2])).toBeNull();
    expect((await readWall(wall)).holdCount).toBe(3);

    // The draft can still be thrown away, and a new hold-edit draft is refused.
    await expect(
      sprayWallMutations.discardSprayWallVersion({}, { input: { versionId: draftId } }, ctxFor(OWNER)),
    ).resolves.toBe(true);
    await expect(openHoldEditDraft(wall)).rejects.toMatchObject(HOLDS_LOCKED);
  });

  it('leaves the holds free while the wall has only draft climbs', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const draftClimb = await saveClimbOn(wall, 'Draft', [holdIds[0], holdIds[2]], { isDraft: true });
    expect((await readWall(wall)).holdsLocked).toBe(false);

    const draftId = await openHoldEditDraft(wall);
    await expect(upsertHold(wall, draftId)).resolves.toHaveLength(1);
    await expect(removeHold(wall, draftId, holdIds[2])).resolves.toBe(1);
    await expect(publishVersion(draftId)).resolves.toMatchObject({ status: 'PUBLISHED' });

    const read = await readWall(wall);
    expect(read.currentVersion?.number).toBe(2);
    expect(read.holdCount).toBe(3);
    // The publish is still the moment a removal lands on the climbs that used it.
    expect(await missingFor(draftClimb)).toBe(1);
  });

  it('locks once a draft climb is published, and decides under the wall lock', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const draftClimb = await saveClimbOn(wall, 'Soon', [holdIds[0], holdIds[1]], { isDraft: true });
    const draftId = await openHoldEditDraft(wall);

    await climbMutations.updateClimb(
      {},
      { input: { uuid: draftClimb, boardType: 'spray', isDraft: false } },
      ctxFor(OWNER),
    );

    await expect(upsertHold(wall, draftId)).rejects.toMatchObject(HOLDS_LOCKED);
    await expect(publishVersion(draftId)).rejects.toMatchObject(HOLDS_LOCKED);
  });
});

describe('a wall’s first publish', () => {
  it('works through publishSprayWallVersion for a wizard wall', async () => {
    const { wall, versionId } = await wizardWallWithDraft();

    await expect(publishVersion(versionId)).resolves.toMatchObject({ status: 'PUBLISHED', number: 1 });
    expect((await readWall(wall)).holdCount).toBe(3);
  });

  it('works through commitSprayWallVersion for a wizard wall, ignoring the reset decisions', async () => {
    const { wall, versionId } = await wizardWallWithDraft();

    await expect(commitVersion(wall, versionId)).resolves.toMatchObject({
      version: { status: 'PUBLISHED', number: 1 },
      keptCount: 3,
      removedCount: 0,
      addedCount: 0,
      climbsChanged: 0,
    });
    // The `added` decision put nothing on the wall, and `fullReset` was not stored.
    expect((await readWall(wall)).holdCount).toBe(3);
    const [version] = (await db.execute(
      sql`SELECT is_full_reset FROM spray_wall_versions WHERE id = ${versionId}`,
    )) as unknown as Array<{ is_full_reset: boolean }>;
    expect(version.is_full_reset).toBe(false);
  });

  it.each(['publish', 'commit'])('archives the old wall when a reset clone lands through %s', async (endpoint) => {
    const { wall: source, holdIds } = await createPublishedWall(OWNER);
    // A source with a published climb is the reason to reset: its holds are locked.
    await saveClimbOn(source, 'Locked in', [holdIds[0]]);
    const clone = (await sprayWallMutations.resetSprayWall(
      {},
      { input: { wallUuid: source.uuid } },
      ctxFor(OWNER),
    )) as CreatedWall;
    const version = (await sprayWallMutations.createSprayWallVersion(
      {},
      { input: { wallUuid: clone.uuid, photoId: registerUploadedPhoto(clone.uuid), anchors: ANCHORS } },
      ctxFor(OWNER),
    )) as { id: string };
    // The clone has never published, so its holds are the wizard's to draw.
    await sprayWallMutations.upsertSprayWallHolds(
      {},
      { input: { wallUuid: clone.uuid, versionId: version.id, holds: BASE_HOLDS } },
      ctxFor(OWNER),
    );

    if (endpoint === 'publish') await publishVersion(version.id);
    else await commitVersion(clone, version.id);

    expect((await readWall(clone)).currentVersion?.number).toBe(1);
    const [archived] = (await db.execute(
      sql`SELECT archived_at FROM spray_walls WHERE layout_id = ${source.layoutId}`,
    )) as unknown as Array<{ archived_at: Date | null }>;
    expect(archived.archived_at).not.toBeNull();
  });
});

describe('the retired in-place reset', () => {
  it('refuses a new photo on a published wall, with or without climbs', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const newPhoto = () =>
      sprayWallMutations.createSprayWallVersion(
        {},
        { input: { wallUuid: wall.uuid, photoId: registerUploadedPhoto(wall.uuid), anchors: ANCHORS } },
        ctxFor(OWNER),
      );

    await expect(newPhoto()).rejects.toMatchObject(RESET_RETIRED);
    await saveClimbOn(wall, 'Alpha', [holdIds[0]]);
    await expect(newPhoto()).rejects.toMatchObject(RESET_RETIRED);

    const [versions] = (await db.execute(sql`
      SELECT count(*)::int AS versions FROM spray_wall_versions WHERE wall_id = ${await wallIdOf(wall)}
    `)) as unknown as Array<{ versions: number }>;
    expect(versions.versions).toBe(1);
  });

  it('refuses proposeSprayWallReset', async () => {
    const { wall } = await createPublishedWall(OWNER);
    await expect(
      sprayWallQueries.proposeSprayWallReset({}, { input: { wallUuid: wall.uuid } }, ctxFor(OWNER)),
    ).rejects.toMatchObject(RESET_RETIRED);
  });

  it('will not publish a leftover reset draft through either endpoint, and lets it be discarded', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const wallId = await wallIdOf(wall);
    // What the old flow left behind: a draft on a NEW photo that has already
    // stamped one hold removed.
    const [leftover] = (await db.execute(sql`
      INSERT INTO spray_wall_versions (wall_id, version_number, status, photo_key, photo_width, photo_height,
                                       anchors, homography, created_by)
      VALUES (${wallId}, 2, 'draft', ${`spray-walls/${wall.uuid}/legacy-reset.jpg`}, 1200, 900,
              ${JSON.stringify(ANCHORS)}::jsonb, '[1,0,0,0,1,0,0,0,1]'::jsonb, ${OWNER})
      RETURNING id
    `)) as unknown as Array<{ id: string | number }>;
    const leftoverId = String(leftover.id);
    await db.execute(sql`UPDATE spray_wall_holds SET removed_version_id = ${leftoverId} WHERE hold_id = ${holdIds[2]}`);

    await expect(publishVersion(leftoverId)).rejects.toMatchObject(RESET_RETIRED);
    await expect(commitVersion(wall, leftoverId)).rejects.toMatchObject(RESET_RETIRED);
    expect((await readWall(wall)).currentVersion?.number).toBe(1);

    await expect(
      sprayWallMutations.discardSprayWallVersion({}, { input: { versionId: leftoverId } }, ctxFor(OWNER)),
    ).resolves.toBe(true);
    expect(await removedVersionOf(holdIds[2])).toBeNull();
  });
});

describe('climbs that lost a hold to an old reset', () => {
  it('leave the wall’s climb list and a name search, and still open by uuid', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER, { isPublic: true });
    const intact = await saveClimbOn(wall, 'Intact', [holdIds[0]]);
    const broken = await saveClimbOn(wall, 'Broken', [holdIds[1]]);
    const retired = await saveClimbOn(wall, 'Retired', [holdIds[2]]);
    await db.execute(sql`UPDATE board_climbs SET missing_hold_count = 1 WHERE uuid = ${broken}`);
    await db.execute(
      sql`UPDATE board_climbs SET missing_hold_count = 2, retired_by_reset = true WHERE uuid = ${retired}`,
    );

    expect(await searchNames(wall)).toEqual(['Intact']);
    expect(await searchNames(wall, 'Broken')).toEqual([]);
    expect(await searchNames(wall, 'Intact')).toEqual(['Intact']);

    for (const climbUuid of [intact, broken, retired]) {
      const opened = (await climbQueries.climb(
        {},
        {
          boardName: 'spray',
          layoutId: wall.layoutId,
          sizeId: wall.sizeId,
          setIds: '1',
          angle: 40,
          climbUuid,
        },
        ctxFor(OWNER),
      )) as { uuid: string; missingHoldCount: number | null } | null;
      expect(opened?.uuid).toBe(climbUuid);
    }
  });
});

describe('the retired reads and inputs', () => {
  it('answers remixClimb with null', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER, { isPublic: true });
    const parent = await saveClimbOn(wall, 'Parent', [holdIds[0]]);
    expect(sprayWallQueries.remixClimb()).toBeNull();
    // A parent that exists answers the same.
    expect(parent).toBeTruthy();
  });

  it('answers Climb.lostHolds with an empty list on a spray climb and null elsewhere', () => {
    expect(resolvers.Climb.lostHolds({ boardType: 'spray' })).toEqual([]);
    expect(resolvers.Climb.lostHolds({ boardType: 'kilter' })).toBeNull();
  });

  it('reports SETTER and no climb edit on every wall, whatever is stored', async () => {
    const { wall } = await createPublishedWall(OWNER, { climbEditPolicy: 'COLLABORATORS' });
    const [stored] = (await db.execute(
      sql`SELECT climb_edit_policy FROM spray_walls WHERE layout_id = ${wall.layoutId}`,
    )) as unknown as Array<{ climb_edit_policy: string }>;
    // Accepted and not written.
    expect(stored.climb_edit_policy).toBe('setter');

    await db.execute(
      sql`UPDATE spray_walls SET climb_edit_policy = 'collaborators' WHERE layout_id = ${wall.layoutId}`,
    );
    expect(await readWall(wall)).toMatchObject({ climbEditPolicy: 'SETTER', viewerCanEditClimbs: false });
  });

  it('accepts climbEditPolicy on updateSprayWall and writes nothing for it', async () => {
    const { wall } = await createPublishedWall(OWNER);

    await expect(
      sprayWallMutations.updateSprayWall(
        {},
        { input: { uuid: wall.uuid, climbEditPolicy: 'COLLABORATORS' } },
        ctxFor(OWNER),
      ),
    ).resolves.toMatchObject({ uuid: wall.uuid, climbEditPolicy: 'SETTER' });
    const [stored] = (await db.execute(
      sql`SELECT climb_edit_policy FROM spray_walls WHERE layout_id = ${wall.layoutId}`,
    )) as unknown as Array<{ climb_edit_policy: string }>;
    expect(stored.climb_edit_policy).toBe('setter');
  });

  it('saves a climb that names a remix parent, and writes no lineage', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const parent = await saveClimbOn(wall, 'Parent', [holdIds[0], holdIds[1]]);
    const child = await saveClimbOn(wall, 'Child', [holdIds[0], holdIds[2]], { remixOfClimbUuid: parent });

    const [lineage] = (await db.execute(
      sql`SELECT count(*)::int AS rows FROM spray_climb_lineage WHERE child_uuid = ${child}`,
    )) as unknown as Array<{ rows: number }>;
    expect(lineage.rows).toBe(0);
  });
});
