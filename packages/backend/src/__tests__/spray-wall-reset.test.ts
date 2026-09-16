import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';

/**
 * Spray wall resets end to end, against the real database (SW-12, #5445).
 *
 * The acceptance case is one wall, three climbs and one hold that comes off:
 * two climbs lose it, one does not, and afterwards the badge, the Intact / Lost
 * holds filter and the remix seed all have to agree about which is which. The
 * rest of this file is the three ways that agreement breaks:
 *
 *  - **A removal that has not landed.** An abandoned draft owns a version number
 *    and can stamp `removed_version_id`, so a count without the landed bound
 *    would badge every climb on the wall as broken the moment an owner started a
 *    reset and walked away — and the number would never come back on its own.
 *  - **Two commits racing.** A reset decides on a read and then writes on the
 *    strength of it; without the wall lock the second commit would publish over
 *    the first, superseding the wrong generation.
 *  - **Visibility.** A wall is a photograph of somebody's home, and `remixClimb`
 *    is a reader like any other: a stranger must not learn a private wall's
 *    climbs exist by asking to remix one.
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
  // The public-promotion path a wall takes when it is made public. Reached from
  // here because `remixClimb`'s visibility case flips a PRIVATE wall to public
  // mid-test; `storedPhotoMetadata` is what exists in the private bucket, so a
  // copy of a key nothing uploaded answers null exactly like the real one does.
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

/**
 * The three holds every wall in this file starts with.
 *
 * Far apart on purpose: the matcher's distance gate is six tenths of the pair's
 * mean radius, so holds this far apart can never be mistaken for one another and
 * a "removed" in a proposal means the detection really was absent.
 */
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

/** Open the next draft on a wall and hand back its version id. */
async function openDraft(wall: CreatedWall, owner = OWNER): Promise<string> {
  const photoId = registerUploadedPhoto(wall.uuid);
  const version = (await sprayWallMutations.createSprayWallVersion(
    {},
    { input: { wallUuid: wall.uuid, photoId, anchors: ANCHORS } },
    ctxFor(owner),
  )) as { id: string };
  return version.id;
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

/** The search the Intact / Lost holds filter drives, straight through the real SQL. */
async function searchNames(wall: CreatedWall, holdIntegrity?: 'intact' | 'broken'): Promise<string[]> {
  const result = await searchClimbs(
    { board_name: 'spray', layout_id: wall.layoutId, size_id: wall.sizeId, set_ids: [1], angle: 40 },
    { page: 0, pageSize: 50, sortBy: 'name', sortOrder: 'asc', holdIntegrity },
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

describe('proposeSprayWallReset', () => {
  it('reports kept / removed / added and how many climbs the removal breaks', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);
    await saveClimbOn(wall, 'Uses the doomed hold', [holdIds[0], holdIds[1]]);
    await saveClimbOn(wall, 'Also uses it', [holdIds[1], holdIds[2]]);
    await saveClimbOn(wall, 'Avoids it', [holdIds[0], holdIds[2]]);

    const versionId = await openDraft(wall);

    // The new photo: two of the three holds still there, the middle one gone, and
    // two new ones bolted on.
    const detections = [
      { cx: 100, cy: 120, r: 24 },
      { cx: 520, cy: 560, r: 18 },
      { cx: 200, cy: 250, r: 22 },
      { cx: 640, cy: 300, r: 26 },
    ];

    const proposal = (await sprayWallQueries.proposeSprayWallReset(
      {},
      { input: { wallUuid: wall.uuid, versionId, detections } },
      ctxFor(OWNER),
    )) as {
      versionNumber: number;
      kept: Array<{ holdId: number; detectionIndex: number }>;
      removed: number[];
      added: number[];
      climbsAffected: number;
      aspectMismatch: boolean;
    } | null;

    expect(proposal).not.toBeNull();
    expect(proposal!.versionNumber).toBe(2);
    expect(proposal!.kept.map((hold) => hold.holdId).sort((a, b) => a - b)).toEqual([holdIds[0], holdIds[2]]);
    expect(proposal!.removed).toEqual([holdIds[1]]);
    expect(proposal!.added.sort((a, b) => a - b)).toEqual([2, 3]);
    // Two of the three climbs use the doomed hold.
    expect(proposal!.climbsAffected).toBe(2);
  });

  it('writes nothing at all', async () => {
    // A client re-runs this on every drag of a hold; if it wrote, the wall would
    // drift under the owner while they were still deciding.
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const versionId = await openDraft(wall);

    const before = await db.execute(sql`SELECT hold_id, removed_version_id FROM spray_wall_holds ORDER BY hold_id`);

    await sprayWallQueries.proposeSprayWallReset(
      {},
      { input: { wallUuid: wall.uuid, versionId, detections: [] } },
      ctxFor(OWNER),
    );

    const after = await db.execute(sql`SELECT hold_id, removed_version_id FROM spray_wall_holds ORDER BY hold_id`);
    expect(after).toEqual(before);
    expect(await missingFor(await saveClimbOn(wall, 'Untouched', [holdIds[0]]))).toBe(0);
  });

  it('refuses a version that is no longer a draft', async () => {
    // A proposal only means anything against a draft. Against the published
    // version it would describe a commit that can never happen — and the commit
    // would refuse it a moment later, after the owner had reviewed a whole screen
    // of decisions.
    const { wall } = await createPublishedWall(OWNER);
    const [published] = (await db.execute(sql`
      SELECT id FROM spray_wall_versions
      WHERE wall_id = (SELECT id FROM spray_walls WHERE layout_id = ${wall.layoutId}) AND status = 'published'
    `)) as unknown as Array<{ id: string }>;

    await expect(
      sprayWallQueries.proposeSprayWallReset(
        {},
        { input: { wallUuid: wall.uuid, versionId: String(published.id), detections: [] } },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(/already published/i);
  });

  it('refuses a reset draft with no anchors, and so does the commit', async () => {
    // The canonical frame is version 1's photo, forever. Without anchors the
    // second photo gets the identity homography again — an assertion that it has
    // the same crop and dimensions as the first, which no phone honours. The
    // detections then arrive as raw photo pixels labelled canonical and the
    // matcher reports the whole wall removed and the whole photo added.
    const { wall } = await createPublishedWall(OWNER);
    const photoId = registerUploadedPhoto(wall.uuid);
    const version = (await sprayWallMutations.createSprayWallVersion(
      {},
      { input: { wallUuid: wall.uuid, photoId } },
      ctxFor(OWNER),
    )) as { id: string };

    await expect(
      sprayWallQueries.proposeSprayWallReset(
        {},
        { input: { wallUuid: wall.uuid, versionId: version.id, detections: [] } },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(/tap the four corners/i);

    // …and the commit refuses it too, because a client is free to skip the
    // proposal and this is the call that writes.
    await expect(
      sprayWallMutations.commitSprayWallVersion(
        {},
        { input: { wallUuid: wall.uuid, versionId: version.id, kept: [], removed: [], added: [] } },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(/tap the four corners/i);

    const [row] = (await db.execute(
      sql`SELECT status FROM spray_wall_versions WHERE id = ${version.id}`,
    )) as unknown as Array<{ status: string }>;
    expect(row.status).toBe('draft');
  });

  it('still accepts version 1 without anchors, where the photo IS the frame', async () => {
    // Version 1 has nothing to compare against, so the identity homography is true
    // by definition rather than a fallback — and `createPublishedWall` would have
    // had nowhere to get anchors from either.
    const wall = (await sprayWallMutations.createSprayWall(
      {},
      { input: { name: `Wall ${uuidv4().slice(0, 6)}`, angle: 40 } },
      ctxFor(OWNER),
    )) as CreatedWall;
    const photoId = registerUploadedPhoto(wall.uuid);
    const version = (await sprayWallMutations.createSprayWallVersion(
      {},
      { input: { wallUuid: wall.uuid, photoId } },
      ctxFor(OWNER),
    )) as { id: string; number: number };
    expect(version.number).toBe(1);

    await expect(
      sprayWallMutations.commitSprayWallVersion(
        {},
        {
          input: {
            wallUuid: wall.uuid,
            versionId: version.id,
            kept: [],
            removed: [],
            added: [{ detection: { cx: 100, cy: 120, r: 24 } }],
          },
        },
        ctxFor(OWNER),
      ),
    ).resolves.toBeTruthy();
  });

  it('refuses a caller who cannot edit the wall', async () => {
    const { wall } = await createPublishedWall(OWNER);
    const versionId = await openDraft(wall);
    await expect(
      sprayWallQueries.proposeSprayWallReset(
        {},
        { input: { wallUuid: wall.uuid, versionId, detections: [] } },
        ctxFor(STRANGER),
      ),
    ).rejects.toThrow();
  });

  it('warns — and only warns — when the new photo is a different shape', async () => {
    // Epic decision 2026-09-14: a reset with a very different aspect ratio warns,
    // never blocks. The owner photographed their own wall from somewhere else.
    const { wall } = await createPublishedWall(OWNER);
    const photoId = registerUploadedPhoto(wall.uuid, { width: 900, height: 1600 });
    const version = (await sprayWallMutations.createSprayWallVersion(
      {},
      // Anchored, like every reset must be — the 800x620 canonical frame it
      // inherits is a different shape from this 900x1600 photo, which is exactly
      // the disagreement the warning is about.
      { input: { wallUuid: wall.uuid, photoId, anchors: ANCHORS } },
      ctxFor(OWNER),
    )) as { id: string };

    const proposal = (await sprayWallQueries.proposeSprayWallReset(
      {},
      { input: { wallUuid: wall.uuid, versionId: version.id, detections: [] } },
      ctxFor(OWNER),
    )) as { aspectMismatch: boolean };

    expect(proposal.aspectMismatch).toBe(true);
    // …and it still commits.
    await expect(
      sprayWallMutations.commitSprayWallVersion(
        {},
        { input: { wallUuid: wall.uuid, versionId: version.id, kept: [], removed: [], added: [] } },
        ctxFor(OWNER),
      ),
    ).resolves.toBeTruthy();
  });
});

describe('commitSprayWallVersion', () => {
  it('lands the reset: two climbs lose a hold, the third does not, and search agrees', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const first = await saveClimbOn(wall, 'Alpha loses a hold', [holdIds[0], holdIds[1]]);
    const second = await saveClimbOn(wall, 'Bravo loses a hold', [holdIds[1], holdIds[2]]);
    const untouched = await saveClimbOn(wall, 'Charlie is intact', [holdIds[0], holdIds[2]]);

    const versionId = await openDraft(wall);
    const result = (await sprayWallMutations.commitSprayWallVersion(
      {},
      {
        input: {
          wallUuid: wall.uuid,
          versionId,
          kept: [
            { holdId: holdIds[0], detection: { cx: 100, cy: 120, r: 24, outline: [1, 0, 0, 1, -1, 0, 0, -1] } },
            { holdId: holdIds[2] },
          ],
          removed: [holdIds[1]],
          added: [{ detection: { cx: 200, cy: 250, r: 22 }, movedFromHoldId: holdIds[1] }],
        },
      },
      ctxFor(OWNER),
    )) as {
      version: { number: number; status: string };
      keptCount: number;
      removedCount: number;
      addedCount: number;
      climbsChanged: number;
    };

    expect(result.version.number).toBe(2);
    expect(result.version.status).toBe('PUBLISHED');
    expect([result.keptCount, result.removedCount, result.addedCount]).toEqual([2, 1, 1]);
    // Two climbs' numbers moved; the third was already 0 and is not rewritten.
    expect(result.climbsChanged).toBe(2);

    expect(await missingFor(first)).toBe(1);
    expect(await missingFor(second)).toBe(1);
    expect(await missingFor(untouched)).toBe(0);

    // The Intact / Lost holds filter, through the real search SQL.
    expect(await searchNames(wall, 'intact')).toEqual(['Charlie is intact']);
    expect(await searchNames(wall, 'broken')).toEqual(['Alpha loses a hold', 'Bravo loses a hold']);
    expect(await searchNames(wall)).toEqual(['Alpha loses a hold', 'Bravo loses a hold', 'Charlie is intact']);

    // The removed hold's rows are still there: a climb that lost it has to stay
    // findable, and its placement is what that climb's frames string resolves to.
    const [placement] = (await db.execute(
      sql`SELECT count(*)::int AS rows FROM board_placements WHERE board_type = 'spray' AND id = ${holdIds[1]}`,
    )) as unknown as Array<{ rows: number }>;
    expect(placement.rows).toBe(1);
  });

  it('keeps a kept hold exactly where it was published, and takes only its outline', async () => {
    // Every climb on the wall renders from cx/cy/r. A kept hold matched its
    // detection within six tenths of a radius — real, and enough to shift a
    // climb's start hold under the climber if it were written through.
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const versionId = await openDraft(wall);

    await sprayWallMutations.commitSprayWallVersion(
      {},
      {
        input: {
          wallUuid: wall.uuid,
          versionId,
          kept: [{ holdId: holdIds[0], detection: { cx: 111, cy: 133, r: 29, outline: [1, 0, 0, 1, -1, 0, 0, -1] } }],
          removed: [],
          added: [],
        },
      },
      ctxFor(OWNER),
    );

    const [hold] = (await db.execute(
      sql`SELECT cx, cy, r, outline FROM spray_wall_holds WHERE hold_id = ${holdIds[0]}`,
    )) as unknown as Array<{ cx: number; cy: number; r: number; outline: number[] | null }>;
    expect([hold.cx, hold.cy, hold.r]).toEqual([100, 120, 24]);
    expect(hold.outline).toEqual([1, 0, 0, 1, -1, 0, 0, -1]);
  });

  it('refuses a hold that is not on the wall', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const versionId = await openDraft(wall);

    await expect(
      sprayWallMutations.commitSprayWallVersion(
        {},
        {
          input: { wallUuid: wall.uuid, versionId, kept: [], removed: [holdIds[2] + 9000], added: [] },
        },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(/is not on this wall/i);
  });

  it('refuses a batch that both keeps and removes the same hold', async () => {
    // Not a contradiction the server can resolve: whichever it applied second
    // would win silently, and one of the two decisions the owner made on that
    // screen would vanish without a word.
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const versionId = await openDraft(wall);

    await expect(
      sprayWallMutations.commitSprayWallVersion(
        {},
        {
          input: {
            wallUuid: wall.uuid,
            versionId,
            kept: [{ holdId: holdIds[0] }],
            removed: [holdIds[0]],
            added: [],
          },
        },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(/both kept and removed/i);

    // Nothing landed: the version is still a draft.
    const [row] = (await db.execute(
      sql`SELECT status FROM spray_wall_versions WHERE id = ${versionId}`,
    )) as unknown as Array<{ status: string }>;
    expect(row.status).toBe('draft');
  });

  it('refuses a movedFromHoldId that belongs to another wall', async () => {
    // `moved_from_hold_id` is lineage, and remix walks it to suggest a successor.
    // A pointer at another wall's hold would offer a climber a hold that is not on
    // their wall — and the FK cannot catch it, because the column carries no FK.
    // It fails on the same rule a stray same-wall predecessor does: it is not in
    // this reset's removals, and nothing outside them can be a predecessor.
    const { wall } = await createPublishedWall(OWNER);
    const { holdIds: otherWallHoldIds } = await createPublishedWall(OWNER);
    const versionId = await openDraft(wall);

    await expect(
      sprayWallMutations.commitSprayWallVersion(
        {},
        {
          input: {
            wallUuid: wall.uuid,
            versionId,
            kept: [],
            removed: [],
            added: [{ detection: { cx: 200, cy: 250, r: 22 }, movedFromHoldId: otherWallHoldIds[0] }],
          },
        },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(/not coming off the wall in this reset/i);

    // And the whole commit rolled back — no orphan hold, no publish.
    const [counts] = (await db.execute(sql`
      SELECT (SELECT count(*)::int FROM spray_wall_holds
              WHERE wall_id = (SELECT id FROM spray_walls WHERE layout_id = ${wall.layoutId})) AS holds,
             (SELECT status FROM spray_wall_versions WHERE id = ${versionId}) AS status
    `)) as unknown as Array<{ holds: number; status: string }>;
    expect([counts.holds, counts.status]).toEqual([3, 'draft']);
  });

  it('refuses a movedFromHoldId that is still alive on the wall', async () => {
    // Two holds would then claim one position, and the day a later reset took the
    // predecessor off, remix would offer this unrelated older hold as its
    // successor — with nothing left to notice the mistake.
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const versionId = await openDraft(wall);

    await expect(
      sprayWallMutations.commitSprayWallVersion(
        {},
        {
          input: {
            wallUuid: wall.uuid,
            versionId,
            kept: [],
            removed: [],
            added: [{ detection: { cx: 200, cy: 250, r: 22 }, movedFromHoldId: holdIds[0] }],
          },
        },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(/not coming off the wall in this reset/i);
  });

  it('refuses a movedFromHoldId an EARLIER reset already removed', async () => {
    // That generation is history: its successor was decided then, or it had none.
    // Back-filling one now rewrites a generation that is already published.
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const firstReset = await openDraft(wall);
    await sprayWallMutations.commitSprayWallVersion(
      {},
      { input: { wallUuid: wall.uuid, versionId: firstReset, kept: [], removed: [holdIds[0]], added: [] } },
      ctxFor(OWNER),
    );

    const secondReset = await openDraft(wall);
    await expect(
      sprayWallMutations.commitSprayWallVersion(
        {},
        {
          input: {
            wallUuid: wall.uuid,
            versionId: secondReset,
            kept: [],
            removed: [],
            added: [{ detection: { cx: 200, cy: 250, r: 22 }, movedFromHoldId: holdIds[0] }],
          },
        },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(/not coming off the wall in this reset/i);
  });

  it('accepts a movedFromHoldId that is in THIS reset removals, and links the pair', async () => {
    // The definition of a move: one removal and one addition, in one sitting.
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const versionId = await openDraft(wall);

    await sprayWallMutations.commitSprayWallVersion(
      {},
      {
        input: {
          wallUuid: wall.uuid,
          versionId,
          kept: [{ holdId: holdIds[0] }, { holdId: holdIds[2] }],
          removed: [holdIds[1]],
          added: [{ detection: { cx: 320, cy: 415, r: 28 }, movedFromHoldId: holdIds[1] }],
        },
      },
      ctxFor(OWNER),
    );

    const [link] = (await db.execute(sql`
      SELECT hold_id FROM spray_wall_holds
      WHERE wall_id = (SELECT id FROM spray_walls WHERE layout_id = ${wall.layoutId})
        AND moved_from_hold_id = ${holdIds[1]}
    `)) as unknown as Array<{ hold_id: number }>;
    expect(link.hold_id).toBeGreaterThan(holdIds[2]);
  });

  it('refuses two additions claiming the same predecessor', async () => {
    // A hold has ONE successor. Two would both get a `moved_from_hold_id` row, and
    // `remixClimb` walks that column the other way — so the climber would be
    // offered two successors with nothing to say which replaced the hold.
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const versionId = await openDraft(wall);

    await expect(
      sprayWallMutations.commitSprayWallVersion(
        {},
        {
          input: {
            wallUuid: wall.uuid,
            versionId,
            kept: [{ holdId: holdIds[0] }, { holdId: holdIds[2] }],
            removed: [holdIds[1]],
            added: [
              { detection: { cx: 320, cy: 415, r: 28 }, movedFromHoldId: holdIds[1] },
              { detection: { cx: 340, cy: 430, r: 26 }, movedFromHoldId: holdIds[1] },
            ],
          },
        },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(/moved from the same hold/i);
  });

  it('refuses two additions at the same place', async () => {
    // Same centre and radius is the same hold twice. Both would land — different
    // catalogue ids, no DB conflict — leaving the wall carrying a duplicate every
    // hold read returns and the editor cannot tell apart.
    const { wall } = await createPublishedWall(OWNER);
    const versionId = await openDraft(wall);

    await expect(
      sprayWallMutations.commitSprayWallVersion(
        {},
        {
          input: {
            wallUuid: wall.uuid,
            versionId,
            kept: [],
            removed: [],
            added: [{ detection: { cx: 200, cy: 250, r: 22 } }, { detection: { cx: 200, cy: 250, r: 22 } }],
          },
        },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(/same place/i);
  });

  it('refreshes every kept outline in one statement', async () => {
    // One round trip for the batch, not one per hold: a capped wall keeps 1,500
    // holds, and a statement each would hold the wall lock open for 1,500 of them.
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const versionId = await openDraft(wall);

    const diamond = [1, 0, 0, 1, -1, 0, 0, -1];
    const square = [1, 1, -1, 1, -1, -1, 1, -1];
    await sprayWallMutations.commitSprayWallVersion(
      {},
      {
        input: {
          wallUuid: wall.uuid,
          versionId,
          kept: [
            { holdId: holdIds[0], detection: { cx: 100, cy: 120, r: 24, outline: diamond } },
            // No detection: keeps whatever it had, which is nothing.
            { holdId: holdIds[1] },
            { holdId: holdIds[2], detection: { cx: 520, cy: 560, r: 18, outline: square } },
          ],
          removed: [],
          added: [],
        },
      },
      ctxFor(OWNER),
    );

    const rows = (await db.execute(sql`
      SELECT hold_id, outline, cx, cy, r FROM spray_wall_holds
      WHERE wall_id = (SELECT id FROM spray_walls WHERE layout_id = ${wall.layoutId})
      ORDER BY hold_id
    `)) as unknown as Array<{ hold_id: number; outline: number[] | null; cx: number; cy: number; r: number }>;

    expect(rows.map((row) => row.outline)).toEqual([diamond, null, square]);
    // …and every kept hold is still exactly where it was published.
    expect(rows.map((row) => [row.cx, row.cy, row.r])).toEqual([
      [100, 120, 24],
      [300, 400, 30],
      [520, 560, 18],
    ]);
  });

  it('refuses to publish into a wall that has been deleted', async () => {
    // The OUTER gate: `loadEditableWall` resolves a live wall only, so a wall
    // already deleted when the call arrives never reaches the transaction. The
    // inner guard — a delete that commits in the window between that read and the
    // wall lock — is a window rather than a state, so it is pinned at source in
    // spray-wall-write-locks.test.ts instead of raced here.
    const { wall } = await createPublishedWall(OWNER);
    const versionId = await openDraft(wall);
    await sprayWallMutations.deleteSprayWall({}, { uuid: wall.uuid }, ctxFor(OWNER));

    await expect(
      sprayWallMutations.commitSprayWallVersion(
        {},
        { input: { wallUuid: wall.uuid, versionId, kept: [], removed: [], added: [] } },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(/not found/i);

    const [row] = (await db.execute(
      sql`SELECT status FROM spray_wall_versions WHERE id = ${versionId}`,
    )) as unknown as Array<{ status: string }>;
    expect(row.status).toBe('draft');
  });

  it('un-stamps every removal when the draft is discarded instead', async () => {
    // Discard DELETES a draft, and it has to undo what the draft removed first —
    // `removed_version_id` is RESTRICT, and a stamp left behind would badge climbs
    // as broken for a reset that never happened.
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const climb = await saveClimbOn(wall, 'Romeo', [holdIds[0], holdIds[1]]);

    const versionId = await openDraft(wall);
    await sprayWallMutations.removeSprayWallHolds(
      {},
      { input: { wallUuid: wall.uuid, versionId, holdIds: [holdIds[0], holdIds[1]] } },
      ctxFor(OWNER),
    );
    const [stamped] = (await db.execute(sql`
      SELECT count(*)::int AS stamped FROM spray_wall_holds WHERE removed_version_id = ${versionId}
    `)) as unknown as Array<{ stamped: number }>;
    expect(stamped.stamped).toBe(2);

    await sprayWallMutations.discardSprayWallVersion({}, { input: { versionId } }, ctxFor(OWNER));

    const rows = (await db.execute(sql`
      SELECT hold_id, removed_version_id FROM spray_wall_holds
      WHERE wall_id = (SELECT id FROM spray_walls WHERE layout_id = ${wall.layoutId})
      ORDER BY hold_id
    `)) as unknown as Array<{ hold_id: number; removed_version_id: string | null }>;
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.removed_version_id === null)).toBe(true);

    // The version row is gone, and the climb was never broken.
    const [versions] = (await db.execute(
      sql`SELECT count(*)::int AS versions FROM spray_wall_versions WHERE id = ${versionId}`,
    )) as unknown as Array<{ versions: number }>;
    expect(versions.versions).toBe(0);
    expect(await missingFor(climb)).toBe(0);
    expect(await searchNames(wall, 'intact')).toEqual(['Romeo']);
  });

  it('rejects a second commit on a version that has already landed', async () => {
    // The stale-versionId case from the issue's acceptance: a client holding a
    // proposal from before somebody else committed must not be able to replay it.
    const { wall } = await createPublishedWall(OWNER);
    const versionId = await openDraft(wall);
    const commit = () =>
      sprayWallMutations.commitSprayWallVersion(
        {},
        { input: { wallUuid: wall.uuid, versionId, kept: [], removed: [], added: [] } },
        ctxFor(OWNER),
      );

    await commit();
    await expect(commit()).rejects.toThrow(/already published/i);
  });

  it('serialises two concurrent commits on the same wall under the wall lock', async () => {
    // Fired together, they contend on `pg_advisory_xact_lock(wall)`. One publishes;
    // the other waits for the lock, re-reads the version under it and finds it is
    // no longer a draft — which is the clean failure, not two publishes racing.
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const versionId = await openDraft(wall);

    const commit = () =>
      sprayWallMutations.commitSprayWallVersion(
        {},
        { input: { wallUuid: wall.uuid, versionId, kept: [], removed: [holdIds[1]], added: [] } },
        ctxFor(OWNER),
      );

    const outcomes = await Promise.allSettled([commit(), commit()]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // Exactly one publish happened: the wall sits at version 2 with one version
    // published, not two.
    const [counts] = (await db.execute(sql`
      SELECT count(*) FILTER (WHERE status = 'published')::int AS published,
             count(*) FILTER (WHERE status = 'superseded')::int AS superseded
      FROM spray_wall_versions
      WHERE wall_id = (SELECT id FROM spray_walls WHERE layout_id = ${wall.layoutId})
    `)) as unknown as Array<{ published: number; superseded: number }>;
    expect([counts.published, counts.superseded]).toEqual([1, 1]);

    // …and the hold came off exactly once.
    const [removed] = (await db.execute(sql`
      SELECT count(*)::int AS removed FROM spray_wall_holds
      WHERE hold_id = ${holdIds[1]} AND removed_version_id IS NOT NULL
    `)) as unknown as Array<{ removed: number }>;
    expect(removed.removed).toBe(1);
  });

  it('counts nothing for a draft that has not landed', async () => {
    // A draft's removals are not removals yet. Until the version lands, the badge,
    // the filter and the remix prompt all have to say the climb is fine.
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const climb = await saveClimbOn(wall, 'Delta', [holdIds[0], holdIds[1]]);

    const versionId = await openDraft(wall);
    await sprayWallMutations.removeSprayWallHolds(
      {},
      { input: { wallUuid: wall.uuid, versionId, holdIds: [holdIds[1]] } },
      ctxFor(OWNER),
    );

    expect(await missingFor(climb)).toBe(0);
    expect(await searchNames(wall, 'broken')).toEqual([]);
    expect(await searchNames(wall, 'intact')).toEqual(['Delta']);

    await sprayWallMutations.commitSprayWallVersion(
      {},
      { input: { wallUuid: wall.uuid, versionId, kept: [], removed: [], added: [] } },
      ctxFor(OWNER),
    );

    // The removal was already stamped by `removeSprayWallHolds`; committing the
    // version is what makes it real.
    expect(await missingFor(climb)).toBe(1);
    expect(await searchNames(wall, 'broken')).toEqual(['Delta']);
  });

  it('never counts a removal an ABANDONED draft made', async () => {
    // Publish v1, let draft v2 remove a hold and walk away, publish v3. The count
    // has to be unchanged — a generation counts only once its version has landed.
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const climb = await saveClimbOn(wall, 'Echo', [holdIds[0], holdIds[1]]);

    // Built by hand: the API enforces one open draft per wall, so this state is no
    // longer reachable through it — but the landed bound is what makes an
    // abandoned draft harmless and a row like this can predate the rule.
    const [abandoned] = (await db.execute(sql`
      INSERT INTO spray_wall_versions (wall_id, version_number, status, photo_key, photo_width, photo_height, anchors, created_at, updated_at)
      VALUES ((SELECT id FROM spray_walls WHERE layout_id = ${wall.layoutId}), 2, 'draft', 'abandoned/key.jpg', 1200, 900,
              ${JSON.stringify(ANCHORS)}::jsonb, now(), now())
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    await db.execute(sql`
      UPDATE spray_wall_holds SET removed_version_id = ${abandoned.id}
      WHERE wall_id = (SELECT id FROM spray_walls WHERE layout_id = ${wall.layoutId}) AND hold_id = ${holdIds[0]}
    `);

    const [live] = (await db.execute(sql`
      INSERT INTO spray_wall_versions (wall_id, version_number, status, photo_key, photo_width, photo_height, anchors, created_at, updated_at)
      VALUES ((SELECT id FROM spray_walls WHERE layout_id = ${wall.layoutId}), 3, 'draft', 'live/key.jpg', 1200, 900,
              ${JSON.stringify(ANCHORS)}::jsonb, now(), now())
      RETURNING id
    `)) as unknown as Array<{ id: string }>;

    await sprayWallMutations.commitSprayWallVersion(
      {},
      { input: { wallUuid: wall.uuid, versionId: live.id, kept: [], removed: [], added: [] } },
      ctxFor(OWNER),
    );

    expect(await missingFor(climb)).toBe(0);
    expect(await searchNames(wall, 'intact')).toEqual(['Echo']);
  });
});

describe('editing a climb re-derives its integrity', () => {
  it('clears the badge when the setter replaces every lost hold', async () => {
    // The other direction from a reset: the CLIMB moves under the wall. Nothing
    // else would ever correct the number — the wall-wide recompute only runs when
    // a reset lands — so the climb would sit in BROKEN searches wearing a badge
    // for a problem its setter had already dealt with.
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const climb = await saveClimbOn(wall, 'Oscar', [holdIds[0], holdIds[1]]);
    expect(await missingFor(climb)).toBe(0);

    // A reset takes hold 1 off and bolts a replacement on.
    const versionId = await openDraft(wall);
    const result = (await sprayWallMutations.commitSprayWallVersion(
      {},
      {
        input: {
          wallUuid: wall.uuid,
          versionId,
          kept: [{ holdId: holdIds[0] }, { holdId: holdIds[2] }],
          removed: [holdIds[1]],
          added: [{ detection: { cx: 320, cy: 415, r: 28 }, movedFromHoldId: holdIds[1] }],
        },
      },
      ctxFor(OWNER),
    )) as { addedCount: number };
    expect(result.addedCount).toBe(1);

    expect(await missingFor(climb)).toBe(1);
    expect(await searchNames(wall, 'broken')).toEqual(['Oscar']);

    const [successor] = (await db.execute(sql`
      SELECT hold_id FROM spray_wall_holds
      WHERE wall_id = (SELECT id FROM spray_walls WHERE layout_id = ${wall.layoutId})
        AND moved_from_hold_id = ${holdIds[1]}
    `)) as unknown as Array<{ hold_id: number }>;

    // The setter moves the climb onto the replacement.
    await climbMutations.updateClimb(
      {},
      {
        input: {
          uuid: climb,
          boardType: 'spray',
          layoutId: wall.layoutId,
          frames: framesFor([holdIds[0], successor.hold_id]),
          angle: 40,
        },
      },
      ctxFor(OWNER),
    );

    expect(await missingFor(climb)).toBe(0);
    expect(await searchNames(wall, 'broken')).toEqual([]);
    expect(await searchNames(wall, 'intact')).toEqual(['Oscar']);
  });

  it('refuses an edit back onto a removed hold, and leaves the count alone', async () => {
    // `assertSprayHoldsAreAlive` is what refuses it — a climb cannot be set on a
    // hold that is not on the wall — and the whole edit rolls back, so the number
    // it would have re-derived never lands either.
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const climb = await saveClimbOn(wall, 'Papa', [holdIds[0], holdIds[1]]);

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
    expect(await missingFor(climb)).toBe(1);

    await expect(
      climbMutations.updateClimb(
        {},
        {
          input: {
            uuid: climb,
            boardType: 'spray',
            layoutId: wall.layoutId,
            // holdIds[1] came off the wall in the reset above.
            frames: framesFor([holdIds[2], holdIds[1]]),
            angle: 40,
          },
        },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(/is not on this wall/i);

    expect(await missingFor(climb)).toBe(1);
    expect(await searchNames(wall, 'broken')).toEqual(['Papa']);
  });

  it('seeds a brand-new spray climb at 0, never NULL', async () => {
    // `assertSprayHoldsAreAlive` runs before the insert, so a climb cannot be born
    // broken — and 0 rather than NULL is what keeps INTACT and BROKEN answering
    // about it from the moment it exists.
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const climb = await saveClimbOn(wall, 'Quebec', [holdIds[0], holdIds[2]]);

    const [row] = (await db.execute(
      sql`SELECT missing_hold_count FROM board_climbs WHERE uuid = ${climb}`,
    )) as unknown as Array<{ missing_hold_count: number | null }>;
    expect(row.missing_hold_count).toBe(0);
    expect(row.missing_hold_count).not.toBeNull();
  });
});

describe('remixClimb', () => {
  it('strips the lost holds and offers the successor a move linked', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const parent = await saveClimbOn(wall, 'Foxtrot', [holdIds[0], holdIds[1], holdIds[2]]);

    const versionId = await openDraft(wall);
    await sprayWallMutations.commitSprayWallVersion(
      {},
      {
        input: {
          wallUuid: wall.uuid,
          versionId,
          kept: [{ holdId: holdIds[0] }, { holdId: holdIds[2] }],
          removed: [holdIds[1]],
          added: [{ detection: { cx: 320, cy: 415, r: 28 }, movedFromHoldId: holdIds[1] }],
        },
      },
      ctxFor(OWNER),
    );

    const seed = (await sprayWallQueries.remixClimb({}, { parentUuid: parent }, ctxFor(OWNER))) as {
      parentUuid: string;
      parentName: string;
      frames: string;
      lostHoldIds: number[];
      keptHoldIds: number[];
      suggestedHoldIds: number[];
    } | null;

    expect(seed).not.toBeNull();
    expect(seed!.parentUuid).toBe(parent);
    expect(seed!.parentName).toBe('Foxtrot');
    expect(seed!.lostHoldIds).toEqual([holdIds[1]]);
    expect(seed!.keptHoldIds).toEqual([holdIds[0], holdIds[2]]);
    // The lost hold's token is gone; the survivors keep their roles.
    expect(seed!.frames).toBe(`p${holdIds[0]}r1p${holdIds[2]}r3`);
    // The successor the review linked, so the remix has somewhere to start.
    expect(seed!.suggestedHoldIds).toHaveLength(1);
    expect(seed!.suggestedHoldIds[0]).toBeGreaterThan(holdIds[2]);
  });

  it('drops a successor that has itself since come off the wall', async () => {
    // Two resets. The first moves hold 1 to a successor; the second takes that
    // successor off. A remix must not offer a hold that is no longer there — and
    // the row must not even be loaded, or a wall with a long reset history ships
    // every successor it has ever had over the wire to be thrown away in JS.
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const parent = await saveClimbOn(wall, 'Sierra', [holdIds[0], holdIds[1]]);

    const firstReset = await openDraft(wall);
    await sprayWallMutations.commitSprayWallVersion(
      {},
      {
        input: {
          wallUuid: wall.uuid,
          versionId: firstReset,
          kept: [{ holdId: holdIds[0] }, { holdId: holdIds[2] }],
          removed: [holdIds[1]],
          added: [{ detection: { cx: 320, cy: 415, r: 28 }, movedFromHoldId: holdIds[1] }],
        },
      },
      ctxFor(OWNER),
    );

    const [successor] = (await db.execute(sql`
      SELECT hold_id FROM spray_wall_holds
      WHERE wall_id = (SELECT id FROM spray_walls WHERE layout_id = ${wall.layoutId})
        AND moved_from_hold_id = ${holdIds[1]}
    `)) as unknown as Array<{ hold_id: number }>;

    // While it is still on the wall it IS offered.
    const before = (await sprayWallQueries.remixClimb({}, { parentUuid: parent }, ctxFor(OWNER))) as {
      suggestedHoldIds: number[];
    };
    expect(before.suggestedHoldIds).toEqual([successor.hold_id]);

    // The second reset takes it off again.
    const secondReset = await openDraft(wall);
    await sprayWallMutations.commitSprayWallVersion(
      {},
      {
        input: {
          wallUuid: wall.uuid,
          versionId: secondReset,
          kept: [{ holdId: holdIds[0] }, { holdId: holdIds[2] }],
          removed: [successor.hold_id],
          added: [],
        },
      },
      ctxFor(OWNER),
    );

    const after = (await sprayWallQueries.remixClimb({}, { parentUuid: parent }, ctxFor(OWNER))) as {
      lostHoldIds: number[];
      suggestedHoldIds: number[];
    };
    expect(after.suggestedHoldIds).toEqual([]);
    // The lineage row is still there — it is the removal that disqualifies it, not
    // a missing link — so this genuinely exercises the predicate.
    expect(after.lostHoldIds).toContain(holdIds[1]);
    const [linked] = (await db.execute(sql`
      SELECT count(*)::int AS rows FROM spray_wall_holds
      WHERE wall_id = (SELECT id FROM spray_walls WHERE layout_id = ${wall.layoutId})
        AND moved_from_hold_id = ${holdIds[1]}
    `)) as unknown as Array<{ rows: number }>;
    expect(linked.rows).toBe(1);
  });

  it('offers one successor per lost hold when the hold editor left a second claim', async () => {
    // A commit refuses two additions naming one `movedFromHoldId`, and pins the
    // predecessor to that same commit's removals — but `upsertSprayWallHolds`, the
    // ordinary hold editor, accepts a predecessor that is still ALIVE. So the
    // editor can link a move off hold 1 while hold 1 is still up, and a later reset
    // can take hold 1 off and link its own successor. Two alive rows, one
    // predecessor. Remix promises at most one suggestion per lost hold, so it keeps
    // the more recently installed of the pair.
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const parent = await saveClimbOn(wall, 'Tango', [holdIds[0], holdIds[1]]);

    // The hold editor's claim, made while hold 1 is still on the wall.
    const editorDraft = await openDraft(wall);
    await sprayWallMutations.upsertSprayWallHolds(
      {},
      {
        input: {
          wallUuid: wall.uuid,
          versionId: editorDraft,
          holds: [{ cx: 305, cy: 405, r: 30, movedFromHoldId: holdIds[1] }],
        },
      },
      ctxFor(OWNER),
    );
    await sprayWallMutations.publishSprayWallVersion({}, { input: { versionId: editorDraft } }, ctxFor(OWNER));

    // The reset that actually takes hold 1 off, linking its own successor.
    const reset = await openDraft(wall);
    await sprayWallMutations.commitSprayWallVersion(
      {},
      {
        input: {
          wallUuid: wall.uuid,
          versionId: reset,
          kept: [{ holdId: holdIds[0] }, { holdId: holdIds[2] }],
          removed: [holdIds[1]],
          added: [{ detection: { cx: 640, cy: 700, r: 26 }, movedFromHoldId: holdIds[1] }],
        },
      },
      ctxFor(OWNER),
    );

    // Both claims are on the wall and both are alive — so the dedupe is doing the
    // work here, not a missing or removed row.
    const claims = (await db.execute(sql`
      SELECT hold_id FROM spray_wall_holds
      WHERE wall_id = (SELECT id FROM spray_walls WHERE layout_id = ${wall.layoutId})
        AND moved_from_hold_id = ${holdIds[1]}
      ORDER BY hold_id
    `)) as unknown as Array<{ hold_id: number }>;
    expect(claims).toHaveLength(2);

    const seed = (await sprayWallQueries.remixClimb({}, { parentUuid: parent }, ctxFor(OWNER))) as {
      lostHoldIds: number[];
      suggestedHoldIds: number[];
    };
    expect(seed.lostHoldIds).toEqual([holdIds[1]]);
    // The reset's successor: installed last, and the one whose predecessor really
    // came off the wall.
    expect(seed.suggestedHoldIds).toEqual([claims[1].hold_id]);
  });

  it('serves the parent even when it is no longer climbable', async () => {
    // Epic decision 2026-09-14: the parent may be unclimbable after a reset, and
    // that is fine — it is exactly the climb worth remixing.
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const parent = await saveClimbOn(wall, 'Golf', [holdIds[0], holdIds[1]]);

    const versionId = await openDraft(wall);
    await sprayWallMutations.commitSprayWallVersion(
      {},
      {
        input: {
          wallUuid: wall.uuid,
          versionId,
          kept: [{ holdId: holdIds[2] }],
          removed: [holdIds[0], holdIds[1]],
          added: [],
        },
      },
      ctxFor(OWNER),
    );

    const seed = (await sprayWallQueries.remixClimb({}, { parentUuid: parent }, ctxFor(OWNER))) as {
      frames: string;
      lostHoldIds: number[];
    } | null;
    expect(seed).not.toBeNull();
    expect(seed!.frames).toBe('');
    expect(seed!.lostHoldIds).toEqual([holdIds[0], holdIds[1]]);
  });

  it('is null for a stranger on a PRIVATE wall, and real once it is public', async () => {
    // A wall is a photograph of somebody's home. "Not visible" and "does not
    // exist" are deliberately the same answer, so asking to remix a climb is not
    // an oracle for which layout ids are private walls.
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const parent = await saveClimbOn(wall, 'Hotel', [holdIds[0]]);

    expect(await sprayWallQueries.remixClimb({}, { parentUuid: parent }, ctxFor(STRANGER))).toBeNull();
    expect(await sprayWallQueries.remixClimb({}, { parentUuid: parent }, ctxFor(OWNER))).not.toBeNull();

    await sprayWallMutations.updateSprayWall({}, { input: { uuid: wall.uuid, isPublic: true } }, ctxFor(OWNER));
    expect(await sprayWallQueries.remixClimb({}, { parentUuid: parent }, ctxFor(STRANGER))).not.toBeNull();
  });

  it('opens an UNLISTED wall to a climber holding the share link', async () => {
    // The crew case the epic wants: somebody photographs their home wall and sends
    // the link. `saveClimb` already accepts that capability, so a crew that can SET
    // a climb and cannot remix one would be an arbitrary hole.
    const { wall, holdIds } = await createPublishedWall(OWNER, { isUnlisted: true });
    const parent = await saveClimbOn(wall, 'Lima', [holdIds[0]]);

    const seed = await sprayWallQueries.remixClimb(
      {},
      { parentUuid: parent, sprayWallUuid: wall.uuid },
      ctxFor(STRANGER),
    );
    expect(seed).not.toBeNull();
  });

  it('refuses a PRIVATE wall even when the uuid is presented', async () => {
    // Private means private: the owner has handed a link to nobody, so there is no
    // capability to present.
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const parent = await saveClimbOn(wall, 'Mike', [holdIds[0]]);

    expect(
      await sprayWallQueries.remixClimb({}, { parentUuid: parent, sprayWallUuid: wall.uuid }, ctxFor(STRANGER)),
    ).toBeNull();
  });

  it('refuses one unlisted wall uuid presented against another', async () => {
    // The pairing is the whole check: without it a single leaked uuid would open
    // every wall in the sequence.
    const { wall, holdIds } = await createPublishedWall(OWNER, { isUnlisted: true });
    const { wall: otherWall } = await createPublishedWall(OWNER, { isUnlisted: true });
    const parent = await saveClimbOn(wall, 'November', [holdIds[0]]);

    expect(
      await sprayWallQueries.remixClimb({}, { parentUuid: parent, sprayWallUuid: otherWall.uuid }, ctxFor(STRANGER)),
    ).toBeNull();
  });

  it('is null for a stranger on an UNLISTED wall, because a layout id is not a secret', async () => {
    // `remixClimb` resolves the wall by LAYOUT id, which comes out of a sequence —
    // so the unlisted exemption (which is a property of a uuid lookup) must not
    // apply, or walking the sequence would enumerate every unlisted home wall.
    const { wall, holdIds } = await createPublishedWall(OWNER, { isUnlisted: true });
    const parent = await saveClimbOn(wall, 'India', [holdIds[0]]);
    expect(await sprayWallQueries.remixClimb({}, { parentUuid: parent }, ctxFor(STRANGER))).toBeNull();
  });

  it('is null for a climb that is not on a spray wall', async () => {
    expect(await sprayWallQueries.remixClimb({}, { parentUuid: uuidv4() }, ctxFor(OWNER))).toBeNull();
  });

  it('writes the lineage row when the child is saved', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const parent = await saveClimbOn(wall, 'Juliet', [holdIds[0], holdIds[1]]);
    const child = await saveClimbOn(wall, 'Juliet remix', [holdIds[0], holdIds[2]], {
      remixOfClimbUuid: parent,
    });

    const [lineage] = (await db.execute(
      sql`SELECT parent_uuid, wall_version_id FROM spray_climb_lineage WHERE child_uuid = ${child}`,
    )) as unknown as Array<{ parent_uuid: string; wall_version_id: string }>;
    expect(lineage.parent_uuid).toBe(parent);
    expect(Number(lineage.wall_version_id)).toBeGreaterThan(0);
  });

  it('refuses a remix of a climb that is not on a spray wall', async () => {
    // `spray_climb_lineage` is a spray table, so there is nothing a remix of a
    // Kilter climb could write. Dropping the field silently would save the climb,
    // report success, and leave the client believing a link exists that never
    // will — and the lineage row can only be written once, with the child.
    await expect(
      climbMutations.saveClimb(
        {},
        {
          input: {
            boardType: 'kilter',
            layoutId: 1,
            name: 'Not a spray remix',
            isDraft: true,
            frames: 'p1r12',
            angle: 40,
            remixOfClimbUuid: 'ffffffffffffffffffffffffffffffff',
          },
        },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(/only spray wall climbs can be remixed/i);
  });

  it('refuses a parent that is not on the same wall', async () => {
    // A lineage row pointing somewhere else would render a "remixed from" link the
    // viewer cannot open, and it would be wrong forever.
    const { wall: first, holdIds: firstHolds } = await createPublishedWall(OWNER);
    const { wall: second, holdIds: secondHolds } = await createPublishedWall(OWNER);
    const strayParent = await saveClimbOn(first, 'Kilo', [firstHolds[0]]);

    await expect(
      saveClimbOn(second, 'Kilo remix', [secondHolds[0]], { remixOfClimbUuid: strayParent }),
    ).rejects.toThrow(/not on this wall/i);

    // …and nothing was written: the whole save is one transaction.
    const [row] = (await db.execute(
      sql`SELECT count(*)::int AS climbs FROM board_climbs WHERE name = 'Kilo remix'`,
    )) as unknown as Array<{ climbs: number }>;
    expect(row.climbs).toBe(0);
  });
});
