import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createRequire } from 'node:module';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type * as GraphQLModule from 'graphql';
import { SPRAY_WALL_WRITE_LOCK_NAMESPACE, type ConnectionContext } from '@boardsesh/shared-schema';

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
// The schema is built with graphql's CJS copy, so `execute` has to come from it too.
const requireFromHere = createRequire(import.meta.url);
const { execute, parse } = requireFromHere('graphql') as typeof GraphQLModule;
const { schema } = await import('../graphql/index');
const { sprayWallQueries, sprayWallMutations, lockWallForWrite } =
  await import('../graphql/resolvers/board/spray-walls');
const { tickMutations } = await import('../graphql/resolvers/ticks/mutations');
const { countClimbs } = await import('../db/queries/climbs/count-climbs');
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
async function searchNames(
  wall: CreatedWall,
  name?: string,
  filters: { onlyDrafts?: boolean; holdIntegrity?: 'broken' } = {},
): Promise<string[]> {
  const result = await searchClimbs(
    sprayRouteParams(wall),
    { page: 0, pageSize: 50, sortBy: 'name', sortOrder: 'asc', ...(name ? { name } : {}), ...filters },
    OWNER,
  );
  return result.climbs.map((climb) => climb.name).sort();
}

const sprayRouteParams = (wall: CreatedWall) => ({
  board_name: 'spray' as const,
  layout_id: wall.layoutId,
  size_id: wall.sizeId,
  set_ids: [1],
  angle: 40,
});

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

  it('locks once a draft climb is published through updateClimb', async () => {
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

  /**
   * What the old in-place flow left behind on a live wall: a draft on a NEW photo
   * that has already stamped one hold removed. `photoKey` defaults to a key no
   * upload would produce.
   */
  async function insertLeftoverResetDraft(
    wall: CreatedWall,
    removedHoldId: number,
    photoKey = `spray-walls/${wall.uuid}/legacy-reset.jpg`,
  ): Promise<string> {
    const [leftover] = (await db.execute(sql`
      INSERT INTO spray_wall_versions (wall_id, version_number, status, photo_key, photo_width, photo_height,
                                       anchors, homography, created_by)
      VALUES (${await wallIdOf(wall)}, 2, 'draft', ${photoKey}, 1200, 900,
              ${JSON.stringify(ANCHORS)}::jsonb, '[1,0,0,0,1,0,0,0,1]'::jsonb, ${OWNER})
      RETURNING id
    `)) as unknown as Array<{ id: string | number }>;
    const leftoverId = String(leftover.id);
    await db.execute(
      sql`UPDATE spray_wall_holds SET removed_version_id = ${leftoverId} WHERE hold_id = ${removedHoldId}`,
    );
    return leftoverId;
  }

  const discard = (versionId: string) =>
    sprayWallMutations.discardSprayWallVersion({}, { input: { versionId } }, ctxFor(OWNER));

  it('will not publish a leftover reset draft through either endpoint, and lets it be discarded', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const leftoverId = await insertLeftoverResetDraft(wall, holdIds[2]);

    await expect(publishVersion(leftoverId)).rejects.toMatchObject(RESET_RETIRED);
    await expect(commitVersion(wall, leftoverId)).rejects.toMatchObject(RESET_RETIRED);
    expect((await readWall(wall)).currentVersion?.number).toBe(1);

    await expect(discard(leftoverId)).resolves.toBe(true);
    expect(await removedVersionOf(holdIds[2])).toBeNull();
  });

  it('answers RESET_RETIRED before HOLDS_LOCKED for a leftover reset draft on a wall with climbs', async () => {
    // The update message is the one an older app should see: its reset is what
    // changed, and Reset wall is what it needs.
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const leftoverId = await insertLeftoverResetDraft(wall, holdIds[2]);
    await saveClimbOn(wall, 'Locks the wall', [holdIds[0], holdIds[1]]);
    expect((await readWall(wall)).holdsLocked).toBe(true);

    await expect(publishVersion(leftoverId)).rejects.toMatchObject(RESET_RETIRED);
    await expect(commitVersion(wall, leftoverId)).rejects.toMatchObject(RESET_RETIRED);

    await expect(discard(leftoverId)).resolves.toBe(true);
    expect(await removedVersionOf(holdIds[2])).toBeNull();
  });

  it('lets a leftover reset draft be discarded on an archived wall', async () => {
    const { wall: source, holdIds } = await createPublishedWall(OWNER);
    const leftoverId = await insertLeftoverResetDraft(source, holdIds[2]);
    const clone = (await sprayWallMutations.resetSprayWall(
      {},
      { input: { wallUuid: source.uuid } },
      ctxFor(OWNER),
    )) as CreatedWall;
    const first = (await sprayWallMutations.createSprayWallVersion(
      {},
      { input: { wallUuid: clone.uuid, photoId: registerUploadedPhoto(clone.uuid), anchors: ANCHORS } },
      ctxFor(OWNER),
    )) as { id: string };
    await publishVersion(first.id);
    const [archived] = (await db.execute(
      sql`SELECT archived_at FROM spray_walls WHERE layout_id = ${source.layoutId}`,
    )) as unknown as Array<{ archived_at: Date | null }>;
    expect(archived.archived_at).not.toBeNull();

    await expect(publishVersion(leftoverId)).rejects.toMatchObject({ extensions: { code: 'SPRAY_WALL_ARCHIVED' } });
    await expect(discard(leftoverId)).resolves.toBe(true);
    expect(await removedVersionOf(holdIds[2])).toBeNull();
  });

  it('answers a retried reset upload with RESET_RETIRED, never the leftover draft it created', async () => {
    // The old flow's create is idempotent on the same upload. A retry after this
    // deploy must not hand the leftover draft back as if the reset could go on.
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const photoId = registerUploadedPhoto(wall.uuid);
    const leftoverId = await insertLeftoverResetDraft(wall, holdIds[2], sprayWallPhotoKey(wall.uuid, photoId));

    const retry = sprayWallMutations.createSprayWallVersion(
      {},
      { input: { wallUuid: wall.uuid, photoId, anchors: ANCHORS } },
      ctxFor(OWNER),
    );
    await expect(retry).rejects.toMatchObject(RESET_RETIRED);
    await expect(discard(leftoverId)).resolves.toBe(true);
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
  it('answers Climb.lostHolds with null on a catalogue climb, as it always did', () => {
    // The spray half runs through the executable schema below.
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

describe('drafts that lose a hold, and the retired Lost holds filter', () => {
  it('keeps a draft that lost a hold in the drafts list, and the setter can re-set it', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const draft = await saveClimbOn(wall, 'Draft to fix', [holdIds[0], holdIds[2]], { isDraft: true });

    // Holds are still free: the wall has only a draft climb. This edit takes off
    // a hold the draft uses.
    const editId = await openHoldEditDraft(wall);
    await removeHold(wall, editId, holdIds[2]);
    await publishVersion(editId);
    expect(await missingFor(draft)).toBe(1);

    // `onlyDrafts` is the only place the setter finds it, in the list and the count.
    expect(await searchNames(wall, undefined, { onlyDrafts: true })).toEqual(['Draft to fix']);
    expect(await countClimbs(sprayRouteParams(wall), { onlyDrafts: true }, OWNER)).toBe(1);

    // Re-set onto holds still on the wall, the per-climb recompute clears it.
    await climbMutations.updateClimb(
      {},
      { input: { uuid: draft, boardType: 'spray', frames: framesFor([holdIds[0], holdIds[1]]) } },
      ctxFor(OWNER),
    );
    expect(await missingFor(draft)).toBe(0);
    expect(await searchNames(wall, undefined, { onlyDrafts: true })).toEqual(['Draft to fix']);
  });

  it('answers the Lost holds filter with an empty list on a spray wall, in the list and the count', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER, { isPublic: true });
    await saveClimbOn(wall, 'Intact', [holdIds[0]]);
    const broken = await saveClimbOn(wall, 'Broken', [holdIds[1]]);
    await db.execute(sql`UPDATE board_climbs SET missing_hold_count = 1 WHERE uuid = ${broken}`);

    expect(await searchNames(wall)).toEqual(['Intact']);
    expect(await searchNames(wall, undefined, { holdIntegrity: 'broken' })).toEqual([]);
    expect(await countClimbs(sprayRouteParams(wall), { holdIntegrity: 'broken' }, OWNER)).toBe(0);
  });
});

describe('the hold lock under a real race', () => {
  /** Wait until Postgres shows a request queued, not granted, on this wall's lock. */
  async function untilQueuedBehindWallLock(wallId: number): Promise<void> {
    await vi.waitFor(
      async () => {
        const [lock] = (await db.execute(sql`
          SELECT EXISTS (
            SELECT 1 FROM pg_locks
            WHERE locktype = 'advisory'
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
              AND classid = ${SPRAY_WALL_WRITE_LOCK_NAMESPACE}
              AND objid = ${wallId}
              AND objsubid = 2
              AND NOT granted
          ) AS waiting
        `)) as unknown as Array<{ waiting: boolean }>;
        expect(lock.waiting).toBe(true);
      },
      { timeout: 5000 },
    );
  }

  /** A transaction that holds the wall lock, runs `work` on cue, then commits. */
  function holdWallLock(
    wallId: number,
    work: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<void>,
  ) {
    let announce: () => void = () => {};
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const mayCommit = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = db.transaction(async (tx) => {
      await lockWallForWrite(tx, wallId);
      announce();
      await mayCommit;
      await work(tx);
    });
    return { held, release, done };
  }

  it('refuses a hold write that queued behind a climb publish', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const draftId = await openHoldEditDraft(wall);
    const wallId = await wallIdOf(wall);

    // The climb publish: what `saveClimb` writes under the wall lock.
    const climbPublish = holdWallLock(wallId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO board_climbs (uuid, board_type, layout_id, name, frames, is_draft, is_listed, user_id)
        VALUES (${uuidv4().replace(/-/g, '').toUpperCase()}, 'spray', ${wall.layoutId}, 'Raced in',
                ${framesFor([holdIds[0]])}, false, true, ${OWNER})
      `);
    });
    await climbPublish.held;
    const holdWrite = upsertHold(wall, draftId);
    const refused = expect(holdWrite).rejects.toMatchObject(HOLDS_LOCKED);
    try {
      await untilQueuedBehindWallLock(wallId);
    } finally {
      climbPublish.release();
      await climbPublish.done;
    }
    await refused;
  });

  it('lets a hold write that held the lock first land, then locks the wall once the climb publishes', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const draftId = await openHoldEditDraft(wall);
    const wallId = await wallIdOf(wall);

    // The hold write: what `removeSprayWallHolds` writes under the wall lock.
    const holdWrite = holdWallLock(wallId, async (tx) => {
      await tx.execute(sql`
        UPDATE spray_wall_holds SET removed_version_id = ${draftId}
        WHERE wall_id = ${wallId} AND hold_id = ${holdIds[2]}
      `);
    });
    await holdWrite.held;
    const climbSave = saveClimbOn(wall, 'Waited its turn', [holdIds[0], holdIds[1]]);
    const saved = expect(climbSave).resolves.toEqual(expect.any(String));
    try {
      await untilQueuedBehindWallLock(wallId);
    } finally {
      holdWrite.release();
      await holdWrite.done;
    }
    await saved;

    // The hold write stands, and every hold write after the climb is refused.
    expect(await removedVersionOf(holdIds[2])).toBe(Number(draftId));
    await expect(upsertHold(wall, draftId)).rejects.toMatchObject(HOLDS_LOCKED);
    await expect(publishVersion(draftId)).rejects.toMatchObject(HOLDS_LOCKED);
  });
});

describe('publishing a draft, end to end', () => {
  it('serialises two concurrent publishes of one draft under the wall lock', async () => {
    // Fired together, they contend on the wall lock. One publishes; the other
    // re-reads the version under the lock and finds it is no longer a draft.
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const draftId = await openHoldEditDraft(wall);
    await removeHold(wall, draftId, holdIds[1]);

    const outcomes = await Promise.allSettled([publishVersion(draftId), publishVersion(draftId)]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);

    const [counts] = (await db.execute(sql`
      SELECT count(*) FILTER (WHERE status = 'published')::int AS published,
             count(*) FILTER (WHERE status = 'superseded')::int AS superseded
      FROM spray_wall_versions WHERE wall_id = ${await wallIdOf(wall)}
    `)) as unknown as Array<{ published: number; superseded: number }>;
    expect([counts.published, counts.superseded]).toEqual([1, 1]);
    const [removed] = (await db.execute(sql`
      SELECT count(*)::int AS removed FROM spray_wall_holds
      WHERE hold_id = ${holdIds[1]} AND removed_version_id IS NOT NULL
    `)) as unknown as Array<{ removed: number }>;
    expect(removed.removed).toBe(1);
  });

  it.each(['publish', 'commit'])('refuses to %s into a wall that has been deleted', async (endpoint) => {
    // The outer gate: a wall already deleted when the call arrives never reaches
    // the transaction. The inner one (a delete committing between the authz read
    // and the lock) is pinned at source in spray-wall-write-locks.test.ts.
    const { wall, versionId } = await wizardWallWithDraft();
    await sprayWallMutations.deleteSprayWall({}, { uuid: wall.uuid }, ctxFor(OWNER));

    await expect(endpoint === 'publish' ? publishVersion(versionId) : commitVersion(wall, versionId)).rejects.toThrow(
      /not found/i,
    );
    const [row] = (await db.execute(
      sql`SELECT status FROM spray_wall_versions WHERE id = ${versionId}`,
    )) as unknown as Array<{ status: string }>;
    expect(row.status).toBe('draft');
  });
});

describe('the retired reads through the executable schema', () => {
  /** Run a document against the real schema, so a nullability mistake fails here. */
  async function run(document: string, variables: Record<string, unknown> = {}) {
    const result = await execute({
      schema,
      document: parse(document),
      variableValues: variables,
      contextValue: ctxFor(OWNER),
    });
    expect((result.errors ?? []).map((error) => error.message)).toEqual([]);
    return result.data as Record<string, unknown>;
  }

  it('answers each retired field with its safe value', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER, { isPublic: true });
    const climbUuid = await saveClimbOn(wall, 'Through the schema', [holdIds[0], holdIds[1]]);
    await tickMutations.saveTick(
      {},
      {
        input: {
          climbUuid,
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

    expect(
      await run(
        `query ($boardType: String!, $climbUuid: String!) {
          climbRevisions(boardType: $boardType, climbUuid: $climbUuid) { revisionNumber }
        }`,
        { boardType: 'spray', climbUuid },
      ),
    ).toEqual({ climbRevisions: [] });

    expect(
      await run(`query ($parentUuid: ID!) { remixClimb(parentUuid: $parentUuid) { parentUuid } }`, {
        parentUuid: climbUuid,
      }),
    ).toEqual({ remixClimb: null });

    expect(
      await run(
        `query ($layoutId: Int!, $sizeId: Int!, $climbUuid: ID!) {
          climb(boardName: "spray", layoutId: $layoutId, sizeId: $sizeId, setIds: "1", angle: 40, climbUuid: $climbUuid) {
            uuid
            lostHolds { id }
          }
        }`,
        { layoutId: wall.layoutId, sizeId: wall.sizeId, climbUuid },
      ),
    ).toEqual({ climb: { uuid: climbUuid, lostHolds: [] } });

    const logs = (await run(
      `query ($input: ClimbLogsInput!) { climbLogs(input: $input) { items { climbRevision climbCurrentRevision } } }`,
      { input: { boardType: 'spray', climbUuid } },
    )) as { climbLogs: { items: Array<{ climbRevision: number | null; climbCurrentRevision: number | null }> } };
    expect(logs.climbLogs.items).toEqual([{ climbRevision: 1, climbCurrentRevision: null }]);

    expect(
      await run(`query ($uuid: ID!) { sprayWall(uuid: $uuid) { climbEditPolicy viewerCanEditClimbs } }`, {
        uuid: wall.uuid,
      }),
    ).toEqual({ sprayWall: { climbEditPolicy: 'SETTER', viewerCanEditClimbs: false } });
  });
});
