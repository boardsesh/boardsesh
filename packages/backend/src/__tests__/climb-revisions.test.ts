import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
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
const { sprayWallMutations } = await import('../graphql/resolvers/board/spray-walls');
const { climbMutations } = await import('../graphql/resolvers/climbs/mutations');
const { climbQueries } = await import('../graphql/resolvers/climbs/queries');
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
});
