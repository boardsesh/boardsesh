import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';

/**
 * Issue #6032 — the write side of a spray wall.
 *
 * The read side goes out of its way not to reveal a private wall's climbs; these
 * three write paths used to answer a held uuid with either "Climb not found" or
 * success, which is an existence oracle, and both answers are a leak:
 *
 *  - `createProposal` / `reportClimb` opened grade and hide proposals on climbs
 *    the caller could not see, and wrote onto drafts strangers don't own;
 *  - `saveTick` stored a spray tick for ANY uuid — a made-up one, or a replay of
 *    a tick whose climb `deleteDraftClimb` hard-deleted in the meantime;
 *  - `fanoutCommentFeedItems` copied a draft's or a private wall's climb name,
 *    frames and layout id into the `feed_items` of people who cannot open the wall.
 *
 * Seeding goes through the real mutations wherever the flow has one (wall,
 * version, holds, publish, `saveClimb`, `reportClimb`), and through raw SQL only
 * where no mutation can produce the shape (a pre-fix legacy feed row, a comment
 * hung off a hand-made proposal). Direct-resolver style, like
 * `report-climb-integration.test.ts`; the wall fixtures are the
 * `spray-wall-api.test.ts` ones, trimmed.
 */

const { storedPhotoMetadata, publishedEvents } = vi.hoisted(() => ({
  storedPhotoMetadata: new Map<string, { width: string; height: string }>(),
  publishedEvents: [] as Array<{ type: string; entityId?: string }>,
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
  publishSocialEvent: vi.fn(async (event: { type: string; entityId?: string }) => {
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

vi.mock('../pubsub/index', () => ({
  pubsub: { publishCommentEvent: vi.fn() },
}));

import { db } from '../db/client';
import { sprayWallPhotoKey } from '../handlers/spray-wall-photos';
import { sprayWallMutations } from '../graphql/resolvers/board/spray-walls';
import { climbMutations } from '../graphql/resolvers/climbs/mutations';
import { socialProposalMutations } from '../graphql/resolvers/social/proposals/mutations';
import { tickMutations } from '../graphql/resolvers/ticks/mutations';
import { fanoutCommentFeedItems, fanoutProposalApprovedFeedItems } from '../events/feed-fanout';

const OWNER = 'wv-owner';
const STRANGER = 'wv-stranger';
const GYM_MEMBER = 'wv-gym-member';
/** Follows OWNER, so every fan-out that passes the gate writes a row for it. */
const FOLLOWER = 'wv-follower';
const ALL_USERS = [OWNER, STRANGER, GYM_MEMBER, FOLLOWER];

const ANGLE = 40;
const CLIMB_NAME = 'Secret garage problem';
const HIDE_REASON = 'These holds were ripped out of the wall and never went back.';

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

/** Stands in for POST /api/spray-wall-photos, like spray-wall-api.test.ts. */
function registerUploadedPhoto(wallUuid: string): string {
  const photoId = uuidv4();
  storedPhotoMetadata.set(sprayWallPhotoKey(wallUuid, photoId), { width: '1200', height: '900' });
  return photoId;
}

type CreatedWall = { uuid: string; layoutId: number; sizeId: number };

/** The owner-side flow: wall → photo → holds → publish. Private unless overridden. */
async function createPublishedWall(
  owner: string,
  overrides: Record<string, unknown> = {},
): Promise<{ wall: CreatedWall; holdIds: number[] }> {
  const wall = (await sprayWallMutations.createSprayWall(
    {},
    { input: { name: `Wall ${uuidv4().slice(0, 6)}`, angle: ANGLE, ...overrides } },
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
    ctxFor(owner),
  )) as Array<{ id: number }>;
  await sprayWallMutations.publishSprayWallVersion({}, { input: { versionId: version.id } }, ctxFor(owner));

  return { wall, holdIds: holds.map((hold) => hold.id) };
}

/** `frames` for a spray climb: start, hand, finish on the given holds. */
function framesFor(holdIds: number[]): string {
  const roles = [1, 2, 3];
  return holdIds.map((holdId, index) => `p${holdId}r${roles[index] ?? 2}`).join('');
}

/** A climb on the wall, published unless `isDraft`. */
async function setClimb(
  wall: CreatedWall,
  holdIds: number[],
  options: { owner?: string; name?: string; isDraft?: boolean } = {},
): Promise<string> {
  const saved = (await climbMutations.saveClimb(
    {},
    {
      input: {
        boardType: 'spray',
        layoutId: wall.layoutId,
        name: options.name ?? CLIMB_NAME,
        isDraft: options.isDraft ?? false,
        frames: framesFor(holdIds),
        angle: ANGLE,
        ...(options.isDraft ? {} : { userGrade: '6b/V4' }),
      },
    },
    ctxFor(options.owner ?? OWNER),
  )) as { uuid: string };
  return saved.uuid;
}

/** Attaches the wall to a gym with GYM_MEMBER in it (shape from spray-wall-api). */
async function attachGymWithMember(wall: CreatedWall): Promise<void> {
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
    VALUES (${gym.id}, ${GYM_MEMBER}, 'member', now())
  `);
}

const hideWall = (wall: CreatedWall) =>
  db.execute(sql`UPDATE spray_walls SET hidden_at = now() WHERE layout_id = ${wall.layoutId}`);

const follow = (followerId: string, followingId: string) =>
  db.execute(sql`
    INSERT INTO user_follows (follower_id, following_id, created_at)
    VALUES (${followerId}, ${followingId}, now()) ON CONFLICT DO NOTHING
  `);

async function captureRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the mutation to reject');
}

const tickCount = async (climbUuid: string, userId: string): Promise<number> => {
  const [row] = (await db.execute(sql`
    SELECT count(*)::int AS n FROM boardsesh_ticks WHERE climb_uuid = ${climbUuid} AND user_id = ${userId}
  `)) as unknown as Array<{ n: number }>;
  return row.n;
};

const proposalCount = async (climbUuid: string): Promise<number> => {
  const [row] = (await db.execute(sql`
    SELECT count(*)::int AS n FROM climb_proposals WHERE climb_uuid = ${climbUuid}
  `)) as unknown as Array<{ n: number }>;
  return row.n;
};

const feedRowsFor = async (recipient: string): Promise<Array<Record<string, unknown>>> => {
  const rows = (await db.execute(sql`
    SELECT metadata FROM feed_items WHERE recipient_id = ${recipient}
  `)) as unknown as Array<{ metadata: Record<string, unknown> }>;
  return rows.map((row) => row.metadata);
};

/** A seeded tick — a raw row, not through `saveTick`, so the tick gate can't be the thing under test. */
async function seedTick(userId: string, climbUuid: string, boardType: string): Promise<string> {
  const tickUuid = uuidv4();
  await db.execute(sql`
    INSERT INTO boardsesh_ticks (uuid, user_id, climb_uuid, board_type, angle, status,
                                 attempt_count, is_mirror, is_benchmark, comment, climbed_at, created_at, updated_at)
    VALUES (${tickUuid}, ${userId}, ${climbUuid}, ${boardType}, ${ANGLE}, 'attempt',
            3, false, false, 'Sent it.', now(), now(), now())
  `);
  return tickUuid;
}

/** A proposal row + the comment a `hide` proposal persists (shape from the sweep seed). */
async function seedProposalWithComment(
  climbUuid: string,
  boardType: string,
): Promise<{ proposalUuid: string; commentUuid: string }> {
  const proposalUuid = uuidv4();
  const commentUuid = uuidv4();
  await db.execute(sql`
    INSERT INTO climb_proposals (uuid, climb_uuid, board_type, angle, proposer_id, type, proposed_value, current_value, reason, status, created_at)
    VALUES (${proposalUuid}, ${climbUuid}, ${boardType}, NULL, ${OWNER}, 'hide', 'true', 'false', ${HIDE_REASON}, 'open', now())
  `);
  await db.execute(sql`
    INSERT INTO comments (uuid, entity_type, entity_id, user_id, body, created_at, updated_at)
    VALUES (${commentUuid}, 'proposal', ${proposalUuid}, ${OWNER}, ${HIDE_REASON}, now(), now())
  `);
  return { proposalUuid, commentUuid };
}

const commentCreatedEvent = (actorId: string, commentUuid: string) => ({
  type: 'comment.created' as const,
  actorId,
  entityType: 'comment' as const,
  entityId: commentUuid,
  timestamp: Date.now(),
  metadata: { commentUuid },
});

const saveTickInput = (overrides: Record<string, unknown> = {}) => ({
  boardType: 'spray',
  angle: ANGLE,
  status: 'attempt',
  attemptCount: 3,
  isMirror: false,
  isBenchmark: false,
  comment: '',
  climbedAt: new Date().toISOString(),
  ...overrides,
});

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE TABLE "spray_walls", "user_boards", "gym_members", "gyms",
                   "board_climbs", "board_climb_holds", "board_climb_stats",
                   "board_layouts", "board_product_sizes", "board_product_sizes_layouts_sets",
                   "board_holes", "board_placements", "board_difficulty_grades",
                   "boardsesh_ticks", "user_follows",
                   "climb_proposals", "proposal_votes", "comments", "feed_items",
                   "community_settings"
    RESTART IDENTITY CASCADE
  `);
  await db.execute(sql`ALTER SEQUENCE spray_wall_catalog_id_seq RESTART WITH 1`);
  await db.execute(sql`ALTER SEQUENCE spray_hold_catalog_id_seq RESTART WITH 1`);

  await Promise.all(ALL_USERS.map(insertUser));

  // The spray grade scale (rows from migration 0227, as spray-wall-api re-seeds).
  await db.execute(sql`
    INSERT INTO board_difficulty_grades (board_type, difficulty, boulder_name, route_name, is_listed)
    VALUES ('spray', 10, '4a/V0', '5b/5.9', true),
           ('spray', 18, '6b/V4', '7a/5.11d', true),
           ('spray', 22, '7a/V6', '7c/5.12d', true)
    ON CONFLICT (board_type, difficulty) DO NOTHING
  `);

  publishedEvents.length = 0;
});

describe('createProposal and reportClimb against a climb the caller cannot see', () => {
  const createHide = (userId: string, climbUuid: string) =>
    socialProposalMutations.createProposal(
      null,
      {
        input: {
          climbUuid,
          boardType: 'spray',
          type: 'hide',
          proposedValue: 'true',
          reason: HIDE_REASON,
        },
      },
      ctxFor(userId),
    );

  const reportGrade = (userId: string, climbUuid: string) =>
    socialProposalMutations.reportClimb(
      null,
      {
        input: {
          climbUuid,
          boardType: 'spray',
          angle: ANGLE,
          kind: 'grade',
          proposedGrade: '7a/V6',
          reason: 'This is way harder than it is graded.',
        },
      },
      ctxFor(userId),
    );

  it('refuses a stranger on a private wall, with the same answer a missing uuid gets', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const climbUuid = await setClimb(wall, holdIds);

    const strangerRejection = await captureRejection(createHide(STRANGER, climbUuid));
    expect(strangerRejection.message).toBe('Climb not found');
    expect(await proposalCount(climbUuid), 'the refusal must not leave a proposal behind').toBe(0);

    // The existence oracle is the point: an invisible wall and a uuid with no row
    // answer identically, so holding a uuid tells you nothing about it.
    const unknownRejection = await captureRejection(createHide(STRANGER, uuidv4()));
    expect(unknownRejection.message).toBe(strangerRejection.message);
  });

  it('refuses reportClimb on the same door', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const climbUuid = await setClimb(wall, holdIds);

    const rejection = await captureRejection(reportGrade(STRANGER, climbUuid));
    expect(rejection.message).toBe('Climb not found');
    expect(await proposalCount(climbUuid)).toBe(0);
  });

  it('keeps the wall open to its owner and to a gym member', async () => {
    const privateWall = await createPublishedWall(OWNER);
    const privateClimb = await setClimb(privateWall.wall, privateWall.holdIds);
    // A grade, not a hide: the owner set this climb, and a setter may not file a
    // hide on their own climb (#5971).
    await reportGrade(OWNER, privateClimb);
    expect(await proposalCount(privateClimb), 'the owner proposes on their own wall').toBe(1);

    const gymWall = await createPublishedWall(OWNER);
    const gymClimb = await setClimb(gymWall.wall, gymWall.holdIds);
    await attachGymWithMember(gymWall.wall);
    await reportGrade(GYM_MEMBER, gymClimb);
    expect(await proposalCount(gymClimb), 'a gym member proposes on the gym wall').toBe(1);
  });

  it('keeps the public wall open to a stranger proposal', async () => {
    // Control for the two above: the public case must still work, so a gate that
    // refused everything would pass the tests above for the wrong reason.
    const { wall, holdIds } = await createPublishedWall(OWNER, { isPublic: true });
    const climbUuid = await setClimb(wall, holdIds);

    await expect(createHide(STRANGER, climbUuid)).resolves.toBeTruthy();
    expect(await proposalCount(climbUuid)).toBe(1);
  });

  it('answers an unlisted wall with not-found (no uuid door on proposals, parity with comments)', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER, { isUnlisted: true });
    const climbUuid = await setClimb(wall, holdIds);

    // Proposals carry no wall-uuid field, so the share-link capability that opens
    // the wall for reads does not open it for writes — exactly how comments
    // already treat an unlisted wall.
    const rejection = await captureRejection(createHide(STRANGER, climbUuid));
    expect(rejection.message).toBe('Climb not found');

    await expect(reportGrade(OWNER, climbUuid)).resolves.toBeTruthy();
  });

  it('falls back to private for a wall an admin hid, except for its owner', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER, { isPublic: true });
    const climbUuid = await setClimb(wall, holdIds);
    await hideWall(wall);

    const strangerRejection = await captureRejection(createHide(STRANGER, climbUuid));
    expect(strangerRejection.message).toBe('Climb not found');

    const gymWall = await createPublishedWall(OWNER, { isPublic: true });
    await attachGymWithMember(gymWall.wall);
    await hideWall(gymWall.wall);
    const hiddenGymClimb = await setClimb(gymWall.wall, gymWall.holdIds);
    await expect(createHide(GYM_MEMBER, hiddenGymClimb)).rejects.toThrow('Climb not found');
    await expect(reportGrade(OWNER, climbUuid)).resolves.toBeTruthy();
  });

  it('refuses a draft the caller does not own, on every board type (as comments do)', async () => {
    await db.execute(sql`
      INSERT INTO "board_climbs" (
        uuid, board_type, layout_id, setter_username, name, frames, frames_count,
        is_draft, is_listed, is_hidden, edge_left, edge_right, edge_bottom, edge_top, created_at, user_id
      )
      VALUES (
        'wv-kilter-draft', 'kilter', 1, 'wv-setter', 'Work in progress', 'p1r1', 1,
        true, true, false, 0, 100, 0, 150, '2026-01-01', ${OWNER}
      )
    `);

    const strangerRejection = await captureRejection(
      socialProposalMutations.createProposal(
        null,
        {
          input: {
            climbUuid: 'wv-kilter-draft',
            boardType: 'kilter',
            type: 'hide',
            proposedValue: 'true',
            reason: HIDE_REASON,
          },
        },
        ctxFor(STRANGER),
      ),
    );
    // The same words as a missing climb — the draft's existence is not observable.
    expect(strangerRejection.message).toBe('Climb not found');

    await socialProposalMutations.createProposal(
      null,
      {
        input: {
          climbUuid: 'wv-kilter-draft',
          boardType: 'kilter',
          // Classic, not hide: a setter may not file a hide on their own climb.
          type: 'classic',
          proposedValue: 'true',
          reason: HIDE_REASON,
        },
      },
      ctxFor(OWNER),
    );
    expect(await proposalCount('wv-kilter-draft'), 'the setter may still propose on their own draft').toBe(1);
  });
});

describe('saveTick against a spray climb', () => {
  it('rejects a made-up uuid, and names the reason for the drainer', async () => {
    const rejection = await captureRejection(
      tickMutations.saveTick({}, { input: saveTickInput({ climbUuid: uuidv4() }) }, ctxFor(STRANGER)),
    );
    expect(rejection.message).toBe('Climb not found');
    // CLIMB_NOT_FOUND is on the offline drainer's permanent-rejection list, so a
    // replay whose climb was hard-deleted dead-letters on attempt one.
    expect((rejection as unknown as { extensions?: { code?: string } }).extensions?.code).toBe('CLIMB_NOT_FOUND');
  });

  it('refuses a stranger on a private wall and writes no row', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const climbUuid = await setClimb(wall, holdIds);

    const rejection = await captureRejection(
      tickMutations.saveTick({}, { input: saveTickInput({ climbUuid }) }, ctxFor(STRANGER)),
    );
    expect(rejection.message).toBe('Climb not found');
    expect(await tickCount(climbUuid, STRANGER)).toBe(0);

    // Invisible wall and missing climb answer identically, for the same reason.
    const unknownRejection = await captureRejection(
      tickMutations.saveTick({}, { input: saveTickInput({ climbUuid: uuidv4() }) }, ctxFor(STRANGER)),
    );
    expect(unknownRejection.message).toBe(rejection.message);
  });

  it('keeps the wall open to its owner, its gym, and the public on a public wall', async () => {
    const privateWall = await createPublishedWall(OWNER);
    const privateClimb = await setClimb(privateWall.wall, privateWall.holdIds);
    await tickMutations.saveTick({}, { input: saveTickInput({ climbUuid: privateClimb }) }, ctxFor(OWNER));
    expect(await tickCount(privateClimb, OWNER), 'the owner logs their own wall').toBe(1);

    const gymWall = await createPublishedWall(OWNER);
    const gymClimb = await setClimb(gymWall.wall, gymWall.holdIds);
    await attachGymWithMember(gymWall.wall);
    await tickMutations.saveTick({}, { input: saveTickInput({ climbUuid: gymClimb }) }, ctxFor(GYM_MEMBER));
    expect(await tickCount(gymClimb, GYM_MEMBER), 'a gym member ticks the gym wall').toBe(1);

    const publicWall = await createPublishedWall(OWNER, { isPublic: true });
    const publicClimb = await setClimb(publicWall.wall, publicWall.holdIds);
    await tickMutations.saveTick({}, { input: saveTickInput({ climbUuid: publicClimb }) }, ctxFor(STRANGER));
    expect(await tickCount(publicClimb, STRANGER), 'anybody ticks a public wall').toBe(1);
  });

  it('opens an unlisted wall to the share-link capability (the wall uuid the tick carries)', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER, { isUnlisted: true });
    const climbUuid = await setClimb(wall, holdIds);

    const rejection = await captureRejection(
      tickMutations.saveTick({}, { input: saveTickInput({ climbUuid }) }, ctxFor(STRANGER)),
    );
    expect(rejection.message).toBe('Climb not found');

    // The link-holder ticks the wall they can open — the read side hands them the
    // page, so refusing the tick would strand it.
    await tickMutations.saveTick({}, { input: saveTickInput({ climbUuid, boardUuid: wall.uuid }) }, ctxFor(STRANGER));
    expect(await tickCount(climbUuid, STRANGER)).toBe(1);
  });

  it('still accepts an Aurora tick naming a climb that has not synced yet', async () => {
    // The exemption the issue asks to preserve: only spray rows are gated.
    await tickMutations.saveTick(
      {},
      { input: saveTickInput({ boardType: 'kilter', climbUuid: uuidv4() }) },
      ctxFor(STRANGER),
    );
  });

  it('rejects the replay of a tick whose spray climb was hard-deleted meanwhile', async () => {
    // The exact shape the offline outbox produces: tick queued against a climb
    // that `deleteDraftClimb` then hard-deletes (drafts, account deletion).
    const { wall, holdIds } = await createPublishedWall(OWNER, { isPublic: true });
    const climbUuid = await setClimb(wall, holdIds, { isDraft: true });
    await tickMutations.saveTick({}, { input: saveTickInput({ climbUuid }) }, ctxFor(OWNER));
    expect(await tickCount(climbUuid, OWNER)).toBe(1);

    await climbMutations.deleteDraftClimb({}, { uuid: climbUuid, boardType: 'spray' }, ctxFor(OWNER));

    const rejection = await captureRejection(
      tickMutations.saveTick({}, { input: saveTickInput({ climbUuid }) }, ctxFor(OWNER)),
    );
    expect((rejection as unknown as { extensions?: { code?: string } }).extensions?.code).toBe('CLIMB_NOT_FOUND');
    expect(await tickCount(climbUuid, OWNER), 'the replay must not orphan a tick row').toBe(1);
  });
});

describe('the feed fan-out stops writing rows it cannot serve', () => {
  it('skips a comment on a proposal whose climb is a draft', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER, { isPublic: true });
    const draftClimb = await setClimb(wall, holdIds, { isDraft: true });
    await follow(FOLLOWER, OWNER);

    const { commentUuid } = await seedProposalWithComment(draftClimb, 'spray');
    await fanoutCommentFeedItems(commentCreatedEvent(OWNER, commentUuid));
    expect(await feedRowsFor(FOLLOWER), 'a draft must not fan its details out').toEqual([]);

    // Control: the same comment on a published climb's proposal does fan out.
    const publishedClimb = await setClimb(wall, holdIds, { name: 'Public garage problem' });
    const published = await seedProposalWithComment(publishedClimb, 'spray');
    await fanoutCommentFeedItems(commentCreatedEvent(OWNER, published.commentUuid));
    const rows = await feedRowsFor(FOLLOWER);
    expect(rows.map((metadata) => metadata.climbName)).toContain('Public garage problem');
  });

  it('skips a comment on a proposal whose spray wall is not public', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const climbUuid = await setClimb(wall, holdIds);
    await follow(FOLLOWER, OWNER);

    const { commentUuid } = await seedProposalWithComment(climbUuid, 'spray');
    await fanoutCommentFeedItems(commentCreatedEvent(OWNER, commentUuid));
    expect(await feedRowsFor(FOLLOWER)).toEqual([]);
  });

  it('skips an approved-proposal fan-out under the same two rules', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER, { isPublic: true });
    await follow(FOLLOWER, OWNER);

    const privateClimb = await createPublishedWall(OWNER);
    const privateProposal = await seedProposalWithComment(
      await setClimb(privateClimb.wall, privateClimb.holdIds),
      'spray',
    );
    await fanoutProposalApprovedFeedItems({
      type: 'proposal.approved',
      actorId: OWNER,
      entityType: 'proposal',
      entityId: privateProposal.proposalUuid,
      timestamp: Date.now(),
      metadata: {},
    });
    expect(await feedRowsFor(FOLLOWER), 'the private wall contributes nothing').toEqual([]);

    const draftClimb = await setClimb(wall, holdIds, { isDraft: true });
    const draftProposal = await seedProposalWithComment(draftClimb, 'spray');
    await fanoutProposalApprovedFeedItems({
      type: 'proposal.approved',
      actorId: OWNER,
      entityType: 'proposal',
      entityId: draftProposal.proposalUuid,
      timestamp: Date.now(),
      metadata: {},
    });
    expect(await feedRowsFor(FOLLOWER), 'the draft contributes nothing').toEqual([]);

    // Control: the public wall's approved proposal still reaches the follower.
    const publicClimb = await setClimb(wall, holdIds, { name: 'Announced problem' });
    const publicProposal = await seedProposalWithComment(publicClimb, 'spray');
    await fanoutProposalApprovedFeedItems({
      type: 'proposal.approved',
      actorId: OWNER,
      entityType: 'proposal',
      entityId: publicProposal.proposalUuid,
      timestamp: Date.now(),
      metadata: {},
    });
    expect((await feedRowsFor(FOLLOWER)).map((metadata) => metadata.climbName)).toContain('Announced problem');
  });

  it('skips a comment on a tick of a private wall, and of a deleted spray climb', async () => {
    const { wall, holdIds } = await createPublishedWall(OWNER);
    const climbUuid = await setClimb(wall, holdIds);
    await follow(FOLLOWER, OWNER);

    const tickUuid = await seedTick(OWNER, climbUuid, 'spray');
    const tickCommentUuid = uuidv4();
    await db.execute(sql`
      INSERT INTO comments (uuid, entity_type, entity_id, user_id, body, created_at, updated_at)
      VALUES (${tickCommentUuid}, 'tick', ${tickUuid}, ${OWNER}, ${HIDE_REASON}, now(), now())
    `);
    await fanoutCommentFeedItems(commentCreatedEvent(OWNER, tickCommentUuid));
    expect(await feedRowsFor(FOLLOWER), 'a private wall tick contributes nothing').toEqual([]);

    // And the deleted-climb shape: a spray tick whose climb row is gone has no
    // wall to check, so it fails closed instead of writing rows to mask later.
    const publicWall = await createPublishedWall(OWNER, { isPublic: true });
    const doomedClimb = await setClimb(publicWall.wall, publicWall.holdIds, { isDraft: true });
    const doomedTick = await seedTick(OWNER, doomedClimb, 'spray');
    await climbMutations.deleteDraftClimb({}, { uuid: doomedClimb, boardType: 'spray' }, ctxFor(OWNER));
    const doomedCommentUuid = uuidv4();
    await db.execute(sql`
      INSERT INTO comments (uuid, entity_type, entity_id, user_id, body, created_at, updated_at)
      VALUES (${doomedCommentUuid}, 'tick', ${doomedTick}, ${OWNER}, 'One more for the deleted climb.', now(), now())
    `);
    await fanoutCommentFeedItems(commentCreatedEvent(OWNER, doomedCommentUuid));
    expect(await feedRowsFor(FOLLOWER), 'a tick on a deleted spray climb contributes nothing').toEqual([]);
  });

  it('fans a comment on a tick of a public wall, and on every other board', async () => {
    // Guards the guards: the rule must not silence comments generally.
    const { wall, holdIds } = await createPublishedWall(OWNER, { isPublic: true });
    const climbUuid = await setClimb(wall, holdIds);
    await follow(FOLLOWER, OWNER);

    const tickUuid = await seedTick(OWNER, climbUuid, 'spray');
    const tickCommentUuid = uuidv4();
    await db.execute(sql`
      INSERT INTO comments (uuid, entity_type, entity_id, user_id, body, created_at, updated_at)
      VALUES (${tickCommentUuid}, 'tick', ${tickUuid}, ${OWNER}, 'Sent it.', now(), now())
    `);
    await fanoutCommentFeedItems(commentCreatedEvent(OWNER, tickCommentUuid));
    expect((await feedRowsFor(FOLLOWER)).map((metadata) => metadata.climbName)).toContain(CLIMB_NAME);

    const kilterTick = await seedTick(OWNER, 'wv-ghost-kilter-climb', 'kilter');
    const kilterCommentUuid = uuidv4();
    await db.execute(sql`
      INSERT INTO comments (uuid, entity_type, entity_id, user_id, body, created_at, updated_at)
      VALUES (${kilterCommentUuid}, 'tick', ${kilterTick}, ${OWNER}, 'Tension-style ghost tick.', now(), now())
    `);
    await fanoutCommentFeedItems(commentCreatedEvent(OWNER, kilterCommentUuid));
    expect(
      await feedRowsFor(FOLLOWER),
      'a tick whose climb has not synced yet still fans out on Aurora boards',
    ).toHaveLength(2);
  });
});
