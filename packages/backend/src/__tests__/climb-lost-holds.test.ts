import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';

/**
 * `Climb.lostHolds` (SW-13, #5446), against the real database.
 *
 * The field is what lets a single-climb surface draw ghost rings where a reset
 * took holds off the wall. Three of the five cases here never touch the database
 * at all — that is the point of them: `missing_hold_count` is already on the
 * climb row, so a catalogue climb and an intact climb must cost no query, and an
 * unknown count must not be guessed either way. The other two are the generation
 * rule: a landed removal is a ghost, a draft's removal is not.
 *
 * Storage is the only stub, exactly as in spray-wall-reset.test.ts — there is no
 * R2 in CI — and everything else is real rows.
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
  uploadToS3: vi.fn(async (_bucket: string, _body: Buffer, key: string) => ({ key })),
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

const { db, dbRead } = await import('../db/client');
const { sprayWallMutations } = await import('../graphql/resolvers/board/spray-walls');
const { climbMutations } = await import('../graphql/resolvers/climbs/mutations');
const { sprayWallPhotoKey } = await import('../handlers/spray-wall-photos');
const { resolveClimbLostHolds } = await import('../graphql/resolvers/climbs/lost-holds');

const OWNER = 'clh-owner';
/** Somebody who has the climb uuid and no business with the wall. */
const STRANGER = 'clh-stranger';

const ANCHORS: [number, number][] = [
  [100, 80],
  [900, 120],
  [880, 700],
  [120, 660],
];

/** A square-ish ring, in radius units relative to the hold's centre. */
const DIAMOND = [1, 0, 0, 1, -1, 0, 0, -1];

/**
 * Three holds far enough apart that the matcher could never confuse them — the
 * same spacing spray-wall-reset.test.ts uses — each with an outline, because a
 * ghost ring is drawn from the silhouette when there is one.
 */
const BASE_HOLDS = [
  { cx: 100, cy: 120, r: 24, outline: DIAMOND },
  { cx: 300, cy: 400, r: 30, outline: DIAMOND },
  { cx: 520, cy: 560, r: 18, outline: DIAMOND },
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

/** Wall, photo, draft version, three holds, publish. */
async function createPublishedWall(): Promise<{ wall: CreatedWall; holdIds: number[] }> {
  const wall = (await sprayWallMutations.createSprayWall(
    {},
    { input: { name: `Wall ${uuidv4().slice(0, 6)}`, angle: 40 } },
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
    { input: { wallUuid: wall.uuid, versionId: version.id, holds: BASE_HOLDS } },
    ctxFor(OWNER),
  )) as Array<{ id: number }>;

  await sprayWallMutations.publishSprayWallVersion({}, { input: { versionId: version.id } }, ctxFor(OWNER));
  return { wall, holdIds: holds.map((hold) => hold.id) };
}

/** Open the next draft on a wall and hand back its version id. */
async function openDraft(wall: CreatedWall): Promise<string> {
  const photoId = registerUploadedPhoto(wall.uuid);
  const version = (await sprayWallMutations.createSprayWallVersion(
    {},
    { input: { wallUuid: wall.uuid, photoId, anchors: ANCHORS } },
    ctxFor(OWNER),
  )) as { id: string };
  return version.id;
}

function framesFor(holdIds: number[]): string {
  const roles = [1, 2, 3];
  return holdIds.map((holdId, index) => `p${holdId}r${roles[index] ?? 2}`).join('');
}

async function saveClimbOn(wall: CreatedWall, name: string, holdIds: number[]): Promise<string> {
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

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE TABLE "spray_walls", "user_boards", "gym_members", "gyms",
                   "board_climbs", "board_climb_holds", "board_climb_stats",
                   "board_layouts", "board_product_sizes", "board_product_sizes_layouts_sets",
                   "board_holes", "board_placements", "board_difficulty_grades",
                   "boardsesh_ticks", "user_follows"
    RESTART IDENTITY CASCADE
  `);
  await db.execute(sql`ALTER SEQUENCE spray_wall_catalog_id_seq RESTART WITH 1`);
  await db.execute(sql`ALTER SEQUENCE spray_hold_catalog_id_seq RESTART WITH 1`);

  await insertUser(OWNER);

  await db.execute(sql`
    INSERT INTO board_difficulty_grades (board_type, difficulty, boulder_name, route_name, is_listed)
    VALUES ('spray', 10, '4a/V0', '5b/5.9', true),
           ('spray', 18, '6b/V4', '7a/5.11d', true)
    ON CONFLICT (board_type, difficulty) DO NOTHING
  `);

  storedPhotoMetadata.clear();
});

afterEach(() => {
  // `clearAllMocks`, not `restoreAllMocks`: the module mocks above are `vi.fn`s
  // carrying the implementations this whole file depends on, and restoring them
  // would strip those. The three query spies restore themselves instead.
  vi.clearAllMocks();
});

describe('Climb.lostHolds answers the cheap cases without a query', () => {
  it('returns null on a catalogue board, where holds do not come off', async () => {
    const select = vi.spyOn(dbRead, 'select');

    await expect(
      resolveClimbLostHolds({ uuid: 'kilter-climb', boardType: 'kilter', missingHoldCount: 3 }, ctxFor(OWNER)),
    ).resolves.toBe(null);
    expect(select).not.toHaveBeenCalled();
    select.mockRestore();
  });

  it('returns [] for an intact spray climb', async () => {
    const select = vi.spyOn(dbRead, 'select');

    await expect(
      resolveClimbLostHolds({ uuid: 'spray-climb', boardType: 'spray', missingHoldCount: 0 }, ctxFor(OWNER)),
    ).resolves.toEqual([]);
    expect(select).not.toHaveBeenCalled();
    select.mockRestore();
  });

  it('returns null when the count is unknown, rather than guessing', async () => {
    // Null is "the producer did not project the column", not "nothing is
    // missing": answering [] would tell the client the climb is whole.
    const select = vi.spyOn(dbRead, 'select');

    await expect(
      resolveClimbLostHolds({ uuid: 'spray-climb', boardType: 'spray', missingHoldCount: null }, ctxFor(OWNER)),
    ).resolves.toBe(null);
    expect(select).not.toHaveBeenCalled();
    select.mockRestore();
  });
});

describe('Climb.lostHolds after a reset', () => {
  /**
   * One wall, one reset, three questions — deliberately a single test rather
   * than three.
   *
   * Every backend run in every worktree shares one worker database, and both
   * `setup.ts` and this file's `beforeEach` `TRUNCATE ... CASCADE`, which reaches
   * `spray_walls` through `users` -> `user_boards`. A second run overlapping this
   * one deletes the wall mid-test, which surfaces as "Spray wall not found" from
   * whichever mutation happened to be in flight. Building the fixture once keeps
   * that window as short as the assertions allow.
   */
  it('returns the holds a landed reset took off, and nothing else', async () => {
    const { wall, holdIds } = await createPublishedWall();
    const climbUuid = await saveClimbOn(wall, 'Loses two', holdIds);

    const versionId = await openDraft(wall);
    await sprayWallMutations.commitSprayWallVersion(
      {},
      {
        input: {
          wallUuid: wall.uuid,
          versionId,
          kept: [{ holdId: holdIds[2] }],
          removed: [holdIds[0], holdIds[1]],
          added: [{ detection: { cx: 640, cy: 300, r: 26 }, movedFromHoldId: holdIds[0] }],
        },
      },
      ctxFor(OWNER),
    );

    // Two of the climb's three holds came off, so the materialised count — the
    // one the resolver is handed — says 2.
    expect(await missingFor(climbUuid)).toBe(2);

    const lost = await resolveClimbLostHolds(
      { uuid: climbUuid, boardType: 'spray', missingHoldCount: await missingFor(climbUuid) },
      ctxFor(OWNER),
    );

    // Both lost holds, in hold-id order, with the geometry they had on the wall
    // and the generation that installed and removed each. The third hold is
    // still there and must not appear.
    expect(lost).toEqual([
      {
        id: holdIds[0],
        cx: BASE_HOLDS[0].cx,
        cy: BASE_HOLDS[0].cy,
        r: BASE_HOLDS[0].r,
        outline: DIAMOND,
        installedVersion: 1,
        removedVersion: 2,
        movedFromHoldId: null,
        source: 'MANUAL',
        confidence: null,
      },
      {
        id: holdIds[1],
        cx: BASE_HOLDS[1].cx,
        cy: BASE_HOLDS[1].cy,
        r: BASE_HOLDS[1].r,
        outline: DIAMOND,
        installedVersion: 1,
        removedVersion: 2,
        movedFromHoldId: null,
        source: 'MANUAL',
        confidence: null,
      },
    ]);

    // Now the generation rule. An abandoned draft owns a version number and can
    // stamp `removed_version_id`; honouring it would draw a ghost ring over a
    // hold still bolted to the wall, for every climber, the moment an owner
    // started a reset and walked away.
    const draftVersionId = await openDraft(wall);
    await db.execute(sql`
      UPDATE spray_wall_holds SET removed_version_id = ${Number(draftVersionId)}
      WHERE hold_id = ${holdIds[2]}
    `);

    const [draft] = (await db.execute(
      sql`SELECT status FROM spray_wall_versions WHERE id = ${Number(draftVersionId)}`,
    )) as unknown as Array<{ status: string }>;
    expect(draft.status).toBe('draft');

    // The count is deliberately 3 — a lie the draft's removal would make true —
    // so the resolver cannot pass by short-circuiting on the number instead of
    // applying the landed bound.
    const afterDraft = await resolveClimbLostHolds(
      { uuid: climbUuid, boardType: 'spray', missingHoldCount: 3 },
      ctxFor(OWNER),
    );

    expect(afterDraft?.map((hold) => hold.id)).toEqual([holdIds[0], holdIds[1]]);

    // ====================================================================
    // And now the privacy rule, on the same fixture.
    //
    // A `Climb` parent is not proof that this server read a row: the queue
    // broadcasts climbs as `ClimbInput`, so a caller who once had this wall
    // shared with them — or who simply holds the climb uuid — can send back a
    // synthetic parent claiming spray and a positive count, and select
    // `lostHolds` on it. The wall here is PRIVATE (created with no visibility
    // flags), so the geometry of its removed holds is the inside of somebody's
    // garage.
    // ====================================================================
    const forgedParent = { uuid: climbUuid, boardType: 'spray' as const, missingHoldCount: 99 };

    // A signed-in stranger with the uuid and a forged count gets an empty list:
    // byte for byte what an intact climb on a visible wall returns, so the field
    // is not an oracle for which climb uuids belong to private walls.
    await insertUser(STRANGER);
    await expect(resolveClimbLostHolds(forgedParent, ctxFor(STRANGER))).resolves.toEqual([]);

    // So does an anonymous caller.
    await expect(resolveClimbLostHolds(forgedParent, ctxFor(null))).resolves.toEqual([]);
    await expect(resolveClimbLostHolds(forgedParent, null)).resolves.toEqual([]);

    // The owner still gets the geometry — the check narrows the query, it does
    // not disable the field.
    const asOwner = await resolveClimbLostHolds(forgedParent, ctxFor(OWNER));
    expect(asOwner?.map((hold) => hold.id)).toEqual([holdIds[0], holdIds[1]]);

    // And once the owner shares the wall, the stranger sees the same rows: the
    // rule is the wall's visibility and nothing about who is asking for what.
    await db.execute(sql`
      UPDATE user_boards SET is_public = true
      WHERE uuid = (SELECT board_uuid FROM spray_walls WHERE layout_id = ${wall.layoutId})
    `);
    const asStrangerOnPublicWall = await resolveClimbLostHolds(forgedParent, ctxFor(STRANGER));
    expect(asStrangerOnPublicWall?.map((hold) => hold.id)).toEqual([holdIds[0], holdIds[1]]);
  });
});
