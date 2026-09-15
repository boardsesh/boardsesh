import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';

/**
 * The spray wall API end to end, against the real database.
 *
 * The happy path the issue asks for is one test: create → upload → version →
 * upsert 3 holds → publish → `sprayWallRenderData` comes back with a presigned
 * photo URL, the homography and the three alive holds. Everything around it is
 * one of the two things that could actually hurt someone:
 *
 *  - **Visibility.** A private wall is a photograph of somebody's home. A second
 *    user must not be able to read one, must be able to read an unlisted one by
 *    uuid, and must not be able to edit any wall they do not own — a gym
 *    `editor` included (epic decision 2026-09-14: ownership grants editing, with
 *    no gym-editor extension).
 *  - **Climb writes.** `saveClimb` on a wall needs a grade to publish, writes the
 *    fingerprint and the stats seed itself, refuses a hold that is not on the
 *    wall, and announces to the feed only for a public wall.
 *
 * Storage is the only stub: there is no R2 in CI, so `presignGetObject` and
 * `getS3ObjectMetadata` are scripted and everything else is real rows.
 */

const { presignedUrls, storedPhotoMetadata, publishedEvents } = vi.hoisted(() => ({
  presignedUrls: [] as string[],
  storedPhotoMetadata: new Map<string, { width: string; height: string }>(),
  publishedEvents: [] as Array<{ type: string; metadata?: Record<string, unknown> }>,
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
const { climbQueries } = await import('../graphql/resolvers/climbs/queries');
const { newClimbSubscriptionResolvers } = await import('../graphql/resolvers/social/new-climb-subscriptions');
const { syncQueries } = await import('../graphql/resolvers/sync/queries');
const { setterFollowQueries } = await import('../graphql/resolvers/social/setter-follows');
const { socialFeedQueries } = await import('../graphql/resolvers/social/feed');
const { activityFeedQueries } = await import('../graphql/resolvers/social/activity-feed');
const { sessionFeedQueries } = await import('../graphql/resolvers/social/session-feed');
const { MAX_HOLDS_PER_WALL, MAX_SPRAY_WALLS_PER_USER, MAX_VERSIONS_PER_WALL } = await import('@boardsesh/board-config');

const OWNER = 'sw-owner';
const STRANGER = 'sw-stranger';
const GYM_EDITOR = 'sw-gym-editor';
const ALL_USERS = [OWNER, STRANGER, GYM_EDITOR];

/** A square-ish quad standing in for the four wall corners in a photo. */
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

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

/**
 * Stand in for POST /api/spray-wall-photos: register the object metadata the
 * handler would have written, so `createSprayWallVersion` can read the
 * dimensions off "storage" the way it does in production.
 */
function registerUploadedPhoto(wallUuid: string, size = { width: 1200, height: 900 }): string {
  const photoId = uuidv4();
  storedPhotoMetadata.set(sprayWallPhotoKey(wallUuid, photoId), {
    width: String(size.width),
    height: String(size.height),
  });
  return photoId;
}

type CreatedWall = { uuid: string; layoutId: number; sizeId: number };

async function createWall(
  owner: string,
  overrides: Record<string, unknown> = {},
): Promise<CreatedWall & { holdCount: number }> {
  const wall = (await sprayWallMutations.createSprayWall(
    {},
    { input: { name: `Wall ${uuidv4().slice(0, 6)}`, angle: 40, ...overrides } },
    ctxFor(owner),
  )) as CreatedWall & { holdCount: number };
  return wall;
}

/** The whole owner-side flow: wall, photo, draft version, three holds, publish. */
async function createPublishedWall(
  owner: string,
  overrides: Record<string, unknown> = {},
): Promise<{ wall: CreatedWall; versionId: string; holdIds: number[] }> {
  const wall = await createWall(owner, overrides);
  const photoId = registerUploadedPhoto(wall.uuid);

  const version = (await sprayWallMutations.createSprayWallVersion(
    {},
    { input: { wallUuid: wall.uuid, photoId, anchors: ANCHORS } },
    ctxFor(owner),
  )) as { id: string; number: number };

  const holds = (await sprayWallMutations.upsertSprayWallHolds(
    {},
    {
      input: {
        wallUuid: wall.uuid,
        versionId: version.id,
        // Every hold sits STRICTLY inside the 800x620 canonical frame the ANCHORS
        // above define. That is not cosmetic: `populateDenormalizedColumns` step 3
        // compares the climb's edge box against the size row's with strict
        // inequalities, so a hold ON the frame edge makes the derivation match
        // nothing — and the `compatible_size_ids` re-assertion this file pins would
        // become untestable, passing whether or not the resolver does it.
        holds: [
          { cx: 100, cy: 120, r: 24 },
          { cx: 300, cy: 400, r: 30, source: 'AUTO', confidence: 0.81 },
          { cx: 520, cy: 560, r: 18, outline: [1, 0, 0, 1, -1, 0, 0, -1] },
        ],
      },
    },
    ctxFor(owner),
  )) as Array<{ id: number }>;

  await sprayWallMutations.publishSprayWallVersion({}, { input: { versionId: version.id } }, ctxFor(owner));

  return { wall, versionId: version.id, holdIds: holds.map((hold) => hold.id) };
}

/** `frames` for a spray climb: start, hand, finish on the given holds. */
function framesFor(holdIds: number[]): string {
  const roles = [1, 2, 3];
  return holdIds.map((holdId, index) => `p${holdId}r${roles[index] ?? 2}`).join('');
}

beforeEach(async () => {
  // `spray_walls` cascades from `user_boards`, which cascades from `users`; the
  // catalogue rows a wall writes are keyed on a sequence that never rolls back,
  // so they are cleared explicitly rather than left to accumulate.
  await db.execute(sql`
    TRUNCATE TABLE "spray_walls", "user_boards", "gym_members", "gyms",
                   "board_climbs", "board_climb_holds", "board_climb_stats",
                   "board_layouts", "board_product_sizes", "board_product_sizes_layouts_sets",
                   "board_holes", "board_placements", "board_difficulty_grades",
                   -- The tick-feed tests below write these; a tick or a follow
                   -- surviving into the next test makes a feed assertion pass or
                   -- fail for the wrong reason.
                   "boardsesh_ticks", "user_follows"
    RESTART IDENTITY CASCADE
  `);
  // `spray_wall_catalog_id_seq` and `spray_hold_catalog_id_seq` are STANDALONE
  // sequences, not identity columns, so `TRUNCATE … RESTART IDENTITY` above does
  // not touch them — they keep climbing across runs, and a worker database reused
  // from an earlier run starts somewhere in the hundreds or thousands. Several
  // assertions here compare ids and counts that only hold from a known start, so
  // without this the suite passes on a fresh DB and fails on a reused one.
  await db.execute(sql`ALTER SEQUENCE spray_wall_catalog_id_seq RESTART WITH 1`);
  await db.execute(sql`ALTER SEQUENCE spray_hold_catalog_id_seq RESTART WITH 1`);

  await Promise.all(ALL_USERS.map(insertUser));

  // The grade scale migration 0227 seeds. `board_difficulty_grades` is in the
  // harness's per-file TRUNCATE list, so the rows have to come back per test.
  await db.execute(sql`
    INSERT INTO board_difficulty_grades (board_type, difficulty, boulder_name, route_name, is_listed)
    VALUES ('spray', 10, '4a/V0', '5b/5.9', true),
           ('spray', 18, '6b/V4', '7a/5.11d', true)
    ON CONFLICT (board_type, difficulty) DO NOTHING
  `);

  presignedUrls.length = 0;
  publishedEvents.length = 0;
  storedPhotoMetadata.clear();

  // `clearAllMocks` resets call history but NOT a `mockReturnValueOnce` queue, so the
  // unconfigured-bucket test two describes down would otherwise hand its leftover
  // `false` to whichever test ran next — and every later wall creation would fail
  // with "photos are not configured". Reset the queue, then restore the default.
  const storage = await import('../storage/s3');
  vi.mocked(storage.isS3Configured).mockReset();
  vi.mocked(storage.isS3Configured).mockReturnValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('the spray wall lifecycle', () => {
  it('goes create → upload → version → 3 holds → publish → render data', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);
    expect(holdIds).toHaveLength(3);

    const renderData = (await sprayWallQueries.sprayWallRenderData({}, { uuid: wall.uuid }, ctxFor(OWNER))) as {
      versionNumber: number;
      boardWidth: number;
      boardHeight: number;
      photo: { url: string; thumbUrl: string | null; expiresAt: string };
      homography: number[];
      holds: Array<{ id: number; installedVersion: number; removedVersion: number | null }>;
    } | null;

    expect(renderData).not.toBeNull();
    expect(renderData!.versionNumber).toBe(1);

    // A presigned URL, not a stored one: the photo is in the private bucket
    // precisely because there is no URL safe to persist.
    expect(renderData!.photo.url).toContain('X-Amz-Signature');
    expect(renderData!.photo.thumbUrl).toContain('@280.jpg');
    expect(Date.parse(renderData!.photo.expiresAt)).toBeGreaterThan(Date.now());

    // Nine floats, and NOT the identity: anchors were tapped, so a real
    // perspective transform was solved.
    expect(renderData!.homography).toHaveLength(9);
    expect(renderData!.homography).not.toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);

    // The canonical frame is the anchor quad's bounding rectangle — derived from
    // the photo, never entered by the owner.
    expect(renderData!.boardWidth).toBe(800);
    expect(renderData!.boardHeight).toBe(620);

    expect(renderData!.holds.map((hold) => hold.id).sort((a, b) => a - b)).toEqual([...holdIds].sort((a, b) => a - b));
    expect(renderData!.holds.every((hold) => hold.installedVersion === 1 && hold.removedVersion === null)).toBe(true);
  });

  it('writes the wall as an LED-less, fixed-angle, private, UNLISTED-catalogue board', async () => {
    const wall = await createWall(OWNER, { name: 'Garage wall' });

    const [board] = (await db.execute(sql`
      SELECT board_type, layout_id, size_id, set_ids, has_leds, is_angle_adjustable, is_public, angle, serial_number
      FROM user_boards WHERE uuid = ${wall.uuid}
    `)) as unknown as Array<Record<string, unknown>>;

    expect(board.board_type).toBe('spray');
    // ONE sequence value is BOTH the layout id and the size id.
    expect(Number(board.layout_id)).toBe(Number(board.size_id));
    expect(board.set_ids).toBe('1');
    // Never from the client: `scanFamilyForBoard('spray')` still answers 'aurora',
    // so a wall with has_leds = true would offer a Bluetooth scan for a wall with
    // no controller.
    expect(board.has_leds).toBe(false);
    expect(board.is_angle_adjustable).toBe(false);
    // A wall is somebody's home until they say otherwise; every other board type
    // defaults public.
    expect(board.is_public).toBe(false);
    expect(Number(board.angle)).toBe(40);
    expect(board.serial_number).toBeNull();

    // All three catalogue rows unlisted. That is the PRIMARY privacy defence, not
    // cosmetics: any reader of board_layouts / board_product_sizes that knows
    // nothing about spray has only is_listed to go on.
    const listedRows = (await db.execute(sql`
      SELECT 'layout' AS kind FROM board_layouts WHERE board_type = 'spray' AND is_listed IS NOT FALSE
      UNION ALL
      SELECT 'size' FROM board_product_sizes WHERE board_type = 'spray' AND is_listed IS NOT FALSE
      UNION ALL
      SELECT 'join' FROM board_product_sizes_layouts_sets WHERE board_type = 'spray' AND is_listed IS NOT FALSE
    `)) as unknown as Array<{ kind: string }>;
    expect(listedRows).toHaveLength(0);
  });

  it('ignores a client that tries to turn LEDs on', async () => {
    // The input schema has no `hasLeds` key at all, so zod strips it — this pins
    // that the strip is real rather than a comment.
    const wall = await createWall(OWNER, { hasLeds: true, isAngleAdjustable: true });
    const [board] = (await db.execute(sql`
      SELECT has_leds, is_angle_adjustable FROM user_boards WHERE uuid = ${wall.uuid}
    `)) as unknown as Array<{ has_leds: boolean; is_angle_adjustable: boolean }>;
    expect(board.has_leds).toBe(false);
    expect(board.is_angle_adjustable).toBe(false);
  });

  it('gives each new hold a board_holes + board_placements pair sharing its id', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);

    const placements = (await db.execute(sql`
      SELECT id, layout_id, hole_id, set_id FROM board_placements
      WHERE board_type = 'spray' ORDER BY id
    `)) as unknown as Array<{ id: number; layout_id: number; hole_id: number; set_id: number }>;

    expect(placements.map((row) => row.id)).toEqual([...holdIds].sort((a, b) => a - b));
    // The hole id IS the placement id: a climb's frames string (p<placementId>r…)
    // has to resolve to the row the wall editor drew, and a wall hold has no
    // separate hole to mount into.
    expect(placements.every((row) => row.hole_id === row.id)).toBe(true);
    expect(placements.every((row) => row.layout_id === wall.layoutId && row.set_id === 1)).toBe(true);
  });

  it('refuses to edit a version that is already published', async () => {
    const { wall, versionId } = await createPublishedWall(OWNER);

    await expect(
      sprayWallMutations.upsertSprayWallHolds(
        {},
        { input: { wallUuid: wall.uuid, versionId, holds: [{ cx: 10, cy: 10, r: 10 }] } },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(/already published/i);
  });

  it('inherits the canonical frame on a second version rather than re-deriving it', async () => {
    const { wall } = await createPublishedWall(OWNER);

    // A second photo taken from further back, at a different resolution. The
    // frame must NOT move — every existing hold's coordinates are in it.
    const photoId = registerUploadedPhoto(wall.uuid, { width: 2000, height: 1500 });
    await sprayWallMutations.createSprayWallVersion(
      {},
      {
        input: {
          wallUuid: wall.uuid,
          photoId,
          anchors: [
            [10, 10],
            [1990, 40],
            [1970, 1490],
            [30, 1460],
          ],
        },
      },
      ctxFor(OWNER),
    );

    const [row] = (await db.execute(sql`
      SELECT reference_width, reference_height FROM spray_walls WHERE layout_id = ${wall.layoutId}
    `)) as unknown as Array<{ reference_width: number; reference_height: number }>;
    expect(row.reference_width).toBe(800);
    expect(row.reference_height).toBe(620);
  });

  it('refuses a version whose photo never landed', async () => {
    const wall = await createWall(OWNER);
    await expect(
      sprayWallMutations.createSprayWallVersion(
        {},
        { input: { wallUuid: wall.uuid, photoId: uuidv4() } },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(/could not be found/i);
  });

  it('deletes a wall softly, leaving the catalogue rows behind', async () => {
    const { wall } = await createPublishedWall(OWNER);
    expect(await sprayWallMutations.deleteSprayWall({}, { uuid: wall.uuid }, ctxFor(OWNER))).toBe(true);

    expect(await sprayWallQueries.sprayWall({}, { uuid: wall.uuid }, ctxFor(OWNER))).toBeNull();

    const [layout] = (await db.execute(sql`
      SELECT id FROM board_layouts WHERE board_type = 'spray' AND id = ${wall.layoutId}
    `)) as unknown as Array<{ id: number }>;
    expect(layout).toBeDefined();
  });
});

describe('who can see and who can edit a wall', () => {
  it('hides a private wall from a second user entirely', async () => {
    const { wall } = await createPublishedWall(OWNER);

    expect(await sprayWallQueries.sprayWall({}, { uuid: wall.uuid }, ctxFor(STRANGER))).toBeNull();
    expect(await sprayWallQueries.sprayWallByLayout({}, { layoutId: wall.layoutId }, ctxFor(STRANGER))).toBeNull();
    expect(await sprayWallQueries.sprayWallRenderData({}, { uuid: wall.uuid }, ctxFor(STRANGER))).toBeNull();
    // And from an anonymous reader.
    expect(await sprayWallQueries.sprayWall({}, { uuid: wall.uuid }, ctxFor(null))).toBeNull();
  });

  it('lets a second user read an UNLISTED wall by uuid', async () => {
    const { wall } = await createPublishedWall(OWNER, { isUnlisted: true });

    const read = (await sprayWallQueries.sprayWall({}, { uuid: wall.uuid }, ctxFor(STRANGER))) as {
      uuid: string;
      viewerCanEdit: boolean;
    } | null;
    expect(read?.uuid).toBe(wall.uuid);
    // Readable, not editable.
    expect(read?.viewerCanEdit).toBe(false);
  });

  it('refuses every wall mutation from a user who does not own the wall', async () => {
    const { wall, versionId } = await createPublishedWall(OWNER, { isUnlisted: true });
    const photoId = registerUploadedPhoto(wall.uuid);

    await expect(
      sprayWallMutations.upsertSprayWallHolds(
        {},
        { input: { wallUuid: wall.uuid, versionId, holds: [{ cx: 5, cy: 5, r: 5 }] } },
        ctxFor(STRANGER),
      ),
    ).rejects.toThrow(/not authorized/i);

    await expect(
      sprayWallMutations.createSprayWallVersion({}, { input: { wallUuid: wall.uuid, photoId } }, ctxFor(STRANGER)),
    ).rejects.toThrow(/not authorized/i);

    await expect(
      sprayWallMutations.publishSprayWallVersion({}, { input: { versionId } }, ctxFor(STRANGER)),
    ).rejects.toThrow(/not authorized/i);

    await expect(sprayWallMutations.deleteSprayWall({}, { uuid: wall.uuid }, ctxFor(STRANGER))).rejects.toThrow(
      /not authorized/i,
    );
  });

  it("lets a gym EDITOR see a gym's wall but never edit its holds", async () => {
    // The epic's decision, and the reason `requireBoardEditAccess` is reused
    // unchanged: a gym editor can edit the gym's page. A wall belongs to the
    // person who photographed it.
    const { wall, versionId } = await createPublishedWall(OWNER);

    const gymUuid = uuidv4();
    await db.execute(sql`
      INSERT INTO gyms (uuid, name, slug, owner_id, is_public, created_at, updated_at)
      VALUES (${gymUuid}, 'Spray Gym', ${gymUuid}, ${OWNER}, true, now(), now())
    `);
    const [gym] = (await db.execute(sql`SELECT id FROM gyms WHERE uuid = ${gymUuid}`)) as unknown as Array<{
      id: number;
    }>;
    await db.execute(sql`UPDATE user_boards SET gym_id = ${gym.id} WHERE uuid = ${wall.uuid}`);
    await db.execute(sql`
      INSERT INTO gym_members (gym_id, user_id, role, created_at)
      VALUES (${gym.id}, ${GYM_EDITOR}, 'editor', now())
    `);

    // Gym membership is what grants VIEW access to a private gym wall.
    const read = (await sprayWallQueries.sprayWall({}, { uuid: wall.uuid }, ctxFor(GYM_EDITOR))) as {
      viewerCanEdit: boolean;
    } | null;
    expect(read).not.toBeNull();
    expect(read!.viewerCanEdit).toBe(false);

    await expect(
      sprayWallMutations.upsertSprayWallHolds(
        {},
        { input: { wallUuid: wall.uuid, versionId, holds: [{ cx: 5, cy: 5, r: 5 }] } },
        ctxFor(GYM_EDITOR),
      ),
    ).rejects.toThrow(/not authorized/i);
  });

  it('never resolves an UNLISTED wall by layoutId, for anyone but a principal', async () => {
    // Layout ids come out of `spray_wall_catalog_id_seq` — 1, 2, 3, … — so if
    // unlisted were world-readable here, an anonymous caller could walk the
    // sequence and collect a live presigned photo of every unlisted home wall in
    // the database. Unlisted is a uuid capability and nothing else.
    const { wall } = await createPublishedWall(OWNER, { isUnlisted: true });

    expect(await sprayWallQueries.sprayWallByLayout({}, { layoutId: wall.layoutId }, ctxFor(null))).toBeNull();
    expect(await sprayWallQueries.sprayWallByLayout({}, { layoutId: wall.layoutId }, ctxFor(STRANGER))).toBeNull();

    // The uuid path still works for both, because that is the capability.
    expect(await sprayWallQueries.sprayWall({}, { uuid: wall.uuid }, ctxFor(STRANGER))).not.toBeNull();

    // And the owner can still reach their own wall by layout id.
    expect(await sprayWallQueries.sprayWallByLayout({}, { layoutId: wall.layoutId }, ctxFor(OWNER))).not.toBeNull();
  });

  it('still resolves a PUBLIC wall by layoutId for an anonymous caller', async () => {
    // Guards the guard: a by-layout rule that refused everything would pass the
    // test above for the wrong reason.
    const { wall } = await createPublishedWall(OWNER, { isPublic: true });
    expect(await sprayWallQueries.sprayWallByLayout({}, { layoutId: wall.layoutId }, ctxFor(null))).not.toBeNull();
  });

  describe('setting climbs with the share link', () => {
    // The crew case the epic wants: somebody photographs their home wall, sends
    // the link, and the crew sets climbs on it. The link's uuid is the capability;
    // the layoutId in the request is not, because it comes out of a sequence.
    async function saveAs(
      userId: string | null,
      wall: CreatedWall,
      holdIds: number[],
      extra: Record<string, unknown> = {},
    ) {
      return climbMutations.saveClimb(
        {},
        {
          input: {
            boardType: 'spray',
            layoutId: wall.layoutId,
            name: 'Crew climb',
            isDraft: false,
            frames: framesFor(holdIds),
            angle: 40,
            userGrade: '6b/V4',
            ...extra,
          },
        },
        ctxFor(userId),
      );
    }

    it('accepts a link-holder who presents the wall uuid on an UNLISTED wall', async () => {
      const { wall, holdIds } = await createPublishedWall(OWNER, { isUnlisted: true });

      const saved = (await saveAs(STRANGER, wall, holdIds, { sprayWallUuid: wall.uuid })) as { uuid: string };

      const [climb] = (await db.execute(sql`
        SELECT layout_id, board_type, user_id, compatible_size_ids FROM board_climbs WHERE uuid = ${saved.uuid}
      `)) as unknown as Array<{
        layout_id: number;
        board_type: string;
        user_id: string;
        compatible_size_ids: number[];
      }>;
      expect(climb.board_type).toBe('spray');
      expect(climb.layout_id).toBe(wall.layoutId);
      expect(climb.user_id).toBe(STRANGER);
      expect(climb.compatible_size_ids).toEqual([wall.sizeId]);
    });

    it('refuses the same link-holder without the uuid', async () => {
      const { wall, holdIds } = await createPublishedWall(OWNER, { isUnlisted: true });
      await expect(saveAs(STRANGER, wall, holdIds)).rejects.toThrow(/could not be found/i);
    });

    it('refuses a uuid that belongs to a DIFFERENT wall', async () => {
      // The pairing is the whole check: without it one leaked uuid would authorize
      // writes to every wall in the sequence.
      const target = await createPublishedWall(OWNER, { isUnlisted: true });
      const elsewhere = await createPublishedWall(OWNER, { isUnlisted: true });

      await expect(
        saveAs(STRANGER, target.wall, target.holdIds, { sprayWallUuid: elsewhere.wall.uuid }),
      ).rejects.toThrow(/could not be found/i);
    });

    it('refuses a PRIVATE wall even with the correct uuid', async () => {
      // Private means private: the owner has not handed a link to anybody.
      const { wall, holdIds } = await createPublishedWall(OWNER);
      await expect(saveAs(STRANGER, wall, holdIds, { sprayWallUuid: wall.uuid })).rejects.toThrow(
        /could not be found/i,
      );
    });

    it('lets a link-holder EDIT the climb they set, and only with the uuid', async () => {
      const { wall, holdIds } = await createPublishedWall(OWNER, { isUnlisted: true });
      const saved = (await saveAs(STRANGER, wall, holdIds, { sprayWallUuid: wall.uuid })) as { uuid: string };

      // An edit resolves the wall from the STORED layoutId, which is no more a
      // secret than the one on the create — so it needs the capability too.
      await expect(
        climbMutations.updateClimb(
          {},
          { input: { uuid: saved.uuid, boardType: 'spray', name: 'Renamed' } },
          ctxFor(STRANGER),
        ),
      ).rejects.toThrow(/could not be found/i);

      await expect(
        climbMutations.updateClimb(
          {},
          { input: { uuid: saved.uuid, boardType: 'spray', name: 'Renamed', sprayWallUuid: wall.uuid } },
          ctxFor(STRANGER),
        ),
      ).resolves.toMatchObject({ uuid: saved.uuid });
    });

    it('does not need the uuid from the owner or a gym member', async () => {
      // Ignored when the caller is already a principal, so a client may send it
      // unconditionally.
      const { wall, holdIds } = await createPublishedWall(OWNER, { isUnlisted: true });
      await expect(saveAs(OWNER, wall, holdIds)).resolves.toMatchObject({ uuid: expect.any(String) });
    });

    it('still refuses a climb on a wall the caller has no claim on at all', async () => {
      // A PRIVATE wall, no uuid — the case the by-layout rule exists for.
      const { wall, holdIds } = await createPublishedWall(OWNER);
      await expect(saveAs(STRANGER, wall, holdIds)).rejects.toThrow(/could not be found/i);
    });
  });

  it('hides a draft version from a viewer who cannot edit', async () => {
    const { wall } = await createPublishedWall(OWNER, { isUnlisted: true });
    const photoId = registerUploadedPhoto(wall.uuid);
    await sprayWallMutations.createSprayWallVersion({}, { input: { wallUuid: wall.uuid, photoId } }, ctxFor(OWNER));

    const asOwner = (await sprayWallQueries.sprayWall({}, { uuid: wall.uuid }, ctxFor(OWNER))) as {
      versions: Array<{ status: string }>;
    };
    expect(asOwner.versions.map((version) => version.status)).toEqual(['DRAFT', 'PUBLISHED']);

    const asStranger = (await sprayWallQueries.sprayWall({}, { uuid: wall.uuid }, ctxFor(STRANGER))) as {
      versions: Array<{ status: string }>;
    };
    expect(asStranger.versions.map((version) => version.status)).toEqual(['PUBLISHED']);

    // And the half-finished reset is not renderable by them either.
    expect(
      await sprayWallQueries.sprayWallRenderData({}, { uuid: wall.uuid, version: 2 }, ctxFor(STRANGER)),
    ).toBeNull();
  });

  it('lists only the caller’s own walls', async () => {
    await createPublishedWall(OWNER);
    await createPublishedWall(STRANGER);

    const mine = (await sprayWallQueries.mySprayWalls({}, {}, ctxFor(OWNER))) as Array<{ viewerCanEdit: boolean }>;
    expect(mine).toHaveLength(1);
    expect(mine[0].viewerCanEdit).toBe(true);
  });
});

describe('removing holds', () => {
  it('stamps a removal for a hold from an earlier version and deletes one drawn in this draft', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);

    const photoId = registerUploadedPhoto(wall.uuid);
    const reset = (await sprayWallMutations.createSprayWallVersion(
      {},
      { input: { wallUuid: wall.uuid, photoId, anchors: ANCHORS } },
      ctxFor(OWNER),
    )) as { id: string };

    const [freshHold] = (await sprayWallMutations.upsertSprayWallHolds(
      {},
      { input: { wallUuid: wall.uuid, versionId: reset.id, holds: [{ cx: 700, cy: 500, r: 22 }] } },
      ctxFor(OWNER),
    )) as Array<{ id: number }>;

    const removed = await sprayWallMutations.removeSprayWallHolds(
      {},
      { input: { wallUuid: wall.uuid, versionId: reset.id, holdIds: [holdIds[0], freshHold.id] } },
      ctxFor(OWNER),
    );
    expect(removed).toBe(2);

    const rows = (await db.execute(sql`
      SELECT hold_id, removed_version_id FROM spray_wall_holds
      WHERE wall_id = (SELECT id FROM spray_walls WHERE layout_id = ${wall.layoutId})
      ORDER BY hold_id
    `)) as unknown as Array<{ hold_id: number; removed_version_id: number | null }>;

    // The hold drawn in THIS draft is gone: it was never on the real wall.
    expect(rows.some((row) => row.hold_id === freshHold.id)).toBe(false);
    // The one installed by version 1 is stamped, never deleted: a climb set on it
    // has to stay findable and countable.
    expect(rows.find((row) => row.hold_id === holdIds[0])!.removed_version_id).not.toBeNull();
  });

  it('never revives an ABANDONED draft\u2019s holds in a later published version', async () => {
    // Version numbers are handed out when a photo is uploaded, so a draft nobody
    // finished still owns one. Bounded on the number alone, v2's holds would come
    // back as alive at v3 — holds nobody ever screwed to the wall, which climbs
    // could then be set on.
    const { wall, holdIds } = await createPublishedWall(OWNER);

    // v2: started, a hold drawn, then walked away from.
    const abandonedPhoto = registerUploadedPhoto(wall.uuid);
    const abandoned = (await sprayWallMutations.createSprayWallVersion(
      {},
      { input: { wallUuid: wall.uuid, photoId: abandonedPhoto, anchors: ANCHORS } },
      ctxFor(OWNER),
    )) as { id: string; number: number };
    const [ghostHold] = (await sprayWallMutations.upsertSprayWallHolds(
      {},
      { input: { wallUuid: wall.uuid, versionId: abandoned.id, holds: [{ cx: 200, cy: 200, r: 20 }] } },
      ctxFor(OWNER),
    )) as Array<{ id: number }>;
    // …and it also marked one of v1's holds as gone, which must not take effect.
    await sprayWallMutations.removeSprayWallHolds(
      {},
      { input: { wallUuid: wall.uuid, versionId: abandoned.id, holdIds: [holdIds[1]] } },
      ctxFor(OWNER),
    );
    expect(abandoned.number).toBe(2);

    // v3: the reset that actually happened.
    const realPhoto = registerUploadedPhoto(wall.uuid);
    const real = (await sprayWallMutations.createSprayWallVersion(
      {},
      { input: { wallUuid: wall.uuid, photoId: realPhoto, anchors: ANCHORS } },
      ctxFor(OWNER),
    )) as { id: string; number: number };
    const [realHold] = (await sprayWallMutations.upsertSprayWallHolds(
      {},
      { input: { wallUuid: wall.uuid, versionId: real.id, holds: [{ cx: 400, cy: 200, r: 20 }] } },
      ctxFor(OWNER),
    )) as Array<{ id: number }>;
    await sprayWallMutations.publishSprayWallVersion({}, { input: { versionId: real.id } }, ctxFor(OWNER));
    expect(real.number).toBe(3);

    const renderData = (await sprayWallQueries.sprayWallRenderData({}, { uuid: wall.uuid }, ctxFor(OWNER))) as {
      versionNumber: number;
      holds: Array<{ id: number }>;
    };
    expect(renderData.versionNumber).toBe(3);
    const aliveIds = renderData.holds.map((hold) => hold.id);

    // v2's addition never happened…
    expect(aliveIds).not.toContain(ghostHold.id);
    // …and neither did its removal.
    expect(aliveIds).toContain(holdIds[1]);
    expect(aliveIds).toContain(realHold.id);

    // The published hold count agrees with the render payload.
    const [row] = (await db.execute(
      sql`SELECT hold_count FROM spray_walls WHERE layout_id = ${wall.layoutId}`,
    )) as unknown as Array<{ hold_count: number }>;
    expect(row.hold_count).toBe(aliveIds.length);

    // And the climb gate agrees too: the ghost hold is not settable.
    await expect(
      climbMutations.saveClimb(
        {},
        {
          input: {
            boardType: 'spray',
            layoutId: wall.layoutId,
            name: 'Uses a ghost hold',
            isDraft: false,
            frames: framesFor([holdIds[0], ghostHold.id]),
            angle: 40,
            userGrade: '6b/V4',
          },
        },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(new RegExp(`Hold ${ghostHold.id} is not on this wall`, 'i'));

    // The abandoned draft is still editable in its own right — the exclusion is
    // about other generations, not about drafts being unreadable.
    const abandonedRender = (await sprayWallQueries.sprayWallRenderData(
      {},
      { uuid: wall.uuid, version: 2 },
      ctxFor(OWNER),
    )) as { holds: Array<{ id: number }> };
    expect(abandonedRender.holds.map((hold) => hold.id)).toContain(ghostHold.id);
    expect(abandonedRender.holds.map((hold) => hold.id)).not.toContain(realHold.id);
  });

  it('refuses a hold that is not on the wall', async () => {
    const { wall, versionId } = await createPublishedWall(OWNER);
    const photoId = registerUploadedPhoto(wall.uuid);
    const reset = (await sprayWallMutations.createSprayWallVersion(
      {},
      { input: { wallUuid: wall.uuid, photoId } },
      ctxFor(OWNER),
    )) as { id: string };
    void versionId;

    await expect(
      sprayWallMutations.removeSprayWallHolds(
        {},
        { input: { wallUuid: wall.uuid, versionId: reset.id, holdIds: [999_999] } },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(/not on this wall/i);
  });
});

describe('saveClimb on a spray wall', () => {
  it('refuses a publish with no grade, and takes one with a grade', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const frames = framesFor(holdIds);

    await expect(
      climbMutations.saveClimb(
        {},
        {
          input: {
            boardType: 'spray',
            layoutId: wall.layoutId,
            name: 'Ungraded traverse',
            isDraft: false,
            frames,
            angle: 40,
          },
        },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(/needs your grade/i);

    // Nothing was written — the check is ahead of every insert.
    const [{ climbs }] = (await db.execute(
      sql`SELECT count(*)::int AS climbs FROM board_climbs WHERE board_type = 'spray'`,
    )) as unknown as Array<{ climbs: number }>;
    expect(climbs).toBe(0);

    const saved = (await climbMutations.saveClimb(
      {},
      {
        input: {
          boardType: 'spray',
          layoutId: wall.layoutId,
          name: 'Blue traverse',
          isDraft: false,
          frames,
          angle: 40,
          userGrade: '6b/V4',
        },
      },
      ctxFor(OWNER),
    )) as { uuid: string };

    const [climb] = (await db.execute(sql`
      SELECT hold_fingerprint, compatible_size_ids, required_set_ids, missing_hold_count, is_listed
      FROM board_climbs WHERE uuid = ${saved.uuid}
    `)) as unknown as Array<Record<string, unknown>>;

    // Written HERE because a wall has no Aurora sync to come back and fill it in;
    // without it the per-wall duplicate gate has nothing to key on.
    expect(climb.hold_fingerprint).toBeTruthy();
    // The wall's own size and nothing else — and NOT whatever the unscoped
    // compatible_size_ids join in populateDenormalizedColumns produced.
    expect(climb.compatible_size_ids).toEqual([wall.sizeId]);
    expect(climb.required_set_ids).toEqual([1]);
    expect(climb.missing_hold_count).toBe(0);
    expect(climb.is_listed).toBe(true);

    // The setter's grade is the ONLY grade this climb will ever have: spray has
    // `crowdGrade: false`, so nothing converges on a consensus difficulty.
    const [stats] = (await db.execute(sql`
      SELECT display_difficulty, difficulty_average, angle
      FROM board_climb_stats WHERE climb_uuid = ${saved.uuid}
    `)) as unknown as Array<{ display_difficulty: number; difficulty_average: number; angle: number }>;
    expect(stats.display_difficulty).toBe(18);
    expect(stats.difficulty_average).toBe(18);
    expect(stats.angle).toBe(40);
  });

  it('refuses a grade the Boardsesh scale does not know', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);
    await expect(
      climbMutations.saveClimb(
        {},
        {
          input: {
            boardType: 'spray',
            layoutId: wall.layoutId,
            name: 'Nonsense grade',
            isDraft: false,
            frames: framesFor(holdIds),
            angle: 40,
            userGrade: 'V99',
          },
        },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(/not a grade/i);
  });

  it('refuses a hold that is not alive on the wall', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);

    // Take one hold off the wall through a committed reset.
    const photoId = registerUploadedPhoto(wall.uuid);
    const reset = (await sprayWallMutations.createSprayWallVersion(
      {},
      { input: { wallUuid: wall.uuid, photoId, anchors: ANCHORS } },
      ctxFor(OWNER),
    )) as { id: string };
    await sprayWallMutations.removeSprayWallHolds(
      {},
      { input: { wallUuid: wall.uuid, versionId: reset.id, holdIds: [holdIds[2]] } },
      ctxFor(OWNER),
    );
    await sprayWallMutations.publishSprayWallVersion({}, { input: { versionId: reset.id } }, ctxFor(OWNER));

    await expect(
      climbMutations.saveClimb(
        {},
        {
          input: {
            boardType: 'spray',
            layoutId: wall.layoutId,
            name: 'Uses a gone hold',
            isDraft: false,
            frames: framesFor(holdIds),
            angle: 40,
            userGrade: '6b/V4',
          },
        },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(new RegExp(`Hold ${holdIds[2]} is not on this wall`, 'i'));

    // The surviving two still work, so the rejection is about the dead hold and
    // not about spray climbs in general.
    await expect(
      climbMutations.saveClimb(
        {},
        {
          input: {
            boardType: 'spray',
            layoutId: wall.layoutId,
            name: 'Uses live holds',
            isDraft: false,
            frames: framesFor([holdIds[0], holdIds[1]]),
            angle: 40,
            userGrade: '4a/V0',
          },
        },
        ctxFor(OWNER),
      ),
    ).resolves.toMatchObject({ uuid: expect.any(String) });
  });

  it('refuses a hold that only an unpublished DRAFT has drawn', async () => {
    // The published version is the generation a climb is set against. A hold the
    // owner drew mid-reset is not on the real wall yet, so publishing a climb on
    // it would make a climb nobody can do — and the check reads the published set
    // rather than "removed_version_id IS NULL" precisely to catch this.
    const { wall, holdIds } = await createPublishedWall(OWNER);

    const photoId = registerUploadedPhoto(wall.uuid);
    const draft = (await sprayWallMutations.createSprayWallVersion(
      {},
      { input: { wallUuid: wall.uuid, photoId, anchors: ANCHORS } },
      ctxFor(OWNER),
    )) as { id: string };
    const [draftOnlyHold] = (await sprayWallMutations.upsertSprayWallHolds(
      {},
      { input: { wallUuid: wall.uuid, versionId: draft.id, holds: [{ cx: 640, cy: 300, r: 26 }] } },
      ctxFor(OWNER),
    )) as Array<{ id: number }>;

    await expect(
      climbMutations.saveClimb(
        {},
        {
          input: {
            boardType: 'spray',
            layoutId: wall.layoutId,
            name: 'Uses an unpublished hold',
            isDraft: false,
            frames: framesFor([holdIds[0], draftOnlyHold.id]),
            angle: 40,
            userGrade: '6b/V4',
          },
        },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(new RegExp(`Hold ${draftOnlyHold.id} is not on this wall`, 'i'));

    // And the climber-facing render payload does not show it either: version 1 is
    // still the published one.
    const renderData = (await sprayWallQueries.sprayWallRenderData({}, { uuid: wall.uuid }, ctxFor(OWNER))) as {
      versionNumber: number;
      holds: Array<{ id: number }>;
    };
    expect(renderData.versionNumber).toBe(1);
    expect(renderData.holds.map((hold) => hold.id)).not.toContain(draftOnlyHold.id);

    // The editor, reading the draft explicitly, does see it — otherwise the
    // hold editor could not correct a hold it had just drawn.
    const draftRender = (await sprayWallQueries.sprayWallRenderData(
      {},
      { uuid: wall.uuid, version: 2 },
      ctxFor(OWNER),
    )) as { holds: Array<{ id: number }> };
    expect(draftRender.holds.map((hold) => hold.id)).toContain(draftOnlyHold.id);
  });

  it('refuses a climb on a wall the caller cannot see', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);

    // A layoutId is not authorization: without the wall resolve, any signed-in
    // caller could publish climbs into a stranger's private wall.
    await expect(
      climbMutations.saveClimb(
        {},
        {
          input: {
            boardType: 'spray',
            layoutId: wall.layoutId,
            name: 'Not my wall',
            isDraft: false,
            frames: framesFor(holdIds),
            angle: 40,
            userGrade: '6b/V4',
          },
        },
        ctxFor(STRANGER),
      ),
    ).rejects.toThrow(/could not be found/i);
  });

  it('takes no climbs at all on a wall with nothing published', async () => {
    const wall = await createWall(OWNER);
    const photoId = registerUploadedPhoto(wall.uuid);
    const draft = (await sprayWallMutations.createSprayWallVersion(
      {},
      { input: { wallUuid: wall.uuid, photoId, anchors: ANCHORS } },
      ctxFor(OWNER),
    )) as { id: string };
    const [hold] = (await sprayWallMutations.upsertSprayWallHolds(
      {},
      { input: { wallUuid: wall.uuid, versionId: draft.id, holds: [{ cx: 50, cy: 50, r: 20 }] } },
      ctxFor(OWNER),
    )) as Array<{ id: number }>;

    await expect(
      climbMutations.saveClimb(
        {},
        {
          input: {
            boardType: 'spray',
            layoutId: wall.layoutId,
            name: 'Too early',
            isDraft: false,
            frames: framesFor([hold.id]),
            angle: 40,
            userGrade: '4a/V0',
          },
        },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(/not on this wall/i);
  });

  it('announces to the feed for a public wall and stays silent for a private one', async () => {
    const privateWall = await createPublishedWall(OWNER);
    await climbMutations.saveClimb(
      {},
      {
        input: {
          boardType: 'spray',
          layoutId: privateWall.wall.layoutId,
          name: 'Quiet climb',
          isDraft: false,
          frames: framesFor(privateWall.holdIds),
          angle: 40,
          userGrade: '6b/V4',
        },
      },
      ctxFor(OWNER),
    );
    // A feed event carries the climb name and the wall's layout id to every
    // follower, which would announce the existence of somebody's home wall.
    expect(publishedEvents.filter((event) => event.type === 'climb.created')).toHaveLength(0);

    const publicWall = await createPublishedWall(OWNER, { isPublic: true });
    await climbMutations.saveClimb(
      {},
      {
        input: {
          boardType: 'spray',
          layoutId: publicWall.wall.layoutId,
          name: 'Loud climb',
          isDraft: false,
          frames: framesFor(publicWall.holdIds),
          angle: 40,
          userGrade: '4a/V0',
        },
      },
      ctxFor(OWNER),
    );
    const announced = publishedEvents.filter((event) => event.type === 'climb.created');
    expect(announced).toHaveLength(1);
    expect(announced[0].metadata).toMatchObject({ climbName: 'Loud climb', difficultyName: '4a/V0' });
  });

  it('keeps a draft’s grade so the publish through updateClimb can find it', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);

    const draft = (await climbMutations.saveClimb(
      {},
      {
        input: {
          boardType: 'spray',
          layoutId: wall.layoutId,
          name: 'Draft with a grade',
          isDraft: true,
          frames: framesFor(holdIds),
          angle: 40,
          userGrade: '6b/V4',
        },
      },
      ctxFor(OWNER),
    )) as { uuid: string };

    // Seeded on the DRAFT: updateClimb's publish-time seed has no grade source to
    // reconstruct from, so skipping it here would lose the grade at publish.
    const [stats] = (await db.execute(sql`
      SELECT display_difficulty FROM board_climb_stats WHERE climb_uuid = ${draft.uuid}
    `)) as unknown as Array<{ display_difficulty: number }>;
    expect(stats.display_difficulty).toBe(18);

    await expect(
      climbMutations.updateClimb(
        {},
        { input: { uuid: draft.uuid, boardType: 'spray', isDraft: false } },
        ctxFor(OWNER),
      ),
    ).resolves.toMatchObject({ isDraft: false });
  });

  it('refuses to publish an ungraded draft through updateClimb', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);

    const draft = (await climbMutations.saveClimb(
      {},
      {
        input: {
          boardType: 'spray',
          layoutId: wall.layoutId,
          name: 'Ungraded draft',
          isDraft: true,
          frames: framesFor(holdIds),
          angle: 40,
        },
      },
      ctxFor(OWNER),
    )) as { uuid: string };

    // Otherwise draft → publish is a way around assertSprayGradeOnPublish.
    await expect(
      climbMutations.updateClimb(
        {},
        { input: { uuid: draft.uuid, boardType: 'spray', isDraft: false } },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(/needs your grade/i);
  });

  it('refuses an edit that moves a climb onto a hold that came off the wall', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);

    const saved = (await climbMutations.saveClimb(
      {},
      {
        input: {
          boardType: 'spray',
          layoutId: wall.layoutId,
          name: 'Editable climb',
          isDraft: false,
          frames: framesFor([holdIds[0], holdIds[1]]),
          angle: 40,
          userGrade: '6b/V4',
        },
      },
      ctxFor(OWNER),
    )) as { uuid: string };

    const photoId = registerUploadedPhoto(wall.uuid);
    const reset = (await sprayWallMutations.createSprayWallVersion(
      {},
      { input: { wallUuid: wall.uuid, photoId, anchors: ANCHORS } },
      ctxFor(OWNER),
    )) as { id: string };
    await sprayWallMutations.removeSprayWallHolds(
      {},
      { input: { wallUuid: wall.uuid, versionId: reset.id, holdIds: [holdIds[2]] } },
      ctxFor(OWNER),
    );
    await sprayWallMutations.publishSprayWallVersion({}, { input: { versionId: reset.id } }, ctxFor(OWNER));

    await expect(
      climbMutations.updateClimb(
        {},
        { input: { uuid: saved.uuid, boardType: 'spray', frames: framesFor(holdIds) } },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(/not on this wall/i);

    // The stored frames are untouched — a rejected edit must leave the row alone.
    const [row] = (await db.execute(
      sql`SELECT frames FROM board_climbs WHERE uuid = ${saved.uuid}`,
    )) as unknown as Array<{ frames: string }>;
    expect(row.frames).toBe(framesFor([holdIds[0], holdIds[1]]));
  });
});

describe('the caps, and the shapes the server refuses', () => {
  it('refuses the 11th wall', async () => {
    // The real bound on wall volume — the per-minute limiter is a spam ceiling,
    // not a budget.
    for (let created = 0; created < MAX_SPRAY_WALLS_PER_USER; created++) {
      await createWall(OWNER);
    }
    await expect(createWall(OWNER)).rejects.toThrow(
      new RegExp(`limit of ${MAX_SPRAY_WALLS_PER_USER} spray walls`, 'i'),
    );
    // Another climber is unaffected: the cap is per owner.
    await expect(createWall(STRANGER)).resolves.toMatchObject({ layoutId: expect.any(Number) });
  });

  it('refuses a version past the per-wall cap', async () => {
    const wall = await createWall(OWNER);
    for (let created = 0; created < MAX_VERSIONS_PER_WALL; created++) {
      const photoId = registerUploadedPhoto(wall.uuid);
      await sprayWallMutations.createSprayWallVersion(
        {},
        { input: { wallUuid: wall.uuid, photoId, anchors: ANCHORS } },
        ctxFor(OWNER),
      );
    }
    const overflowPhoto = registerUploadedPhoto(wall.uuid);
    await expect(
      sprayWallMutations.createSprayWallVersion(
        {},
        { input: { wallUuid: wall.uuid, photoId: overflowPhoto, anchors: ANCHORS } },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(new RegExp(`limit of ${MAX_VERSIONS_PER_WALL} photos`, 'i'));
  });

  it('refuses the hold that would take a wall past the per-wall cap', async () => {
    const wall = await createWall(OWNER);
    const photoId = registerUploadedPhoto(wall.uuid);
    const version = (await sprayWallMutations.createSprayWallVersion(
      {},
      { input: { wallUuid: wall.uuid, photoId, anchors: ANCHORS } },
      ctxFor(OWNER),
    )) as { id: string };

    // Fill the wall exactly to the cap in one batch — which is legal, and is what
    // a dense detector run looks like.
    const toTheCap = Array.from({ length: MAX_HOLDS_PER_WALL }, (_, index) => ({
      cx: 10 + (index % 700),
      cy: 10 + Math.floor(index / 700),
      r: 12,
    }));
    await expect(
      sprayWallMutations.upsertSprayWallHolds(
        {},
        { input: { wallUuid: wall.uuid, versionId: version.id, holds: toTheCap } },
        ctxFor(OWNER),
      ),
    ).resolves.toHaveLength(MAX_HOLDS_PER_WALL);

    // The next one is refused on the RESULTING TOTAL, not on the batch size — the
    // cap bounds what an editor session and a reset match hold in memory at once,
    // so it cannot be dodged by sending one hold at a time.
    await expect(
      sprayWallMutations.upsertSprayWallHolds(
        {},
        { input: { wallUuid: wall.uuid, versionId: version.id, holds: [{ cx: 900, cy: 900, r: 12 }] } },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(new RegExp(`at most ${MAX_HOLDS_PER_WALL} holds`, 'i'));

    const [{ holds }] = (await db.execute(
      sql`SELECT count(*)::int AS holds FROM spray_wall_holds`,
    )) as unknown as Array<{ holds: number }>;
    expect(holds).toBe(MAX_HOLDS_PER_WALL);
  });

  it("keeps a climb's compatible_size_ids to its OWN wall on a two-wall database", async () => {
    // `populateDenormalizedColumns` derives this column by joining every spray
    // size row whose edge box contains the climb's, with no layout scoping — so on
    // a second wall with a roomier frame the unasserted value would name both.
    const first = await createPublishedWall(OWNER);

    // A wall whose canonical frame strictly contains the first one's holds.
    const roomy = await createWall(OWNER);
    const roomyPhoto = registerUploadedPhoto(roomy.uuid, { width: 4000, height: 4000 });
    const roomyVersion = (await sprayWallMutations.createSprayWallVersion(
      {},
      {
        input: {
          wallUuid: roomy.uuid,
          photoId: roomyPhoto,
          anchors: [
            [0, 0],
            [4000, 0],
            [4000, 4000],
            [0, 4000],
          ],
        },
      },
      ctxFor(OWNER),
    )) as { id: string };
    await sprayWallMutations.upsertSprayWallHolds(
      {},
      { input: { wallUuid: roomy.uuid, versionId: roomyVersion.id, holds: [{ cx: 2000, cy: 2000, r: 40 }] } },
      ctxFor(OWNER),
    );
    await sprayWallMutations.publishSprayWallVersion({}, { input: { versionId: roomyVersion.id } }, ctxFor(OWNER));

    const saved = (await climbMutations.saveClimb(
      {},
      {
        input: {
          boardType: 'spray',
          layoutId: first.wall.layoutId,
          name: 'Only on wall one',
          isDraft: false,
          frames: framesFor(first.holdIds),
          angle: 40,
          userGrade: '6b/V4',
        },
      },
      ctxFor(OWNER),
    )) as { uuid: string };

    const [climb] = (await db.execute(sql`
      SELECT edge_left, edge_right, edge_bottom, edge_top, compatible_size_ids, required_set_ids
      FROM board_climbs WHERE uuid = ${saved.uuid}
    `)) as unknown as Array<{
      edge_left: number;
      edge_right: number;
      edge_bottom: number;
      edge_top: number;
      compatible_size_ids: number[];
      required_set_ids: number[];
    }>;

    // Both walls' size rows carry a real edge box — `createSprayWallVersion` writes
    // it when the frame is decided — and the climb's box sits strictly inside BOTH.
    // So the unasserted derivation really would name both sizes, which is what
    // makes the next assertion a pin rather than a tautology.
    const sizeRows = (await db.execute(sql`
      SELECT id, edge_left, edge_right, edge_bottom, edge_top
      FROM board_product_sizes WHERE board_type = 'spray' ORDER BY id
    `)) as unknown as Array<{
      id: number;
      edge_left: number;
      edge_right: number;
      edge_bottom: number;
      edge_top: number;
    }>;
    expect(sizeRows.map((row) => row.id)).toEqual([first.wall.sizeId, roomy.sizeId]);
    for (const row of sizeRows) {
      expect(row.edge_left).toBe(0);
      expect(row.edge_bottom).toBe(0);
      expect(row.edge_right).toBeGreaterThan(climb.edge_right);
      expect(row.edge_top).toBeGreaterThan(climb.edge_top);
      expect(row.edge_left).toBeLessThan(climb.edge_left);
      expect(row.edge_bottom).toBeLessThan(climb.edge_bottom);
    }

    expect(climb.compatible_size_ids).toEqual([first.wall.sizeId]);
    expect(climb.compatible_size_ids).not.toContain(roomy.sizeId);
    expect(climb.required_set_ids).toEqual([1]);

    // …and an EDIT that moves the holds re-runs the same helper, so it needs its
    // own re-assertion. Pinned here rather than in a second fixture because the
    // two-wall database is what makes the derivation wrong in the first place.
    await climbMutations.updateClimb(
      {},
      { input: { uuid: saved.uuid, boardType: 'spray', frames: framesFor([first.holdIds[0], first.holdIds[1]]) } },
      ctxFor(OWNER),
    );
    const [edited] = (await db.execute(sql`
      SELECT compatible_size_ids, required_set_ids FROM board_climbs WHERE uuid = ${saved.uuid}
    `)) as unknown as Array<{ compatible_size_ids: number[]; required_set_ids: number[] }>;
    expect(edited.compatible_size_ids).toEqual([first.wall.sizeId]);
    expect(edited.required_set_ids).toEqual([1]);
  });

  it('refuses a degenerate anchor quad rather than pinning a broken frame', async () => {
    // On version 1 the anchors DEFINE the canonical frame, and every later version
    // inherits it — so four taps in a line would pin an 8x0 coordinate space on the
    // wall for good and land every hold ever drawn on it in the same pixel.
    const wall = await createWall(OWNER);
    const photoId = registerUploadedPhoto(wall.uuid);

    const collinear = [
      [0, 0],
      [100, 0],
      [200, 0],
      [300, 0],
    ];
    await expect(
      sprayWallMutations.createSprayWallVersion(
        {},
        { input: { wallUuid: wall.uuid, photoId, anchors: collinear } },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(/do not enclose a wall/i);

    const identical = [
      [50, 50],
      [50, 50],
      [50, 50],
      [50, 50],
    ];
    await expect(
      sprayWallMutations.createSprayWallVersion(
        {},
        { input: { wallUuid: wall.uuid, photoId, anchors: identical } },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(/do not enclose a wall/i);

    // Concave: clears the size and area rules, and its homography's denominator
    // crosses zero INSIDE the wall. The geometry rule lives in
    // `@boardsesh/spray-wall-geometry`; what this pins is that the Zod refine
    // actually reaches it from the resolver.
    await expect(
      sprayWallMutations.createSprayWallVersion(
        {},
        {
          input: {
            wallUuid: wall.uuid,
            photoId,
            anchors: [
              [0, 0],
              [100, 0],
              [40, 40],
              [0, 100],
            ],
          },
        },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(/do not enclose a wall/i);

    // A bow-tie, whose two lobes partly cancel in a shoelace test.
    await expect(
      sprayWallMutations.createSprayWallVersion(
        {},
        {
          input: {
            wallUuid: wall.uuid,
            photoId,
            anchors: [
              [0, 0],
              [100, 0],
              [0, 100],
              [140, 140],
            ],
          },
        },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(/do not enclose a wall/i);

    // A hard perspective trapezoid is NOT degenerate and still goes through.
    await expect(
      sprayWallMutations.createSprayWallVersion(
        {},
        {
          input: {
            wallUuid: wall.uuid,
            photoId,
            anchors: [
              [40, 60],
              [1100, 220],
              [1050, 820],
              [90, 700],
            ],
          },
        },
        ctxFor(OWNER),
      ),
    ).resolves.toMatchObject({ number: 1 });
  });

  it('refuses a movedFromHoldId that has never been on this wall', async () => {
    // Lineage, not geometry: a pointer at another wall's hold would make remix
    // suggest a successor for a hold that was never there.
    const { wall } = await createPublishedWall(OWNER);
    const other = await createPublishedWall(OWNER);

    const photoId = registerUploadedPhoto(wall.uuid);
    const draft = (await sprayWallMutations.createSprayWallVersion(
      {},
      { input: { wallUuid: wall.uuid, photoId, anchors: ANCHORS } },
      ctxFor(OWNER),
    )) as { id: string };

    await expect(
      sprayWallMutations.upsertSprayWallHolds(
        {},
        {
          input: {
            wallUuid: wall.uuid,
            versionId: draft.id,
            holds: [{ cx: 300, cy: 300, r: 20, movedFromHoldId: other.holdIds[0] }],
          },
        },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(/has never been on this wall/i);

    // A predecessor from THIS wall is accepted, even once it has come off — a
    // move's whole point is that the old hold is gone.
    const { holdIds } = {
      holdIds: (
        (await sprayWallQueries.sprayWallRenderData({}, { uuid: wall.uuid }, ctxFor(OWNER))) as {
          holds: Array<{ id: number }>;
        }
      ).holds.map((hold) => hold.id),
    };
    await expect(
      sprayWallMutations.upsertSprayWallHolds(
        {},
        {
          input: {
            wallUuid: wall.uuid,
            versionId: draft.id,
            holds: [{ cx: 310, cy: 310, r: 20, movedFromHoldId: holdIds[0] }],
          },
        },
        ctxFor(OWNER),
      ),
    ).resolves.toHaveLength(1);
  });

  it('degrades to a null photo instead of erroring when the bucket is unconfigured', async () => {
    // `SprayWallVersion.photo` is nullable for exactly this: minted per read, so a
    // backend with no `private` bucket has nothing to hand back, and a non-null
    // field would hard-error the whole `versions` list instead of one absent photo.
    const { wall } = await createPublishedWall(OWNER);
    const storage = await import('../storage/s3');
    vi.mocked(storage.isS3Configured).mockReturnValueOnce(false).mockReturnValueOnce(false);

    const read = (await sprayWallQueries.sprayWall({}, { uuid: wall.uuid }, ctxFor(OWNER))) as {
      versions: Array<{ photo: unknown; number: number }>;
    };
    expect(read.versions).toHaveLength(1);
    expect(read.versions[0].photo).toBeNull();

    // And the render payload, which CANNOT serve a null photo, returns null whole
    // rather than a half-built object.
    vi.mocked(storage.isS3Configured).mockReturnValueOnce(false).mockReturnValueOnce(false);
    expect(await sprayWallQueries.sprayWallRenderData({}, { uuid: wall.uuid }, ctxFor(OWNER))).toBeNull();
  });
});

describe('a private wall\u2019s climbs are not readable through the climb API', () => {
  // A spray climb is stored `is_listed = true` — that is what makes queue, play,
  // ticks and search work on a wall unchanged — so every predicate written for the
  // eight catalogue boards reads it as public. Layout ids come out of a sequence,
  // so each of these reads was an enumeration of every wall in the database.
  //
  // The contract for all of them: an EMPTY result, never an error, and never a
  // different shape — otherwise the response says which layout ids are private.
  async function wallWithAClimb(overrides: Record<string, unknown> = {}) {
    const { wall, holdIds } = await createPublishedWall(OWNER, overrides);
    const saved = (await climbMutations.saveClimb(
      {},
      {
        input: {
          boardType: 'spray',
          layoutId: wall.layoutId,
          name: 'Secret garage problem',
          isDraft: false,
          frames: framesFor(holdIds),
          angle: 40,
          userGrade: '6b/V4',
        },
      },
      ctxFor(OWNER),
    )) as { uuid: string };
    return { wall, holdIds, climbUuid: saved.uuid };
  }

  const searchInputFor = (layoutId: number, sizeId: number) => ({
    boardName: 'spray',
    layoutId,
    sizeId,
    setIds: '1',
    angle: 40,
  });

  it('searchClimbs returns an empty page to a stranger and the climbs to the owner', async () => {
    const { wall } = await wallWithAClimb();
    const input = searchInputFor(wall.layoutId, wall.sizeId);

    for (const viewer of [null, STRANGER]) {
      const context = (await climbQueries.searchClimbs({}, { input }, ctxFor(viewer))) as {
        _cachedClimbs?: unknown[];
        _cachedTotalCount?: number;
      };
      expect(context._cachedClimbs).toEqual([]);
      expect(context._cachedTotalCount).toBe(0);
    }

    // The owner gets a real search context — no pre-baked empty — so the gate is
    // not simply refusing everyone.
    const asOwner = (await climbQueries.searchClimbs({}, { input }, ctxFor(OWNER))) as {
      _cachedClimbs?: unknown[];
      params: { layout_id: number };
    };
    expect(asOwner._cachedClimbs).toBeUndefined();
    expect(asOwner.params.layout_id).toBe(wall.layoutId);
  });

  it('never serves a spray search from the shared anonymous cache', async () => {
    // The Redis key is the board config with NO viewer in it, so one owner's page of
    // their own private wall would be handed to the next caller for that layout.
    const { wall } = await wallWithAClimb();
    const asOwner = (await climbQueries.searchClimbs(
      {},
      { input: searchInputFor(wall.layoutId, wall.sizeId) },
      ctxFor(OWNER),
    )) as { _isCacheable?: boolean };
    expect(asOwner._isCacheable).toBe(false);
  });

  it('searchClimbs still works for a PUBLIC wall, anonymously', async () => {
    const { wall } = await wallWithAClimb({ isPublic: true });
    const context = (await climbQueries.searchClimbs(
      {},
      { input: searchInputFor(wall.layoutId, wall.sizeId) },
      ctxFor(null),
    )) as { _cachedClimbs?: unknown[] };
    expect(context._cachedClimbs).toBeUndefined();
  });

  it('similarClimbs takes a bare hold set, so it needed the gate most', async () => {
    // `climbUuid` is optional here: posting holds with threshold 0 against a guessed
    // layoutId dumped the whole catalogue with no capability at all.
    const { wall, holdIds } = await wallWithAClimb();
    const input = {
      boardType: 'spray',
      layoutId: wall.layoutId,
      // `frames` instead of `climbUuid` — that is the whole point: no capability.
      frames: framesFor(holdIds),
      threshold: 0,
      limit: 20,
    };
    expect(await climbQueries.similarClimbs({}, { input }, ctxFor(null))).toEqual([]);
    expect(await climbQueries.similarClimbs({}, { input }, ctxFor(STRANGER))).toEqual([]);
  });

  it('setterStats hides the private wall\u2019s crew', async () => {
    const { wall } = await wallWithAClimb();
    const input = {
      boardName: 'spray',
      layoutId: wall.layoutId,
      sizeId: wall.sizeId,
      setIds: '1',
      angle: 40,
    };
    expect(await climbQueries.setterStats({}, { input }, ctxFor(STRANGER))).toEqual([]);
    expect((await climbQueries.setterStats({}, { input }, ctxFor(OWNER))).length).toBeGreaterThan(0);
  });

  it('newClimbFeed hides it, and it was the cheapest read of all', async () => {
    const { wall } = await wallWithAClimb();
    const input = { boardType: 'spray', layoutId: wall.layoutId, limit: 20, offset: 0 };

    const asStranger = await newClimbSubscriptionResolvers.Query.newClimbFeed({}, { input }, ctxFor(STRANGER));
    expect(asStranger.items).toEqual([]);
    expect(asStranger.totalCount).toBe(0);

    const asOwner = await newClimbSubscriptionResolvers.Query.newClimbFeed({}, { input }, ctxFor(OWNER));
    expect(asOwner.items.length).toBeGreaterThan(0);
  });

  it('the climb(uuid) read is gated by the WALL, not by holding the uuid', async () => {
    // A uuid is a 122-bit secret so this is not enumerable — but it is the path a
    // shared link takes, and a link that escaped once would otherwise serve a
    // private wall's climb forever.
    const { wall, climbUuid } = await wallWithAClimb();
    const args = {
      boardName: 'spray',
      layoutId: wall.layoutId,
      sizeId: wall.sizeId,
      setIds: '1',
      angle: 40,
      climbUuid,
    };
    expect(await climbQueries.climb({}, args, ctxFor(STRANGER))).toBeNull();
    expect(await climbQueries.climb({}, args, ctxFor(OWNER))).not.toBeNull();
  });

  it('the offline syncClimbs pull hands a stranger an empty page', async () => {
    // The highest-fidelity leak: this scope is `board_type` + `layout_id` and
    // nothing else — no is_listed, no is_draft — because it is a full row mirror.
    const { wall } = await wallWithAClimb();
    const args = { boardType: 'spray', layoutId: wall.layoutId, sizeId: wall.sizeId, cursor: null, limit: 50 };

    const asStranger = await syncQueries.syncClimbs({}, args, ctxFor(STRANGER));
    expect(asStranger.documents).toEqual([]);
    expect(asStranger.hasMore).toBe(false);

    const asOwner = await syncQueries.syncClimbs({}, args, ctxFor(OWNER));
    expect(asOwner.documents.length).toBeGreaterThan(0);
  });

  it('userClimbs does not leak a private wall through a public profile', async () => {
    // No board scoping at all on this one — a spray climb rode along with every
    // other board the climber has set on, layout id included.
    const { climbUuid } = await wallWithAClimb();

    const asStranger = (await setterFollowQueries.userClimbs(
      {},
      { input: { userId: OWNER, limit: 50, offset: 0 } },
      ctxFor(STRANGER),
    )) as { climbs: Array<{ uuid: string }>; totalCount: number };
    expect(asStranger.climbs.map((climb) => climb.uuid)).not.toContain(climbUuid);

    const asOwner = (await setterFollowQueries.userClimbs(
      {},
      { input: { userId: OWNER, limit: 50, offset: 0 } },
      ctxFor(OWNER),
    )) as { climbs: Array<{ uuid: string }> };
    expect(asOwner.climbs.map((climb) => climb.uuid)).toContain(climbUuid);
  });

  // ---- the TICK-shaped readers -------------------------------------------
  //
  // These do not take a board type or a layout from the caller at all — they walk
  // from a tick to its climb — so the gate cannot sit at the front of the resolver
  // and has to ride in the WHERE. They select the climb's name and frames, and the
  // epic decided private-wall ticks are the owner's logbook alone.

  /** A published climb on a private wall, with a tick on it by the owner. */
  async function tickOnAPrivateWall(overrides: Record<string, unknown> = {}) {
    const { wall, climbUuid } = await wallWithAClimb(overrides);
    await db.execute(sql`
      INSERT INTO boardsesh_ticks (uuid, user_id, climb_uuid, board_type, angle, status, climbed_at, created_at, updated_at)
      VALUES (${uuidv4()}, ${OWNER}, ${climbUuid}, 'spray', 40, 'send', now(), now(), now())
    `);
    return { wall, climbUuid };
  }

  it('globalAscentsFeed hides it from an anonymous reader, and shows the owner their own tick', async () => {
    const { climbUuid } = await tickOnAPrivateWall();
    const read = async (viewer: string | null) =>
      (
        (await socialFeedQueries.globalAscentsFeed({}, { input: { limit: 50, offset: 0 } }, ctxFor(viewer))) as {
          items: Array<{ climbUuid?: string }>;
        }
      ).items.map((item) => item.climbUuid);

    expect(await read(null)).not.toContain(climbUuid);
    expect(await read(STRANGER)).not.toContain(climbUuid);
    expect(await read(OWNER)).toContain(climbUuid);
  });

  it('followingAscentsFeed hides it from a follower', async () => {
    // Following somebody is not access to the inside of their garage.
    const { climbUuid } = await tickOnAPrivateWall();
    await db.execute(sql`
      INSERT INTO user_follows (follower_id, following_id, created_at)
      VALUES (${STRANGER}, ${OWNER}, now()) ON CONFLICT DO NOTHING
    `);

    const feed = (await socialFeedQueries.followingAscentsFeed(
      {},
      { input: { limit: 50, offset: 0 } },
      ctxFor(STRANGER),
    )) as { items: Array<{ climbUuid?: string }> };
    expect(feed.items.map((item) => item.climbUuid)).not.toContain(climbUuid);
  });

  it('trendingFeed hides it, and that one is unauthenticated and rate-limit free', async () => {
    const { climbUuid } = await tickOnAPrivateWall();
    const read = async (viewer: string | null) =>
      (
        (await activityFeedQueries.trendingFeed({}, { input: { limit: 50 } }, ctxFor(viewer))) as {
          items: Array<{ climbUuid?: string }>;
        }
      ).items.map((item) => item.climbUuid);

    expect(await read(null)).not.toContain(climbUuid);
    expect(await read(STRANGER)).not.toContain(climbUuid);
    expect(await read(OWNER)).toContain(climbUuid);
  });

  it('sessionDetail hides it, and its daily ids are handed out by the grouped feed', async () => {
    // `daily:<userId>:<day>` needs no auth and no secret, so the id is not a
    // capability — the wall's visibility has to decide.
    const { climbUuid } = await tickOnAPrivateWall();
    const [{ day }] = (await db.execute(sql`SELECT to_char(now(), 'YYYY-MM-DD') AS day`)) as unknown as Array<{
      day: string;
    }>;
    const sessionId = `daily:${OWNER}:${day}`;

    const read = async (viewer: string | null) => {
      const detail = (await sessionFeedQueries.sessionDetail({}, { sessionId }, ctxFor(viewer))) as {
        ticks?: Array<{ climbUuid?: string; climbName?: string }>;
      } | null;
      return (detail?.ticks ?? []).map((tick) => tick.climbUuid);
    };

    expect(await read(null)).not.toContain(climbUuid);
    expect(await read(STRANGER)).not.toContain(climbUuid);
    expect(await read(OWNER)).toContain(climbUuid);
  });

  it('a PUBLIC wall still reaches every one of those feeds', async () => {
    // Guards the guard: a condition that dropped every spray row would pass the
    // four tests above for the wrong reason.
    const { climbUuid } = await tickOnAPrivateWall({ isPublic: true });

    const global = (await socialFeedQueries.globalAscentsFeed(
      {},
      { input: { limit: 50, offset: 0 } },
      ctxFor(null),
    )) as { items: Array<{ climbUuid?: string }> };
    expect(global.items.map((item) => item.climbUuid)).toContain(climbUuid);

    const trending = (await activityFeedQueries.trendingFeed({}, { input: { limit: 50 } }, ctxFor(null))) as {
      items: Array<{ climbUuid?: string }>;
    };
    expect(trending.items.map((item) => item.climbUuid)).toContain(climbUuid);
  });

  it('keeps a tick whose climb row is MISSING — the "Unknown Climb" case', async () => {
    // Four callers AND this predicate onto a LEFT-JOINed `board_climbs`, and a tick
    // with no climb row is a case they deliberately render as "Unknown Climb". With
    // a plain `<>`, `NULL <> 'spray'` is NULL and the row vanishes — and
    // `sessionDetail`, which returns null when it finds no ticks, loses the whole
    // session. Hence `IS DISTINCT FROM`.
    const orphanUuid = 'ORPHANTICKCLIMBUUID0000000000001';
    await db.execute(sql`
      INSERT INTO boardsesh_ticks (uuid, user_id, climb_uuid, board_type, angle, status, climbed_at, created_at, updated_at)
      VALUES (${uuidv4()}, ${OWNER}, ${orphanUuid}, 'kilter', 40, 'send', now(), now(), now())
    `);

    const [{ day }] = (await db.execute(sql`SELECT to_char(now(), 'YYYY-MM-DD') AS day`)) as unknown as Array<{
      day: string;
    }>;

    const detail = (await sessionFeedQueries.sessionDetail(
      {},
      { sessionId: `daily:${OWNER}:${day}` },
      ctxFor(OWNER),
    )) as { ticks?: Array<{ climbUuid?: string }> } | null;
    expect(detail).not.toBeNull();
    expect((detail?.ticks ?? []).map((tick) => tick.climbUuid)).toContain(orphanUuid);

    const global = (await socialFeedQueries.globalAscentsFeed(
      {},
      { input: { limit: 50, offset: 0 } },
      ctxFor(null),
    )) as { items: Array<{ climbUuid?: string }> };
    expect(global.items.map((item) => item.climbUuid)).toContain(orphanUuid);
  });

  it('lets a GYM MEMBER read a gym wall\u2019s climbs', async () => {
    // The rule is owner / gym member / public, so a gym's spray wall has to work
    // for the gym — otherwise the fix has broken the product.
    const { wall, climbUuid } = await wallWithAClimb();
    const gymUuid = uuidv4();
    await db.execute(sql`
      INSERT INTO gyms (uuid, name, slug, owner_id, is_public, created_at, updated_at)
      VALUES (${gymUuid}, 'Gate Gym', ${gymUuid}, ${OWNER}, true, now(), now())
    `);
    const [gym] = (await db.execute(sql`SELECT id FROM gyms WHERE uuid = ${gymUuid}`)) as unknown as Array<{
      id: number;
    }>;
    await db.execute(sql`UPDATE user_boards SET gym_id = ${gym.id} WHERE uuid = ${wall.uuid}`);
    await db.execute(sql`
      INSERT INTO gym_members (gym_id, user_id, role, created_at)
      VALUES (${gym.id}, ${GYM_EDITOR}, 'member', now())
    `);

    const asMember = (await climbQueries.searchClimbs(
      {},
      { input: searchInputFor(wall.layoutId, wall.sizeId) },
      ctxFor(GYM_EDITOR),
    )) as { _cachedClimbs?: unknown[] };
    expect(asMember._cachedClimbs).toBeUndefined();

    expect(
      await climbQueries.climb(
        {},
        {
          boardName: 'spray',
          layoutId: wall.layoutId,
          sizeId: wall.sizeId,
          setIds: '1',
          angle: 40,
          climbUuid,
        },
        ctxFor(GYM_EDITOR),
      ),
    ).not.toBeNull();
  });
});

describe('a published generation is immutable', () => {
  it('turns a correction to an INHERITED hold into a removal plus a new hold', async () => {
    // `spray_wall_holds` is the geometry every climb on the published wall renders
    // from. Editing an inherited hold in place would move it under all of them —
    // before this draft is published, and even if it never is.
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const inherited = holdIds[0];

    const [before] = (await db.execute(sql`
      SELECT cx, cy, r FROM spray_wall_holds
      WHERE wall_id = (SELECT id FROM spray_walls WHERE layout_id = ${wall.layoutId}) AND hold_id = ${inherited}
    `)) as unknown as Array<{ cx: number; cy: number; r: number }>;

    const photoId = registerUploadedPhoto(wall.uuid);
    const draft = (await sprayWallMutations.createSprayWallVersion(
      {},
      { input: { wallUuid: wall.uuid, photoId, anchors: ANCHORS } },
      ctxFor(OWNER),
    )) as { id: string };

    const written = (await sprayWallMutations.upsertSprayWallHolds(
      {},
      {
        input: {
          wallUuid: wall.uuid,
          versionId: draft.id,
          holds: [{ id: inherited, cx: before.cx + 37, cy: before.cy + 41, r: before.r + 3 }],
        },
      },
      ctxFor(OWNER),
    )) as Array<{ id: number; cx: number; cy: number; movedFromHoldId: number | null; installedVersion: number }>;

    // The caller gets the SUCCESSOR, not the id it sent — the id it sent is history
    // as of this draft.
    expect(written).toHaveLength(1);
    expect(written[0].id).not.toBe(inherited);
    expect(written[0].cx).toBe(before.cx + 37);
    expect(written[0].movedFromHoldId).toBe(inherited);
    expect(written[0].installedVersion).toBe(2);

    // The ORIGINAL row is untouched apart from being stamped removed at the draft.
    const [original] = (await db.execute(sql`
      SELECT cx, cy, r, removed_version_id FROM spray_wall_holds
      WHERE wall_id = (SELECT id FROM spray_walls WHERE layout_id = ${wall.layoutId}) AND hold_id = ${inherited}
    `)) as unknown as Array<{ cx: number; cy: number; r: number; removed_version_id: number | null }>;
    expect(original.cx).toBe(before.cx);
    expect(original.cy).toBe(before.cy);
    expect(original.r).toBe(before.r);
    expect(Number(original.removed_version_id)).toBe(Number(draft.id));

    // And the PUBLISHED wall still renders the old geometry, because version 1 is
    // what climbers are looking at until the draft publishes.
    const published = (await sprayWallQueries.sprayWallRenderData({}, { uuid: wall.uuid }, ctxFor(OWNER))) as {
      versionNumber: number;
      holds: Array<{ id: number; cx: number }>;
    };
    expect(published.versionNumber).toBe(1);
    expect(published.holds.find((hold) => hold.id === inherited)!.cx).toBe(before.cx);
    expect(published.holds.map((hold) => hold.id)).not.toContain(written[0].id);
  });

  it('edits a hold the SAME draft drew, in place', async () => {
    // Guards the guard: a rule that superseded everything would make the editor
    // allocate a new id every time somebody nudged a hold they had just placed.
    const wall = await createWall(OWNER);
    const photoId = registerUploadedPhoto(wall.uuid);
    const draft = (await sprayWallMutations.createSprayWallVersion(
      {},
      { input: { wallUuid: wall.uuid, photoId, anchors: ANCHORS } },
      ctxFor(OWNER),
    )) as { id: string };

    const [drawn] = (await sprayWallMutations.upsertSprayWallHolds(
      {},
      { input: { wallUuid: wall.uuid, versionId: draft.id, holds: [{ cx: 100, cy: 100, r: 20 }] } },
      ctxFor(OWNER),
    )) as Array<{ id: number }>;

    const [nudged] = (await sprayWallMutations.upsertSprayWallHolds(
      {},
      { input: { wallUuid: wall.uuid, versionId: draft.id, holds: [{ id: drawn.id, cx: 140, cy: 150, r: 22 }] } },
      ctxFor(OWNER),
    )) as Array<{ id: number; cx: number; cy: number }>;

    expect(nudged.id).toBe(drawn.id);
    expect(nudged.cx).toBe(140);

    // One row, not two: no supersede happened.
    const [{ holds }] = (await db.execute(
      sql`SELECT count(*)::int AS holds FROM spray_wall_holds
          WHERE wall_id = (SELECT id FROM spray_walls WHERE layout_id = ${wall.layoutId})`,
    )) as unknown as Array<{ holds: number }>;
    expect(holds).toBe(1);

    // And the catalogue centre moved with it.
    const [hole] = (await db.execute(
      sql`SELECT x, y FROM board_holes WHERE board_type = 'spray' AND id = ${drawn.id}`,
    )) as unknown as Array<{ x: number; y: number }>;
    expect([hole.x, hole.y]).toEqual([140, 150]);
  });
});

describe('publishing re-materialises climb integrity', () => {
  it('sets missing_hold_count on every climb that lost a hold', async () => {
    // A publish is the moment a removal becomes real. Without the recompute a climb
    // that just lost two holds reads 0 everywhere — badge, Intact / Lost holds
    // filter, remix prompt and the offline mirror all say it is fine.
    const { wall, holdIds } = await createPublishedWall(OWNER);

    const saveClimbOn = async (name: string, holds: number[]) =>
      (await climbMutations.saveClimb(
        {},
        {
          input: {
            boardType: 'spray',
            layoutId: wall.layoutId,
            name,
            isDraft: false,
            frames: framesFor(holds),
            angle: 40,
            userGrade: '6b/V4',
          },
        },
        ctxFor(OWNER),
      )) as { uuid: string };

    // Two climbs share the doomed hold; a third avoids it.
    const first = await saveClimbOn('Shares the doomed hold', [holdIds[0], holdIds[1]]);
    const second = await saveClimbOn('Also shares it', [holdIds[1], holdIds[2]]);
    const untouched = await saveClimbOn('Avoids it', [holdIds[0], holdIds[2]]);

    const missingFor = async (uuid: string) => {
      const [row] = (await db.execute(
        sql`SELECT missing_hold_count FROM board_climbs WHERE uuid = ${uuid}`,
      )) as unknown as Array<{ missing_hold_count: number | null }>;
      return row.missing_hold_count;
    };

    expect(await missingFor(first.uuid)).toBe(0);

    const photoId = registerUploadedPhoto(wall.uuid);
    const reset = (await sprayWallMutations.createSprayWallVersion(
      {},
      { input: { wallUuid: wall.uuid, photoId, anchors: ANCHORS } },
      ctxFor(OWNER),
    )) as { id: string };
    await sprayWallMutations.removeSprayWallHolds(
      {},
      { input: { wallUuid: wall.uuid, versionId: reset.id, holdIds: [holdIds[1]] } },
      ctxFor(OWNER),
    );

    // Still a DRAFT: the removal has not happened as far as anyone is concerned.
    expect(await missingFor(first.uuid)).toBe(0);
    expect(await missingFor(second.uuid)).toBe(0);

    await sprayWallMutations.publishSprayWallVersion({}, { input: { versionId: reset.id } }, ctxFor(OWNER));

    expect(await missingFor(first.uuid)).toBe(1);
    expect(await missingFor(second.uuid)).toBe(1);
    expect(await missingFor(untouched.uuid)).toBe(0);
  });

  it('counts nothing for a removal an ABANDONED draft made', async () => {
    // The recompute carries the same landed-version bound `aliveHolds` does, or
    // starting a reset and walking away would badge every climb on the wall as
    // broken and the number would never come back on its own.
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const climb = (await climbMutations.saveClimb(
      {},
      {
        input: {
          boardType: 'spray',
          layoutId: wall.layoutId,
          name: 'Untouched by an abandoned draft',
          isDraft: false,
          frames: framesFor([holdIds[0], holdIds[1]]),
          angle: 40,
          userGrade: '6b/V4',
        },
      },
      ctxFor(OWNER),
    )) as { uuid: string };

    // Draft v2 removes a hold, and is never published.
    const abandonedPhoto = registerUploadedPhoto(wall.uuid);
    const abandoned = (await sprayWallMutations.createSprayWallVersion(
      {},
      { input: { wallUuid: wall.uuid, photoId: abandonedPhoto, anchors: ANCHORS } },
      ctxFor(OWNER),
    )) as { id: string };
    await sprayWallMutations.removeSprayWallHolds(
      {},
      { input: { wallUuid: wall.uuid, versionId: abandoned.id, holdIds: [holdIds[0]] } },
      ctxFor(OWNER),
    );

    // Draft v3 removes nothing and publishes, which runs the recompute.
    const realPhoto = registerUploadedPhoto(wall.uuid);
    const real = (await sprayWallMutations.createSprayWallVersion(
      {},
      { input: { wallUuid: wall.uuid, photoId: realPhoto, anchors: ANCHORS } },
      ctxFor(OWNER),
    )) as { id: string };
    await sprayWallMutations.publishSprayWallVersion({}, { input: { versionId: real.id } }, ctxFor(OWNER));

    const [row] = (await db.execute(
      sql`SELECT missing_hold_count FROM board_climbs WHERE uuid = ${climb.uuid}`,
    )) as unknown as Array<{ missing_hold_count: number | null }>;
    expect(row.missing_hold_count).toBe(0);
  });
});

describe('updateSprayWall', () => {
  it('shares a private wall, which is the only way one ever becomes visible', async () => {
    const { wall } = await createPublishedWall(OWNER);
    expect(await sprayWallQueries.sprayWall({}, { uuid: wall.uuid }, ctxFor(STRANGER))).toBeNull();

    await sprayWallMutations.updateSprayWall(
      {},
      { input: { uuid: wall.uuid, isUnlisted: true, name: 'The Shed', description: 'Low and mean' } },
      ctxFor(OWNER),
    );

    const read = (await sprayWallQueries.sprayWall({}, { uuid: wall.uuid }, ctxFor(STRANGER))) as {
      board: { name: string; description: string | null; isUnlisted: boolean };
    } | null;
    expect(read?.board.name).toBe('The Shed');
    expect(read?.board.description).toBe('Low and mean');
    expect(read?.board.isUnlisted).toBe(true);

    // A rename reaches the catalogue rows too, or they drift from the wall forever.
    const [layout] = (await db.execute(
      sql`SELECT name, is_listed FROM board_layouts WHERE board_type = 'spray' AND id = ${wall.layoutId}`,
    )) as unknown as Array<{ name: string; is_listed: boolean }>;
    expect(layout.name).toBe('The Shed');
    // …and nothing here makes a wall listable.
    expect(layout.is_listed).toBe(false);
  });

  it('refuses an angle change once a version is published', async () => {
    // Stats are keyed by angle: every tick already recorded sits at the old one, so
    // moving it would orphan the wall's whole history.
    const { wall } = await createPublishedWall(OWNER);
    await expect(
      sprayWallMutations.updateSprayWall({}, { input: { uuid: wall.uuid, angle: 25 } }, ctxFor(OWNER)),
    ).rejects.toThrow(/cannot change/i);
  });

  it('allows an angle change while nothing is published yet', async () => {
    const wall = await createWall(OWNER);
    await sprayWallMutations.updateSprayWall({}, { input: { uuid: wall.uuid, angle: 25 } }, ctxFor(OWNER));
    const [board] = (await db.execute(
      sql`SELECT angle FROM user_boards WHERE uuid = ${wall.uuid}`,
    )) as unknown as Array<{ angle: number }>;
    expect(Number(board.angle)).toBe(25);
  });

  it('refuses a stranger, and refuses an empty update', async () => {
    const { wall } = await createPublishedWall(OWNER);
    await expect(
      sprayWallMutations.updateSprayWall({}, { input: { uuid: wall.uuid, isPublic: true } }, ctxFor(STRANGER)),
    ).rejects.toThrow(/not authorized/i);
    await expect(sprayWallMutations.updateSprayWall({}, { input: { uuid: wall.uuid } }, ctxFor(OWNER))).rejects.toThrow(
      /Nothing to update/i,
    );
  });
});

describe('the wall angle is fixed', () => {
  it('refuses a climb at an angle the wall is not set at', async () => {
    // Nothing downstream would complain — `board_climbs.angle` takes what it is
    // given — it would just scatter the wall's climbs across angles the wall has
    // never been at, where search (exact angle) would never show them again.
    const { wall, holdIds } = await createPublishedWall(OWNER);
    await expect(
      climbMutations.saveClimb(
        {},
        {
          input: {
            boardType: 'spray',
            layoutId: wall.layoutId,
            name: 'Wrong angle',
            isDraft: false,
            frames: framesFor(holdIds),
            angle: 25,
            userGrade: '6b/V4',
          },
        },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(/set at 40°/i);

    const [{ climbs }] = (await db.execute(
      sql`SELECT count(*)::int AS climbs FROM board_climbs WHERE board_type = 'spray'`,
    )) as unknown as Array<{ climbs: number }>;
    expect(climbs).toBe(0);
  });

  it('refuses an EDIT that moves a climb off the wall angle', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const saved = (await climbMutations.saveClimb(
      {},
      {
        input: {
          boardType: 'spray',
          layoutId: wall.layoutId,
          name: 'Right angle',
          isDraft: false,
          frames: framesFor(holdIds),
          angle: 40,
          userGrade: '6b/V4',
        },
      },
      ctxFor(OWNER),
    )) as { uuid: string };

    await expect(
      climbMutations.updateClimb({}, { input: { uuid: saved.uuid, boardType: 'spray', angle: 30 } }, ctxFor(OWNER)),
    ).rejects.toThrow(/set at 40°/i);
  });
});

describe('publishing a draft that was created without a grade', () => {
  it('accepts the grade on updateClimb, which used to be impossible', async () => {
    // `saveClimb` lets a draft through without a grade on purpose — the grade is the
    // last thing a setter decides — but `UpdateClimbInput` had no `userGrade`, so
    // draft → publish always hit the grade error and the draft could never publish.
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const draft = (await climbMutations.saveClimb(
      {},
      {
        input: {
          boardType: 'spray',
          layoutId: wall.layoutId,
          name: 'Graded at publish',
          isDraft: true,
          frames: framesFor(holdIds),
          angle: 40,
        },
      },
      ctxFor(OWNER),
    )) as { uuid: string };

    // Still refused with no grade from either source.
    await expect(
      climbMutations.updateClimb(
        {},
        { input: { uuid: draft.uuid, boardType: 'spray', isDraft: false } },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(/needs your grade/i);

    await expect(
      climbMutations.updateClimb(
        {},
        { input: { uuid: draft.uuid, boardType: 'spray', isDraft: false, userGrade: '6b/V4' } },
        ctxFor(OWNER),
      ),
    ).resolves.toMatchObject({ isDraft: false });

    const [stats] = (await db.execute(sql`
      SELECT display_difficulty, difficulty_average FROM board_climb_stats WHERE climb_uuid = ${draft.uuid}
    `)) as unknown as Array<{ display_difficulty: number; difficulty_average: number }>;
    expect(stats.display_difficulty).toBe(18);
    expect(stats.difficulty_average).toBe(18);
  });

  it('refuses a grade the scale does not know, at publish time', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const draft = (await climbMutations.saveClimb(
      {},
      {
        input: {
          boardType: 'spray',
          layoutId: wall.layoutId,
          name: 'Nonsense at publish',
          isDraft: true,
          frames: framesFor(holdIds),
          angle: 40,
        },
      },
      ctxFor(OWNER),
    )) as { uuid: string };

    await expect(
      climbMutations.updateClimb(
        {},
        { input: { uuid: draft.uuid, boardType: 'spray', isDraft: false, userGrade: 'V99' } },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(/not a grade/i);
  });
});

describe('the alive-holds check on a metadata-only edit', () => {
  it('validates the STORED holds, so it is not vacuous', async () => {
    // The check reads `board_climb_holds`, and `saveClimb` writes those rows for
    // every spray climb — not gated on a frames change — so a metadata-only edit
    // still has holds to validate. If those rows were ever conditional, this test
    // would pass while the check did nothing.
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const saved = (await climbMutations.saveClimb(
      {},
      {
        input: {
          boardType: 'spray',
          layoutId: wall.layoutId,
          name: 'Has stored holds',
          isDraft: false,
          frames: framesFor(holdIds),
          angle: 40,
          userGrade: '6b/V4',
        },
      },
      ctxFor(OWNER),
    )) as { uuid: string };

    const [{ stored }] = (await db.execute(sql`
      SELECT count(*)::int AS stored FROM board_climb_holds
      WHERE board_type = 'spray' AND climb_uuid = ${saved.uuid}
    `)) as unknown as Array<{ stored: number }>;
    expect(stored).toBe(holdIds.length);

    // Take one of its holds off the wall for real.
    const photoId = registerUploadedPhoto(wall.uuid);
    const reset = (await sprayWallMutations.createSprayWallVersion(
      {},
      { input: { wallUuid: wall.uuid, photoId, anchors: ANCHORS } },
      ctxFor(OWNER),
    )) as { id: string };
    await sprayWallMutations.removeSprayWallHolds(
      {},
      { input: { wallUuid: wall.uuid, versionId: reset.id, holdIds: [holdIds[0]] } },
      ctxFor(OWNER),
    );
    await sprayWallMutations.publishSprayWallVersion({}, { input: { versionId: reset.id } }, ctxFor(OWNER));

    // A pure RENAME — no frames in the input at all — is still refused, because the
    // climb it would re-publish is one nobody can do.
    await expect(
      climbMutations.updateClimb(
        {},
        { input: { uuid: saved.uuid, boardType: 'spray', name: 'Renamed' } },
        ctxFor(OWNER),
      ),
    ).rejects.toThrow(/not on this wall/i);
  });
});
