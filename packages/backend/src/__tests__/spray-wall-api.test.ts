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
                   "board_holes", "board_placements", "board_difficulty_grades"
    RESTART IDENTITY CASCADE
  `);
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
