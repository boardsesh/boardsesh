import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';

/**
 * Editing a published climb in place, against the real database.
 *
 * Climb revision history (#5955) and the holds-change stats reset (#6023) were
 * retired. The rules under test:
 *
 *  - only a climb's setter edits it, on a spray wall like on every other board,
 *    and a published climb only within 24 hours of its first publish. A wall
 *    owner, a collaborator and the stored `climb_edit_policy` grant nothing;
 *  - a draft stays editable by its setter, and publishing it still works;
 *  - an edit is made in place: no `board_climb_revisions` row, the revision
 *    numbers do not move, and a holds edit keeps the climb's sends and stars;
 *  - `climbRevisions` answers the empty list;
 *  - the holds epoch a climb was given before the retirement is still READ:
 *    sends on the old holds stay off the counts, search filters and Projects.
 *
 * Storage is the only stub, as in spray-wall-api.test.ts.
 */

const { storedPhotoMetadata, publicBucketObjects } = vi.hoisted(() => ({
  storedPhotoMetadata: new Map<string, { width: string; height: string }>(),
  publicBucketObjects: new Map<string, string>(),
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
  uploadToS3: vi.fn(async (_bucket: string, _body: Buffer, key: string) => ({ key })),
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
  publishSocialEvent: vi.fn(async () => undefined),
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
const { sprayWallMutations, lockWallForWrite } = await import('../graphql/resolvers/board/spray-walls');
const { climbMutations } = await import('../graphql/resolvers/climbs/mutations');
const { climbQueries } = await import('../graphql/resolvers/climbs/queries');
const { climbFieldResolvers } = await import('../graphql/resolvers/climbs/field-resolvers');
const { tickMutations } = await import('../graphql/resolvers/ticks/mutations');
const { playlistQueries } = await import('../graphql/resolvers/playlists/queries');
const { recomputeClimbStatsBulk, buildRecommendationCountSql, buildRecommendationSentOverlapSql } =
  await import('@boardsesh/db/queries');
const { sprayWallPhotoKey } = await import('../handlers/spray-wall-photos');

const OWNER = 'rev-owner';
const SETTER = 'rev-setter';
const STRANGER = 'rev-stranger';
const ALL_USERS = [OWNER, SETTER, STRANGER];

const ANCHORS: [number, number][] = [
  [100, 80],
  [900, 120],
  [880, 700],
  [120, 660],
];

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

function registerUploadedPhoto(wallUuid: string): string {
  const photoId = uuidv4();
  storedPhotoMetadata.set(sprayWallPhotoKey(wallUuid, photoId), { width: '1200', height: '900' });
  return photoId;
}

type CreatedWall = { uuid: string; layoutId: number; sizeId: number };

async function openDraft(wall: CreatedWall): Promise<string> {
  const version = (await sprayWallMutations.createSprayWallVersion(
    {},
    { input: { wallUuid: wall.uuid, photoId: registerUploadedPhoto(wall.uuid), anchors: ANCHORS } },
    ctxFor(OWNER),
  )) as { id: string };
  return version.id;
}

/** OWNER's wall with three published holds. */
async function createPublishedWall(
  overrides: Record<string, unknown> = {},
): Promise<{ wall: CreatedWall; holdIds: number[] }> {
  const wall = (await sprayWallMutations.createSprayWall(
    {},
    { input: { name: `Wall ${uuidv4().slice(0, 6)}`, angle: 40, ...overrides } },
    ctxFor(OWNER),
  )) as CreatedWall;
  const versionId = await openDraft(wall);
  const holds = (await sprayWallMutations.upsertSprayWallHolds(
    {},
    { input: { wallUuid: wall.uuid, versionId, holds: BASE_HOLDS } },
    ctxFor(OWNER),
  )) as Array<{ id: number }>;
  await sprayWallMutations.publishSprayWallVersion({}, { input: { versionId } }, ctxFor(OWNER));
  return { wall, holdIds: holds.map((hold) => hold.id) };
}

function framesFor(holdIds: number[]): string {
  const roles = [1, 2, 3];
  return holdIds.map((holdId, index) => `p${holdId}r${roles[index] ?? 2}`).join('');
}

async function saveSprayClimb(
  wall: CreatedWall,
  holdIds: number[],
  extra: Record<string, unknown> = {},
  setter = OWNER,
): Promise<string> {
  const saved = (await climbMutations.saveClimb(
    {},
    {
      input: {
        boardType: 'spray',
        layoutId: wall.layoutId,
        name: 'Original name',
        description: 'Original notes',
        isDraft: false,
        frames: framesFor(holdIds),
        angle: 40,
        userGrade: '6b/V4',
        ...extra,
      },
    },
    ctxFor(setter),
  )) as { uuid: string };
  return saved.uuid;
}

const editSpray = (climbUuid: string, changes: Record<string, unknown>, editor = OWNER) =>
  climbMutations.updateClimb({}, { input: { uuid: climbUuid, boardType: 'spray', ...changes } }, ctxFor(editor));

type RevisionRow = {
  revision_number: number;
  name: string | null;
  description: string | null;
  frames: string | null;
  angle: number | null;
  difficulty_id: number | null;
  spray_wall_version_id: string | number | null;
  changes: string[];
  edited_by: string | null;
  created_at: Date | string;
};

async function revisionsOf(climbUuid: string): Promise<RevisionRow[]> {
  const rows = (await db.execute(sql`
    SELECT revision_number, name, description, frames, angle, difficulty_id, spray_wall_version_id,
           changes, edited_by, created_at
    FROM board_climb_revisions
    WHERE climb_uuid = ${climbUuid}
    ORDER BY revision_number
  `)) as unknown as RevisionRow[];
  // A plain array: the driver's result carries extra properties `toEqual([])`
  // should not have to reason about.
  return [...rows];
}

type ClimbRevisionColumns = { revision_number: number; holds_revision_number: number; sync_seq: number };

/** The climb's own copy of its revision, the holds epoch, and the cursor `syncClimbs` pages on. */
async function revisionColumnsOf(climbUuid: string): Promise<ClimbRevisionColumns> {
  const [row] = (await db.execute(sql`
    SELECT revision_number, holds_revision_number, sync_seq
    FROM board_climbs
    WHERE uuid = ${climbUuid}
  `)) as unknown as Array<{ revision_number: number; holds_revision_number: number; sync_seq: string | number }>;
  return {
    revision_number: row.revision_number,
    holds_revision_number: row.holds_revision_number,
    sync_seq: Number(row.sync_seq),
  };
}

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE TABLE "spray_walls", "user_boards", "gym_members", "gyms",
                   "board_climbs", "board_climb_holds", "board_climb_stats",
                   "board_layouts", "board_product_sizes", "board_product_sizes_layouts_sets",
                   "board_holes", "board_placements", "board_difficulty_grades",
                   "boardsesh_ticks", "user_follows", "feed_items"
    RESTART IDENTITY CASCADE
  `);
  await db.execute(sql`ALTER SEQUENCE spray_wall_catalog_id_seq RESTART WITH 1`);
  await db.execute(sql`ALTER SEQUENCE spray_hold_catalog_id_seq RESTART WITH 1`);

  await Promise.all(ALL_USERS.map(insertUser));

  await db.execute(sql`
    INSERT INTO board_difficulty_grades (board_type, difficulty, boulder_name, route_name, is_listed)
    VALUES ('spray', 10, '4a/V0', '5b/5.9', true),
           ('spray', 18, '6b/V4', '7a/5.11d', true),
           ('spray', 22, '7a/V6', '7c/5.12d', true)
    ON CONFLICT (board_type, difficulty) DO NOTHING
  `);

  storedPhotoMetadata.clear();
  publicBucketObjects.clear();

  const storage = await import('../storage/s3');
  vi.mocked(storage.isS3Configured).mockReset();
  vi.mocked(storage.isS3Configured).mockReturnValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

type StatsRow = {
  ascensionist_count: number;
  boardsesh_ascensionist_count: number;
  fa_username: string | null;
  fa_at: string | Date | null;
  quality_average: number | null;
  display_difficulty: number | null;
  sync_seq: number;
};

async function statsOf(boardType: string, climbUuid: string, angle = 40): Promise<StatsRow | undefined> {
  const [row] = (await db.execute(sql`
    SELECT ascensionist_count, boardsesh_ascensionist_count, fa_username, fa_at, quality_average,
           display_difficulty, sync_seq
    FROM board_climb_stats
    WHERE board_type = ${boardType} AND climb_uuid = ${climbUuid} AND angle = ${angle}
  `)) as unknown as Array<Record<keyof StatsRow, string | number | Date | null>>;
  if (!row) return undefined;
  return {
    ascensionist_count: Number(row.ascensionist_count),
    boardsesh_ascensionist_count: Number(row.boardsesh_ascensionist_count),
    fa_username: row.fa_username as string | null,
    fa_at: row.fa_at as string | Date | null,
    quality_average: row.quality_average == null ? null : Number(row.quality_average),
    display_difficulty: row.display_difficulty == null ? null : Number(row.display_difficulty),
    sync_seq: Number(row.sync_seq),
  };
}

const logTick = (climbUuid: string, climber: string, status: 'send' | 'attempt', quality?: number) =>
  tickMutations.saveTick(
    {},
    {
      input: {
        climbUuid,
        boardType: 'spray',
        angle: 40,
        status,
        attemptCount: 1,
        isMirror: false,
        isBenchmark: false,
        comment: '',
        climbedAt: new Date().toISOString(),
        ...(quality == null ? {} : { quality }),
      },
    },
    ctxFor(climber),
  );

/** The uuids a search of the wall returns to `viewer` with one personal filter on. */
async function searchWall(wall: CreatedWall, viewer: string, filter: Record<string, unknown>): Promise<string[]> {
  const context = await climbQueries.searchClimbs(
    {},
    {
      input: { boardName: 'spray', layoutId: wall.layoutId, sizeId: wall.sizeId, setIds: '1', angle: 40, ...filter },
    },
    ctxFor(viewer),
  );
  const climbs = await climbFieldResolvers.climbs(context as Parameters<typeof climbFieldResolvers.climbs>[0]);
  return climbs.map((climb) => climb.uuid);
}

/** A Kilter climb SETTER published an hour ago, inside the catalogue edit window. */
async function insertKilterClimb(): Promise<string> {
  const climbUuid = uuidv4().replace(/-/g, '').toUpperCase();
  const publishedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, name, description, frames, frames_count, frames_pace,
                              angle, is_draft, is_listed, created_at, published_at, user_id, setter_username)
    VALUES (${climbUuid}, 'kilter', 1, 'Kilter route', '', 'p1117r12p1140r15', 1, 0,
            40, false, true, ${publishedAt}, ${publishedAt}, ${SETTER}, 'setter')
  `);
  return climbUuid;
}

const insertKilterSend = (climbUuid: string, climber: string, angle: number, difficulty: number) =>
  db.execute(sql`
    INSERT INTO boardsesh_ticks (uuid, user_id, climb_uuid, board_type, angle, status, quality, difficulty,
                                 climb_revision, climbed_at, created_at, updated_at)
    VALUES (${uuidv4()}, ${climber}, ${climbUuid}, 'kilter', ${angle}, 'send', 4, ${difficulty},
            1, now() - interval '10 minutes', now(), now())
  `);

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

const setPublishedAt = (climbUuid: string, publishedAt: string) =>
  db.execute(sql`UPDATE board_climbs SET published_at = ${publishedAt} WHERE uuid = ${climbUuid}`);

async function climbRowOf(
  climbUuid: string,
): Promise<{ name: string; is_draft: boolean; published_at: string | null }> {
  const [row] = (await db.execute(
    sql`SELECT name, is_draft, published_at FROM board_climbs WHERE uuid = ${climbUuid}`,
  )) as unknown as Array<{ name: string; is_draft: boolean; published_at: string | null }>;
  return row;
}

describe('who may edit a published spray climb, and for how long', () => {
  it('lets the setter edit within 24 hours of the first publish', async () => {
    const { wall, holdIds } = await createPublishedWall({ isPublic: true });
    const climbUuid = await saveSprayClimb(wall, holdIds, {}, SETTER);
    await setPublishedAt(climbUuid, hoursAgo(23));

    await expect(editSpray(climbUuid, { name: 'Renamed' }, SETTER)).resolves.toMatchObject({
      uuid: climbUuid,
      isDraft: false,
    });
    expect((await climbRowOf(climbUuid)).name).toBe('Renamed');
  });

  it('refuses the setter after 24 hours, as on every other board', async () => {
    const { wall, holdIds } = await createPublishedWall({ isPublic: true });
    const climbUuid = await saveSprayClimb(wall, holdIds, {}, SETTER);
    await setPublishedAt(climbUuid, hoursAgo(25));

    await expect(editSpray(climbUuid, { name: 'Renamed' }, SETTER)).rejects.toMatchObject({
      extensions: { code: 'CLIMB_EDIT_WINDOW_EXPIRED' },
    });
    expect((await climbRowOf(climbUuid)).name).toBe('Original name');
  });

  it('refuses the wall owner on somebody else’s climb, inside the window', async () => {
    const { wall, holdIds } = await createPublishedWall({ isPublic: true });
    const climbUuid = await saveSprayClimb(wall, holdIds, {}, SETTER);

    await expect(editSpray(climbUuid, { name: 'Owner rename' }, OWNER)).rejects.toMatchObject({
      extensions: { code: 'CLIMB_EDIT_NOT_ALLOWED' },
    });
    expect((await climbRowOf(climbUuid)).name).toBe('Original name');
  });

  it('refuses a collaborator, and the owner, on a wall whose stored policy says collaborators', async () => {
    const { wall, holdIds } = await createPublishedWall({ isPublic: true });
    // The retired setting, as an older app left it. Nothing reads it any more.
    await db.execute(
      sql`UPDATE spray_walls SET climb_edit_policy = 'collaborators' WHERE layout_id = ${wall.layoutId}`,
    );
    const climbUuid = await saveSprayClimb(wall, holdIds, {}, SETTER);

    for (const editor of [STRANGER, OWNER]) {
      await expect(editSpray(climbUuid, { name: 'Not yours' }, editor)).rejects.toMatchObject({
        extensions: { code: 'CLIMB_EDIT_NOT_ALLOWED' },
      });
    }
    expect((await climbRowOf(climbUuid)).name).toBe('Original name');
  });

  it('keeps a draft editable by its setter for as long as it is a draft, and publishes it', async () => {
    const { wall, holdIds } = await createPublishedWall({ isPublic: true });
    const climbUuid = await saveSprayClimb(wall, holdIds, { isDraft: true }, SETTER);
    await db.execute(sql`UPDATE board_climbs SET created_at = ${hoursAgo(24 * 10)} WHERE uuid = ${climbUuid}`);

    await editSpray(climbUuid, { name: 'Still a draft' }, SETTER);
    expect(await climbRowOf(climbUuid)).toMatchObject({ name: 'Still a draft', is_draft: true, published_at: null });

    await expect(editSpray(climbUuid, { isDraft: false }, SETTER)).resolves.toMatchObject({ isDraft: false });
    const published = await climbRowOf(climbUuid);
    expect(published.is_draft).toBe(false);
    expect(published.published_at).not.toBeNull();

    // …and the fresh publish starts the 24 hour window.
    await editSpray(climbUuid, { name: 'Published' }, SETTER);
    expect((await climbRowOf(climbUuid)).name).toBe('Published');
  });
});

describe('a holds edit in the window', () => {
  it('is made in place: no revision row, the numbers stay, and the sends and stars stay', async () => {
    const { wall, holdIds } = await createPublishedWall({ isPublic: true });
    const climbUuid = await saveSprayClimb(wall, holdIds);
    await logTick(climbUuid, OWNER, 'send', 5);
    await logTick(climbUuid, STRANGER, 'send', 3);
    await logTick(climbUuid, SETTER, 'attempt');
    const statsBefore = await statsOf('spray', climbUuid);
    expect(statsBefore).toMatchObject({ ascensionist_count: 2, fa_username: 'User ' + OWNER, quality_average: 4 });

    const result = await editSpray(climbUuid, { frames: framesFor([holdIds[0], holdIds[2]]), name: 'Moved' });

    expect(result).toMatchObject({ revisionNumber: 1, holdsRevisionNumber: 1 });
    expect(await revisionColumnsOf(climbUuid)).toMatchObject({ revision_number: 1, holds_revision_number: 1 });
    expect(await revisionsOf(climbUuid)).toEqual([]);
    expect(await statsOf('spray', climbUuid)).toMatchObject({
      ascensionist_count: 2,
      fa_username: 'User ' + OWNER,
      quality_average: 4,
      display_difficulty: 18,
    });
    expect(await searchWall(wall, STRANGER, { showOnlyCompleted: true })).toEqual([climbUuid]);
    expect(await searchWall(wall, SETTER, { showOnlyAttempted: true })).toEqual([climbUuid]);
    expect(await searchWall(wall, OWNER, { minUserRating: 4 })).toEqual([climbUuid]);

    // The rest of an in-window edit still happens: the hold rows follow the frames.
    const holdRows = (await db.execute(
      sql`SELECT hold_id FROM board_climb_holds WHERE climb_uuid = ${climbUuid} ORDER BY hold_id`,
    )) as unknown as Array<{ hold_id: number }>;
    expect([...holdRows].map((row) => Number(row.hold_id))).toEqual([holdIds[0], holdIds[2]]);
    // No stats recompute was queued for the edit.
    const pending = (await db.execute(sql`
      SELECT angle FROM climb_stats_recompute_pending WHERE board_type = 'spray' AND climb_uuid = ${climbUuid}
    `)) as unknown as Array<{ angle: number }>;
    expect([...pending]).toEqual([]);
  });

  it('hands back, and keeps, the stored numbers of a climb edited before revisions were retired', async () => {
    const { wall, holdIds } = await createPublishedWall({ isPublic: true });
    const climbUuid = await saveSprayClimb(wall, holdIds);
    await db.execute(
      sql`UPDATE board_climbs SET revision_number = 3, holds_revision_number = 2 WHERE uuid = ${climbUuid}`,
    );

    await expect(editSpray(climbUuid, { frames: framesFor([holdIds[1], holdIds[2]]) })).resolves.toMatchObject({
      revisionNumber: 3,
      holdsRevisionNumber: 2,
    });
    expect(await revisionColumnsOf(climbUuid)).toMatchObject({ revision_number: 3, holds_revision_number: 2 });
    expect(await revisionsOf(climbUuid)).toEqual([]);
  });

  it('keeps the sends on a catalogue climb too', async () => {
    const climbUuid = await insertKilterClimb();
    await insertKilterSend(climbUuid, STRANGER, 40, 20);
    await recomputeClimbStatsBulk(db, [{ boardType: 'kilter', climbUuid, angle: 40 }]);
    const before = await statsOf('kilter', climbUuid, 40);
    expect(before).toMatchObject({ ascensionist_count: 1, display_difficulty: 20 });

    await climbMutations.updateClimb(
      {},
      { input: { uuid: climbUuid, boardType: 'kilter', frames: 'p1117r12p1141r15' } },
      ctxFor(SETTER),
    );

    expect(await revisionColumnsOf(climbUuid)).toMatchObject({ revision_number: 1, holds_revision_number: 1 });
    expect(await statsOf('kilter', climbUuid, 40)).toEqual(before);
  });

  it('leaves saveTick stamping the climb revision, with and without one from the client', async () => {
    const { wall, holdIds } = await createPublishedWall({ isPublic: true });
    const climbUuid = await saveSprayClimb(wall, holdIds);
    await editSpray(climbUuid, { frames: framesFor([holdIds[0], holdIds[2]]) });

    await logTick(climbUuid, STRANGER, 'send');
    await tickMutations.saveTick(
      {},
      {
        input: {
          climbUuid,
          boardType: 'spray',
          angle: 40,
          status: 'attempt',
          attemptCount: 1,
          isMirror: false,
          isBenchmark: false,
          comment: '',
          climbedAt: new Date().toISOString(),
          climbRevision: 1,
        },
      },
      ctxFor(SETTER),
    );

    const ticks = (await db.execute(sql`
      SELECT user_id, climb_revision FROM boardsesh_ticks WHERE climb_uuid = ${climbUuid} ORDER BY user_id
    `)) as unknown as Array<{ user_id: string; climb_revision: number | null }>;
    expect([...ticks]).toEqual([
      { user_id: SETTER, climb_revision: 1 },
      { user_id: STRANGER, climb_revision: 1 },
    ]);
  });
});

describe('climbRevisions', () => {
  it('answers the empty list, even for a climb with revision rows from before the retirement', async () => {
    const { wall, holdIds } = await createPublishedWall({ isPublic: true });
    const climbUuid = await saveSprayClimb(wall, holdIds);
    await db.execute(sql`
      INSERT INTO board_climb_revisions (board_type, climb_uuid, revision_number, changes)
      VALUES ('spray', ${climbUuid}, 1, '{}'::text[]), ('spray', ${climbUuid}, 2, '{name}'::text[])
    `);

    expect(climbQueries.climbRevisions()).toEqual([]);
    // The rows are kept, not deleted.
    expect((await revisionsOf(climbUuid)).map((revision) => revision.revision_number)).toEqual([1, 2]);
  });
});

/**
 * What a holds edit made BEFORE revisions were retired left behind: the frames
 * moved, revision rows 1 and 2, the climb on revision 2 with its holds epoch at 2,
 * and the stats recomputed against that epoch. Nothing writes this any more, but
 * climbs that had it keep it, and every reader of the epoch still honours it.
 */
async function moveHoldsTheLegacyWay(climbUuid: string, frames: string): Promise<void> {
  await editSpray(climbUuid, { frames });
  await db.execute(sql`
    INSERT INTO board_climb_revisions (board_type, climb_uuid, revision_number, changes, created_at)
    VALUES ('spray', ${climbUuid}, 1, '{}'::text[], now() - interval '1 hour'),
           ('spray', ${climbUuid}, 2, '{holds}'::text[], now() - interval '1 second')
  `);
  await db.execute(sql`
    UPDATE board_climbs SET revision_number = 2, holds_revision_number = 2
    WHERE uuid = ${climbUuid} AND board_type = 'spray'
  `);
  await recomputeClimbStatsBulk(db, [{ boardType: 'spray', climbUuid, angle: 40 }]);
}

describe('a climb whose holds moved before revisions were retired (#6023)', () => {
  it('keeps the sends from before the move off its count, first ascent, stars and sent marks', async () => {
    const { wall, holdIds } = await createPublishedWall({ isPublic: true });
    const climbUuid = await saveSprayClimb(wall, holdIds);
    await logTick(climbUuid, OWNER, 'send', 5);
    await logTick(climbUuid, STRANGER, 'send', 3);
    await logTick(climbUuid, SETTER, 'attempt');

    await moveHoldsTheLegacyWay(climbUuid, framesFor([holdIds[0], holdIds[2]]));

    expect(await statsOf('spray', climbUuid)).toMatchObject({
      ascensionist_count: 0,
      boardsesh_ascensionist_count: 0,
      fa_username: null,
      fa_at: null,
      quality_average: null,
      // The setter's grade is not a statistic and stays.
      display_difficulty: 18,
    });
    expect(await searchWall(wall, STRANGER, { showOnlyCompleted: true })).toEqual([]);
    expect(await searchWall(wall, STRANGER, { hideCompleted: true })).toEqual([climbUuid]);
    expect(await searchWall(wall, STRANGER, { onlyRatedByMe: true })).toEqual([]);
    expect(await searchWall(wall, SETTER, { showOnlyAttempted: true })).toEqual([]);
    expect(await searchWall(wall, SETTER, { hideAttempted: true })).toEqual([climbUuid]);
    expect(await searchWall(wall, STRANGER, { minUserRating: 4 })).toEqual([climbUuid]);

    // A send on the new holds counts, and is the first ascent of them.
    await logTick(climbUuid, STRANGER, 'send', 2);
    expect(await statsOf('spray', climbUuid)).toMatchObject({
      ascensionist_count: 1,
      fa_username: 'User ' + STRANGER,
      quality_average: 2,
    });
    expect(await searchWall(wall, STRANGER, { showOnlyCompleted: true })).toEqual([climbUuid]);
    expect(await searchWall(wall, OWNER, { showOnlyCompleted: true })).toEqual([]);
  });

  it('lists a climb as a project only on tries of its current holds', async () => {
    const { wall, holdIds } = await createPublishedWall({ isPublic: true });
    const climbUuid = await saveSprayClimb(wall, holdIds);

    /** The climber's Projects playlist, its total, and the count on its library card. */
    const projectsOf = async (climber: string) => {
      const playlist = (await playlistQueries.smartPlaylist(
        {},
        { input: { type: 'PROJECTS', userId: climber, boardName: 'spray' } },
        ctxFor(climber),
      )) as { climbs: Array<{ uuid: string }>; totalCount: number };
      const cards = await playlistQueries.mySmartPlaylistCounts({}, {}, ctxFor(climber));
      return {
        uuids: playlist.climbs.map((climb) => climb.uuid),
        totalCount: playlist.totalCount,
        cardCount: cards.find((card) => card.type === 'PROJECTS')?.count,
      };
    };
    const project = { uuids: [climbUuid], totalCount: 1, cardCount: 1 };
    const noProject = { uuids: [], totalCount: 0, cardCount: 0 };

    await logTick(climbUuid, SETTER, 'attempt');
    await logTick(climbUuid, STRANGER, 'send');
    expect(await projectsOf(SETTER)).toEqual(project);
    expect(await projectsOf(STRANGER)).toEqual(noProject);

    await moveHoldsTheLegacyWay(climbUuid, framesFor([holdIds[0], holdIds[2]]));
    // Neither has tried the new holds. The old send does not turn into a
    // project, and the old attempt is no longer one.
    expect(await projectsOf(SETTER)).toEqual(noProject);
    expect(await projectsOf(STRANGER)).toEqual(noProject);

    // Trying the new holds makes it a project again, old send or not.
    await logTick(climbUuid, STRANGER, 'attempt');
    expect(await projectsOf(STRANGER)).toEqual(project);
    await logTick(climbUuid, STRANGER, 'send');
    expect(await projectsOf(STRANGER)).toEqual(noProject);
  });

  it('finds the edited climbs among the unedited ones in a logbook', async () => {
    // Projects reads the holds epoch through the index of edited climbs only, so
    // every other climb must come out at epoch 1 without its row being read.
    const { wall, holdIds } = await createPublishedWall({ isPublic: true });
    const [first, second, third] = holdIds;
    const holdSets = [
      [first, second, third],
      [first, second],
      [first, third],
      [second, third],
      [second, first],
      [third, first],
    ];
    const climbUuids: string[] = [];
    for (const [index, holdSet] of holdSets.entries()) {
      climbUuids.push(await saveSprayClimb(wall, holdSet, { name: `Climb ${index}` }));
    }
    const [sentThenEdited, sentOnly, triedThenEdited, ...triedOnly] = climbUuids;
    for (const climbUuid of climbUuids) await logTick(climbUuid, STRANGER, 'attempt');
    await logTick(sentThenEdited, STRANGER, 'send');
    await logTick(sentOnly, STRANGER, 'send');

    /** Page, total and library card, which must always describe the same set. */
    const projects = async () => {
      const playlist = (await playlistQueries.smartPlaylist(
        {},
        { input: { type: 'PROJECTS', userId: STRANGER, boardName: 'spray' } },
        ctxFor(STRANGER),
      )) as { climbs: Array<{ uuid: string }>; totalCount: number };
      const cards = await playlistQueries.mySmartPlaylistCounts({}, {}, ctxFor(STRANGER));
      const uuids = playlist.climbs.map((climb) => climb.uuid).sort();
      expect(playlist.totalCount).toBe(uuids.length);
      expect(cards.find((card) => card.type === 'PROJECTS')?.count).toBe(uuids.length);
      return uuids;
    };

    expect(await projects()).toEqual([triedThenEdited, ...triedOnly].sort());

    await moveHoldsTheLegacyWay(sentThenEdited, framesFor([third, second, first]));
    await moveHoldsTheLegacyWay(triedThenEdited, framesFor([third, second]));
    // The two edited climbs leave the list until their new holds are tried; the
    // four nobody edited are untouched.
    expect(await projects()).toEqual([...triedOnly].sort());

    await logTick(sentThenEdited, STRANGER, 'attempt');
    expect(await projects()).toEqual([sentThenEdited, ...triedOnly].sort());
  });
});

// Migration 0252 ends with an UPDATE that fills the two columns in for climbs
// edited between the deploy that created `board_climb_revisions` and the one
// that added the columns. The test database is built from schema-sql.ts, not
// from the migrations, so the statement is read out of the file and run here.
describe('the backfill at the end of migration 0252', () => {
  const backfill = readFileSync(new URL('../../../db/drizzle/0252_tick_climb_revision.sql', import.meta.url), 'utf8')
    .split('--> statement-breakpoint')
    .at(-1)!
    .trim();
  const runBackfill = () => db.execute(sql.raw(backfill));

  /** A published catalogue climb, with the revision columns as the ALTERs leave them: 1 and 1. */
  async function insertClimb(): Promise<string> {
    const climbUuid = uuidv4().replace(/-/g, '').toUpperCase();
    await db.execute(sql`
      INSERT INTO board_climbs (uuid, board_type, layout_id, name, frames, is_draft, is_listed, user_id)
      VALUES (${climbUuid}, 'kilter', 1, 'Backfill climb', 'p1117r12', false, true, ${SETTER})
    `);
    return climbUuid;
  }

  /** Revision rows as the earlier deploy would have written them. Revision 1 always changes nothing. */
  async function insertRevisions(climbUuid: string, changesPerRevision: Record<number, string[]>): Promise<void> {
    for (const [revisionNumber, changes] of Object.entries(changesPerRevision)) {
      await db.execute(sql`
        INSERT INTO board_climb_revisions (board_type, climb_uuid, revision_number, changes)
        VALUES ('kilter', ${climbUuid}, ${Number(revisionNumber)}, ${`{${changes.join(',')}}`}::text[])
      `);
    }
  }

  it('is the UPDATE statement alone, with no comment inside it', () => {
    expect(backfill).toMatch(/^UPDATE "board_climbs"/);
    expect(backfill).not.toMatch(/--/);
  });

  it('sets the revision to the newest row and the epoch to the newest row that changed the holds', async () => {
    const renamedOnly = await insertClimb();
    const holdsThenRenamed = await insertClimb();
    const holdsLast = await insertClimb();
    const pruned = await insertClimb();
    await insertRevisions(renamedOnly, { 1: [], 2: ['name'], 3: ['description', 'grade'] });
    await insertRevisions(holdsThenRenamed, { 1: [], 2: ['holds'], 3: ['name'], 4: ['rules'] });
    await insertRevisions(holdsLast, { 1: [], 2: ['name'], 3: ['name', 'holds'] });
    // Numbers with a gap after 1, as pruning leaves them.
    await insertRevisions(pruned, { 1: [], 40: ['holds'], 41: ['name'] });

    await runBackfill();

    expect(await revisionColumnsOf(renamedOnly)).toMatchObject({ revision_number: 3, holds_revision_number: 1 });
    expect(await revisionColumnsOf(holdsThenRenamed)).toMatchObject({ revision_number: 4, holds_revision_number: 2 });
    expect(await revisionColumnsOf(holdsLast)).toMatchObject({ revision_number: 3, holds_revision_number: 3 });
    expect(await revisionColumnsOf(pruned)).toMatchObject({ revision_number: 41, holds_revision_number: 40 });
  });

  it('leaves a climb with no revision rows alone, and does nothing on a second run', async () => {
    const unedited = await insertClimb();
    const edited = await insertClimb();
    await insertRevisions(edited, { 1: [], 2: ['holds'] });
    const uneditedBefore = await revisionColumnsOf(unedited);

    await runBackfill();
    const editedAfterFirstRun = await revisionColumnsOf(edited);
    await runBackfill();

    // Not rewritten at all: `sync_seq` is where it was, so no phone re-pulls it.
    expect(await revisionColumnsOf(unedited)).toEqual(uneditedBefore);
    // The second run found nothing that differed, so it did not fire the sync trigger again.
    expect(editedAfterFirstRun).toMatchObject({ revision_number: 2, holds_revision_number: 2 });
    expect(await revisionColumnsOf(edited)).toEqual(editedAfterFirstRun);
  });

  it('re-delivers a climb it changes', async () => {
    const climbUuid = await insertClimb();
    await insertRevisions(climbUuid, { 1: [], 2: ['holds'], 3: ['name'] });
    const before = await revisionColumnsOf(climbUuid);

    await runBackfill();

    const backfilled = await revisionColumnsOf(climbUuid);
    expect(backfilled).toMatchObject({ revision_number: 3, holds_revision_number: 2 });
    expect(backfilled.sync_seq).toBeGreaterThan(before.sync_seq);
  });

  it('puts the epoch one edit too high after a pace-only edit, which `changes` cannot tell from a hold moving', async () => {
    // The limit the migration's header describes, pinned so nobody reads the
    // backfill as exact.
    const climbUuid = await insertClimb();
    await insertRevisions(climbUuid, { 1: [], 2: ['holds'] });

    await runBackfill();

    expect(await revisionColumnsOf(climbUuid)).toMatchObject({ revision_number: 2, holds_revision_number: 2 });
  });
});

describe('an edit decided on a climb another edit has since changed', () => {
  it('is refused with CLIMB_EDIT_CONFLICT, and leaves the frames and the hold rows agreeing', async () => {
    // The setter has the climb open on two devices with frames F0. The first
    // device's edit lands and moves the holds to F1. The second device's save
    // carries the F0 it loaded plus a rename: decided on the row it read, that is
    // "frames unchanged", so it would write F0 back and skip the hold rewrite,
    // leaving `frames` and `board_climb_holds` describing two different climbs.
    const { wall, holdIds } = await createPublishedWall({ isPublic: true });
    const framesAsLoaded = framesFor(holdIds);
    const framesAfterFirstEdit = framesFor([holdIds[0], holdIds[2]]);
    const climbUuid = await saveSprayClimb(wall, holdIds, {}, SETTER);
    const [wallRow] = (await db.execute(
      sql`SELECT id FROM spray_walls WHERE layout_id = ${wall.layoutId}`,
    )) as unknown as Array<{ id: string | number }>;

    let lockHeld: () => void = () => undefined;
    const lockIsHeld = new Promise<void>((resolve) => {
      lockHeld = resolve;
    });
    let letTheFirstDeviceCommit: () => void = () => undefined;
    const firstDeviceMayCommit = new Promise<void>((resolve) => {
      letTheFirstDeviceCommit = resolve;
    });

    // The first device's edit, as a transaction that holds the wall lock the way
    // `updateClimb` does, writes what it writes, and commits on cue.
    const firstDeviceEdit = db.transaction(async (tx) => {
      await lockWallForWrite(tx, Number(wallRow.id));
      lockHeld();
      await firstDeviceMayCommit;
      await tx.execute(sql`UPDATE board_climbs SET frames = ${framesAfterFirstEdit} WHERE uuid = ${climbUuid}`);
      await tx.execute(sql`
        DELETE FROM board_climb_holds WHERE climb_uuid = ${climbUuid} AND hold_id = ${holdIds[1]}
      `);
    });

    await lockIsHeld;
    // Loads the climb (frames F0), then queues behind the wall lock.
    const setterEdit = editSpray(climbUuid, { name: 'Renamed', frames: framesAsLoaded }, SETTER);
    const setterOutcome = setterEdit.then(
      () => ({ refusedWith: null as unknown }),
      (error: unknown) => ({ refusedWith: error }),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    letTheFirstDeviceCommit();
    await firstDeviceEdit;

    const { refusedWith } = await setterOutcome;
    expect(refusedWith).toMatchObject({ extensions: { code: 'CLIMB_EDIT_CONFLICT' } });

    // Nothing of the refused edit landed: the first device's frames stand and the
    // hold rows still match them.
    const [climb] = (await db.execute(
      sql`SELECT name, frames FROM board_climbs WHERE uuid = ${climbUuid}`,
    )) as unknown as Array<{ name: string; frames: string }>;
    expect(climb).toEqual({ name: 'Original name', frames: framesAfterFirstEdit });
    const holdRows = (await db.execute(
      sql`SELECT hold_id FROM board_climb_holds WHERE climb_uuid = ${climbUuid} ORDER BY hold_id`,
    )) as unknown as Array<{ hold_id: number }>;
    expect([...holdRows].map((row) => Number(row.hold_id))).toEqual([holdIds[0], holdIds[2]]);
    expect(await revisionsOf(climbUuid)).toEqual([]);

    // Reloaded, the same rename goes through, in place.
    await editSpray(climbUuid, { name: 'Renamed' }, SETTER);
    expect((await climbRowOf(climbUuid)).name).toBe('Renamed');
    expect(await revisionsOf(climbUuid)).toEqual([]);
  });
});

describe('recommendations and a send from before the holds moved (#6023)', () => {
  it('offers the climb again, and the card count subtraction still adds up', async () => {
    const publishedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const insertClimb = async (holdsEpoch: number): Promise<string> => {
      const climbUuid = uuidv4().replace(/-/g, '').toUpperCase();
      await db.execute(sql`
        INSERT INTO board_climbs (uuid, board_type, layout_id, name, description, frames, frames_count, angle,
                                  is_draft, is_listed, created_at, published_at, compatible_size_ids,
                                  revision_number, holds_revision_number)
        VALUES (${climbUuid}, 'kilter', 1, 'Fresh', '', 'p1117r12p1140r15', 1, 40,
                false, true, ${publishedAt}, ${publishedAt}, ARRAY[10]::int[],
                ${holdsEpoch}, ${holdsEpoch})
      `);
      return climbUuid;
    };
    const insertSend = (climbUuid: string, climbRevision: number | null) =>
      db.execute(sql`
        INSERT INTO boardsesh_ticks (uuid, user_id, climb_uuid, board_type, angle, status, climb_revision,
                                     climbed_at, created_at, updated_at)
        VALUES (${uuidv4()}, ${STRANGER}, ${climbUuid}, 'kilter', 40, 'send', ${climbRevision}, now(), now(), now())
      `);

    // Sent as it stands; sent before its holds moved (twice, one with no
    // revision at all); never sent.
    await insertSend(await insertClimb(1), null);
    const editedSinceSent = await insertClimb(3);
    await insertSend(editedSinceSent, 2);
    await insertSend(editedSinceSent, null);
    await insertClimb(1);

    const params = {
      type: 'RECOMMENDED_FRESH' as const,
      target: { boardType: 'kilter', layoutId: 1, sizeId: 10, angle: 40, setIds: null },
      shorterSizeIds: [],
      narrowerSameHeightSizeIds: [],
      gradeBand: null,
      freshWindowDays: 365,
    };
    const countOf = async (statement: Parameters<typeof db.execute>[0]) => {
      const [row] = (await db.execute(statement)) as unknown as Array<{ count: number | string }>;
      return Number(row.count);
    };

    const excluded = await countOf(buildRecommendationCountSql({ ...params, excludeUserId: STRANGER }));
    const catalog = await countOf(buildRecommendationCountSql({ ...params, excludeUserId: null }));
    const overlap = await countOf(buildRecommendationSentOverlapSql({ ...params, excludeUserId: null }, STRANGER));

    expect(excluded).toBe(2);
    expect(catalog).toBe(3);
    expect(overlap).toBe(1);
    expect(catalog - overlap).toBe(excluded);
  });
});
