import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { Readable } from 'node:stream';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { mapPoint } from '@boardsesh/spray-wall-geometry';

/**
 * Spray wall training data (SW-20, #5471): consent, hold provenance, the admin
 * vetting queue and the export, against the real database.
 *
 * The acceptance rules are the ones a climber is promised, so they are asserted
 * on the export's actual files rather than on helper return values:
 *
 *  - a wall whose owner never consented is never exported, approval or not;
 *  - switching consent off retires the stored export that held the wall, and
 *    the next export leaves it out;
 *  - switching it off covers the whole physical wall: the archived walls it
 *    was reset from and a reset clone that is not finished yet;
 *  - a wall's split is frozen across runs and shared by its reset clones;
 *  - holds land on the photo through the version's own homography;
 *  - each detector suggestion's fate is read back correctly.
 *
 * Storage is the only stub: an in-memory bucket, so the export's writes, reads,
 * listings and deletes are real operations on real keys.
 */

const { buckets, storedPhotoMetadata } = vi.hoisted(() => ({
  buckets: new Map<string, Map<string, Buffer>>(),
  storedPhotoMetadata: new Map<string, { width: string; height: string }>(),
}));

function bucket(name: string): Map<string, Buffer> {
  let objects = buckets.get(name);
  if (!objects) {
    objects = new Map();
    buckets.set(name, objects);
  }
  return objects;
}

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
  getS3ObjectMetadataStrict: vi.fn(async (_bucket: string, key: string) => {
    const metadata = storedPhotoMetadata.get(key);
    return metadata ? { contentType: 'image/jpeg', contentLength: 1024, lastModified: new Date(), metadata } : null;
  }),
  getFromS3Strict: vi.fn(async (bucketName: string, key: string) => {
    const body = bucket(bucketName).get(key);
    return body
      ? { stream: Readable.from([body]), contentType: 'application/octet-stream', contentLength: body.length }
      : null;
  }),
  uploadToS3: vi.fn(async (bucketName: string, body: Buffer, key: string) => {
    bucket(bucketName).set(key, body);
    return { key };
  }),
  copyObjectBetweenBuckets: vi.fn(
    async (source: string, sourceKey: string, destination: string, destinationKey: string) => {
      const body = bucket(source).get(sourceKey);
      if (!body) return null;
      bucket(destination).set(destinationKey, body);
      return { key: destinationKey };
    },
  ),
  listS3Objects: vi.fn(async (bucketName: string, prefix: string) =>
    [...bucket(bucketName).entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, body]) => ({ key, size: body.length, lastModified: new Date() })),
  ),
  deleteFromS3: vi.fn(async (bucketName: string, key: string) => {
    bucket(bucketName).delete(key);
  }),
  getPublicUrl: vi.fn((_bucket: string, key: string) => `https://media.example/${key}`),
}));

vi.mock('../services/board-render', () => ({
  RenderQueueSaturatedError: class RenderQueueSaturatedError extends Error {},
  runOnRenderSemaphore: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));
vi.mock('../events', () => ({ publishSocialEvent: vi.fn(async () => undefined) }));
vi.mock('../lib/web-revalidate', () => ({ notifyClimbRevalidated: vi.fn(async () => undefined) }));
vi.mock('../utils/rate-limiter', () => ({ checkRateLimit: vi.fn(), resetAllRateLimits: vi.fn() }));
vi.mock('../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: vi.fn().mockResolvedValue(undefined) }));

const { db } = await import('../db/client');
const { deleteFromS3 } = await import('../storage/s3');
const { sprayWallQueries, sprayWallMutations } = await import('../graphql/resolvers/board/spray-walls');
const {
  sprayTrainingQueries,
  sprayTrainingMutations,
  exportSprayTrainingDataset,
  trainingRef,
  trainingSplitForRoot,
  SPRAY_TRAINING_EXPORT_PREFIX,
  SPRAY_TRAINING_EXPORT_LEASE,
} = await import('../graphql/resolvers/board/spray-training');
const { buildUserDataArchive } = await import('../services/user-data-export-archive');
const { sprayWallPhotoKey } = await import('../handlers/spray-wall-photos');
const { SYSTEM_BOARD_OWNER_ID } = await import('../graphql/resolvers/board-presence/shared');

const OWNER = 'sw20-owner';
const STRANGER = 'sw20-stranger';
const ADMIN = 'sw20-admin';
const SPRAY_ADMIN = 'sw20-spray-admin';
const ALL_USERS = [OWNER, STRANGER, ADMIN, SPRAY_ADMIN];

/** An off-axis quad, so every version below carries a NON-identity homography. */
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

function registerUploadedPhoto(wallUuid: string): string {
  const photoId = uuidv4();
  const key = sprayWallPhotoKey(wallUuid, photoId);
  storedPhotoMetadata.set(key, { width: '1200', height: '900' });
  bucket('private').set(key, Buffer.from(`jpeg-bytes-of-${photoId}`));
  return photoId;
}

type CreatedWall = { uuid: string; layoutId: number };
type HoldInput = Record<string, unknown> & { cx: number; cy: number; r: number };

const DEFAULT_HOLDS: HoldInput[] = [
  { cx: 100, cy: 120, r: 24 },
  { cx: 300, cy: 400, r: 30, outline: [1, 0, 0, 1, -1, 0, 0, -1] },
  { cx: 520, cy: 560, r: 18 },
];

async function createWall(input: Record<string, unknown> = {}, owner = OWNER): Promise<CreatedWall> {
  return (await sprayWallMutations.createSprayWall(
    {},
    { input: { name: `Wall ${uuidv4().slice(0, 6)}`, angle: 40, ...input } },
    ctxFor(owner),
  )) as CreatedWall;
}

async function createDraft(wall: CreatedWall, owner = OWNER): Promise<string> {
  const version = (await sprayWallMutations.createSprayWallVersion(
    {},
    { input: { wallUuid: wall.uuid, photoId: registerUploadedPhoto(wall.uuid), anchors: ANCHORS } },
    ctxFor(owner),
  )) as { id: string };
  return version.id;
}

async function upsertHolds(wall: CreatedWall, versionId: string, holds: HoldInput[]) {
  return (await sprayWallMutations.upsertSprayWallHolds(
    {},
    { input: { wallUuid: wall.uuid, versionId, holds } },
    ctxFor(OWNER),
  )) as Array<{
    id: number;
    autoReview: string | null;
    originDetectionId: string | null;
    originCandidateIndex: number | null;
  }>;
}

async function publish(versionId: string) {
  await sprayWallMutations.publishSprayWallVersion({}, { input: { versionId } }, ctxFor(OWNER));
}

/** Photograph a wall, mark its holds and publish: a new wall's or a reset clone's first version. */
async function publishFirstVersion(wall: CreatedWall, holds: HoldInput[] = DEFAULT_HOLDS): Promise<string> {
  const versionId = await createDraft(wall);
  await upsertHolds(wall, versionId, holds);
  await publish(versionId);
  return versionId;
}

async function createPublishedWall(input: Record<string, unknown> = {}, holds: HoldInput[] = DEFAULT_HOLDS) {
  const wall = await createWall(input);
  return { wall, versionId: await publishFirstVersion(wall, holds) };
}

/** Start a reset: the clone exists, unpublished, and the source is still live. */
async function startReset(source: CreatedWall): Promise<CreatedWall> {
  return (await sprayWallMutations.resetSprayWall(
    {},
    { input: { wallUuid: source.uuid } },
    ctxFor(OWNER),
  )) as CreatedWall;
}

async function setTrainingConsent(wall: CreatedWall, trainingConsent: boolean) {
  return (await sprayWallMutations.updateSprayWall(
    {},
    { input: { uuid: wall.uuid, trainingConsent } },
    ctxFor(OWNER),
  )) as { trainingConsent: boolean | null };
}

/** The wall's row as the consent write leaves it. Timestamps as text, which keeps `updated_at`'s microseconds. */
async function wallRowOf(wall: CreatedWall) {
  const rows = (await db.execute(sql`
    SELECT training_consent_at::text AS training_consent_at, archived_at::text AS archived_at,
           updated_at::text AS updated_at
    FROM spray_walls WHERE board_uuid = ${wall.uuid}
  `)) as unknown as Array<{ training_consent_at: string | null; archived_at: string | null; updated_at: string }>;
  return rows[0];
}

async function wallIdOf(wall: CreatedWall): Promise<number> {
  const rows = (await db.execute(sql`SELECT id FROM spray_walls WHERE board_uuid = ${wall.uuid}`)) as unknown as Array<{
    id: number;
  }>;
  return Number(rows[0].id);
}

/** A finished detector run on the version's photo, inserted as the worker would leave it. */
async function insertDetection(
  versionId: string,
  candidates: Array<{ cx: number; cy: number; r: number; confidence: number }>,
): Promise<string> {
  const detectionId = uuidv4();
  await db.execute(sql`
    INSERT INTO spray_wall_detections (id, wall_id, version_id, requested_by, photo_key, photo_width, photo_height,
                                       model_version, weights_sha256, job_id, status, result, finished_at)
    SELECT ${detectionId}, v.wall_id, v.id, ${OWNER}, v.photo_key, 1200, 900, 'test-model', 'sha', ${'job-' + detectionId},
           'done', ${JSON.stringify({ width: 1200, height: 900, candidates })}::jsonb, now()
    FROM spray_wall_versions v WHERE v.id = ${Number(versionId)}
  `);
  return detectionId;
}

type QueueItem = {
  versionId: string;
  holds: Array<{ id: number; cx: number; cy: number; r: number; autoReview: string | null }>;
  candidates: Array<{ index: number; fate: string }>;
  stats: Record<string, number>;
  review: { status: string; reason: string | null };
  unmappableHoldCount: number;
};
type Queue = {
  items: QueueItem[];
  hasMore: boolean;
  totals: { unreviewed: number; approved: number; rejected: number };
};

async function queue(status = 'UNREVIEWED', ctx = ctxFor(ADMIN)): Promise<Queue> {
  return (await sprayTrainingQueries.sprayTrainingQueue({}, { status }, ctx)) as Queue;
}

async function queueVersionIds(status = 'UNREVIEWED'): Promise<string[]> {
  return (await queue(status)).items.map((item) => item.versionId);
}

async function review(versionId: string, status: string, reason?: string) {
  return sprayTrainingMutations.setSprayTrainingReview({}, { input: { versionId, status, reason } }, ctxFor(ADMIN));
}

function exportKeys(): string[] {
  return [...bucket('private').keys()].filter((key) => key.startsWith(SPRAY_TRAINING_EXPORT_PREFIX)).sort();
}

/** The ids of the exports that still have any object in the bucket, oldest first. */
function storedExportIds(): string[] {
  return [...new Set(exportKeys().map((key) => key.slice(SPRAY_TRAINING_EXPORT_PREFIX.length).split('/')[0]))].sort();
}

function readJson<T>(key: string): T {
  const body = bucket('private').get(key);
  if (!body) throw new Error(`no object at ${key}`);
  return JSON.parse(body.toString('utf8')) as T;
}

type Manifest = {
  exportId: string;
  schemaVersion: number;
  images: Array<{ versionId: number; file: string; split: string; rootRef: string }>;
  files: Record<string, string>;
  splits: Record<string, number[]>;
  consentSnapshot: Array<{ rootRef: string; consentAt: string; versionRefs: string[] }>;
  counts: { candidateFates: Record<string, number> };
};

type Coco = {
  images: Array<{ id: number; file_name: string; width: number; height: number; boardsesh: { root_ref: string } }>;
  annotations: Array<{
    image_id: number;
    bbox: [number, number, number, number];
    segmentation: number[][];
    attributes: { source: string; auto_review: string | null; mask_from_circle?: boolean };
  }>;
};

const manifestOf = (exportId: string) => readJson<Manifest>(`${SPRAY_TRAINING_EXPORT_PREFIX}${exportId}/manifest.json`);

const DAY_MS = 24 * 60 * 60 * 1000;
const RUN_1 = new Date('2026-10-07T08:00:00.000Z');
const runAt = (day: number) => new Date(RUN_1.getTime() + day * DAY_MS);

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE TABLE "spray_walls", "user_boards", "board_climbs", "board_climb_holds", "board_climb_stats",
                   "board_layouts", "board_product_sizes", "board_product_sizes_layouts_sets",
                   "board_holes", "board_placements", "community_roles", "feed_items",
                   "sync_daemon_leases"
    RESTART IDENTITY CASCADE
  `);
  await db.execute(sql`ALTER SEQUENCE spray_wall_catalog_id_seq RESTART WITH 1`);
  await db.execute(sql`ALTER SEQUENCE spray_hold_catalog_id_seq RESTART WITH 1`);
  await Promise.all(ALL_USERS.map(insertUser));
  await db.execute(sql`
    INSERT INTO community_roles (user_id, role, board_type, created_at)
    VALUES (${ADMIN}, 'admin', NULL, now()), (${SPRAY_ADMIN}, 'admin', 'spray', now())
  `);
  buckets.clear();
  storedPhotoMetadata.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('training consent on the wall', () => {
  it('is on by default, readable only by the owner, and owner-only to change', async () => {
    const { wall } = await createPublishedWall({ isPublic: true });

    const asOwner = (await sprayWallQueries.sprayWall({}, { uuid: wall.uuid }, ctxFor(OWNER))) as {
      trainingConsent: boolean | null;
    };
    const asStranger = (await sprayWallQueries.sprayWall({}, { uuid: wall.uuid }, ctxFor(STRANGER))) as {
      trainingConsent: boolean | null;
    };
    expect(asOwner.trainingConsent).toBe(true);
    expect(asStranger.trainingConsent).toBeNull();

    // A community admin may edit a public wall's holds, but not decide this.
    await expect(
      sprayWallMutations.updateSprayWall({}, { input: { uuid: wall.uuid, trainingConsent: false } }, ctxFor(ADMIN)),
    ).rejects.toMatchObject({ extensions: { code: 'SPRAY_WALL_VISIBILITY_OWNER_ONLY' } });

    expect((await setTrainingConsent(wall, false)).trainingConsent).toBe(false);
    expect((await wallRowOf(wall)).training_consent_at).toBeNull();

    expect((await setTrainingConsent(wall, true)).trainingConsent).toBe(true);
  });

  it('starts off when the climber switched it off at creation', async () => {
    const wall = await createWall({ trainingConsent: false });
    expect((await wallRowOf(wall)).training_consent_at).toBeNull();
  });
});

/**
 * A reset clones the wall, so one physical wall is several rows linked by
 * `reset_from_wall_id`. "No" on any of them is "no" for the wall.
 */
describe('training consent across a reset', () => {
  it('switches the archived source off with its live clone, and leaves its other columns alone', async () => {
    const source = await createPublishedWall();
    const clone = await startReset(source.wall);
    await publishFirstVersion(clone);
    const archivedSource = await wallRowOf(source.wall);
    // The clone's publish archived the source, and the source is still consented.
    expect(archivedSource.archived_at).not.toBeNull();
    expect(archivedSource.training_consent_at).not.toBeNull();
    // An unrelated wall of the same owner, which the switch must not reach.
    const unrelated = await createPublishedWall();

    await setTrainingConsent(clone, false);

    expect((await wallRowOf(clone)).training_consent_at).toBeNull();
    const revokedSource = await wallRowOf(source.wall);
    expect(revokedSource.training_consent_at).toBeNull();
    // Only the stamp moved: `updated_at` is what devices and the photo purge
    // read, and nothing about the archived wall they read has changed.
    expect(revokedSource.updated_at).toBe(archivedSource.updated_at);
    expect((await wallRowOf(unrelated.wall)).training_consent_at).not.toBeNull();
    expect(await queueVersionIds()).toEqual([unrelated.versionId]);
  });

  it('switches an unfinished reset clone off with the live wall it was cloned from', async () => {
    const source = await createPublishedWall();
    const clone = await startReset(source.wall);
    // The clone copied the source's "on" when the reset started.
    expect((await wallRowOf(clone)).training_consent_at).not.toBeNull();

    await setTrainingConsent(source.wall, false);

    expect((await wallRowOf(clone)).training_consent_at).toBeNull();
    // The reset finishes: the new photo was never consented, so it is not queued.
    await publishFirstVersion(clone);
    expect(await queueVersionIds()).toEqual([]);
  });

  it('switches back on for the one wall it names, never for the archived source', async () => {
    const source = await createPublishedWall();
    const clone = await startReset(source.wall);
    const cloneVersionId = await publishFirstVersion(clone);
    await setTrainingConsent(clone, false);

    await setTrainingConsent(clone, true);

    expect((await wallRowOf(clone)).training_consent_at).not.toBeNull();
    expect((await wallRowOf(source.wall)).training_consent_at).toBeNull();
    // The old photo stays out; only the wall that was switched on comes back.
    expect(await queueVersionIds()).toEqual([cloneVersionId]);
  });
});

describe('hold provenance on upsert', () => {
  it('validates origins, never downgrades, and marks a nudged auto hold edited even from an old app', async () => {
    const wall = await createWall();
    const versionId = await createDraft(wall);
    const detectionId = await insertDetection(versionId, [
      { cx: 10, cy: 10, r: 5, confidence: 0.9 },
      { cx: 20, cy: 20, r: 5, confidence: 0.8 },
    ]);

    // Another wall's run: a real, finished detection that is not this wall's.
    const otherWall = await createWall();
    const otherVersionId = await createDraft(otherWall);
    const foreignDetectionId = await insertDetection(otherVersionId, [{ cx: 1, cy: 1, r: 1, confidence: 0.9 }]);

    const [accepted, foreign, outOfRange, manual] = await upsertHolds(wall, versionId, [
      {
        cx: 100,
        cy: 100,
        r: 20,
        source: 'AUTO',
        confidence: 0.9,
        autoReview: 'ACCEPTED',
        originDetectionId: detectionId,
        originCandidateIndex: 0,
      },
      {
        cx: 200,
        cy: 200,
        r: 20,
        source: 'AUTO',
        confidence: 0.9,
        autoReview: 'CONFIRMED',
        originDetectionId: foreignDetectionId,
        originCandidateIndex: 0,
      },
      {
        cx: 300,
        cy: 300,
        r: 20,
        source: 'AUTO',
        confidence: 0.9,
        originDetectionId: detectionId,
        originCandidateIndex: 7,
      },
      {
        cx: 400,
        cy: 400,
        r: 20,
        source: 'MANUAL',
        autoReview: 'EDITED',
        originDetectionId: detectionId,
        originCandidateIndex: 1,
      },
    ]);

    expect(accepted).toMatchObject({ autoReview: 'ACCEPTED', originDetectionId: detectionId, originCandidateIndex: 0 });
    // A foreign run and an out-of-range index are dropped, not a failed save.
    expect(foreign).toMatchObject({ autoReview: 'CONFIRMED', originDetectionId: null, originCandidateIndex: null });
    expect(outOfRange).toMatchObject({ originDetectionId: null, originCandidateIndex: null });
    // A hand-drawn hold carries no provenance whatever the client sent.
    expect(manual).toMatchObject({ autoReview: null, originDetectionId: null, originCandidateIndex: null });

    // An app that predates provenance re-saves the accepted hold untouched apart
    // from rounding: nothing changes.
    const [resaved] = await upsertHolds(wall, versionId, [
      { id: accepted.id, cx: 101, cy: 100, r: 20, source: 'AUTO', confidence: 0.9 },
    ]);
    expect(resaved).toMatchObject({ autoReview: 'ACCEPTED', originDetectionId: detectionId, originCandidateIndex: 0 });

    // The same old app nudges it: the server records the correction itself and
    // keeps the origin it never sent.
    const [nudged] = await upsertHolds(wall, versionId, [
      { id: accepted.id, cx: 140, cy: 100, r: 20, source: 'AUTO', confidence: 0.9 },
    ]);
    expect(nudged).toMatchObject({ autoReview: 'EDITED', originDetectionId: detectionId, originCandidateIndex: 0 });

    // Never downgraded by a later, weaker claim.
    const [stillEdited] = await upsertHolds(wall, versionId, [
      { id: accepted.id, cx: 140, cy: 100, r: 20, source: 'AUTO', confidence: 0.9, autoReview: 'ACCEPTED' },
    ]);
    expect(stillEdited.autoReview).toBe('EDITED');

    // Turning it into a manual hold clears everything.
    const [cleared] = await upsertHolds(wall, versionId, [
      { id: accepted.id, cx: 140, cy: 100, r: 20, source: 'MANUAL' },
    ]);
    expect(cleared).toMatchObject({ autoReview: null, originDetectionId: null, originCandidateIndex: null });
  });
});

describe('hold provenance edge cases', () => {
  it('clears provenance on an explicit null, and inherits it on a moved hold', async () => {
    const wall = await createWall();
    const versionId = await createDraft(wall);
    const detectionId = await insertDetection(versionId, [
      { cx: 10, cy: 10, r: 5, confidence: 0.9 },
      { cx: 20, cy: 20, r: 5, confidence: 0.9 },
    ]);
    const [cleared, moved] = await upsertHolds(wall, versionId, [
      {
        cx: 100,
        cy: 100,
        r: 20,
        source: 'AUTO',
        confidence: 0.9,
        autoReview: 'ACCEPTED',
        originDetectionId: detectionId,
        originCandidateIndex: 0,
      },
      {
        cx: 300,
        cy: 300,
        r: 20,
        source: 'AUTO',
        confidence: 0.9,
        autoReview: 'ACCEPTED',
        originDetectionId: detectionId,
        originCandidateIndex: 1,
      },
    ]);

    // The editor merged it: it says outright the result came from no suggestion.
    const [merged] = await upsertHolds(wall, versionId, [
      {
        id: cleared.id,
        cx: 120,
        cy: 100,
        r: 25,
        source: 'AUTO',
        confidence: 0.9,
        autoReview: null,
        originDetectionId: null,
        originCandidateIndex: null,
      },
    ]);
    expect(merged).toMatchObject({ autoReview: null, originDetectionId: null, originCandidateIndex: null });

    // A new hold that moved from an auto hold, with a new shape and no provenance
    // of its own: it carries its predecessor's origin, as a correction.
    const [successor] = await upsertHolds(wall, versionId, [
      { cx: 360, cy: 300, r: 20, source: 'AUTO', confidence: 0.9, movedFromHoldId: moved.id },
    ]);
    expect(successor).toMatchObject({ autoReview: 'EDITED', originDetectionId: detectionId, originCandidateIndex: 1 });
  });

  it('refuses an origin from another photo of the same wall', async () => {
    const wall = await createWall();
    const versionId = await createDraft(wall);
    const detectionId = await insertDetection(versionId, [{ cx: 10, cy: 10, r: 5, confidence: 0.9 }]);
    await db.execute(
      sql`UPDATE spray_wall_detections SET photo_key = 'some-other-photo.jpg' WHERE id = ${detectionId}`,
    );
    const [hold] = await upsertHolds(wall, versionId, [
      {
        cx: 100,
        cy: 100,
        r: 20,
        source: 'AUTO',
        confidence: 0.9,
        originDetectionId: detectionId,
        originCandidateIndex: 0,
      },
    ]);
    expect(hold).toMatchObject({ originDetectionId: null, originCandidateIndex: null });
  });
});

describe('the user data export', () => {
  it('lists each owned spray wall with its training consent stamp', async () => {
    const consenting = await createWall();
    const declining = await createWall({ trainingConsent: false });
    const archive = await buildUserDataArchive(db, OWNER, 'spray', '2026-W40');
    const byUuid = new Map((archive.sprayWalls ?? []).map((wall) => [wall.uuid, wall]));
    expect(byUuid.get(consenting.uuid)?.trainingConsentAt).toEqual(expect.any(String));
    expect(byUuid.get(declining.uuid)?.trainingConsentAt).toBeNull();
  });
});

describe('eligibility', () => {
  it('lists a consented, published wall and keeps an archived one', async () => {
    const { versionId } = await createPublishedWall();
    expect(await queueVersionIds()).toEqual([versionId]);

    await db.execute(sql`UPDATE spray_walls SET archived_at = now()`);
    expect(await queueVersionIds()).toEqual([versionId]);
  });

  it('leaves out a wall whose owner switched consent off', async () => {
    await createPublishedWall({ trainingConsent: false });
    expect(await queueVersionIds()).toEqual([]);
  });

  it('leaves out a draft', async () => {
    const wall = await createWall();
    const versionId = await createDraft(wall);
    await upsertHolds(wall, versionId, DEFAULT_HOLDS);
    expect(await queueVersionIds()).toEqual([]);
  });

  it('leaves out a version whose photo was purged', async () => {
    await createPublishedWall();
    await db.execute(sql`UPDATE spray_wall_versions SET photo_key = NULL`);
    expect(await queueVersionIds()).toEqual([]);
  });

  it('leaves out a deleted wall and a deleted board', async () => {
    const { wall } = await createPublishedWall();
    const { wall: other } = await createPublishedWall();
    await db.execute(sql`UPDATE spray_walls SET deleted_at = now() WHERE board_uuid = ${wall.uuid}`);
    await db.execute(sql`UPDATE user_boards SET deleted_at = now() WHERE uuid = ${other.uuid}`);
    expect(await queueVersionIds()).toEqual([]);
  });

  it('leaves out an admin-hidden wall', async () => {
    await createPublishedWall();
    await db.execute(sql`UPDATE spray_walls SET hidden_at = now()`);
    expect(await queueVersionIds()).toEqual([]);
  });

  it('leaves out a system-owned wall', async () => {
    const { wall } = await createPublishedWall();
    await insertUser(SYSTEM_BOARD_OWNER_ID);
    await db.execute(sql`UPDATE user_boards SET owner_id = ${SYSTEM_BOARD_OWNER_ID} WHERE uuid = ${wall.uuid}`);
    expect(await queueVersionIds()).toEqual([]);
  });

  it('keeps only the newest published version of one photo', async () => {
    const { wall, versionId } = await createPublishedWall();
    // A hold edit: a new version that reuses the published photo.
    const edit = (await sprayWallMutations.createSprayWallVersion(
      {},
      { input: { wallUuid: wall.uuid, sourceVersionId: versionId } },
      ctxFor(OWNER),
    )) as { id: string };
    await upsertHolds(wall, edit.id, [{ cx: 700, cy: 700, r: 20 }]);
    await publish(edit.id);

    expect(await queueVersionIds()).toEqual([edit.id]);
  });
});

describe('the vetting queue', () => {
  it('refuses a climber who is not a spray admin, and serves a spray-scoped one', async () => {
    await createPublishedWall();
    await expect(queue('UNREVIEWED', ctxFor(STRANGER))).rejects.toThrow('Admin role required');
    expect((await queue('UNREVIEWED', ctxFor(SPRAY_ADMIN))).items).toHaveLength(1);
    await expect(
      sprayTrainingMutations.setSprayTrainingReview(
        {},
        { input: { versionId: '1', status: 'APPROVED' } },
        ctxFor(STRANGER),
      ),
    ).rejects.toThrow('Admin role required');
  });

  it('moves a version between tabs and refuses a rejection with no reason', async () => {
    const { versionId } = await createPublishedWall();

    await expect(review(versionId, 'REJECTED')).rejects.toThrow();
    await review(versionId, 'REJECTED', 'PHOTO_QUALITY');
    const rejected = await queue('REJECTED');
    expect(rejected.items.map((item) => item.review)).toEqual([
      expect.objectContaining({ status: 'REJECTED', reason: 'PHOTO_QUALITY' }),
    ]);
    expect(rejected.totals).toEqual({ unreviewed: 0, approved: 0, rejected: 1 });

    await review(versionId, 'APPROVED');
    expect(await queueVersionIds('APPROVED')).toEqual([versionId]);

    await review(versionId, 'UNREVIEWED');
    expect(await queueVersionIds('UNREVIEWED')).toEqual([versionId]);
    const rows = (await db.execute(
      sql`SELECT count(*)::int AS n FROM spray_wall_training_reviews`,
    )) as unknown as Array<{
      n: number;
    }>;
    expect(rows[0].n).toBe(0);
  });

  it('refuses to review a version that is not eligible', async () => {
    const { versionId } = await createPublishedWall({ trainingConsent: false });
    await expect(review(versionId, 'APPROVED')).rejects.toMatchObject({
      extensions: { code: 'SPRAY_TRAINING_NOT_ELIGIBLE' },
    });
  });

  it('projects holds onto the photo through a non-identity homography', async () => {
    const { versionId } = await createPublishedWall();
    const [version] = (await db.execute(
      sql`SELECT homography FROM spray_wall_versions WHERE id = ${Number(versionId)}`,
    )) as unknown as Array<{ homography: number[] }>;
    const isIdentity = version.homography.every((value, index) => value === [1, 0, 0, 0, 1, 0, 0, 0, 1][index]);
    expect(isIdentity).toBe(false);

    const [item] = (await queue()).items;
    expect(item.holds).toHaveLength(DEFAULT_HOLDS.length);
    expect(item.unmappableHoldCount).toBe(0);
    for (const [index, hold] of item.holds.entries()) {
      // Photo pixels pushed back through photo→canonical land on the stored hold.
      const [canonicalX, canonicalY] = mapPoint(version.homography, hold.cx, hold.cy);
      expect(canonicalX).toBeCloseTo(DEFAULT_HOLDS[index].cx, 4);
      expect(canonicalY).toBeCloseTo(DEFAULT_HOLDS[index].cy, 4);
    }
  });

  it('reads each suggestion fate back', async () => {
    const wall = await createWall();
    const versionId = await createDraft(wall);
    const detectionId = await insertDetection(versionId, [
      { cx: 10, cy: 10, r: 5, confidence: 0.9 }, // kept
      { cx: 20, cy: 20, r: 5, confidence: 0.8 }, // edited
      { cx: 30, cy: 30, r: 5, confidence: 0.85 }, // shown, then dropped
      { cx: 40, cy: 40, r: 5, confidence: 0.3 }, // under the editor's floor
    ]);
    await upsertHolds(wall, versionId, [
      {
        cx: 100,
        cy: 100,
        r: 20,
        source: 'AUTO',
        confidence: 0.9,
        autoReview: 'ACCEPTED',
        originDetectionId: detectionId,
        originCandidateIndex: 0,
      },
      {
        cx: 200,
        cy: 200,
        r: 20,
        source: 'AUTO',
        confidence: 0.8,
        autoReview: 'EDITED',
        originDetectionId: detectionId,
        originCandidateIndex: 1,
      },
      { cx: 300, cy: 300, r: 20 },
    ]);
    await publish(versionId);

    const [item] = (await queue()).items;
    expect(item.candidates.map((candidate) => candidate.fate)).toEqual(['KEPT', 'EDITED', 'DELETED', 'NOT_SHOWN']);
    expect(item.stats).toMatchObject({
      holdCount: 3,
      manualHoldCount: 1,
      autoHoldCount: 2,
      acceptedHoldCount: 1,
      editedHoldCount: 1,
      deletedCandidateCount: 1,
      notShownCandidateCount: 1,
    });
  });

  it('says UNKNOWN when no hold records where it came from', async () => {
    const wall = await createWall();
    const versionId = await createDraft(wall);
    await insertDetection(versionId, [
      { cx: 10, cy: 10, r: 5, confidence: 0.9 },
      { cx: 40, cy: 40, r: 5, confidence: 0.3 },
    ]);
    // An app that predates provenance: auto holds, no origin.
    await upsertHolds(wall, versionId, [{ cx: 100, cy: 100, r: 20, source: 'AUTO', confidence: 0.9 }]);
    await publish(versionId);

    const [item] = (await queue()).items;
    expect(item.candidates.map((candidate) => candidate.fate)).toEqual(['UNKNOWN', 'NOT_SHOWN']);
  });
});

describe('the export', () => {
  it('never exports a wall without consent, even with an approved review row', async () => {
    const { versionId } = await createPublishedWall({ trainingConsent: false });
    await db.execute(sql`
      INSERT INTO spray_wall_training_reviews (version_id, status, reviewed_by) VALUES (${Number(versionId)}, 'approved', ${ADMIN})
    `);

    const result = await exportSprayTrainingDataset({ now: RUN_1 });
    expect(result).toMatchObject({ exportId: null, imagesWritten: 0, skipped: true });
    expect(exportKeys()).toEqual([]);
  });

  it('writes images, COCO labels in photo pixels, candidates and a manifest listing every file', async () => {
    const { versionId } = await createPublishedWall();
    await review(versionId, 'APPROVED');

    const result = await exportSprayTrainingDataset({ now: RUN_1 });
    expect(result).toMatchObject({ imagesWritten: 1, skipped: false, exportsRetired: 0 });
    const exportId = result.exportId!;
    expect(exportId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

    const manifest = manifestOf(exportId);
    expect(manifest.exportId).toBe(exportId);
    expect(manifest.schemaVersion).toBe(1);
    const [image] = manifest.images;
    expect(image.file).toBe(`${image.split}/v${versionId}.jpg`);

    // Every file but the manifest is listed with its sha256, and nothing else is.
    const prefix = `${SPRAY_TRAINING_EXPORT_PREFIX}${exportId}/`;
    const written = exportKeys()
      .map((key) => key.slice(prefix.length))
      .filter((path) => path !== 'manifest.json');
    expect(Object.keys(manifest.files).sort()).toEqual(written.sort());
    for (const sha of Object.values(manifest.files)) expect(sha).toMatch(/^[0-9a-f]{64}$/);
    // Every split carries an annotations file, even an empty one.
    expect(written).toEqual(
      expect.arrayContaining([
        'train/_annotations.coco.json',
        'valid/_annotations.coco.json',
        'eval/_annotations.coco.json',
      ]),
    );

    const coco = readJson<Coco>(`${prefix}${image.split}/_annotations.coco.json`);
    expect(coco.images).toEqual([
      expect.objectContaining({ file_name: `v${versionId}.jpg`, width: 1200, height: 900 }),
    ]);
    expect(coco.annotations).toHaveLength(DEFAULT_HOLDS.length);
    // The two circle-only holds get a 24-point polygon tagged as such; the traced
    // one keeps its own ring and carries no tag.
    const circles = coco.annotations.filter((annotation) => annotation.attributes.mask_from_circle === true);
    expect(circles).toHaveLength(2);
    for (const circle of circles) expect(circle.segmentation[0]).toHaveLength(48);
    const traced = coco.annotations.find((annotation) => annotation.attributes.mask_from_circle === undefined)!;
    expect(traced.segmentation[0]).toHaveLength(8);

    // The bbox is in PHOTO pixels: the projected hold, not the canonical one.
    const [queued] = (await queue('APPROVED')).items;
    const firstHold = queued.holds[0];
    const [x, y, width, height] = coco.annotations[0].bbox;
    expect(x + width / 2).toBeCloseTo(firstHold.cx, 0);
    expect(y + height / 2).toBeCloseTo(firstHold.cy, 0);

    expect(readJson<{ images: unknown[] }>(`${prefix}candidates.json`).images).toHaveLength(1);
  });

  it('retires the export holding a wall whose owner switched consent off, and leaves it out of the next', async () => {
    const leaving = await createPublishedWall();
    const staying = await createPublishedWall();
    await review(leaving.versionId, 'APPROVED');
    await review(staying.versionId, 'APPROVED');

    const first = await exportSprayTrainingDataset({ now: RUN_1 });
    expect(first.imagesWritten).toBe(2);

    await setTrainingConsent(leaving.wall, false);
    // Out of the queue at once, approval or not.
    expect(await queueVersionIds('APPROVED')).toEqual([staying.versionId]);

    const second = await exportSprayTrainingDataset({ now: runAt(1) });
    expect(second).toMatchObject({ imagesWritten: 1, exportsRetired: 1, skipped: false });
    expect(exportKeys().some((key) => key.startsWith(`${SPRAY_TRAINING_EXPORT_PREFIX}${first.exportId}/`))).toBe(false);
    expect(manifestOf(second.exportId!).images.map((image) => String(image.versionId))).toEqual([staying.versionId]);
    expect(exportKeys().some((key) => key.includes(`/v${leaving.versionId}.jpg`))).toBe(false);

    // Nothing changed since: the next run writes nothing.
    expect(await exportSprayTrainingDataset({ now: runAt(2) })).toMatchObject({ exportId: null, skipped: true });
  });

  it('retires the export holding an archived wall whose owner switched consent off on its reset clone', async () => {
    const source = await createPublishedWall();
    const clone = await startReset(source.wall);
    const cloneVersionId = await publishFirstVersion(clone);
    const staying = await createPublishedWall();
    for (const versionId of [source.versionId, cloneVersionId, staying.versionId]) await review(versionId, 'APPROVED');

    const first = await exportSprayTrainingDataset({ now: RUN_1 });
    // The archived source's old photo is in the stored export, beside the clone's.
    expect(manifestOf(first.exportId!).images.map((image) => String(image.versionId))).toEqual([
      source.versionId,
      cloneVersionId,
      staying.versionId,
    ]);

    // The owner says no on the wall they can still see: the live clone.
    await setTrainingConsent(clone, false);
    expect(await queueVersionIds('APPROVED')).toEqual([staying.versionId]);

    const second = await exportSprayTrainingDataset({ now: runAt(1) });
    expect(second).toMatchObject({ imagesWritten: 1, exportsRetired: 1, skipped: false });
    expect(storedExportIds()).toEqual([second.exportId]);
    expect(manifestOf(second.exportId!).images.map((image) => String(image.versionId))).toEqual([staying.versionId]);
    for (const versionId of [source.versionId, cloneVersionId]) {
      expect(exportKeys().some((key) => key.includes(`/v${versionId}.jpg`))).toBe(false);
    }
  });

  it('deletes every stale manifest before any other object, so a failed delete leaves no stale export readable', async () => {
    const leaving = await createPublishedWall();
    const staying = await createPublishedWall();
    await review(leaving.versionId, 'APPROVED');
    await review(staying.versionId, 'APPROVED');
    const first = await exportSprayTrainingDataset({ now: RUN_1 });
    // A second stored export that also holds the leaving wall.
    const later = await createPublishedWall();
    await review(later.versionId, 'APPROVED');
    const second = await exportSprayTrainingDataset({ now: runAt(1) });
    expect(storedExportIds()).toEqual([first.exportId, second.exportId]);

    await setTrainingConsent(leaving.wall, false);

    // Storage starts failing on the first object that is not a manifest.
    const deleteMock = vi.mocked(deleteFromS3);
    const workingDelete = deleteMock.getMockImplementation()!;
    deleteMock.mockImplementation(async (bucketName, key) => {
      if (!key.endsWith('/manifest.json')) throw new Error('storage unavailable');
      await workingDelete(bucketName, key);
    });
    try {
      await expect(exportSprayTrainingDataset({ now: runAt(2) })).rejects.toThrow('storage unavailable');
    } finally {
      deleteMock.mockImplementation(workingDelete);
    }

    // Both stale exports still have their photos, and NEITHER has a manifest. The
    // ML fetch reads the newest export that has one: deleting the newer export
    // whole first would have left the older one, leaving wall and all, as that.
    expect(storedExportIds()).toEqual([first.exportId, second.exportId]);
    expect(exportKeys().filter((key) => key.endsWith('/manifest.json'))).toEqual([]);

    // Storage is back: the next run finishes the job and writes a clean export.
    const third = await exportSprayTrainingDataset({ now: runAt(3) });
    expect(third).toMatchObject({ imagesWritten: 2, exportsRetired: 2, skipped: false });
    expect(storedExportIds()).toEqual([third.exportId]);
    expect(manifestOf(third.exportId!).images.map((image) => String(image.versionId))).toEqual([
      staying.versionId,
      later.versionId,
    ]);
  });

  it('keeps only the newest two exports', async () => {
    const exportIds: string[] = [];
    for (let day = 0; day < 3; day++) {
      const { versionId } = await createPublishedWall();
      await review(versionId, 'APPROVED');
      exportIds.push((await exportSprayTrainingDataset({ now: runAt(day) })).exportId!);
    }
    expect(storedExportIds()).toEqual(exportIds.slice(1).sort());
  });

  it('freezes the split across runs and shares it with reset clones', async () => {
    const source = await createPublishedWall();
    const clone = await startReset(source.wall);
    const cloneVersionId = await publishFirstVersion(clone);
    // The clone's publish archived the source, which stays eligible.
    await review(source.versionId, 'APPROVED');
    await review(cloneVersionId, 'APPROVED');

    const expectedSplit = trainingSplitForRoot(source.wall.uuid);
    const expectedRoot = trainingRef('root', source.wall.uuid);

    const first = manifestOf((await exportSprayTrainingDataset({ now: RUN_1 })).exportId!);
    expect(first.images.map((image) => [String(image.versionId), image.split, image.rootRef])).toEqual([
      [source.versionId, expectedSplit, expectedRoot],
      [cloneVersionId, expectedSplit, expectedRoot],
    ]);
    const coco = readJson<Coco>(
      `${SPRAY_TRAINING_EXPORT_PREFIX}${first.exportId}/${expectedSplit}/_annotations.coco.json`,
    );
    expect(coco.images.map((image) => image.boardsesh.root_ref)).toEqual([expectedRoot, expectedRoot]);

    // A second run with something else changed: the same versions, the same split.
    const other = await createPublishedWall();
    await review(other.versionId, 'APPROVED');
    const second = manifestOf((await exportSprayTrainingDataset({ now: runAt(1) })).exportId!);
    for (const versionId of [source.versionId, cloneVersionId]) {
      expect(second.images.find((image) => String(image.versionId) === versionId)?.split).toBe(expectedSplit);
    }
    expect(await wallIdOf(clone)).not.toBe(await wallIdOf(source.wall));

    // A root's refs appear in exactly one split.
    const rootsBySplit = new Map<string, Set<string>>();
    for (const split of ['train', 'valid', 'eval']) {
      const splitCoco = readJson<Coco>(
        `${SPRAY_TRAINING_EXPORT_PREFIX}${second.exportId}/${split}/_annotations.coco.json`,
      );
      rootsBySplit.set(split, new Set(splitCoco.images.map((image) => image.boardsesh.root_ref)));
    }
    const allRoots = [...rootsBySplit.values()].flatMap((roots) => [...roots]);
    expect(new Set(allRoots).size).toBe(allRoots.length);
  });

  it('follows a reset chain deeper than fifty walls, to the root for the split and to every wall for a revoke', async () => {
    // Fifty-five ancestors linked by hand. Each is archived as it is made: a
    // climber owns at most ten live walls, and a reset archives its source anyway.
    const ANCESTOR_COUNT = 55;
    let rootUuid = '';
    let parentWallId: number | null = null;
    for (let generation = 0; generation < ANCESTOR_COUNT; generation++) {
      const ancestor = await createWall();
      if (generation === 0) rootUuid = ancestor.uuid;
      await db.execute(sql`
        UPDATE spray_walls SET archived_at = now(), reset_from_wall_id = ${parentWallId}
        WHERE board_uuid = ${ancestor.uuid}
      `);
      parentWallId = await wallIdOf(ancestor);
    }
    const newest = await createPublishedWall();
    await db.execute(
      sql`UPDATE spray_walls SET reset_from_wall_id = ${parentWallId} WHERE board_uuid = ${newest.wall.uuid}`,
    );
    await review(newest.versionId, 'APPROVED');

    // The split comes from the ROOT, all fifty-five resets up. A walk that gave
    // up part-way would name some wall in the middle, and hash to its split.
    const manifest = manifestOf((await exportSprayTrainingDataset({ now: RUN_1 })).exportId!);
    expect(manifest.images.map((image) => [image.split, image.rootRef])).toEqual([
      [trainingSplitForRoot(rootUuid), trainingRef('root', rootUuid)],
    ]);

    // And "no" on the newest wall reaches the oldest.
    await setTrainingConsent(newest.wall, false);
    const [stillConsented] = (await db.execute(
      sql`SELECT count(*)::int AS walls FROM spray_walls WHERE training_consent_at IS NOT NULL`,
    )) as unknown as Array<{ walls: number }>;
    expect(stillConsented.walls).toBe(0);
  });

  it('answers LOCKED and writes nothing while another run holds the lease', async () => {
    const { versionId } = await createPublishedWall();
    await review(versionId, 'APPROVED');
    // A live run elsewhere: a fresh lease row this process does not own.
    await db.execute(sql`
      INSERT INTO sync_daemon_leases (daemon_name, holder_id, acquired_at, heartbeat_at)
      VALUES (${SPRAY_TRAINING_EXPORT_LEASE}, 'another-run', now(), now())
    `);

    expect(await exportSprayTrainingDataset({ now: RUN_1 })).toMatchObject({
      exportId: null,
      skipped: true,
      skippedReason: 'LOCKED',
    });
    expect(exportKeys()).toEqual([]);

    // The other run finishes and releases: the next run writes, and releases too.
    await db.execute(sql`DELETE FROM sync_daemon_leases`);
    expect(await exportSprayTrainingDataset({ now: runAt(1) })).toMatchObject({ skipped: false, skippedReason: null });
    const leases = (await db.execute(sql`SELECT count(*)::int AS n FROM sync_daemon_leases`)) as unknown as Array<{
      n: number;
    }>;
    expect(leases[0].n).toBe(0);
  });

  it('takes over a lease whose holder died more than its TTL ago', async () => {
    const { versionId } = await createPublishedWall();
    await review(versionId, 'APPROVED');
    await db.execute(sql`
      INSERT INTO sync_daemon_leases (daemon_name, holder_id, acquired_at, heartbeat_at)
      VALUES (${SPRAY_TRAINING_EXPORT_LEASE}, 'crashed-run', now() - interval '1 hour', now() - interval '1 hour')
    `);
    expect(await exportSprayTrainingDataset({ now: RUN_1 })).toMatchObject({ skipped: false });
  });

  it('stops at its deadline without writing a manifest', async () => {
    const { versionId } = await createPublishedWall();
    await review(versionId, 'APPROVED');
    await expect(exportSprayTrainingDataset({ now: RUN_1, deadlineMs: -1 })).rejects.toThrow('deadline');
    expect(exportKeys().some((key) => key.endsWith('manifest.json'))).toBe(false);
    // And the lease was released, so the next run is not blocked.
    expect(await exportSprayTrainingDataset({ now: runAt(1) })).toMatchObject({ skipped: false });
  });

  it('retires a stored export with no manifest or a corrupt one', async () => {
    const { versionId } = await createPublishedWall();
    await review(versionId, 'APPROVED');
    bucket('private').set(`${SPRAY_TRAINING_EXPORT_PREFIX}2020-01-01T00-00-00-000Z/train/v1.jpg`, Buffer.from('x'));
    bucket('private').set(`${SPRAY_TRAINING_EXPORT_PREFIX}2020-01-02T00-00-00-000Z/train/v1.jpg`, Buffer.from('x'));
    bucket('private').set(
      `${SPRAY_TRAINING_EXPORT_PREFIX}2020-01-02T00-00-00-000Z/manifest.json`,
      Buffer.from('{not json'),
    );

    const result = await exportSprayTrainingDataset({ now: RUN_1 });
    expect(result).toMatchObject({ exportsRetired: 2, skipped: false });
    expect(exportKeys().some((key) => key.includes('2020-01-0'))).toBe(false);
  });

  it.each([
    ['deleted', (wall: CreatedWall) => sprayWallMutations.deleteSprayWall({}, { uuid: wall.uuid }, ctxFor(OWNER))],
    [
      'hidden',
      (wall: CreatedWall) => db.execute(sql`UPDATE spray_walls SET hidden_at = now() WHERE board_uuid = ${wall.uuid}`),
    ],
  ])('retires the export holding a wall that was %s', async (_label, act) => {
    const leaving = await createPublishedWall();
    const staying = await createPublishedWall();
    await review(leaving.versionId, 'APPROVED');
    await review(staying.versionId, 'APPROVED');
    const first = await exportSprayTrainingDataset({ now: RUN_1 });

    await act(leaving.wall);

    const second = await exportSprayTrainingDataset({ now: runAt(1) });
    expect(second).toMatchObject({ imagesWritten: 1, exportsRetired: 1 });
    expect(exportKeys().some((key) => key.includes(`/${first.exportId}/`))).toBe(false);
    expect(manifestOf(second.exportId!).images.map((image) => String(image.versionId))).toEqual([staying.versionId]);
  });

  it('retires the export holding a version an admin un-approved', async () => {
    const leaving = await createPublishedWall();
    const staying = await createPublishedWall();
    await review(leaving.versionId, 'APPROVED');
    await review(staying.versionId, 'APPROVED');
    const first = await exportSprayTrainingDataset({ now: RUN_1 });

    await review(leaving.versionId, 'REJECTED', 'BAD_HOLDS');

    const second = await exportSprayTrainingDataset({ now: runAt(1) });
    expect(second).toMatchObject({ imagesWritten: 1, exportsRetired: 1 });
    expect(exportKeys().some((key) => key.includes(`/${first.exportId}/`))).toBe(false);
  });

  it('leaves out a version whose holds do not project onto the photo, and the queue says why', async () => {
    const broken = await createPublishedWall();
    const fine = await createPublishedWall();
    // A singular homography: nothing projects.
    await db.execute(sql`
      UPDATE spray_wall_versions SET homography = '[0,0,0,0,0,0,0,0,0]'::jsonb WHERE id = ${Number(broken.versionId)}
    `);
    const queued = (await queue()).items.find((item) => item.versionId === broken.versionId)!;
    expect(queued.unmappableHoldCount).toBe(DEFAULT_HOLDS.length);
    expect(queued.holds).toEqual([]);

    await review(broken.versionId, 'APPROVED');
    await review(fine.versionId, 'APPROVED');
    const result = await exportSprayTrainingDataset({ now: RUN_1 });
    expect(result).toMatchObject({ imagesWritten: 1, versionsSkipped: 1 });
    const manifest = manifestOf(result.exportId!) as Manifest & {
      counts: { skippedVersions: { unmappableHolds: number } };
    };
    expect(manifest.images.map((image) => String(image.versionId))).toEqual([fine.versionId]);
    expect(manifest.counts.skippedVersions.unmappableHolds).toBe(1);
  });
});
