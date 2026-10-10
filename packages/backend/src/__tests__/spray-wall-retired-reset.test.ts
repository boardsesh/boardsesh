import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createRequire } from 'node:module';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type * as GraphQLModule from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';

/**
 * The retired in-place reset, and live-wall hold edits, against the real
 * database.
 *
 * The rules (docs/spray-walls.md, "Resets", "Editing the holds of a live wall"
 * and "What an older app gets back"):
 *
 *  - holds stay editable on a live wall, published climbs or not. A climb that
 *    used a removed hold gets `missing_hold_count`, stays listed and can be
 *    found with the Holds filter;
 *  - a new photo on a published wall, `proposeSprayWallReset`, and publishing a
 *    reset-purpose draft are refused with SPRAY_WALL_RESET_RETIRED. A leftover
 *    reset draft can still be discarded;
 *  - a wall's FIRST publish works through both `publishSprayWallVersion` and
 *    `commitSprayWallVersion`, for a wizard wall and for a reset clone;
 *  - the retired reads answer their safe values, through the real schema.
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

// saveTick schedules more database work on 2 s timers that outlive a test. A
// late statement from one test would hold locks while the next one's
// TRUNCATE ... CASCADE runs and deadlock it, so the two timer queues are
// stubbed. The in-request recompute (`recomputeClimbStatsNow`) stays real: the
// stats assertions read what it writes.
vi.mock('../graphql/resolvers/ticks/debounced-climb-stats-publisher', async () => ({
  ...(await vi.importActual<typeof import('../graphql/resolvers/ticks/debounced-climb-stats-publisher')>(
    '../graphql/resolvers/ticks/debounced-climb-stats-publisher',
  )),
  queueClimbStatsRecompute: vi.fn(),
}));
vi.mock('../graphql/resolvers/board-presence/stats', async () => ({
  ...(await vi.importActual<typeof import('../graphql/resolvers/board-presence/stats')>(
    '../graphql/resolvers/board-presence/stats',
  )),
  queueBoardStatsPublish: vi.fn(),
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
const { sprayWallQueries, sprayWallMutations } = await import('../graphql/resolvers/board/spray-walls');
const { tickMutations } = await import('../graphql/resolvers/ticks/mutations');
const { countClimbs } = await import('../db/queries/climbs/count-climbs');
const { climbMutations } = await import('../graphql/resolvers/climbs/mutations');
const { climbQueries } = await import('../graphql/resolvers/climbs/queries');
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
  filters: { onlyDrafts?: boolean; holdIntegrity?: 'any' | 'intact' | 'broken' } = {},
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

describe('holds stay editable on a live wall', () => {
  it('takes a hold off under a published climb, which keeps the climb listed with a lost hold', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER, { isPublic: true });
    const climb = await saveClimbOn(wall, 'Loses one', [holdIds[0], holdIds[1]]);
    const intact = await saveClimbOn(wall, 'Keeps all', [holdIds[0], holdIds[2]]);

    // The app asks first how many climbs use the hold, then confirms.
    const usage = (await sprayWallQueries.sprayWallHoldUsage(
      {},
      { wallUuid: wall.uuid, holdIds: [holdIds[1]] },
      ctxFor(OWNER),
    )) as Array<{ holdId: number; publishedClimbCount: number }>;
    expect(usage).toEqual([expect.objectContaining({ holdId: holdIds[1], publishedClimbCount: 1 })]);

    const draftId = await openHoldEditDraft(wall);
    await expect(upsertHold(wall, draftId)).resolves.toHaveLength(1);
    await expect(removeHold(wall, draftId, holdIds[1])).resolves.toBe(1);
    await expect(publishVersion(draftId)).resolves.toMatchObject({ status: 'PUBLISHED' });

    expect(await missingFor(climb)).toBe(1);
    expect(await missingFor(intact)).toBe(0);
    // Still listed, and the Holds filter values work again.
    expect(await searchNames(wall)).toEqual(['Keeps all', 'Loses one']);
    expect(await searchNames(wall, undefined, { holdIntegrity: 'broken' })).toEqual(['Loses one']);
    expect(await searchNames(wall, undefined, { holdIntegrity: 'intact' })).toEqual(['Keeps all']);
    expect(await countClimbs(sprayRouteParams(wall), { holdIntegrity: 'broken' }, OWNER)).toBe(1);
  });

  it('lets the setter re-set a draft that lost a hold, and it is findable in the drafts list', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const draft = await saveClimbOn(wall, 'Draft to fix', [holdIds[0], holdIds[2]], { isDraft: true });

    const editId = await openHoldEditDraft(wall);
    await removeHold(wall, editId, holdIds[2]);
    await publishVersion(editId);
    expect(await missingFor(draft)).toBe(1);

    expect(await searchNames(wall, undefined, { onlyDrafts: true })).toEqual(['Draft to fix']);
    expect(await searchNames(wall, undefined, { onlyDrafts: true, holdIntegrity: 'broken' })).toEqual(['Draft to fix']);
    expect(await countClimbs(sprayRouteParams(wall), { onlyDrafts: true }, OWNER)).toBe(1);

    // Re-set onto holds still on the wall, the per-climb recompute clears it.
    await climbMutations.updateClimb(
      {},
      { input: { uuid: draft, boardType: 'spray', frames: framesFor([holdIds[0], holdIds[1]]) } },
      ctxFor(OWNER),
    );
    expect(await missingFor(draft)).toBe(0);
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

  it('answers RESET_RETIRED for a leftover reset draft on a wall with climbs', async () => {
    // The update message is the one an older app should see: its reset is what
    // changed, and Reset wall is what it needs.
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const leftoverId = await insertLeftoverResetDraft(wall, holdIds[2]);
    await saveClimbOn(wall, 'A published climb', [holdIds[0], holdIds[1]]);

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

describe('a climb that lost a hold', () => {
  it('stays listed and opens by uuid, and the Holds filter splits the list', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER, { isPublic: true });
    const intact = await saveClimbOn(wall, 'Intact', [holdIds[0]]);
    const broken = await saveClimbOn(wall, 'Broken', [holdIds[1]]);
    await db.execute(sql`UPDATE board_climbs SET missing_hold_count = 1 WHERE uuid = ${broken}`);

    expect(await searchNames(wall)).toEqual(['Broken', 'Intact']);
    expect(await searchNames(wall, 'Broken')).toEqual(['Broken']);
    expect(await searchNames(wall, undefined, { holdIntegrity: 'intact' })).toEqual(['Intact']);
    expect(await searchNames(wall, undefined, { holdIntegrity: 'broken' })).toEqual(['Broken']);

    for (const climbUuid of [intact, broken]) {
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
      )) as { uuid: string } | null;
      expect(opened?.uuid).toBe(climbUuid);
    }
  });
});

describe('the retired reads and inputs', () => {
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

describe('publishing a draft, end to end', () => {
  it('serialises two concurrent publishes of one draft under the wall lock', async () => {
    // Fired together, they contend on the wall lock. One publishes; the other
    // re-reads the version under the lock and finds it is no longer a draft.
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const draftId = await openHoldEditDraft(wall);
    await removeHold(wall, draftId, holdIds[1]);

    const outcomes = await Promise.allSettled([publishVersion(draftId), publishVersion(draftId)]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(rejected).toHaveLength(1);
    // The loser re-read the version under the lock and found it no longer a draft.
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      extensions: { code: 'SPRAY_WALL_VERSION_NOT_DRAFT' },
    });

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

describe('reads through the executable schema', () => {
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

  it('treats a MOVED hold as lost: the old position is the ghost, the successor links back', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER, { isPublic: true });
    const climbUuid = await saveClimbOn(wall, 'Moved under it', [holdIds[0]]);
    const editId = await openHoldEditDraft(wall);

    // A correction to an inherited hold is the supersede path: the old row is
    // stamped removed at this draft and a successor gets a new id.
    const [successor] = (await sprayWallMutations.upsertSprayWallHolds(
      {},
      {
        input: {
          wallUuid: wall.uuid,
          versionId: editId,
          holds: [{ id: holdIds[0], cx: BASE_HOLDS[0].cx + 30, cy: BASE_HOLDS[0].cy, r: BASE_HOLDS[0].r }],
        },
      },
      ctxFor(OWNER),
    )) as Array<{ id: number; cx: number; movedFromHoldId: number | null }>;
    expect(successor.id).not.toBe(holdIds[0]);
    await publishVersion(editId);

    expect(await missingFor(climbUuid)).toBe(1);
    const read = (await run(
      `query ($layoutId: Int!, $sizeId: Int!, $climbUuid: ID!) {
        climb(boardName: "spray", layoutId: $layoutId, sizeId: $sizeId, setIds: "1", angle: 40, climbUuid: $climbUuid) {
          lostHolds { id cx }
        }
      }`,
      { layoutId: wall.layoutId, sizeId: wall.sizeId, climbUuid },
    )) as { climb: { lostHolds: Array<{ id: number; cx: number }> } };
    expect(read.climb.lostHolds).toEqual([{ id: holdIds[0], cx: BASE_HOLDS[0].cx }]);

    // The alive successor carries the move back to the hold it replaced.
    const alive = (await db.execute(sql`
      SELECT hold_id, cx, moved_from_hold_id FROM spray_wall_holds
      WHERE wall_id = ${await wallIdOf(wall)} AND removed_version_id IS NULL AND moved_from_hold_id IS NOT NULL
    `)) as unknown as Array<{ hold_id: number; cx: number; moved_from_hold_id: number }>;
    expect([...alive].map((row) => [Number(row.hold_id), Number(row.cx), Number(row.moved_from_hold_id)])).toEqual([
      [successor.id, BASE_HOLDS[0].cx + 30, holdIds[0]],
    ]);
    expect(successor.movedFromHoldId).toBe(holdIds[0]);
  });

  it('draws the hold a published hold edit took off, for the remix ghost', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER, { isPublic: true });
    const climbUuid = await saveClimbOn(wall, 'Lost one', [holdIds[0], holdIds[1]]);
    const editId = await openHoldEditDraft(wall);
    await removeHold(wall, editId, holdIds[1]);
    await publishVersion(editId);

    const read = (await run(
      `query ($layoutId: Int!, $sizeId: Int!, $climbUuid: ID!) {
        climb(boardName: "spray", layoutId: $layoutId, sizeId: $sizeId, setIds: "1", angle: 40, climbUuid: $climbUuid) {
          missingHoldCount
          lostHolds { id cx cy r installedVersion removedVersion }
        }
      }`,
      { layoutId: wall.layoutId, sizeId: wall.sizeId, climbUuid },
    )) as { climb: { missingHoldCount: number; lostHolds: Array<Record<string, number>> } };
    // The removed hold's last geometry, installed by version 1 and taken off by 2.
    expect(read.climb).toEqual({
      missingHoldCount: 1,
      lostHolds: [
        {
          id: holdIds[1],
          cx: BASE_HOLDS[1].cx,
          cy: BASE_HOLDS[1].cy,
          r: BASE_HOLDS[1].r,
          installedVersion: 1,
          removedVersion: 2,
        },
      ],
    });
  });

  it('answers each retired field with its safe value, and lostHolds [] for an intact climb', async () => {
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
    expect(logs.climbLogs.items).toEqual([{ climbRevision: null, climbCurrentRevision: null }]);

    expect(
      await run(`query ($uuid: ID!) { sprayWall(uuid: $uuid) { climbEditPolicy viewerCanEditClimbs } }`, {
        uuid: wall.uuid,
      }),
    ).toEqual({ sprayWall: { climbEditPolicy: 'SETTER', viewerCanEditClimbs: false } });
  });
});
