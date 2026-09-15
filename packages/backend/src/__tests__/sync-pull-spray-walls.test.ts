import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext, SyncResult, SyncCursorInput } from '@boardsesh/shared-schema';
import { db } from '../db/client';

/**
 * `syncSprayWalls` — the offline mirror of a spray wall (issue #5448).
 *
 * The thing this file exists to prove is the gate, not the payload. A wall's
 * `layout_id` comes out of `spray_wall_catalog_id_seq`, so it is 1, 2, 3 — any
 * authenticated account can walk it. If this resolver answered on a guessed id
 * it would hand over the name, the geometry, every hold and a LIVE presigned
 * photograph of every private home wall in the database, one page at a time.
 *
 * So: the owner gets the wall, a gym member of the wall's gym gets it, a public
 * wall is world-readable to any signed-in caller, and a stranger gets an
 * ordinary empty page — not an error, not a different shape, because a
 * distinguishable response is itself an oracle for which ids are real walls.
 * Unlisted is deliberately NOT an exemption here: unlisted means "reachable by
 * uuid", and a layout id is not a uuid.
 *
 * Rows are written by hand rather than through the SW-05 mutation API: this is a
 * read gate, and building the fixtures out of raw INSERTs keeps the test honest
 * about exactly which rows produce which answer.
 *
 * Storage is stubbed because there is no R2 in CI.
 */

const { presignedKeys } = vi.hoisted(() => ({ presignedKeys: [] as string[] }));

vi.mock('../storage/s3', () => ({
  isS3Configured: vi.fn(() => true),
  presignGetObject: vi.fn(async (_bucket: string, key: string) => {
    presignedKeys.push(key);
    return { url: `https://private.example/${key}?X-Amz-Signature=stub`, expiresAt: new Date().toISOString() };
  }),
  getS3ObjectMetadata: vi.fn(async () => null),
  uploadToS3: vi.fn(async (_bucket: string, _body: Buffer, key: string) => ({ key })),
}));

const { syncQueries } = await import('../graphql/resolvers/sync/queries');

const OWNER = 'spray-sync-owner';
const STRANGER = 'spray-sync-stranger';
const GYM_MEMBER = 'spray-sync-gym-member';
const ALL_USERS = [OWNER, STRANGER, GYM_MEMBER];

/** The PUBLISHED version's photo — version 2's. Version 1's is the older key. */
const PHOTO_KEY = 'spray-walls/a-wall/photo-2.jpg';
const HOMOGRAPHY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function ctxFor(userId: string | null): ConnectionContext {
  return {
    connectionId: 'spray-sync-conn',
    isAuthenticated: userId !== null,
    userId,
    sessionId: null,
    controllerId: null,
    controllerApiKey: null,
  } as unknown as ConnectionContext;
}

type WallOptions = {
  layoutId: number;
  isPublic?: boolean;
  isUnlisted?: boolean;
  gymId?: number | null;
  /** Leave false to keep the wall a draft: nothing published, so no holds are alive. */
  publish?: boolean;
  deleted?: boolean;
};

/**
 * A wall with two photo versions and three holds, one of which came off.
 *
 * Shaped so the published generation is version 2: hold 3 is installed at v1 and
 * removed by v2, so a payload that carries it is a payload reading the wrong
 * generation — which is the bug this fixture exists to catch, not a detail.
 * A wall that is not published stops at a version-1 draft.
 */
async function insertWall(options: WallOptions): Promise<{ boardUuid: string; wallId: number }> {
  const boardUuid = `board-${options.layoutId}`;
  await db.execute(sql`
    INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name,
                             is_public, is_unlisted, gym_id)
    VALUES (${boardUuid}, ${`wall-${options.layoutId}`}, ${OWNER}, 'spray', ${options.layoutId},
            ${options.layoutId}, '', ${`Wall ${options.layoutId}`},
            ${options.isPublic ?? false}, ${options.isUnlisted ?? false}, ${options.gymId ?? null})
  `);

  const [wallRow] = (await db.execute(sql`
    INSERT INTO spray_walls (board_uuid, layout_id, reference_width, reference_height, hold_count, deleted_at)
    VALUES (${boardUuid}, ${options.layoutId}, 800, 620, 0, ${options.deleted ? sql`now()` : null})
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const wallId = Number(wallRow.id);

  const [firstRow] = (await db.execute(sql`
    INSERT INTO spray_wall_versions (wall_id, version_number, status, photo_key, photo_width, photo_height,
                                     homography, published_at)
    VALUES (${wallId}, 1, ${options.publish ? 'superseded' : 'draft'}, 'spray-walls/a-wall/photo-1.jpg',
            1200, 900, ${JSON.stringify(HOMOGRAPHY)}::jsonb, ${options.publish ? sql`now()` : null})
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const firstVersionId = Number(firstRow.id);

  const baseHoldId = options.layoutId * 1000;
  if (!options.publish) {
    await db.execute(sql`
      INSERT INTO spray_wall_holds (wall_id, hold_id, cx, cy, r, installed_version_id)
      VALUES (${wallId}, ${baseHoldId + 1}, 100, 120, 24, ${firstVersionId})
    `);
    return { boardUuid, wallId };
  }

  const [currentRow] = (await db.execute(sql`
    INSERT INTO spray_wall_versions (wall_id, version_number, status, photo_key, photo_width, photo_height,
                                     homography, published_at)
    VALUES (${wallId}, 2, 'published', ${PHOTO_KEY}, 1200, 900, ${JSON.stringify(HOMOGRAPHY)}::jsonb, now())
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const currentVersionId = Number(currentRow.id);

  await db.execute(sql`
    INSERT INTO spray_wall_holds (wall_id, hold_id, cx, cy, r, outline, installed_version_id, removed_version_id)
    VALUES
      (${wallId}, ${baseHoldId + 1}, 100, 120, 24, ${JSON.stringify([1, 0, 0, 1, -1, 0, 0, -1])}::jsonb, ${firstVersionId}, NULL),
      (${wallId}, ${baseHoldId + 2}, 300, 400, 30, NULL, ${firstVersionId}, NULL),
      (${wallId}, ${baseHoldId + 3}, 520, 560, 18, NULL, ${firstVersionId}, ${currentVersionId})
  `);

  await db.execute(sql`
    UPDATE spray_walls SET current_version_id = ${currentVersionId}, hold_count = 2, updated_at = now()
    WHERE id = ${wallId}
  `);

  return { boardUuid, wallId };
}

type SprayWallDocument = {
  layout_id: number;
  board_uuid: string;
  name: string;
  reference_width: number;
  reference_height: number;
  current_version_number: number | null;
  photo_key: string | null;
  photo_url: string | null;
  holds: Array<{ id: number; cx: number; cy: number; r: number; outline: number[] | null }>;
  homography: number[] | null;
  updated_at: string;
  sync_seq: string;
};

async function pull(
  userId: string | null,
  layoutId: number | null,
  overrides: { boardType?: string; cursor?: SyncCursorInput | null } = {},
): Promise<SyncResult> {
  return syncQueries.syncSprayWalls(
    undefined,
    {
      boardType: overrides.boardType ?? 'spray',
      layoutId,
      sizeId: layoutId,
      cursor: overrides.cursor ?? null,
      limit: 500,
    },
    ctxFor(userId),
  );
}

const documentsOf = (result: SyncResult) => result.documents as unknown as SprayWallDocument[];

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE TABLE "spray_walls", "user_boards", "gym_members", "gyms", "users" RESTART IDENTITY CASCADE
  `);
  for (const userId of ALL_USERS) {
    await db.execute(sql`
      INSERT INTO users (id, name, email) VALUES (${userId}, ${userId}, ${`${userId}@example.com`})
    `);
  }
  presignedKeys.length = 0;
});

describe('syncSprayWalls — visibility', () => {
  it('gives the owner the wall', async () => {
    await insertWall({ layoutId: 1, publish: true });

    const documents = documentsOf(await pull(OWNER, 1));

    expect(documents).toHaveLength(1);
    expect(documents[0].layout_id).toBe(1);
    expect(documents[0].board_uuid).toBe('board-1');
    expect(documents[0].name).toBe('Wall 1');
  });

  it('gives a stranger NOTHING for a private wall, as an ordinary empty page', async () => {
    await insertWall({ layoutId: 1, publish: true });

    const result = await pull(STRANGER, 1);

    expect(result.documents).toEqual([]);
    expect(result.hasMore).toBe(false);
    // Indistinguishable from a layout that is not a wall at all: same shape, same
    // cursor, no error. Anything else answers "yes, id 1 is somebody's wall".
    const unknownLayout = await pull(STRANGER, 999);
    expect(unknownLayout).toEqual(result);
    // And nothing was signed on the way — a stranger must not even cause a
    // signature over a private object to exist.
    expect(presignedKeys).toEqual([]);
  });

  it('gives a stranger a PUBLIC wall', async () => {
    await insertWall({ layoutId: 1, isPublic: true, publish: true });

    expect(documentsOf(await pull(STRANGER, 1))).toHaveLength(1);
  });

  it('does NOT treat unlisted as an exemption on a layout id', async () => {
    // Unlisted means "reachable by uuid" — an unguessable 122-bit capability.
    // A layout id is a small integer from a sequence, so honouring unlisted here
    // would let one account walk it and collect every unlisted wall's photo.
    await insertWall({ layoutId: 1, isUnlisted: true, publish: true });

    expect(await pull(STRANGER, 1)).toEqual(await pull(STRANGER, 999));
    expect(documentsOf(await pull(OWNER, 1))).toHaveLength(1);
  });

  it('gives a member of the wall’s gym the wall', async () => {
    const [gymRow] = (await db.execute(sql`
      INSERT INTO gyms (uuid, slug, name, owner_id) VALUES ('gym-1', 'gym-1', 'Gym One', ${OWNER}) RETURNING id
    `)) as unknown as Array<{ id: string }>;
    const gymId = Number(gymRow.id);
    await db.execute(sql`
      INSERT INTO gym_members (gym_id, user_id, role) VALUES (${gymId}, ${GYM_MEMBER}, 'member')
    `);
    await insertWall({ layoutId: 1, gymId, publish: true });

    expect(documentsOf(await pull(GYM_MEMBER, 1))).toHaveLength(1);
    expect(documentsOf(await pull(STRANGER, 1))).toEqual([]);
  });

  it('answers an empty page for an unscoped pull, even for the owner', async () => {
    // No layout id means no wall to check a rule against, so there is no wall the
    // rule could permit. Without this, one unscoped call would return every wall.
    await insertWall({ layoutId: 1, publish: true });
    await insertWall({ layoutId: 2, publish: true });

    expect((await pull(OWNER, null)).documents).toEqual([]);
  });

  it('answers an empty page for a non-spray board type', async () => {
    await insertWall({ layoutId: 1, publish: true });

    expect((await pull(OWNER, 1, { boardType: 'kilter' })).documents).toEqual([]);
  });

  it('excludes a soft-deleted wall from its own owner', async () => {
    await insertWall({ layoutId: 1, publish: true, deleted: true });

    expect((await pull(OWNER, 1)).documents).toEqual([]);
  });
});

describe('syncSprayWalls — payload', () => {
  it('carries the published version, its holds and its homography', async () => {
    await insertWall({ layoutId: 1, publish: true });

    const [document] = documentsOf(await pull(OWNER, 1));

    expect(document.current_version_number).toBe(2);
    expect(document.reference_width).toBe(800);
    expect(document.reference_height).toBe(620);
    expect(document.homography).toEqual(HOMOGRAPHY);
    // Two of the three rows: the third was removed BY the published version.
    expect(document.holds.map((hold) => hold.id)).toEqual([1001, 1002]);
    expect(document.holds[0]).toEqual({ id: 1001, cx: 100, cy: 120, r: 24, outline: [1, 0, 0, 1, -1, 0, 0, -1] });
    // An untraced hold carries a null outline, which the renderer draws as a ring.
    expect(document.holds[1].outline).toBeNull();
  });

  it('carries the photo key plus a presigned URL, and the URL is not a column', async () => {
    await insertWall({ layoutId: 1, publish: true });

    const [document] = documentsOf(await pull(OWNER, 1));

    expect(document.photo_key).toBe(PHOTO_KEY);
    expect(document.photo_url).toContain(PHOTO_KEY);
    expect(presignedKeys).toEqual([PHOTO_KEY]);
    // The device drops it: `spray_walls.transientColumns` in table-config.ts is
    // what keeps it out of SQLite, and out of the schema-drift telemetry.
  });

  it('has no holds while the wall is still a draft', async () => {
    // Holds exist in the table from the moment the owner starts drawing. Showing
    // them before a publish would put an unfinished layout on climbers' screens.
    await insertWall({ layoutId: 1 });

    const [document] = documentsOf(await pull(OWNER, 1));

    expect(document.current_version_number).toBeNull();
    expect(document.holds).toEqual([]);
  });

  it('advances the cursor past the wall it returned', async () => {
    await insertWall({ layoutId: 1, publish: true });

    const first = await pull(OWNER, 1);
    const second = await pull(OWNER, 1, { cursor: first.cursor });

    expect(first.documents).toHaveLength(1);
    expect(second.documents).toEqual([]);
    expect(second.hasMore).toBe(false);
  });
});
