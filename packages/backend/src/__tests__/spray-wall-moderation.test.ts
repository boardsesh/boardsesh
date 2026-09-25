import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';

/**
 * Reporting a wall, hiding it, and clearing the photographs of a deleted one
 * (SW-17, epic #5346).
 *
 * Three things are worth a test here, and they are the three that could hurt
 * somebody:
 *
 *  - **The hidden gate.** A hidden wall has to read exactly like a private one
 *    for everybody but its owner. Not "mostly": the by-uuid read, the by-layout
 *    read and the climb-visibility predicate are three separate implementations
 *    of one rule, and each is asserted separately — an owner still sees their
 *    wall and its climbs, a stranger who had the uuid gets nothing.
 *  - **The retention threshold.** A wall deleted 31 days ago loses its photos; a
 *    wall deleted yesterday keeps them. Driven with an injected clock rather
 *    than a real 30-day wait, and asserted on BOTH sides, because a purge that
 *    fires early deletes photographs nobody agreed to lose.
 *  - **Reporting.** Any signed-in climber who can see a wall, once — a second
 *    report is the same report, and a wall a viewer cannot see is "not found",
 *    not a different error, so a report is never an oracle for which uuids exist.
 *
 * Storage is the only stub: there is no R2 in CI, so the object listing and
 * delete are scripted and everything else is real rows.
 */

const { presignedUrls, storedPhotoMetadata, storedObjects, deletedObjects, publishedEvents } = vi.hoisted(() => ({
  presignedUrls: [] as string[],
  storedPhotoMetadata: new Map<string, { width: string; height: string }>(),
  storedObjects: new Map<string, Set<string>>(),
  deletedObjects: [] as Array<{ bucket: string; key: string }>,
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
  listS3Objects: vi.fn(async (bucket: string, prefix: string) =>
    [...(storedObjects.get(bucket) ?? [])]
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ key, size: 1024, lastModified: new Date() })),
  ),
  deleteFromS3: vi.fn(async (bucket: string, key: string) => {
    storedObjects.get(bucket)?.delete(key);
    deletedObjects.push({ bucket, key });
  }),
  // The `media` bucket's stable URL, read by `publicPhotoUrl` and the share card.
  getPublicUrl: vi.fn((_bucket: string, key: string) => `https://media.example/${key}`),
}));

// The share card composes under the shared render cap; a passthrough keeps the
// WASM renderer out of a test that only asks which gates a hidden wall clears.
vi.mock('../services/board-render', () => ({
  RenderQueueSaturatedError: class RenderQueueSaturatedError extends Error {},
  runOnRenderSemaphore: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../events', () => ({
  publishSocialEvent: vi.fn(async (event: { type: string; metadata?: Record<string, unknown> }) => {
    publishedEvents.push(event);
  }),
}));
vi.mock('../lib/web-revalidate', () => ({ notifyClimbRevalidated: vi.fn(async () => undefined) }));
vi.mock('../utils/rate-limiter', () => ({ checkRateLimit: vi.fn(), resetAllRateLimits: vi.fn() }));
vi.mock('../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: vi.fn().mockResolvedValue(undefined) }));

const { db } = await import('../db/client');
const { sprayWallQueries, sprayWallMutations } = await import('../graphql/resolvers/board/spray-walls');
const { sprayWallModerationMutations, sprayWallModerationQueries, purgeDeletedSprayWallPhotos } =
  await import('../graphql/resolvers/board/spray-wall-moderation');
const { climbMutations } = await import('../graphql/resolvers/climbs/mutations');
const { climbQueries } = await import('../graphql/resolvers/climbs/queries');
const { smartPlaylist } = await import('../graphql/resolvers/playlists/queries/smart-playlists');
const { favoriteClimbsQuery } = await import('../graphql/resolvers/favorites/favorite-climbs-query');
const { sprayWallPhotoKey } = await import('../handlers/spray-wall-photos');
const { SPRAY_WALL_PHOTO_RETENTION_DAYS } = await import('@boardsesh/board-config');
const { socialBoardQueries } = await import('../graphql/resolvers/social/boards');
const { createSprayOgCardDeps, renderSprayOgCard, resetSprayOgCardCache, SprayPhotoUnavailableError } =
  await import('../services/spray-og-card');

const OWNER = 'sw17-owner';
const STRANGER = 'sw17-stranger';
const ADMIN = 'sw17-admin';
const GYM_MEMBER = 'sw17-gym-member';
const ALL_USERS = [OWNER, STRANGER, ADMIN, GYM_MEMBER];

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

/** An HTTP context that has already cleared the cron secret, for the purge mutation. */
const cronCtx = (): ConnectionContext =>
  ({
    connectionId: 'conn-cron',
    isAuthenticated: false,
    userId: null,
    transport: 'http',
    isCronAuthenticated: true,
  }) as unknown as ConnectionContext;

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

function registerUploadedPhoto(wallUuid: string): string {
  const photoId = uuidv4();
  const key = sprayWallPhotoKey(wallUuid, photoId);
  storedPhotoMetadata.set(key, { width: '1200', height: '900' });
  for (const bucket of ['private', 'media']) {
    if (!storedObjects.has(bucket)) storedObjects.set(bucket, new Set());
  }
  storedObjects.get('private')!.add(key);
  // The thumbnail variant the photo handler writes alongside the base object.
  storedObjects.get('private')!.add(`${key}@280.jpg`);
  return photoId;
}

type CreatedWall = { uuid: string; layoutId: number };

/** A wall with no photo and no version — the state an abandoned wizard leaves. */
async function createWallOnly(): Promise<CreatedWall> {
  for (const bucket of ['private', 'media']) {
    if (!storedObjects.has(bucket)) storedObjects.set(bucket, new Set());
  }
  return (await sprayWallMutations.createSprayWall(
    {},
    { input: { name: `Wall ${uuidv4().slice(0, 6)}`, angle: 40 } },
    ctxFor(OWNER),
  )) as CreatedWall;
}

async function createPublishedWall(overrides: Record<string, unknown> = {}) {
  const wall = (await sprayWallMutations.createSprayWall(
    {},
    { input: { name: `Wall ${uuidv4().slice(0, 6)}`, angle: 40, ...overrides } },
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
    {
      input: {
        wallUuid: wall.uuid,
        versionId: version.id,
        holds: [
          { cx: 100, cy: 120, r: 24 },
          { cx: 300, cy: 400, r: 30 },
          { cx: 520, cy: 560, r: 18 },
        ],
      },
    },
    ctxFor(OWNER),
  )) as Array<{ id: number }>;

  await sprayWallMutations.publishSprayWallVersion({}, { input: { versionId: version.id } }, ctxFor(OWNER));
  return { wall, versionId: version.id, holdIds: holds.map((hold) => hold.id) };
}

async function setClimbOnWall(wall: CreatedWall, holdIds: number[], name = 'Garage classic'): Promise<string> {
  const frames = holdIds.map((holdId, index) => `p${holdId}r${[1, 2, 3][index] ?? 2}`).join('');
  const saved = (await climbMutations.saveClimb(
    {},
    {
      input: {
        boardType: 'spray',
        layoutId: wall.layoutId,
        name,
        isDraft: false,
        frames,
        angle: 40,
        userGrade: '6b/V4',
      },
    },
    ctxFor(OWNER),
  )) as { uuid: string };
  return saved.uuid;
}

/**
 * A gym with one member, and the wall attached to it.
 *
 * The gym-member path is the one `viewerCanReport` dropped when it restated the
 * visibility rule instead of delegating, so it needs a fixture of its own.
 */
async function attachWallToGymWithMember(wallUuid: string): Promise<void> {
  const gymUuid = uuidv4();
  await db.execute(sql`
    INSERT INTO gyms (uuid, name, slug, owner_id, created_at, updated_at)
    VALUES (${gymUuid}, ${'Gym ' + gymUuid.slice(0, 6)}, ${'gym-' + gymUuid.slice(0, 8)}, ${ADMIN}, now(), now())
  `);
  await db.execute(sql`
    INSERT INTO gym_members (gym_id, user_id, role, created_at)
    VALUES ((SELECT id FROM gyms WHERE uuid = ${gymUuid}), ${GYM_MEMBER}, 'member', now())
  `);
  await db.execute(sql`
    UPDATE user_boards SET gym_id = (SELECT id FROM gyms WHERE uuid = ${gymUuid}) WHERE uuid = ${wallUuid}
  `);
}

/** Backdate a wall's soft delete so the retention threshold can be driven. */
async function deleteWallDaysAgo(wallUuid: string, days: number): Promise<void> {
  await sprayWallMutations.deleteSprayWall({}, { uuid: wallUuid }, ctxFor(OWNER));
  await db.execute(sql`
    UPDATE spray_walls SET deleted_at = now() - (${days} || ' days')::interval WHERE board_uuid = ${wallUuid}
  `);
}

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE TABLE "spray_walls", "user_boards", "gym_members", "gyms",
                   "board_climbs", "board_climb_holds", "board_climb_stats",
                   "board_layouts", "board_product_sizes", "board_product_sizes_layouts_sets",
                   "board_holes", "board_placements", "board_difficulty_grades",
                   "community_roles", "boardsesh_ticks", "feed_items", "user_favorites"
    RESTART IDENTITY CASCADE
  `);
  await db.execute(sql`ALTER SEQUENCE spray_wall_catalog_id_seq RESTART WITH 1`);
  await db.execute(sql`ALTER SEQUENCE spray_hold_catalog_id_seq RESTART WITH 1`);

  await Promise.all(ALL_USERS.map(insertUser));
  await db.execute(sql`
    INSERT INTO community_roles (user_id, role, board_type, created_at)
    VALUES (${ADMIN}, 'admin', NULL, now())
  `);
  await db.execute(sql`
    INSERT INTO board_difficulty_grades (board_type, difficulty, boulder_name, route_name, is_listed)
    VALUES ('spray', 10, '4a/V0', '5b/5.9', true),
           ('spray', 18, '6b/V4', '7a/5.11d', true)
    ON CONFLICT (board_type, difficulty) DO NOTHING
  `);

  presignedUrls.length = 0;
  deletedObjects.length = 0;
  publishedEvents.length = 0;
  storedPhotoMetadata.clear();
  storedObjects.clear();

  const storage = await import('../storage/s3');
  vi.mocked(storage.isS3Configured).mockReset();
  vi.mocked(storage.isS3Configured).mockReturnValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('reporting a wall', () => {
  it('records one report per climber and answers the second the same way', async () => {
    const { wall } = await createPublishedWall({ isPublic: true });

    const first = await sprayWallModerationMutations.reportSprayWall(
      {},
      { input: { wallUuid: wall.uuid, reason: 'INAPPROPRIATE' } },
      ctxFor(STRANGER),
    );
    const second = await sprayWallModerationMutations.reportSprayWall(
      {},
      { input: { wallUuid: wall.uuid, reason: 'PERSONAL_INFO' } },
      ctxFor(STRANGER),
    );

    expect(first).toEqual({ status: 'CREATED' });
    expect(second).toEqual({ status: 'ALREADY_REPORTED' });

    const queue = (await sprayWallModerationQueries.sprayWallReports({}, { uuid: null }, ctxFor(ADMIN))) as Array<{
      wallUuid: string;
      reason: string;
      hidden: boolean;
    }>;
    expect(queue).toEqual([{ ...queue[0], wallUuid: wall.uuid, reason: 'INAPPROPRIATE', hidden: false }]);
  });

  it('reports a wall the viewer cannot see as not found, exactly like an unknown uuid', async () => {
    const { wall } = await createPublishedWall({ isPublic: false, isUnlisted: false });

    // Called inside the assertion, not hoisted into a pair of variables: a
    // rejected promise nobody is awaiting yet is an unhandled rejection, and
    // Vitest fails the RUN on one even when every test passed.
    await expect(
      sprayWallModerationMutations.reportSprayWall(
        {},
        { input: { wallUuid: wall.uuid, reason: 'OTHER' } },
        ctxFor(STRANGER),
      ),
    ).rejects.toThrow('Spray wall not found');
    await expect(
      sprayWallModerationMutations.reportSprayWall(
        {},
        { input: { wallUuid: uuidv4(), reason: 'OTHER' } },
        ctxFor(STRANGER),
      ),
    ).rejects.toThrow('Spray wall not found');
  });

  it('lets a gym member report the gym\u2019s PRIVATE wall', async () => {
    // The person most likely to notice something wrong with a gym's wall is
    // somebody who climbs there. An earlier version of `viewerCanReport` restated
    // the visibility rule and dropped the gym-member path, so they got "not
    // found" — which is why the check now delegates to `viewerCanSeeSprayWall`.
    const { wall } = await createPublishedWall({ isPublic: false, isUnlisted: false });
    await attachWallToGymWithMember(wall.uuid);

    expect(
      await sprayWallModerationMutations.reportSprayWall(
        {},
        { input: { wallUuid: wall.uuid, reason: 'PERSONAL_INFO' } },
        ctxFor(GYM_MEMBER),
      ),
    ).toEqual({ status: 'CREATED' });
  });

  it('refuses the report queue to a climber who is not an admin', async () => {
    const { wall } = await createPublishedWall({ isPublic: true });
    await sprayWallModerationMutations.reportSprayWall(
      {},
      { input: { wallUuid: wall.uuid, reason: 'OTHER' } },
      ctxFor(STRANGER),
    );
    await expect(sprayWallModerationQueries.sprayWallReports({}, { uuid: null }, ctxFor(OWNER))).rejects.toThrow(
      /admin/i,
    );
  });

  it('drops a pending report once the owner deletes the wall', async () => {
    // Not work any more: no surface shows the wall, and hiding it would change
    // nothing. The row stays as the record of why; the queue does not.
    const { wall } = await createPublishedWall({ isPublic: true });
    await sprayWallModerationMutations.reportSprayWall(
      {},
      { input: { wallUuid: wall.uuid, reason: 'NOT_A_WALL' } },
      ctxFor(STRANGER),
    );
    expect(await sprayWallModerationQueries.sprayWallReports({}, { uuid: null }, ctxFor(ADMIN))).toHaveLength(1);

    await sprayWallMutations.deleteSprayWall({}, { uuid: wall.uuid }, ctxFor(OWNER));

    expect(await sprayWallModerationQueries.sprayWallReports({}, { uuid: null }, ctxFor(ADMIN))).toEqual([]);
  });

  it('refuses the admin switch to a climber who is not an admin', async () => {
    const { wall } = await createPublishedWall({ isPublic: true });
    await expect(
      sprayWallModerationMutations.setSprayWallHidden({}, { input: { uuid: wall.uuid, hidden: true } }, ctxFor(OWNER)),
    ).rejects.toThrow(/admin/i);
  });
});

describe('a hidden wall', () => {
  it('reads as private to a stranger and stays visible to its owner', async () => {
    const { wall, holdIds } = await createPublishedWall({ isPublic: true });
    const climbUuid = await setClimbOnWall(wall, holdIds);

    // Before: an ordinary public wall, visible to anybody.
    expect(await sprayWallQueries.sprayWall({}, { uuid: wall.uuid }, ctxFor(STRANGER))).not.toBeNull();

    await sprayWallModerationMutations.setSprayWallHidden(
      {},
      { input: { uuid: wall.uuid, hidden: true } },
      ctxFor(ADMIN),
    );

    // The stranger loses all three doors: the uuid read, the layout read, and the
    // climbs. Each is a separate implementation of the same rule.
    expect(await sprayWallQueries.sprayWall({}, { uuid: wall.uuid }, ctxFor(STRANGER))).toBeNull();
    expect(await sprayWallQueries.sprayWallByLayout({}, { layoutId: wall.layoutId }, ctxFor(STRANGER))).toBeNull();
    const climbArgs = {
      boardName: 'spray',
      layoutId: wall.layoutId,
      sizeId: wall.layoutId,
      setIds: '1',
      angle: 40,
      climbUuid,
    };
    expect(await climbQueries.climb({}, climbArgs, ctxFor(STRANGER))).toBeNull();

    // The owner keeps everything, and gets the notice the banner renders off.
    const owned = (await sprayWallQueries.sprayWall({}, { uuid: wall.uuid }, ctxFor(OWNER))) as {
      hiddenAt: string | null;
    } | null;
    expect(owned?.hiddenAt).toEqual(expect.any(String));
    expect(await climbQueries.climb({}, climbArgs, ctxFor(OWNER))).not.toBeNull();
  });

  it('comes back for everyone when the flag is cleared, and answers its reports either way', async () => {
    const { wall } = await createPublishedWall({ isPublic: true });
    await sprayWallModerationMutations.reportSprayWall(
      {},
      { input: { wallUuid: wall.uuid, reason: 'NOT_A_WALL' } },
      ctxFor(STRANGER),
    );

    await sprayWallModerationMutations.setSprayWallHidden(
      {},
      { input: { uuid: wall.uuid, hidden: true } },
      ctxFor(ADMIN),
    );
    // Acting on the wall clears the queue whichever way the admin went; leaving
    // the rows pending would put the wall back in front of the next admin forever.
    expect(await sprayWallModerationQueries.sprayWallReports({}, { uuid: null }, ctxFor(ADMIN))).toEqual([]);

    await sprayWallModerationMutations.setSprayWallHidden(
      {},
      { input: { uuid: wall.uuid, hidden: false } },
      ctxFor(ADMIN),
    );
    expect(await sprayWallQueries.sprayWall({}, { uuid: wall.uuid }, ctxFor(STRANGER))).not.toBeNull();
    const owned = (await sprayWallQueries.sprayWall({}, { uuid: wall.uuid }, ctxFor(OWNER))) as {
      hiddenAt: string | null;
    };
    expect(owned.hiddenAt).toBeNull();
  });

  it('drops out of the cross-board climb predicate, not just the wall reads', async () => {
    // `sprayClimbVisibilityCondition` is its own implementation of the rule, in
    // SQL, carried by ~15 reads that never touch the resolver helpers. Deleting
    // its `hidden_at` clause has to red something, and the wall-read tests above
    // do not notice.
    const { wall, holdIds } = await createPublishedWall({ isPublic: true });
    const climbUuid = await setClimbOnWall(wall, holdIds);
    await db.execute(sql`
      INSERT INTO user_favorites (user_id, climb_uuid, board_name, created_at)
      VALUES (${STRANGER}, ${climbUuid}, 'spray', now())
    `);

    const favouritesFor = async (viewer: string) => {
      const page = (await favoriteClimbsQuery.userFavoriteClimbs(
        {},
        {
          input: {
            boardName: 'spray',
            layoutId: wall.layoutId,
            sizeId: wall.layoutId,
            setIds: '1',
            angle: 40,
            page: 0,
            pageSize: 50,
          },
        },
        ctxFor(viewer),
      )) as { climbs: Array<{ uuid: string }> };
      return page.climbs.map((climb) => climb.uuid);
    };

    expect(await favouritesFor(STRANGER)).toContain(climbUuid);

    await sprayWallModerationMutations.setSprayWallHidden(
      {},
      { input: { uuid: wall.uuid, hidden: true } },
      ctxFor(ADMIN),
    );

    expect(await favouritesFor(STRANGER)).not.toContain(climbUuid);
  });

  it('drops out of the REFERENCE predicate too, which never joins the climb', async () => {
    // `sprayReferenceVisibilityCondition` is the third implementation: the
    // smart-playlist reads paginate over ticks and favourites, so the climb is one
    // join away and the column form cannot be used. Asserted separately from the
    // column form because the two share no SQL.
    const { wall, holdIds } = await createPublishedWall({ isPublic: true });
    const climbUuid = await setClimbOnWall(wall, holdIds);
    await db.execute(sql`
      INSERT INTO boardsesh_ticks (uuid, user_id, climb_uuid, board_type, angle, status, quality, climbed_at, created_at, updated_at)
      VALUES (${uuidv4()}, ${OWNER}, ${climbUuid}, 'spray', 40, 'send', 5, now(), now(), now())
    `);

    const fiveStarsFor = async (viewer: string) => {
      const result = (await smartPlaylist(
        {},
        { input: { type: 'FIVE_STARS', userId: OWNER, page: 0, pageSize: 50 } },
        ctxFor(viewer),
      )) as { climbs: Array<{ uuid: string }> };
      return result.climbs.map((climb) => climb.uuid);
    };

    expect(await fiveStarsFor(STRANGER)).toContain(climbUuid);

    await sprayWallModerationMutations.setSprayWallHidden(
      {},
      { input: { uuid: wall.uuid, hidden: true } },
      ctxFor(ADMIN),
    );

    expect(await fiveStarsFor(STRANGER)).not.toContain(climbUuid);
    // And the owner still has their own logbook.
    expect(await fiveStarsFor(OWNER)).toContain(climbUuid);
  });

  it('announces nothing for a climb set on it after it was hidden', async () => {
    // Hiding purges the feed rows that already exist, and that is only half of the
    // job: the wall is still `is_public`, so without the write-time gate the next
    // climb set on it would announce itself — name, setter, layout id, frames — to
    // every follower and put the wall straight back into the feed it was just
    // taken out of.
    const { wall, holdIds } = await createPublishedWall({ isPublic: true });

    // Before: a public wall's new climb does announce.
    await setClimbOnWall(wall, holdIds);
    expect(publishedEvents.filter((event) => event.type === 'climb.created')).not.toHaveLength(0);

    await sprayWallModerationMutations.setSprayWallHidden(
      {},
      { input: { uuid: wall.uuid, hidden: true } },
      ctxFor(ADMIN),
    );
    publishedEvents.length = 0;

    // Two of the three holds, not all three: the duplicate gate is keyed on the
    // hold set, so a second climb on the same holds is refused whatever it is called.
    await setClimbOnWall(wall, holdIds.slice(0, 2), 'Second problem');

    expect(publishedEvents.filter((event) => event.type === 'climb.created')).toHaveLength(0);
  });

  it('stops honouring the share link an unlisted wall handed out', async () => {
    const { wall } = await createPublishedWall({ isPublic: false, isUnlisted: true });
    // The whole point of unlisted: the uuid IS the capability.
    expect(await sprayWallQueries.sprayWall({}, { uuid: wall.uuid }, ctxFor(STRANGER))).not.toBeNull();

    await sprayWallModerationMutations.setSprayWallHidden(
      {},
      { input: { uuid: wall.uuid, hidden: true } },
      ctxFor(ADMIN),
    );

    // Hiding has to take a wall off the internet, so it outranks the capability.
    expect(await sprayWallQueries.sprayWall({}, { uuid: wall.uuid }, ctxFor(STRANGER))).toBeNull();
  });

  // The four reads below were missed by the first pass (#5797): none of them went
  // through the wall helpers or the climb predicate, so each needs its own test.

  it('leaves board search for a stranger and stays in the owner\u2019s', async () => {
    const { wall } = await createPublishedWall({ isPublic: true, name: 'Hidden search wall' });
    const search = async (userId: string | null) =>
      (await socialBoardQueries.searchBoards(
        {},
        { input: { query: 'Hidden search wall', limit: 20, offset: 0 } },
        ctxFor(userId),
      )) as { boards: Array<{ uuid: string }>; totalCount: number };

    expect((await search(STRANGER)).boards.map((board) => board.uuid)).toContain(wall.uuid);

    await sprayWallModerationMutations.setSprayWallHidden(
      {},
      { input: { uuid: wall.uuid, hidden: true } },
      ctxFor(ADMIN),
    );

    for (const viewer of [STRANGER, null]) {
      const page = await search(viewer);
      expect(page.boards.map((board) => board.uuid)).not.toContain(wall.uuid);
      // The count is in the same WHERE, so it cannot promise the row either.
      expect(page.totalCount).toBe(0);
    }
    expect((await search(OWNER)).boards.map((board) => board.uuid)).toContain(wall.uuid);
  });

  it('gets no share card, and never reads the photo to find that out', async () => {
    const { wall } = await createPublishedWall({ isPublic: true });
    // The public copy promotion writes, set by hand: this file's storage stub has
    // no cross-bucket copy, and the card only needs the key to exist.
    await db.execute(sql`
      UPDATE spray_walls SET public_photo_key = ${'spray-walls/' + wall.uuid + '/public.jpg'}
      WHERE board_uuid = ${wall.uuid}
    `);

    // The real loader, so the SELECT is under test too; only the network fetch is
    // stubbed. It refuses, which answers not-found and caches nothing, but a call
    // at all proves every visibility gate opened.
    const renderWith = async () => {
      resetSprayOgCardCache();
      const fetchPhotoBytes = vi.fn(async () => {
        throw new SprayPhotoUnavailableError('stub');
      });
      const result = await renderSprayOgCard(
        { layoutId: wall.layoutId, frames: 'p1r1', format: 'jpeg' },
        { ...createSprayOgCardDeps(), fetchPhotoBytes },
      );
      return { result, fetchPhotoBytes };
    };

    expect((await renderWith()).fetchPhotoBytes).toHaveBeenCalledTimes(1);

    await sprayWallModerationMutations.setSprayWallHidden(
      {},
      { input: { uuid: wall.uuid, hidden: true } },
      ctxFor(ADMIN),
    );

    const hidden = await renderWith();
    expect(hidden.fetchPhotoBytes).not.toHaveBeenCalled();
    expect(hidden.result.kind).toBe('not-found');
  });

  it('hands out no public photo URL, the owner included', async () => {
    const { wall } = await createPublishedWall({ isPublic: true });
    await db.execute(sql`
      UPDATE spray_walls SET public_photo_key = ${'spray-walls/' + wall.uuid + '/public.jpg'}
      WHERE board_uuid = ${wall.uuid}
    `);
    const photoUrlFor = async (viewer: string) =>
      (
        (await sprayWallQueries.sprayWall({}, { uuid: wall.uuid }, ctxFor(viewer))) as {
          publicPhotoUrl: string | null;
        } | null
      )?.publicPhotoUrl ?? null;

    expect(await photoUrlFor(STRANGER)).toEqual(expect.stringContaining('public.jpg'));

    await sprayWallModerationMutations.setSprayWallHidden(
      {},
      { input: { uuid: wall.uuid, hidden: true } },
      ctxFor(ADMIN),
    );

    expect(await photoUrlFor(STRANGER)).toBeNull();
    // The owner still reads the wall, but a hidden wall is private, and a private
    // wall has no public URL for anybody.
    expect(await sprayWallQueries.sprayWall({}, { uuid: wall.uuid }, ctxFor(OWNER))).not.toBeNull();
    expect(await photoUrlFor(OWNER)).toBeNull();
  });

  it('stops the share link opening the board row and listing the climbs', async () => {
    // `board(uuid)` and `searchClimbs({ sprayWallUuid })` honour the unlisted
    // capability through `sprayBoardRowIsReadable`, not `viewerCanSeeSprayWall`,
    // so the test above does not cover them.
    const { wall, holdIds } = await createPublishedWall({ isPublic: false, isUnlisted: true });
    await setClimbOnWall(wall, holdIds);
    const searchInput = {
      boardName: 'spray',
      layoutId: wall.layoutId,
      sizeId: wall.layoutId,
      setIds: '1',
      angle: 40,
      sprayWallUuid: wall.uuid,
    };
    const boardFor = (viewer: string | null) => socialBoardQueries.board({}, { boardUuid: wall.uuid }, ctxFor(viewer));
    // A pre-baked empty page is the refusal; a real search context has none.
    const searchIsRefusedFor = async (viewer: string | null) =>
      ((await climbQueries.searchClimbs({}, { input: searchInput }, ctxFor(viewer))) as { _cachedClimbs?: unknown[] })
        ._cachedClimbs !== undefined;

    expect(await boardFor(STRANGER)).not.toBeNull();
    expect(await searchIsRefusedFor(STRANGER)).toBe(false);

    await sprayWallModerationMutations.setSprayWallHidden(
      {},
      { input: { uuid: wall.uuid, hidden: true } },
      ctxFor(ADMIN),
    );

    for (const viewer of [STRANGER, null]) {
      expect(await boardFor(viewer)).toBeNull();
      expect(await searchIsRefusedFor(viewer)).toBe(true);
    }
    expect(await boardFor(OWNER)).not.toBeNull();
    expect(await searchIsRefusedFor(OWNER)).toBe(false);
  });
});

describe('the photo purge', () => {
  it('keeps photographs for 30 days', () => {
    // Pinned as a literal beside the boundary tests, which are all written
    // relative to the constant: without this, moving the window moves the tests
    // with it and they go on passing while the promise in the release notes and
    // `docs/spray-walls.md` quietly becomes false.
    expect(SPRAY_WALL_PHOTO_RETENTION_DAYS).toBe(30);
  });

  it('clears a wall deleted past the window and leaves one deleted yesterday alone', async () => {
    const stale = await createPublishedWall();
    const fresh = await createPublishedWall();
    await deleteWallDaysAgo(stale.wall.uuid, SPRAY_WALL_PHOTO_RETENTION_DAYS + 1);
    await deleteWallDaysAgo(fresh.wall.uuid, 1);

    const result = await purgeDeletedSprayWallPhotos({ now: new Date() });

    expect(result).toMatchObject({ wallsPurged: 1, wallsConsidered: 1 });
    expect(result.objectsDeleted).toBe(2);
    expect(deletedObjects.every((object) => object.key.startsWith(`spray-walls/${stale.wall.uuid}/`))).toBe(true);

    const keys = await db.execute<{ photo_key: string | null; board_uuid: string }>(sql`
      SELECT v.photo_key, w.board_uuid
      FROM spray_wall_versions v JOIN spray_walls w ON w.id = v.wall_id
    `);
    const byWall = new Map([...keys].map((row) => [row.board_uuid, row.photo_key]));
    expect(byWall.get(stale.wall.uuid)).toBeNull();
    expect(byWall.get(fresh.wall.uuid)).toEqual(expect.any(String));
  });

  it('does not fire one day early', async () => {
    const wall = await createPublishedWall();
    // One day inside the window. Asserted separately from the pair above so a
    // purge widened to 29 days reds here rather than passing on "31 > 30".
    await deleteWallDaysAgo(wall.wall.uuid, SPRAY_WALL_PHOTO_RETENTION_DAYS - 1);

    const result = await purgeDeletedSprayWallPhotos({ now: new Date() });

    expect(result).toMatchObject({ wallsPurged: 0, objectsDeleted: 0, wallsConsidered: 0 });
    expect(deletedObjects).toEqual([]);
  });

  it('leaves the wall, its holds and its climbs behind — only the photographs go', async () => {
    const { wall, holdIds } = await createPublishedWall();
    const climbUuid = await setClimbOnWall(wall, holdIds);
    await deleteWallDaysAgo(wall.uuid, SPRAY_WALL_PHOTO_RETENTION_DAYS + 5);

    await purgeDeletedSprayWallPhotos({ now: new Date() });

    const [counts] = [
      ...(await db.execute<{ walls: number; holds: number; climbs: number }>(sql`
        SELECT
          (SELECT count(*)::int FROM spray_walls WHERE board_uuid = ${wall.uuid}) AS walls,
          (SELECT count(*)::int FROM spray_wall_holds) AS holds,
          (SELECT count(*)::int FROM board_climbs WHERE uuid = ${climbUuid}) AS climbs
      `)),
    ];
    expect(counts).toEqual({ walls: 1, holds: holdIds.length, climbs: 1 });
  });

  it('does not re-list a wall it already cleared', async () => {
    const { wall } = await createPublishedWall();
    await deleteWallDaysAgo(wall.uuid, SPRAY_WALL_PHOTO_RETENTION_DAYS + 2);

    await purgeDeletedSprayWallPhotos({ now: new Date() });
    deletedObjects.length = 0;
    const second = await purgeDeletedSprayWallPhotos({ now: new Date() });

    // The row is never deleted, so a wall swept on an earlier run stays past the
    // cutoff forever; `photos_purged_at` is what takes it out of the candidate set.
    expect(second).toMatchObject({ wallsPurged: 0, wallsConsidered: 0 });
    expect(deletedObjects).toEqual([]);
  });

  it('deletes an abandoned upload that no version ever adopted', async () => {
    // A photo uploaded into the wizard sits in the bucket unreferenced until
    // `createSprayWallVersion` adopts it — and if the climber backs out, it never
    // is. Nothing in the database names that object, so a sweep driven by version
    // rows would leave it there forever. The sweep lists the PREFIX for exactly
    // this case.
    const wall = await createWallOnly();
    const strayKey = sprayWallPhotoKey(wall.uuid, uuidv4());
    storedObjects.get('private')!.add(strayKey);
    await deleteWallDaysAgo(wall.uuid, SPRAY_WALL_PHOTO_RETENTION_DAYS + 1);

    const result = await purgeDeletedSprayWallPhotos({ now: new Date() });

    expect(result).toMatchObject({ wallsPurged: 1, wallsConsidered: 1, objectsDeleted: 1 });
    expect(deletedObjects.map((object) => object.key)).toEqual([strayKey]);
  });

  it('reaches a fresh deletion past a full batch of already-purged walls', async () => {
    // The starvation bug this pins: a purged wall's row is never deleted, so it
    // stays past the cutoff forever. With the already-purged filter applied AFTER
    // `LIMIT 200`, every run past the two-hundredth purge fills its batch with
    // no-ops and nothing deleted afterwards is ever reached — a permanent
    // `wallsPurged: 0` that looks exactly like "nothing to do".
    //
    // Built with raw rows rather than 201 real wall flows: the point is the
    // candidate query's WHERE, and the flow costs a photo, a version and three
    // holds each.
    const batchSize = 3;
    for (let index = 0; index < batchSize + 1; index++) {
      await db.execute(sql`
        INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, angle, created_at, updated_at, deleted_at)
        VALUES (${`purged-${index}`}, ${`purged-${index}`}, ${OWNER}, 'spray', ${9000 + index}, ${9000 + index}, '1',
                ${`Purged ${index}`}, 40, now(), now(), now())
      `);
      await db.execute(sql`
        INSERT INTO spray_walls (board_uuid, layout_id, hold_count, created_at, updated_at, deleted_at)
        VALUES (${`purged-${index}`}, ${9000 + index}, 0, now(), now(),
                now() - ((${SPRAY_WALL_PHOTO_RETENTION_DAYS + 90 - index}) || ' days')::interval)
      `);
      // Already swept. These are the oldest deletions, so they sort to the front
      // of the batch and would fill it entirely if the marker were filtered after
      // the limit instead of inside the query.
      await db.execute(sql`
        UPDATE spray_walls SET photos_purged_at = now() WHERE board_uuid = ${`purged-${index}`}
      `);
    }

    // The one wall with work, deleted MOST recently, so it is last in the order.
    const fresh = await createPublishedWall();
    await deleteWallDaysAgo(fresh.wall.uuid, SPRAY_WALL_PHOTO_RETENTION_DAYS + 1);

    const result = await purgeDeletedSprayWallPhotos({ now: new Date(), batchSize });

    expect(result).toMatchObject({ wallsPurged: 1, wallsConsidered: 1 });
    expect(deletedObjects.every((object) => object.key.startsWith(`spray-walls/${fresh.wall.uuid}/`))).toBe(true);
  });

  it('leaves the photo key intact when the object delete fails', async () => {
    // `photo_key` is the only thing that names the object. Clearing it on a failed
    // delete would leave the photograph in the bucket, unnamed, and the wall would
    // never be a candidate again — the one outcome the whole job exists to prevent.
    const { wall } = await createPublishedWall();
    await deleteWallDaysAgo(wall.uuid, SPRAY_WALL_PHOTO_RETENTION_DAYS + 3);

    const storage = await import('../storage/s3');
    vi.mocked(storage.deleteFromS3).mockRejectedValueOnce(new Error('R2 said no'));

    const result = await purgeDeletedSprayWallPhotos({ now: new Date() });

    expect(result).toMatchObject({ wallsPurged: 0, wallsConsidered: 1 });
    const [row] = [
      ...(await db.execute<{ keys: number }>(sql`
        SELECT count(*)::int AS keys FROM spray_wall_versions v
        JOIN spray_walls w ON w.id = v.wall_id
        WHERE w.board_uuid = ${wall.uuid} AND v.photo_key IS NOT NULL
      `)),
    ];
    expect(row.keys).toBeGreaterThan(0);
  });

  it('refuses to clear a photo key when no private bucket is configured', async () => {
    // A dev backend has no bucket. Reporting zero objects deleted and clearing the
    // key anyway would orphan the photograph; the run has to be a loud no-op.
    const { wall } = await createPublishedWall();
    await deleteWallDaysAgo(wall.uuid, SPRAY_WALL_PHOTO_RETENTION_DAYS + 3);

    const storage = await import('../storage/s3');
    vi.mocked(storage.isS3Configured).mockReturnValue(false);

    const result = await purgeDeletedSprayWallPhotos({ now: new Date() });

    expect(result).toMatchObject({ wallsPurged: 0, objectsDeleted: 0, wallsConsidered: 1 });
    const [row] = [
      ...(await db.execute<{ keys: number }>(sql`
        SELECT count(*)::int AS keys FROM spray_wall_versions v
        JOIN spray_walls w ON w.id = v.wall_id
        WHERE w.board_uuid = ${wall.uuid} AND v.photo_key IS NOT NULL
      `)),
    ];
    expect(row.keys).toBeGreaterThan(0);
  });

  it('refuses the purge mutation without cron authentication', async () => {
    await expect(
      sprayWallModerationMutations.purgeDeletedSprayWallPhotos({}, { limit: null }, ctxFor(ADMIN)),
    ).rejects.toThrow('Cron authentication required');
    await expect(
      sprayWallModerationMutations.purgeDeletedSprayWallPhotos({}, { limit: null }, cronCtx()),
    ).resolves.toMatchObject({ wallsPurged: 0 });
  });
});
