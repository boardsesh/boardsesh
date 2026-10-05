import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';

/**
 * Climb revision history (#5955), against the real database.
 *
 * What `updateClimb` writes to `board_climb_revisions`, and what the
 * `climbRevisions` query hands back. The rules under test:
 *
 *  - rows are written lazily: nothing until the first edit of a PUBLISHED climb,
 *    which writes revision 1 (the climb as published) and revision 2;
 *  - a draft never records, and neither does the save that publishes it;
 *  - a save that changes nothing records nothing;
 *  - two edits in flight get consecutive numbers, and the second one's snapshot
 *    includes the first one's change;
 *  - past the cap the oldest edit goes and revision 1 stays;
 *  - a spray revision names the wall version it was drawn on, and revision 1's is
 *    worked out after the fact;
 *  - the editor is whoever made the edit, which on a spray wall may not be the
 *    setter.
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
const { MAX_REVISIONS_PER_CLIMB } = await import('@boardsesh/board-config');

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

/** version number -> version id, for one wall. */
async function versionIdsOf(wall: CreatedWall): Promise<Map<number, number>> {
  const rows = (await db.execute(sql`
    SELECT v.id, v.version_number
    FROM spray_wall_versions v JOIN spray_walls w ON w.id = v.wall_id
    WHERE w.layout_id = ${wall.layoutId}
  `)) as unknown as Array<{ id: string | number; version_number: number }>;
  return new Map(rows.map((row) => [Number(row.version_number), Number(row.id)]));
}

type ClimbRevisionResult = {
  revisionNumber: number;
  isCurrent: boolean;
  createdAt: string;
  name: string | null;
  description: string | null;
  frames: string | null;
  angle: number | null;
  difficultyId: number | null;
  changes: string[];
  editor: { id: string; displayName: string | null; avatarUrl: string | null } | null;
  editedBySetter: boolean;
  sprayWallVersionNumber: number | null;
};

const readRevisions = async (boardType: string, climbUuid: string, viewer: string | null) =>
  (await climbQueries.climbRevisions({}, { boardType, climbUuid }, ctxFor(viewer))) as ClimbRevisionResult[];

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

describe('what updateClimb records', () => {
  it('writes nothing until a published climb is edited, then revisions 1 and 2', async () => {
    const { wall, holdIds } = await createPublishedWall();
    const climbUuid = await saveSprayClimb(wall, holdIds);
    expect(await revisionsOf(climbUuid)).toEqual([]);

    await editSpray(climbUuid, { name: 'Renamed' });

    const [climb] = (await db.execute(
      sql`SELECT published_at FROM board_climbs WHERE uuid = ${climbUuid}`,
    )) as unknown as Array<{ published_at: string }>;
    const versionIds = await versionIdsOf(wall);
    const revisions = await revisionsOf(climbUuid);
    expect(revisions.map((revision) => revision.revision_number)).toEqual([1, 2]);

    // Revision 1 is the climb as it was published: its own values, dated to the
    // publish, credited to the setter, and changing nothing.
    expect(revisions[0]).toMatchObject({
      name: 'Original name',
      description: 'Original notes',
      frames: framesFor(holdIds),
      angle: 40,
      difficulty_id: 18,
      changes: [],
      edited_by: OWNER,
    });
    expect(new Date(revisions[0].created_at).getTime()).toBe(Date.parse(climb.published_at));
    expect(Number(revisions[0].spray_wall_version_id)).toBe(versionIds.get(1));

    // Revision 2 is the climb as it stands now.
    expect(revisions[1]).toMatchObject({
      name: 'Renamed',
      description: 'Original notes',
      frames: framesFor(holdIds),
      difficulty_id: 18,
      changes: ['name'],
      edited_by: OWNER,
    });
    expect(Number(revisions[1].spray_wall_version_id)).toBe(versionIds.get(1));

    // A second edit adds one row, not two.
    await editSpray(climbUuid, { description: 'New notes' });
    const after = await revisionsOf(climbUuid);
    expect(after.map((revision) => revision.revision_number)).toEqual([1, 2, 3]);
    expect(after[2]).toMatchObject({ name: 'Renamed', description: 'New notes', changes: ['description'] });
  });

  it('records nothing for a save that changes nothing', async () => {
    const { wall, holdIds } = await createPublishedWall();
    const climbUuid = await saveSprayClimb(wall, holdIds);

    // Every field resent with the value it already has, and a call with no fields.
    await editSpray(climbUuid, {
      name: 'Original name',
      description: 'Original notes',
      frames: framesFor(holdIds),
      angle: 40,
      userGrade: '6b/V4',
    });
    await editSpray(climbUuid, {});
    expect(await revisionsOf(climbUuid)).toEqual([]);

    // The same no-op after a real edit adds no third row.
    await editSpray(climbUuid, { name: 'Renamed' });
    await editSpray(climbUuid, { name: 'Renamed' });
    expect((await revisionsOf(climbUuid)).map((revision) => revision.revision_number)).toEqual([1, 2]);
  });

  it('records nothing for a draft, or for the save that publishes it', async () => {
    const { wall, holdIds } = await createPublishedWall();
    const climbUuid = await saveSprayClimb(wall, holdIds, { isDraft: true });

    await editSpray(climbUuid, { name: 'Draft rename' });
    await editSpray(climbUuid, { description: 'Draft notes' });
    expect(await revisionsOf(climbUuid)).toEqual([]);

    // The publish itself, carrying an edit in the same call.
    await editSpray(climbUuid, { isDraft: false, name: 'Published name' });
    expect(await revisionsOf(climbUuid)).toEqual([]);

    // History starts at publication: revision 1 is the climb as published, not
    // any of the draft states before it.
    await editSpray(climbUuid, { name: 'After publish' });
    const revisions = await revisionsOf(climbUuid);
    expect(revisions.map((revision) => revision.revision_number)).toEqual([1, 2]);
    expect(revisions[0]).toMatchObject({ name: 'Published name', description: 'Draft notes', changes: [] });
    expect(revisions[1]).toMatchObject({ name: 'After publish', changes: ['name'] });
  });

  it('gives two concurrent edits consecutive numbers, the second built on the first', async () => {
    const { wall, holdIds } = await createPublishedWall();
    const climbUuid = await saveSprayClimb(wall, holdIds);

    await Promise.all([editSpray(climbUuid, { name: 'Renamed' }), editSpray(climbUuid, { description: 'New notes' })]);

    const revisions = await revisionsOf(climbUuid);
    expect(revisions.map((revision) => revision.revision_number)).toEqual([1, 2, 3]);
    expect(revisions[0]).toMatchObject({ name: 'Original name', description: 'Original notes', changes: [] });
    // Whichever landed second, its snapshot carries BOTH changes and its diff
    // names only its own. That is the row lock: the second edit's "before" is the
    // first edit's result, not the climb both of them loaded.
    expect(revisions[2]).toMatchObject({ name: 'Renamed', description: 'New notes' });
    expect([...revisions[1].changes, ...revisions[2].changes].sort()).toEqual(['description', 'name']);
    expect(revisions[1].changes).toHaveLength(1);
    expect(revisions[2].changes).toHaveLength(1);
  });

  it('prunes the oldest edits past the cap and keeps revision 1', async () => {
    const { wall, holdIds } = await createPublishedWall();
    const climbUuid = await saveSprayClimb(wall, holdIds);

    // Edit N writes revision N + 1, so this many edits is three rows past the cap.
    const edits = MAX_REVISIONS_PER_CLIMB + 2;
    for (let edit = 1; edit <= edits; edit += 1) {
      await editSpray(climbUuid, { name: `Rename ${edit}` });
    }

    const revisions = await revisionsOf(climbUuid);
    expect(revisions).toHaveLength(MAX_REVISIONS_PER_CLIMB);
    const numbers = revisions.map((revision) => revision.revision_number);
    // The original survives; revisions 2, 3 and 4 are the ones that went.
    expect(numbers[0]).toBe(1);
    expect(numbers[1]).toBe(5);
    expect(numbers.at(-1)).toBe(edits + 1);
    expect(revisions[0]).toMatchObject({ name: 'Original name', changes: [] });
    expect(revisions.at(-1)).toMatchObject({ name: `Rename ${edits}` });

    // The climb's own number follows the newest revision, not the row count, and
    // pruning does not touch it. Renames only, so the holds epoch never moved.
    expect(await revisionColumnsOf(climbUuid)).toMatchObject({
      revision_number: edits + 1,
      holds_revision_number: 1,
    });
  }, 120_000);

  it('records a grade-only edit on a spray wall as `grade`', async () => {
    const { wall, holdIds } = await createPublishedWall();
    const climbUuid = await saveSprayClimb(wall, holdIds);

    await editSpray(climbUuid, { userGrade: '7a/V6' });

    const revisions = await revisionsOf(climbUuid);
    expect(revisions.map((revision) => [revision.difficulty_id, revision.changes])).toEqual([
      [18, []],
      [22, ['grade']],
    ]);
  });

  it('names what each kind of edit changed', async () => {
    const { wall, holdIds } = await createPublishedWall();
    const climbUuid = await saveSprayClimb(wall, holdIds);

    await editSpray(climbUuid, { frames: framesFor([holdIds[0], holdIds[2]]) });
    await editSpray(climbUuid, { anyFeet: true });
    await editSpray(climbUuid, { name: 'Both', description: 'At once', userGrade: '4a/V0' });

    const revisions = await revisionsOf(climbUuid);
    expect(revisions.map((revision) => revision.changes)).toEqual([
      [],
      ['holds'],
      ['rules'],
      ['name', 'description', 'grade'],
    ]);
    expect(revisions[1].frames).toBe(framesFor([holdIds[0], holdIds[2]]));
  });

  it('puts revision 1 on the wall version the climb was published on, across a reset', async () => {
    const { wall, holdIds } = await createPublishedWall();
    // Uses the hold the reset is about to take off, so only version 1 ever had
    // all of its holds.
    const lostAHold = await saveSprayClimb(wall, [holdIds[0], holdIds[1]], { name: 'Loses a hold' });
    // Uses only holds the reset keeps, so both versions could be its original.
    const intact = await saveSprayClimb(wall, [holdIds[0], holdIds[2]], { name: 'Stays intact' });

    const versionId = await openDraft(wall);
    await sprayWallMutations.commitSprayWallVersion(
      {},
      {
        input: {
          wallUuid: wall.uuid,
          versionId,
          kept: [{ holdId: holdIds[0] }, { holdId: holdIds[2] }],
          removed: [holdIds[1]],
          added: [],
        },
      },
      ctxFor(OWNER),
    );
    // Set after the reset, on holds that were on the wall in version 1 as well.
    const setAfterReset = await saveSprayClimb(wall, [holdIds[2], holdIds[0]], { name: 'Set after the reset' });

    // Move the first climb off the lost hold; rename the other two.
    await editSpray(lostAHold, { frames: framesFor([holdIds[0], holdIds[2]]), noMatch: true });
    await editSpray(intact, { name: 'Stays intact, renamed' });
    await editSpray(setAfterReset, { name: 'Set after the reset, renamed' });

    const versionIds = await versionIdsOf(wall);
    const versionsOf = async (climbUuid: string) =>
      (await revisionsOf(climbUuid)).map((revision) => Number(revision.spray_wall_version_id));

    // The hold range alone pins it: version 2 never had the lost hold.
    expect(await versionsOf(lostAHold)).toEqual([versionIds.get(1), versionIds.get(2)]);
    // Both versions had its holds; it was published before version 2 was.
    expect(await versionsOf(intact)).toEqual([versionIds.get(1), versionIds.get(2)]);
    // Both versions had its holds; it was published after version 2 was.
    expect(await versionsOf(setAfterReset)).toEqual([versionIds.get(2), versionIds.get(2)]);
  });

  it('leaves revision 1 without a wall version when no version fits', async () => {
    const { wall, holdIds } = await createPublishedWall();
    const climbUuid = await saveSprayClimb(wall, holdIds);
    // A climb whose stored frames name a hold this wall never had. Not reachable
    // through the API; it stands for any row the derivation cannot place.
    await db.execute(sql`UPDATE board_climbs SET frames = 'p999999r1' WHERE uuid = ${climbUuid}`);

    await editSpray(climbUuid, { frames: framesFor(holdIds), name: 'Repaired' });

    const versionIds = await versionIdsOf(wall);
    const revisions = await revisionsOf(climbUuid);
    expect(revisions[0].spray_wall_version_id).toBeNull();
    expect(Number(revisions[1].spray_wall_version_id)).toBe(versionIds.get(1));
  });

  it('records a wall owner as the editor of somebody else’s climb, and leaves the setter alone', async () => {
    const { wall, holdIds } = await createPublishedWall({ isPublic: true });
    const climbUuid = await saveSprayClimb(wall, holdIds, {}, SETTER);

    await editSpray(climbUuid, { name: 'Fixed by the owner', userGrade: '7a/V6' }, OWNER);

    const revisions = await revisionsOf(climbUuid);
    expect(revisions.map((revision) => [revision.revision_number, revision.edited_by])).toEqual([
      [1, SETTER],
      [2, OWNER],
    ]);
    expect(revisions[1].changes).toEqual(['name', 'grade']);

    const [climb] = (await db.execute(
      sql`SELECT user_id, setter_username, name FROM board_climbs WHERE uuid = ${climbUuid}`,
    )) as unknown as Array<{ user_id: string; setter_username: string; name: string }>;
    expect(climb).toEqual({ user_id: SETTER, setter_username: `User ${SETTER}`, name: 'Fixed by the owner' });
  });

  it('records an edit on a catalogue board, with no grade and no wall version', async () => {
    const climbUuid = uuidv4().replace(/-/g, '').toUpperCase();
    const publishedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await db.execute(sql`
      INSERT INTO board_climbs (uuid, board_type, layout_id, name, description, frames, frames_count, frames_pace,
                                angle, is_draft, is_listed, created_at, published_at, user_id, setter_username)
      VALUES (${climbUuid}, 'kilter', 1, 'Kilter original', '', 'p1117r12p1140r15', 1, 0,
              40, false, true, ${publishedAt}, ${publishedAt}, ${SETTER}, 'setter')
    `);

    await climbMutations.updateClimb(
      {},
      { input: { uuid: climbUuid, boardType: 'kilter', name: 'Kilter renamed', description: 'Sit start' } },
      ctxFor(SETTER),
    );

    const revisions = await revisionsOf(climbUuid);
    expect(revisions.map((revision) => revision.revision_number)).toEqual([1, 2]);
    expect(revisions[0]).toMatchObject({ name: 'Kilter original', difficulty_id: null, spray_wall_version_id: null });
    expect(revisions[1]).toMatchObject({
      name: 'Kilter renamed',
      description: 'Sit start',
      difficulty_id: null,
      spray_wall_version_id: null,
      changes: ['name', 'description'],
      edited_by: SETTER,
    });
  });
});

describe('the revision columns on board_climbs (#6023)', () => {
  it('start at 1 and stay there until a published climb is edited', async () => {
    const { wall, holdIds } = await createPublishedWall();
    const published = await saveSprayClimb(wall, holdIds);
    const draft = await saveSprayClimb(wall, [holdIds[0], holdIds[1]], { isDraft: true });
    expect(await revisionColumnsOf(published)).toMatchObject({ revision_number: 1, holds_revision_number: 1 });

    // A draft has no history, so editing one (holds included) and publishing it
    // leave both numbers alone. So does a save that changes nothing.
    await editSpray(draft, { frames: framesFor([holdIds[0], holdIds[2]]) });
    await editSpray(draft, { isDraft: false, name: 'Published name' });
    await editSpray(published, { name: 'Original name' });
    expect(await revisionColumnsOf(draft)).toMatchObject({ revision_number: 1, holds_revision_number: 1 });
    expect(await revisionColumnsOf(published)).toMatchObject({ revision_number: 1, holds_revision_number: 1 });
  });

  it('move the revision on every edit and the holds epoch only when a hold moves', async () => {
    const { wall, holdIds } = await createPublishedWall();
    const climbUuid = await saveSprayClimb(wall, holdIds);

    // The first edit writes revisions 1 and 2. A rename leaves the holds alone.
    await editSpray(climbUuid, { name: 'Renamed' });
    expect(await revisionColumnsOf(climbUuid)).toMatchObject({ revision_number: 2, holds_revision_number: 1 });

    await editSpray(climbUuid, { frames: framesFor([holdIds[0], holdIds[2]]) });
    expect(await revisionColumnsOf(climbUuid)).toMatchObject({ revision_number: 3, holds_revision_number: 3 });

    // Notes, rules and the grade are all revisions of the same holds.
    await editSpray(climbUuid, { description: 'New notes' });
    await editSpray(climbUuid, { anyFeet: true });
    await editSpray(climbUuid, { userGrade: '7a/V6' });
    expect(await revisionColumnsOf(climbUuid)).toMatchObject({ revision_number: 6, holds_revision_number: 3 });

    // The same holds in the same roles is not an edit at all.
    await editSpray(climbUuid, { frames: framesFor([holdIds[0], holdIds[2]]) });
    expect(await revisionColumnsOf(climbUuid)).toMatchObject({ revision_number: 6, holds_revision_number: 3 });

    await editSpray(climbUuid, { frames: framesFor(holdIds), name: 'Back on three' });
    expect(await revisionColumnsOf(climbUuid)).toMatchObject({ revision_number: 7, holds_revision_number: 7 });

    // Always the newest row's number.
    expect((await revisionsOf(climbUuid)).at(-1)?.revision_number).toBe(7);
  });

  it('move both to 2 when the first edit is the one that moves a hold', async () => {
    const { wall, holdIds } = await createPublishedWall();
    const climbUuid = await saveSprayClimb(wall, holdIds);

    await editSpray(climbUuid, { frames: framesFor([holdIds[0], holdIds[1]]) });

    expect(await revisionColumnsOf(climbUuid)).toMatchObject({ revision_number: 2, holds_revision_number: 2 });
  });

  it('keep the holds epoch on a pace-only edit, which is still a revision', async () => {
    const climbUuid = uuidv4().replace(/-/g, '').toUpperCase();
    const publishedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await db.execute(sql`
      INSERT INTO board_climbs (uuid, board_type, layout_id, name, description, frames, frames_count, frames_pace,
                                angle, is_draft, is_listed, created_at, published_at, user_id, setter_username)
      VALUES (${climbUuid}, 'kilter', 1, 'Kilter route', '', 'p1117r12p1140r15', 1, 0,
              40, false, true, ${publishedAt}, ${publishedAt}, ${SETTER}, 'setter')
    `);

    await climbMutations.updateClimb(
      {},
      { input: { uuid: climbUuid, boardType: 'kilter', framesPace: 900 } },
      ctxFor(SETTER),
    );

    expect((await revisionsOf(climbUuid)).map((revision) => revision.changes)).toEqual([[], ['holds']]);
    expect(await revisionColumnsOf(climbUuid)).toMatchObject({ revision_number: 2, holds_revision_number: 1 });
  });

  it('give two concurrent edits the higher number, and the epoch of whichever moved a hold', async () => {
    const { wall, holdIds } = await createPublishedWall();
    const climbUuid = await saveSprayClimb(wall, holdIds);

    // A rename never conflicts with another edit (`climbEditDecisionsAreStale`
    // ignores the name), so both of these land, in either order.
    await Promise.all([editSpray(climbUuid, { name: 'Renamed' }), editSpray(climbUuid, { description: 'New notes' })]);

    expect(await revisionColumnsOf(climbUuid)).toMatchObject({ revision_number: 3, holds_revision_number: 1 });
  });

  it('re-deliver the climb to syncClimbs on an edit that only touched the stats row', async () => {
    const { wall, holdIds } = await createPublishedWall();
    const climbUuid = await saveSprayClimb(wall, holdIds);
    const before = await revisionColumnsOf(climbUuid);

    // A spray regrade writes `board_climb_stats`, not `board_climbs`. The
    // revision write is then the only change to the climb row, and it has to
    // fire the sync trigger or a phone would keep the old revision number.
    await editSpray(climbUuid, { userGrade: '7a/V6' });

    const after = await revisionColumnsOf(climbUuid);
    expect(after.revision_number).toBe(2);
    expect(after.sync_seq).toBeGreaterThan(before.sync_seq);
  });
});

describe('what updateClimb answers with (#6023)', () => {
  type UpdateAnswer = { revisionNumber: number | null; holdsRevisionNumber: number | null; isDraft: boolean };
  const edit = async (climbUuid: string, changes: Record<string, unknown>) =>
    (await editSpray(climbUuid, changes)) as UpdateAnswer;

  it('hands back the revision numbers the save left on the climb', async () => {
    const { wall, holdIds } = await createPublishedWall();
    const climbUuid = await saveSprayClimb(wall, holdIds);

    // A rename: a new revision, same holds.
    expect(await edit(climbUuid, { name: 'Renamed' })).toMatchObject({ revisionNumber: 2, holdsRevisionNumber: 1 });
    // A hold moves: both numbers.
    expect(await edit(climbUuid, { frames: framesFor([holdIds[0], holdIds[2]]) })).toMatchObject({
      revisionNumber: 3,
      holdsRevisionNumber: 3,
    });
    // A grade-only edit, which never touches the climb row itself.
    expect(await edit(climbUuid, { userGrade: '7a/V6' })).toMatchObject({ revisionNumber: 4, holdsRevisionNumber: 3 });
    // A save that changes nothing answers the numbers as they are.
    expect(await edit(climbUuid, { name: 'Renamed' })).toMatchObject({ revisionNumber: 4, holdsRevisionNumber: 3 });

    expect(await revisionColumnsOf(climbUuid)).toMatchObject({ revision_number: 4, holds_revision_number: 3 });
  });

  it('answers 1 and 1 for a draft edit, for the publish, and for a replay of that publish', async () => {
    const { wall, holdIds } = await createPublishedWall();
    const climbUuid = await saveSprayClimb(wall, holdIds, { isDraft: true });

    expect(await edit(climbUuid, { name: 'Draft rename' })).toMatchObject({
      isDraft: true,
      revisionNumber: 1,
      holdsRevisionNumber: 1,
    });
    const publish = { isDraft: false, name: 'Published name' };
    expect(await edit(climbUuid, publish)).toMatchObject({ isDraft: false, revisionNumber: 1, holdsRevisionNumber: 1 });
    // The double tap: the publish has landed, so this one writes nothing.
    expect(await edit(climbUuid, publish)).toMatchObject({ isDraft: false, revisionNumber: 1, holdsRevisionNumber: 1 });
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

  it('re-delivers a climb it changes, and agrees with what the code writes for the same edits', async () => {
    const { wall, holdIds } = await createPublishedWall();
    const climbUuid = await saveSprayClimb(wall, holdIds);
    await editSpray(climbUuid, { frames: framesFor([holdIds[0], holdIds[2]]) });
    await editSpray(climbUuid, { name: 'Renamed' });
    const written = await revisionColumnsOf(climbUuid);
    expect(written).toMatchObject({ revision_number: 3, holds_revision_number: 2 });

    // Put the row back to how the ALTERs would have left it had these edits been
    // made before the columns existed.
    await db.execute(
      sql`UPDATE board_climbs SET revision_number = 1, holds_revision_number = 1 WHERE uuid = ${climbUuid}`,
    );
    const reset = await revisionColumnsOf(climbUuid);
    await runBackfill();

    const backfilled = await revisionColumnsOf(climbUuid);
    expect(backfilled).toMatchObject({ revision_number: 3, holds_revision_number: 2 });
    expect(backfilled.sync_seq).toBeGreaterThan(reset.sync_seq);
  });

  it('puts the epoch one edit too high after a pace-only edit, which `changes` cannot tell from a hold moving', async () => {
    // The limit the migration's header describes, pinned so nobody reads the
    // backfill as exact. The code leaves the epoch at 1 for this edit.
    const climbUuid = await insertClimb();
    await insertRevisions(climbUuid, { 1: [], 2: ['holds'] });

    await runBackfill();

    expect(await revisionColumnsOf(climbUuid)).toMatchObject({ revision_number: 2, holds_revision_number: 2 });
  });
});

describe('an edit decided on a climb another edit has since changed', () => {
  it('is refused with CLIMB_EDIT_CONFLICT, and leaves the frames and the hold rows agreeing', async () => {
    // The wall owner and the setter both open the climb with frames F0. The
    // owner's edit lands first and moves the holds to F1. The setter's save
    // carries the F0 it loaded plus a rename: decided on the row it read, that is
    // "frames unchanged", so it would write F0 back and skip the hold rewrite,
    // leaving `frames` and `board_climb_holds` describing two different climbs.
    const { wall, holdIds } = await createPublishedWall({ isPublic: true });
    const framesAsLoaded = framesFor(holdIds);
    const framesAfterOwnerEdit = framesFor([holdIds[0], holdIds[2]]);
    const climbUuid = await saveSprayClimb(wall, holdIds, {}, SETTER);
    const [wallRow] = (await db.execute(
      sql`SELECT id FROM spray_walls WHERE layout_id = ${wall.layoutId}`,
    )) as unknown as Array<{ id: string | number }>;

    let lockHeld: () => void = () => undefined;
    const lockIsHeld = new Promise<void>((resolve) => {
      lockHeld = resolve;
    });
    let letTheOwnerCommit: () => void = () => undefined;
    const ownerMayCommit = new Promise<void>((resolve) => {
      letTheOwnerCommit = resolve;
    });

    // The owner's edit, as a transaction that holds the wall lock the way
    // `updateClimb` does, writes what it writes, and commits on cue.
    const ownerEdit = db.transaction(async (tx) => {
      await lockWallForWrite(tx, Number(wallRow.id));
      lockHeld();
      await ownerMayCommit;
      await tx.execute(sql`UPDATE board_climbs SET frames = ${framesAfterOwnerEdit} WHERE uuid = ${climbUuid}`);
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
    letTheOwnerCommit();
    await ownerEdit;

    const { refusedWith } = await setterOutcome;
    expect(refusedWith).toMatchObject({ extensions: { code: 'CLIMB_EDIT_CONFLICT' } });

    // Nothing of the refused edit landed: the owner's frames stand, the hold rows
    // still match them, and no revision was written for an edit that did not happen.
    const [climb] = (await db.execute(
      sql`SELECT name, frames FROM board_climbs WHERE uuid = ${climbUuid}`,
    )) as unknown as Array<{ name: string; frames: string }>;
    expect(climb).toEqual({ name: 'Original name', frames: framesAfterOwnerEdit });
    const holdRows = (await db.execute(
      sql`SELECT hold_id FROM board_climb_holds WHERE climb_uuid = ${climbUuid} ORDER BY hold_id`,
    )) as unknown as Array<{ hold_id: number }>;
    expect([...holdRows].map((row) => Number(row.hold_id))).toEqual([holdIds[0], holdIds[2]]);
    expect(await revisionsOf(climbUuid)).toEqual([]);

    // Reloaded, the same rename goes through.
    await editSpray(climbUuid, { name: 'Renamed' }, SETTER);
    expect((await revisionsOf(climbUuid)).map((revision) => revision.changes)).toEqual([[], ['name']]);
  });
});

describe('climbRevisions', () => {
  it('answers newest first, with the top row current and the editors named', async () => {
    const { wall, holdIds } = await createPublishedWall({ isPublic: true });
    const climbUuid = await saveSprayClimb(wall, holdIds, {}, SETTER);
    await editSpray(climbUuid, { name: 'Setter rename' }, SETTER);
    await editSpray(climbUuid, { userGrade: '7a/V6' }, OWNER);

    const revisions = await readRevisions('spray', climbUuid, STRANGER);
    expect(
      revisions.map((revision) => ({
        revisionNumber: revision.revisionNumber,
        isCurrent: revision.isCurrent,
        name: revision.name,
        difficultyId: revision.difficultyId,
        changes: revision.changes,
        editorId: revision.editor?.id,
        editedBySetter: revision.editedBySetter,
        sprayWallVersionNumber: revision.sprayWallVersionNumber,
      })),
    ).toEqual([
      {
        revisionNumber: 3,
        isCurrent: true,
        name: 'Setter rename',
        difficultyId: 22,
        changes: ['grade'],
        editorId: OWNER,
        editedBySetter: false,
        sprayWallVersionNumber: 1,
      },
      {
        revisionNumber: 2,
        isCurrent: false,
        name: 'Setter rename',
        difficultyId: 18,
        changes: ['name'],
        editorId: SETTER,
        editedBySetter: true,
        sprayWallVersionNumber: 1,
      },
      {
        revisionNumber: 1,
        isCurrent: false,
        name: 'Original name',
        difficultyId: 18,
        changes: [],
        editorId: SETTER,
        editedBySetter: true,
        sprayWallVersionNumber: 1,
      },
    ]);
    expect(revisions[0].editor).toMatchObject({ id: OWNER, displayName: `User ${OWNER}` });
    expect(Number.isFinite(Date.parse(revisions[0].createdAt))).toBe(true);
  });

  it('answers an empty list for a climb nobody has edited', async () => {
    const { wall, holdIds } = await createPublishedWall();
    const climbUuid = await saveSprayClimb(wall, holdIds);
    expect(await readRevisions('spray', climbUuid, OWNER)).toEqual([]);
    expect(await readRevisions('spray', 'NOSUCHCLIMB', OWNER)).toEqual([]);
  });

  it('answers an empty list on a private wall to everyone who cannot see it', async () => {
    const { wall, holdIds } = await createPublishedWall();
    const climbUuid = await saveSprayClimb(wall, holdIds);
    await editSpray(climbUuid, { name: 'Renamed' });

    expect(await readRevisions('spray', climbUuid, OWNER)).toHaveLength(2);
    expect(await readRevisions('spray', climbUuid, STRANGER)).toEqual([]);
    expect(await readRevisions('spray', climbUuid, null)).toEqual([]);
    // The board type is the caller's claim, not the climb's: asking for a spray
    // climb's history as if it were a Kilter climb must not get past the wall.
    expect(await readRevisions('kilter', climbUuid, STRANGER)).toEqual([]);
  });

  it('answers a catalogue climb’s history to anyone', async () => {
    const climbUuid = uuidv4().replace(/-/g, '').toUpperCase();
    const publishedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await db.execute(sql`
      INSERT INTO board_climbs (uuid, board_type, layout_id, name, description, frames, frames_count, frames_pace,
                                angle, is_draft, is_listed, created_at, published_at, user_id, setter_username)
      VALUES (${climbUuid}, 'kilter', 1, 'Kilter original', '', 'p1117r12p1140r15', 1, 0,
              40, false, true, ${publishedAt}, ${publishedAt}, ${SETTER}, 'setter')
    `);
    await climbMutations.updateClimb(
      {},
      { input: { uuid: climbUuid, boardType: 'kilter', name: 'Kilter renamed' } },
      ctxFor(SETTER),
    );

    const revisions = await readRevisions('kilter', climbUuid, null);
    expect(
      revisions.map((revision) => [revision.revisionNumber, revision.name, revision.sprayWallVersionNumber]),
    ).toEqual([
      [2, 'Kilter renamed', null],
      [1, 'Kilter original', null],
    ]);
    expect(revisions[1].createdAt).toBe(publishedAt);
  });
  it('answers `editor: null` once the editor’s account is gone, and keeps the revision', async () => {
    const { wall, holdIds } = await createPublishedWall({ isPublic: true });
    const climbUuid = await saveSprayClimb(wall, holdIds, {}, SETTER);
    await editSpray(climbUuid, { name: 'Setter rename' }, SETTER);
    await editSpray(climbUuid, { name: 'Owner rename' }, OWNER);

    await db.execute(sql`DELETE FROM users WHERE id = ${SETTER}`);

    const revisions = await readRevisions('spray', climbUuid, STRANGER);
    expect(
      revisions.map((revision) => [
        revision.revisionNumber,
        revision.name,
        revision.editor?.id ?? null,
        revision.editedBySetter,
      ]),
    ).toEqual([
      [3, 'Owner rename', OWNER, false],
      // The deleted setter's two rows: still there, with nobody to name. Not
      // "edited by the setter" either, since there is no setter left to match.
      [2, 'Setter rename', null, false],
      [1, 'Original name', null, false],
    ]);
  });

  it('treats a hidden wall as the owner’s alone, a gym admin included', async () => {
    // An admin of the wall's gym can edit the wall, so normally its climbs too.
    // Hiding a wall takes it away from everyone but its owner, and that has to
    // cover both halves: editing a climb, and reading its history.
    const { wall, holdIds } = await createPublishedWall({ isPublic: true });
    const climbUuid = await saveSprayClimb(wall, holdIds, {}, SETTER);
    const gymUuid = uuidv4();
    const [gym] = (await db.execute(sql`
      INSERT INTO gyms (uuid, name, slug, owner_id, is_public, created_at, updated_at)
      VALUES (${gymUuid}, 'Spray Gym', ${gymUuid}, ${OWNER}, true, now(), now())
      RETURNING id
    `)) as unknown as Array<{ id: number }>;
    await db.execute(sql`
      INSERT INTO gym_members (gym_id, user_id, role, created_at) VALUES (${gym.id}, ${STRANGER}, 'admin', now())
    `);
    await db.execute(sql`UPDATE user_boards SET gym_id = ${gym.id} WHERE uuid = ${wall.uuid}`);

    // Before the wall is hidden the gym admin can do both.
    await editSpray(climbUuid, { name: 'Fixed by the gym admin' }, STRANGER);
    expect(await readRevisions('spray', climbUuid, STRANGER)).toHaveLength(2);

    await db.execute(sql`UPDATE spray_walls SET hidden_at = now() WHERE board_uuid = ${wall.uuid}`);

    await expect(editSpray(climbUuid, { name: 'Edited while hidden' }, STRANGER)).rejects.toThrow(
      'You can only update your own climbs',
    );
    expect(await readRevisions('spray', climbUuid, STRANGER)).toEqual([]);
    expect(await readRevisions('spray', climbUuid, null)).toEqual([]);

    // The owner still sees and edits it.
    await editSpray(climbUuid, { name: 'Edited by the owner' }, OWNER);
    expect((await readRevisions('spray', climbUuid, OWNER)).map((revision) => revision.name)).toEqual([
      'Edited by the owner',
      'Fixed by the gym admin',
      'Original name',
    ]);
  });
});

describe('a moved hold restarts the climb’s sends, first ascent and stars (#6023)', () => {
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

  it('drops the count, the first ascent, the stars and the sent mark, and counts a new send', async () => {
    const { wall, holdIds } = await createPublishedWall({ isPublic: true });
    const climbUuid = await saveSprayClimb(wall, holdIds);
    await logTick(climbUuid, OWNER, 'send', 5);
    await logTick(climbUuid, STRANGER, 'send', 3);
    await logTick(climbUuid, SETTER, 'attempt');

    expect(await statsOf('spray', climbUuid)).toMatchObject({
      ascensionist_count: 2,
      fa_username: 'User ' + OWNER,
      quality_average: 4,
      display_difficulty: 18,
    });
    expect(await searchWall(wall, STRANGER, { showOnlyCompleted: true })).toEqual([climbUuid]);
    expect(await searchWall(wall, STRANGER, { hideCompleted: true })).toEqual([]);
    expect(await searchWall(wall, STRANGER, { onlyRatedByMe: true })).toEqual([climbUuid]);
    expect(await searchWall(wall, SETTER, { showOnlyAttempted: true })).toEqual([climbUuid]);
    expect(await searchWall(wall, SETTER, { hideAttempted: true })).toEqual([]);

    // A rename, new notes and a regrade are edits of the same climb: nothing restarts.
    await editSpray(climbUuid, { name: 'Renamed', description: 'New notes' });
    await editSpray(climbUuid, { userGrade: '7a/V6' });
    expect(await revisionColumnsOf(climbUuid)).toMatchObject({ revision_number: 3, holds_revision_number: 1 });
    expect(await statsOf('spray', climbUuid)).toMatchObject({
      ascensionist_count: 2,
      fa_username: 'User ' + OWNER,
      quality_average: 4,
      display_difficulty: 22,
    });
    expect(await searchWall(wall, STRANGER, { showOnlyCompleted: true })).toEqual([climbUuid]);

    // Moving a hold does. The stats are already at zero when updateClimb returns:
    // they were recomputed in its transaction.
    await editSpray(climbUuid, { frames: framesFor([holdIds[0], holdIds[2]]) });
    expect(await revisionColumnsOf(climbUuid)).toMatchObject({ revision_number: 4, holds_revision_number: 4 });
    expect(await statsOf('spray', climbUuid)).toMatchObject({
      ascensionist_count: 0,
      boardsesh_ascensionist_count: 0,
      fa_username: null,
      fa_at: null,
      quality_average: null,
      // The setter's grade is not a statistic and stays.
      display_difficulty: 22,
    });
    expect(await searchWall(wall, STRANGER, { showOnlyCompleted: true })).toEqual([]);
    expect(await searchWall(wall, STRANGER, { hideCompleted: true })).toEqual([climbUuid]);
    expect(await searchWall(wall, STRANGER, { onlyRatedByMe: true })).toEqual([]);
    expect(await searchWall(wall, SETTER, { showOnlyAttempted: true })).toEqual([]);
    expect(await searchWall(wall, SETTER, { hideAttempted: true })).toEqual([climbUuid]);

    // The old ticks are still in the logbook, on the revision they were logged on.
    const oldTicks = (await db.execute(sql`
      SELECT climb_revision FROM boardsesh_ticks WHERE climb_uuid = ${climbUuid}
    `)) as unknown as Array<{ climb_revision: number | null }>;
    expect(oldTicks.map((tick) => tick.climb_revision)).toEqual([1, 1, 1]);

    // A send on the new holds counts, and is the first ascent of them.
    await logTick(climbUuid, STRANGER, 'send', 2);
    expect(await statsOf('spray', climbUuid)).toMatchObject({
      ascensionist_count: 1,
      fa_username: 'User ' + STRANGER,
      quality_average: 2,
      display_difficulty: 22,
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

    await editSpray(climbUuid, { frames: framesFor([holdIds[0], holdIds[2]]) });
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

  it('does not touch the stats row of a climb nobody has sent', async () => {
    const { wall, holdIds } = await createPublishedWall({ isPublic: true });
    const climbUuid = await saveSprayClimb(wall, holdIds);
    await logTick(climbUuid, STRANGER, 'attempt');
    const before = await statsOf('spray', climbUuid);

    await editSpray(climbUuid, { frames: framesFor([holdIds[0], holdIds[2]]) });

    expect(await revisionColumnsOf(climbUuid)).toMatchObject({ holds_revision_number: 2 });
    // Same sync_seq: no write reached the row, so the seeded grade and the
    // setter's name in the first-ascent column are as saveClimb left them.
    expect(await statsOf('spray', climbUuid)).toEqual(before);
    expect(before?.display_difficulty).toBe(18);
  });

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

  it('restarts every angle that has a send on a catalogue climb, and keeps its tick-derived grade', async () => {
    const climbUuid = await insertKilterClimb();
    await insertKilterSend(climbUuid, STRANGER, 40, 20);
    await insertKilterSend(climbUuid, OWNER, 25, 16);
    // A row a setter seeded at an angle nobody has sent: the recompute must not
    // reach it, or it would write the (empty) tick average over the grade.
    await db.execute(sql`
      INSERT INTO board_climb_stats (board_type, climb_uuid, angle, ascensionist_count, display_difficulty, difficulty_average)
      VALUES ('kilter', ${climbUuid}, 55, 0, 24, 24)
    `);
    await recomputeClimbStatsBulk(db, [
      { boardType: 'kilter', climbUuid, angle: 40 },
      { boardType: 'kilter', climbUuid, angle: 25 },
    ]);
    expect(await statsOf('kilter', climbUuid, 40)).toMatchObject({ ascensionist_count: 1, display_difficulty: 20 });
    const seededBefore = await statsOf('kilter', climbUuid, 55);

    // A pace change is a revision of the same holds.
    await climbMutations.updateClimb(
      {},
      { input: { uuid: climbUuid, boardType: 'kilter', framesPace: 900 } },
      ctxFor(SETTER),
    );
    expect(await revisionColumnsOf(climbUuid)).toMatchObject({ revision_number: 2, holds_revision_number: 1 });
    expect(await statsOf('kilter', climbUuid, 40)).toMatchObject({
      ascensionist_count: 1,
      fa_username: 'User ' + STRANGER,
      quality_average: 4,
    });

    await climbMutations.updateClimb(
      {},
      { input: { uuid: climbUuid, boardType: 'kilter', frames: 'p1117r12p1141r15' } },
      ctxFor(SETTER),
    );
    expect(await revisionColumnsOf(climbUuid)).toMatchObject({ revision_number: 3, holds_revision_number: 3 });
    for (const [angle, grade] of [
      [40, 20],
      [25, 16],
    ]) {
      expect(await statsOf('kilter', climbUuid, angle)).toMatchObject({
        ascensionist_count: 0,
        fa_username: null,
        quality_average: null,
        // The grade average reads every send, so the climb keeps its grade.
        display_difficulty: grade,
      });
    }
    expect(await statsOf('kilter', climbUuid, 55)).toEqual(seededBefore);
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
