import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';

/**
 * Issue #5960 — `deleteClimb`: a setter deletes their own spray climb until
 * somebody has logged it.
 *
 * Three things are pinned here:
 *
 *  - who may delete what (setter only, spray only, no ticks, live wall);
 *  - that every row pointing at the climb goes with it, including other
 *    climbers' favourites and playlist entries, and that the tombstones the
 *    offline pull reads are written;
 *  - the race against `saveTick`, in both orders. The two sides lock the climb
 *    row (`FOR UPDATE` in the delete, `FOR KEY SHARE` inside saveTick's insert
 *    transaction), so a tick and a delete can never both commit.
 *
 * The races are interleaved deterministically, not by timing: one side is held
 * mid-transaction (saveTick through its inferred-session hook, the delete
 * through a row lock this test holds on a favourite it has to remove), and the
 * other side is started only once the first is parked. A wait for "a backend is
 * waiting on a lock" proves the second side blocked rather than slipped past.
 */

const { storedPhotoMetadata, reconcileHold } = vi.hoisted(() => ({
  storedPhotoMetadata: new Map<string, { width: string; height: string }>(),
  reconcileHold: { current: null as null | { entered: () => void; release: Promise<void> } },
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
  // A public wall's publish copies the photo to the public bucket. Without these
  // the copy fails and retries in the background, and a retry still running when
  // the next test's TRUNCATE starts deadlocks against it.
  copyObjectBetweenBuckets: vi.fn(
    async (_source: string, _sourceKey: string, _destination: string, destinationKey: string) => ({
      key: destinationKey,
    }),
  ),
  deleteFromS3: vi.fn(async () => undefined),
  getPublicUrl: vi.fn((_bucket: string, key: string) => `https://media.example/${key}`),
}));

vi.mock('../events', () => ({ publishSocialEvent: vi.fn(async () => undefined) }));
vi.mock('../lib/web-revalidate', () => ({ notifyClimbRevalidated: vi.fn(async () => undefined) }));
vi.mock('../utils/rate-limiter', () => ({ checkRateLimit: vi.fn(), resetAllRateLimits: vi.fn() }));
vi.mock('../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../pubsub/index', () => ({ pubsub: { publishCommentEvent: vi.fn() } }));

// saveTick calls this inside its insert transaction, after the insert. Holding
// it parks a tick that is inserted but not committed, with its climb lock held.
vi.mock('../services/inferred-sessions/reconcile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/inferred-sessions/reconcile')>();
  return {
    ...actual,
    reconcileInferredSessions: async (...args: Parameters<typeof actual.reconcileInferredSessions>) => {
      const hold = reconcileHold.current;
      if (hold) {
        reconcileHold.current = null;
        hold.entered();
        await hold.release;
      }
      return actual.reconcileInferredSessions(...args);
    },
  };
});

import { db } from '../db/client';
import { sprayWallPhotoKey } from '../handlers/spray-wall-photos';
import { sprayWallMutations } from '../graphql/resolvers/board/spray-walls';
import { climbMutations } from '../graphql/resolvers/climbs/mutations';
import { deleteClimbMutations } from '../graphql/resolvers/climbs/delete-climb';
import { tickMutations } from '../graphql/resolvers/ticks/mutations';

const OWNER = 'dc-owner';
const STRANGER = 'dc-stranger';
const CLIMBER = 'dc-climber';
const ALL_USERS = [OWNER, STRANGER, CLIMBER];
const ANGLE = 40;

const ANCHORS: [number, number][] = [
  [100, 80],
  [900, 120],
  [880, 700],
  [120, 660],
];

const ctxFor = (userId: string): ConnectionContext =>
  ({ connectionId: `conn-${userId}`, isAuthenticated: true, userId }) as unknown as ConnectionContext;

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

type CreatedWall = { uuid: string; layoutId: number };

/** wall → photo → holds → publish, through the real mutations. Public, so CLIMBER can tick it. */
async function createPublishedWall(): Promise<{ wall: CreatedWall; holdIds: number[] }> {
  const wall = (await sprayWallMutations.createSprayWall(
    {},
    { input: { name: `Wall ${uuidv4().slice(0, 6)}`, angle: ANGLE, isPublic: true } },
    ctxFor(OWNER),
  )) as CreatedWall;
  const photoId = uuidv4();
  storedPhotoMetadata.set(sprayWallPhotoKey(wall.uuid, photoId), { width: '1200', height: '900' });
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
  return { wall, holdIds: holds.map((hold) => hold.id) };
}

async function setClimb(wall: CreatedWall, holdIds: number[], setter = OWNER): Promise<string> {
  const saved = (await climbMutations.saveClimb(
    {},
    {
      input: {
        boardType: 'spray',
        layoutId: wall.layoutId,
        name: 'Garage crimps',
        isDraft: false,
        frames: holdIds.map((holdId, index) => `p${holdId}r${[1, 2, 3][index] ?? 2}`).join(''),
        angle: ANGLE,
        userGrade: '6b/V4',
      },
    },
    ctxFor(setter),
  )) as { uuid: string };
  return saved.uuid;
}

const deleteClimb = (userId: string, climbUuid: string, boardType = 'spray') =>
  deleteClimbMutations.deleteClimb({}, { uuid: climbUuid, boardType }, ctxFor(userId));

const saveTick = (userId: string, climbUuid: string) =>
  tickMutations.saveTick(
    {},
    {
      input: {
        boardType: 'spray',
        climbUuid,
        angle: ANGLE,
        status: 'attempt',
        attemptCount: 2,
        isMirror: false,
        isBenchmark: false,
        comment: '',
        climbedAt: new Date().toISOString(),
      },
    },
    ctxFor(userId),
  );

type Outcome = { ok: true } | { ok: false; code: unknown; message: string };

/** Settles to the outcome instead of rejecting, so a race can be inspected after both sides finish. */
const outcomeOf = (promise: Promise<unknown>): Promise<Outcome> =>
  promise.then(
    () => ({ ok: true }) as const,
    (error: { message: string; extensions?: { code?: unknown } }) => ({
      ok: false as const,
      code: error.extensions?.code,
      message: error.message,
    }),
  );

const count = async (query: ReturnType<typeof sql>): Promise<number> => {
  const [row] = (await db.execute(query)) as unknown as Array<{ n: number }>;
  return row.n;
};

const climbExists = async (climbUuid: string) =>
  (await count(sql`SELECT count(*)::int AS n FROM board_climbs WHERE uuid = ${climbUuid}`)) === 1;

const ticksOn = (climbUuid: string) =>
  count(sql`SELECT count(*)::int AS n FROM boardsesh_ticks WHERE climb_uuid = ${climbUuid}`);

/** True once `minimum` other backends in this database are blocked on a lock. */
async function waitForLockWaiters(minimum: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const waiting = await count(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()
    `);
    if (waiting >= minimum) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

/** Resolves when `promise` settles, or when `minimum` lock waiters appear, whichever is first. */
const parkedOrSettled = (promise: Promise<unknown>, minimum: number) =>
  Promise.race([promise.then(() => 'settled' as const), waitForLockWaiters(minimum).then(() => 'parked' as const)]);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** One row in every table that points at the climb without an FK. Returns the ids the asserts need. */
async function seedReferences(climbUuid: string, wall: CreatedWall) {
  const commentUuid = uuidv4();
  const replyUuid = uuidv4();
  const proposalUuid = uuidv4();
  const proposalCommentUuid = uuidv4();
  const playlistUuid = uuidv4();
  const [board] = (await db.execute(sql`SELECT id FROM user_boards WHERE uuid = ${wall.uuid}`)) as unknown as Array<{
    id: number;
  }>;

  await db.execute(sql`
    INSERT INTO comments (uuid, user_id, entity_type, entity_id, body, created_at, updated_at)
    VALUES (${commentUuid}, ${STRANGER}, 'climb', ${climbUuid}, 'Nice line', now(), now())
  `);
  await db.execute(sql`
    INSERT INTO comments (uuid, user_id, entity_type, entity_id, parent_comment_id, body, created_at, updated_at)
    SELECT ${replyUuid}, ${OWNER}, 'climb', ${climbUuid}, id, 'Thanks', now(), now() FROM comments WHERE uuid = ${commentUuid}
  `);
  await db.execute(sql`
    INSERT INTO climb_proposals (uuid, climb_uuid, board_type, angle, proposer_id, type, proposed_value, current_value, status, created_at)
    VALUES (${proposalUuid}, ${climbUuid}, 'spray', ${ANGLE}, ${STRANGER}, 'grade', '6c/V5', '6b/V4', 'open', now())
  `);
  await db.execute(sql`
    INSERT INTO proposal_votes (proposal_id, user_id, value, weight, created_at)
    SELECT id, ${CLIMBER}, 1, 1, now() FROM climb_proposals WHERE uuid = ${proposalUuid}
  `);
  await db.execute(sql`
    INSERT INTO comments (uuid, user_id, entity_type, entity_id, body, created_at, updated_at)
    VALUES (${proposalCommentUuid}, ${STRANGER}, 'proposal', ${proposalUuid}, 'Feels harder', now(), now())
  `);
  await db.execute(sql`
    INSERT INTO votes (user_id, entity_type, entity_id, value, created_at)
    VALUES (${STRANGER}, 'climb', ${climbUuid}, 1, now()), (${CLIMBER}, 'comment', ${commentUuid}, 1, now())
  `);
  await db.execute(sql`
    INSERT INTO vote_counts (entity_type, entity_id, upvotes, downvotes, score, created_at)
    VALUES ('climb', ${climbUuid}, 1, 0, 1, now()), ('comment', ${commentUuid}, 1, 0, 1, now())
  `);
  await db.execute(sql`
    INSERT INTO climb_community_status (climb_uuid, board_type, angle) VALUES (${climbUuid}, 'spray', ${ANGLE})
  `);
  await db.execute(sql`INSERT INTO climb_classic_status (climb_uuid, board_type) VALUES (${climbUuid}, 'spray')`);
  await db.execute(sql`
    INSERT INTO community_settings (scope, scope_key, key, value) VALUES ('climb', ${climbUuid}, 'approval_threshold', '3')
  `);
  await db.execute(sql`
    INSERT INTO notifications (uuid, recipient_id, actor_id, type, entity_type, entity_id, created_at)
    VALUES (${uuidv4()}, ${OWNER}, ${STRANGER}, 'comment_on_climb', 'climb', ${climbUuid}, now()),
           (${uuidv4()}, ${OWNER}, ${STRANGER}, 'proposal_on_your_climb', 'proposal', ${proposalUuid}, now())
  `);
  await db.execute(sql`
    INSERT INTO notifications (uuid, recipient_id, actor_id, type, comment_id, created_at)
    SELECT ${uuidv4()}, ${STRANGER}, ${OWNER}, 'comment_reply', id, now() FROM comments WHERE uuid = ${replyUuid}
  `);
  await db.execute(sql`
    INSERT INTO feed_items (recipient_id, actor_id, type, entity_type, entity_id, created_at)
    VALUES (${CLIMBER}, ${OWNER}, 'new_climb', 'climb', ${climbUuid}, now()),
           (${CLIMBER}, ${STRANGER}, 'comment', 'comment', ${commentUuid}, now()),
           (${CLIMBER}, ${STRANGER}, 'proposal_approved', 'proposal', ${proposalUuid}, now())
  `);
  await db.execute(sql`
    INSERT INTO user_favorites (user_id, board_name, climb_uuid, angle, created_at)
    VALUES (${STRANGER}, 'spray', ${climbUuid}, ${ANGLE}, now())
  `);
  await db.execute(sql`
    INSERT INTO playlists (uuid, board_type, layout_id, name, created_at, updated_at)
    VALUES (${playlistUuid}, 'spray', ${wall.layoutId}, 'Projects', now(), now())
  `);
  await db.execute(sql`
    INSERT INTO playlist_climbs (playlist_id, climb_uuid, angle, position, added_at)
    SELECT id, ${climbUuid}, ${ANGLE}, 0, now() FROM playlists WHERE uuid = ${playlistUuid}
  `);
  await db.execute(sql`
    INSERT INTO board_climb_popularity (board_type, climb_uuid, angle, total_ascensionist_count)
    VALUES ('spray', ${climbUuid}, ${ANGLE}, 0)
  `);
  await db.execute(sql`
    INSERT INTO board_climb_embeddings (board_type, climb_uuid, angle, model_version)
    VALUES ('spray', ${climbUuid}, ${ANGLE}, 'test')
  `);
  const otherClimb = uuidv4();
  await db.execute(sql`
    INSERT INTO board_climb_similar (board_type, climb_uuid, angle, neighbor_uuid, score, rank, model_version)
    VALUES ('spray', ${climbUuid}, ${ANGLE}, ${otherClimb}, 0.9, 1, 'test'),
           ('spray', ${otherClimb}, ${ANGLE}, ${climbUuid}, 0.9, 1, 'test')
  `);
  await db.execute(sql`
    INSERT INTO board_climb_grades (board_type, climb_uuid, angle, confidence, model_version, coeff_version)
    VALUES ('spray', ${climbUuid}, ${ANGLE}, 'low', 'test', 'test')
  `);
  await db.execute(sql`INSERT INTO board_climb_send_stats (board_type, climb_uuid) VALUES ('spray', ${climbUuid})`);
  await db.execute(sql`
    INSERT INTO board_climb_events (board_id, board_type, climb_uuid, angle, seq, confirmed_at)
    VALUES (${board.id}, 'spray', ${climbUuid}, ${ANGLE}, 1, now())
  `);
  await db.execute(sql`
    INSERT INTO climb_stats_recompute_pending (board_type, climb_uuid, angle) VALUES ('spray', ${climbUuid}, ${ANGLE})
  `);
  await db.execute(sql`
    INSERT INTO board_climb_ratings (board_type, climb_uuid, angle, user_id) VALUES ('spray', ${climbUuid}, ${ANGLE}, ${CLIMBER})
  `);
  await db.execute(sql`
    INSERT INTO board_beta_links (board_type, climb_uuid, link) VALUES ('spray', ${climbUuid}, 'https://www.instagram.com/p/abc123/')
  `);

  return { commentUuid, replyUuid, proposalUuid, proposalCommentUuid, otherClimb };
}

/** Row counts per table for everything `seedReferences` writes, keyed for a readable diff on failure. */
async function referenceCounts(climbUuid: string, ids: Awaited<ReturnType<typeof seedReferences>>) {
  const entityIds = [climbUuid, ids.proposalUuid, ids.commentUuid, ids.replyUuid, ids.proposalCommentUuid];
  const inEntities = sql.join(
    entityIds.map((id) => sql`${id}`),
    sql`, `,
  );
  return {
    comments: await count(sql`SELECT count(*)::int AS n FROM comments WHERE entity_id IN (${inEntities})`),
    climb_proposals: await count(sql`SELECT count(*)::int AS n FROM climb_proposals WHERE climb_uuid = ${climbUuid}`),
    proposal_votes: await count(sql`SELECT count(*)::int AS n FROM proposal_votes`),
    votes: await count(sql`SELECT count(*)::int AS n FROM votes WHERE entity_id IN (${inEntities})`),
    vote_counts: await count(sql`SELECT count(*)::int AS n FROM vote_counts WHERE entity_id IN (${inEntities})`),
    climb_community_status: await count(
      sql`SELECT count(*)::int AS n FROM climb_community_status WHERE climb_uuid = ${climbUuid}`,
    ),
    climb_classic_status: await count(
      sql`SELECT count(*)::int AS n FROM climb_classic_status WHERE climb_uuid = ${climbUuid}`,
    ),
    community_settings: await count(
      sql`SELECT count(*)::int AS n FROM community_settings WHERE scope = 'climb' AND scope_key = ${climbUuid}`,
    ),
    notifications: await count(sql`SELECT count(*)::int AS n FROM notifications`),
    feed_items: await count(sql`SELECT count(*)::int AS n FROM feed_items`),
    user_favorites: await count(sql`SELECT count(*)::int AS n FROM user_favorites WHERE climb_uuid = ${climbUuid}`),
    playlist_climbs: await count(sql`SELECT count(*)::int AS n FROM playlist_climbs WHERE climb_uuid = ${climbUuid}`),
    board_climb_popularity: await count(
      sql`SELECT count(*)::int AS n FROM board_climb_popularity WHERE climb_uuid = ${climbUuid}`,
    ),
    board_climb_embeddings: await count(
      sql`SELECT count(*)::int AS n FROM board_climb_embeddings WHERE climb_uuid = ${climbUuid}`,
    ),
    board_climb_similar: await count(
      sql`SELECT count(*)::int AS n FROM board_climb_similar WHERE climb_uuid = ${climbUuid} OR neighbor_uuid = ${climbUuid}`,
    ),
    board_climb_grades: await count(
      sql`SELECT count(*)::int AS n FROM board_climb_grades WHERE climb_uuid = ${climbUuid}`,
    ),
    board_climb_send_stats: await count(
      sql`SELECT count(*)::int AS n FROM board_climb_send_stats WHERE climb_uuid = ${climbUuid}`,
    ),
    board_climb_events: await count(
      sql`SELECT count(*)::int AS n FROM board_climb_events WHERE climb_uuid = ${climbUuid}`,
    ),
    climb_stats_recompute_pending: await count(
      sql`SELECT count(*)::int AS n FROM climb_stats_recompute_pending WHERE climb_uuid = ${climbUuid}`,
    ),
    board_climb_ratings: await count(
      sql`SELECT count(*)::int AS n FROM board_climb_ratings WHERE climb_uuid = ${climbUuid}`,
    ),
    board_beta_links: await count(sql`SELECT count(*)::int AS n FROM board_beta_links WHERE climb_uuid = ${climbUuid}`),
    // board_climb_holds is left out: it goes by the FK cascade from board_climbs
    // in production (migration 0025), which the test schema does not model.
  };
}

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE TABLE "spray_walls", "user_boards", "board_climbs", "board_climb_holds", "board_climb_stats",
                   "board_climb_stats_history", "board_layouts", "board_product_sizes",
                   "board_product_sizes_layouts_sets", "board_holes", "board_placements",
                   "board_difficulty_grades", "boardsesh_ticks", "climb_proposals", "proposal_votes",
                   "comments", "votes", "vote_counts", "feed_items", "notifications", "community_settings",
                   "climb_community_status", "climb_classic_status", "user_favorites", "playlists",
                   "playlist_climbs", "board_climb_popularity", "board_climb_embeddings", "board_climb_similar",
                   "board_climb_grades", "board_climb_send_stats", "board_climb_events",
                   "climb_stats_recompute_pending", "board_climb_ratings", "board_beta_links", "sync_deletions"
    RESTART IDENTITY CASCADE
  `);
  await db.execute(sql`ALTER SEQUENCE spray_wall_catalog_id_seq RESTART WITH 1`);
  await db.execute(sql`ALTER SEQUENCE spray_hold_catalog_id_seq RESTART WITH 1`);
  await Promise.all(ALL_USERS.map(insertUser));
  await db.execute(sql`
    INSERT INTO board_difficulty_grades (board_type, difficulty, boulder_name, route_name, is_listed)
    VALUES ('spray', 10, '4a/V0', '5b/5.9', true), ('spray', 18, '6b/V4', '7a/5.11d', true)
    ON CONFLICT (board_type, difficulty) DO NOTHING
  `);
  reconcileHold.current = null;
});

describe('deleteClimb: who may delete what', () => {
  it('lets the setter delete an unticked published climb, and the climb is gone', async () => {
    const { wall, holdIds } = await createPublishedWall();
    const climbUuid = await setClimb(wall, holdIds);

    await expect(deleteClimb(OWNER, climbUuid)).resolves.toBe(true);
    expect(await climbExists(climbUuid)).toBe(false);
  });

  it('refuses while anybody else has a tick on it', async () => {
    const { wall, holdIds } = await createPublishedWall();
    const climbUuid = await setClimb(wall, holdIds);
    await saveTick(CLIMBER, climbUuid);

    expect(await outcomeOf(deleteClimb(OWNER, climbUuid))).toMatchObject({ ok: false, code: 'CLIMB_HAS_TICKS' });
    expect(await climbExists(climbUuid)).toBe(true);
  });

  it("refuses while the setter's own tick is on it", async () => {
    const { wall, holdIds } = await createPublishedWall();
    const climbUuid = await setClimb(wall, holdIds);
    await saveTick(OWNER, climbUuid);

    expect(await outcomeOf(deleteClimb(OWNER, climbUuid))).toMatchObject({ ok: false, code: 'CLIMB_HAS_TICKS' });
    expect(await climbExists(climbUuid)).toBe(true);
  });

  it('answers somebody else exactly as it answers a uuid with no climb', async () => {
    const { wall, holdIds } = await createPublishedWall();
    const climbUuid = await setClimb(wall, holdIds);

    const stranger = await outcomeOf(deleteClimb(STRANGER, climbUuid));
    const missing = await outcomeOf(deleteClimb(OWNER, uuidv4()));
    expect(stranger).toEqual({ ok: false, code: 'CLIMB_NOT_FOUND', message: 'Climb not found' });
    expect(missing).toEqual(stranger);
    expect(await climbExists(climbUuid)).toBe(true);
  });

  it('refuses a climb on any other board, even the caller’s own', async () => {
    const climbUuid = uuidv4();
    await db.execute(sql`
      INSERT INTO board_climbs (uuid, board_type, layout_id, user_id, name, is_draft, is_listed)
      VALUES (${climbUuid}, 'kilter', 1, ${OWNER}, 'Catalogue climb', false, true)
    `);

    expect(await outcomeOf(deleteClimb(OWNER, climbUuid, 'kilter'))).toMatchObject({
      ok: false,
      code: 'CLIMB_DELETE_NOT_ALLOWED',
    });
    expect(await climbExists(climbUuid)).toBe(true);
  });

  it('refuses on an archived wall', async () => {
    const { wall, holdIds } = await createPublishedWall();
    const climbUuid = await setClimb(wall, holdIds);
    await db.execute(sql`UPDATE spray_walls SET archived_at = now() WHERE board_uuid = ${wall.uuid}`);

    expect(await outcomeOf(deleteClimb(OWNER, climbUuid))).toMatchObject({ ok: false, code: 'SPRAY_WALL_ARCHIVED' });
    expect(await climbExists(climbUuid)).toBe(true);
  });

  it('turns a later tick on the deleted climb into CLIMB_NOT_FOUND, which the drainer dead-letters', async () => {
    const { wall, holdIds } = await createPublishedWall();
    const climbUuid = await setClimb(wall, holdIds);
    await deleteClimb(OWNER, climbUuid);

    expect(await outcomeOf(saveTick(CLIMBER, climbUuid))).toMatchObject({ ok: false, code: 'CLIMB_NOT_FOUND' });
    expect(await ticksOn(climbUuid)).toBe(0);
  });
});

describe('deleteClimb: what goes with the climb', () => {
  it('removes every row that points at it, and leaves the refusal path untouched', async () => {
    const { wall, holdIds } = await createPublishedWall();
    const climbUuid = await setClimb(wall, holdIds);
    const ids = await seedReferences(climbUuid, wall);

    const before = await referenceCounts(climbUuid, ids);
    // Every table is seeded, so an all-zero "after" proves a delete, not an empty table.
    for (const [table, rows] of Object.entries(before)) {
      expect({ table, seeded: rows > 0 }).toEqual({ table, seeded: true });
    }

    await deleteClimb(OWNER, climbUuid);

    const after = await referenceCounts(climbUuid, ids);
    expect(after).toEqual(Object.fromEntries(Object.keys(before).map((table) => [table, 0])));
  });

  it('keeps every reference when the delete is refused', async () => {
    const { wall, holdIds } = await createPublishedWall();
    const climbUuid = await setClimb(wall, holdIds);
    const ids = await seedReferences(climbUuid, wall);
    await saveTick(CLIMBER, climbUuid);
    const before = await referenceCounts(climbUuid, ids);

    await outcomeOf(deleteClimb(OWNER, climbUuid));

    expect(await referenceCounts(climbUuid, ids)).toEqual(before);
  });

  it('writes an unscoped climb tombstone and a favourite tombstone scoped to the climber who starred it', async () => {
    const { wall, holdIds } = await createPublishedWall();
    const climbUuid = await setClimb(wall, holdIds);
    await seedReferences(climbUuid, wall);

    await deleteClimb(OWNER, climbUuid);

    const tombstones = (await db.execute(sql`
      SELECT table_name, record_id, user_id FROM sync_deletions
      WHERE table_name IN ('board_climbs', 'user_favorites') ORDER BY table_name
    `)) as unknown as Array<{ table_name: string; record_id: string; user_id: string | null }>;
    expect(tombstones).toEqual([
      { table_name: 'board_climbs', record_id: climbUuid, user_id: null },
      { table_name: 'user_favorites', record_id: `spray:${climbUuid}:${ANGLE}`, user_id: STRANGER },
    ]);
  });
});

describe('deleteClimb against a concurrent saveTick', () => {
  it('tick first: the delete waits for the tick to commit, then refuses', async () => {
    const { wall, holdIds } = await createPublishedWall();
    const climbUuid = await setClimb(wall, holdIds);

    // Park saveTick after its insert, inside its transaction.
    const entered = deferred();
    const release = deferred();
    reconcileHold.current = { entered: entered.resolve, release: release.promise };
    const tick = outcomeOf(saveTick(CLIMBER, climbUuid));
    await entered.promise;

    const deletion = outcomeOf(deleteClimb(OWNER, climbUuid));
    // With the tick's row lock in place the delete blocks on it. Without it, the
    // delete does not wait: it sees no committed tick and goes straight through.
    const deleteState = await parkedOrSettled(deletion, 1);
    release.resolve();

    expect(await tick).toEqual({ ok: true });
    expect(await deletion).toMatchObject({ ok: false, code: 'CLIMB_HAS_TICKS' });
    expect(deleteState).toBe('parked');
    expect(await climbExists(climbUuid)).toBe(true);
    expect(await ticksOn(climbUuid)).toBe(1);
  });

  it('delete first: the tick waits for the delete to commit, then is refused', async () => {
    const { wall, holdIds } = await createPublishedWall();
    const climbUuid = await setClimb(wall, holdIds);
    await db.execute(sql`
      INSERT INTO user_favorites (user_id, board_name, climb_uuid, angle, created_at)
      VALUES (${STRANGER}, 'spray', ${climbUuid}, ${ANGLE}, now())
    `);

    // Park the delete after it has locked the climb and counted ticks: it has to
    // remove this favourite, and this transaction holds the favourite's row.
    const holding = deferred();
    const release = deferred();
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM user_favorites WHERE climb_uuid = ${climbUuid} FOR UPDATE`);
      holding.resolve();
      await release.promise;
    });
    await holding.promise;

    const deletion = outcomeOf(deleteClimb(OWNER, climbUuid));
    expect(await waitForLockWaiters(1)).toBe(true);

    const tick = outcomeOf(saveTick(CLIMBER, climbUuid));
    // With the delete's row lock in place, the tick blocks on it (a second waiter).
    // Without it, or without saveTick's in-transaction re-check, the tick commits.
    const tickState = await parkedOrSettled(tick, 2);
    release.resolve();
    await holder;

    expect(await deletion).toEqual({ ok: true });
    expect(await tick).toMatchObject({ ok: false, code: 'CLIMB_NOT_FOUND' });
    expect(tickState).toBe('parked');
    expect(await climbExists(climbUuid)).toBe(false);
    expect(await ticksOn(climbUuid)).toBe(0);
  });
});
