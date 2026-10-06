import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import postgres from 'postgres';
import sharp from 'sharp';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import type { DbInstance } from '@boardsesh/db/client';
import { BACKGROUND_JOB_QUEUES } from '@boardsesh/db/background-jobs';
import { backgroundJobRuns, sprayWallVersions } from '@boardsesh/db/schema';
import { ART_RECIPE, canonicalArtSize } from '@boardsesh/spray-wall-geometry';

/**
 * The `spray-wall-art` family end to end: a publish queues the job in its own
 * transaction, and the job renders under exactly the maintenance worker's
 * grants, with real sharp and an in-memory bucket.
 */

type StoredObject = { body: Buffer; contentType: string; cacheControl?: string; metadata?: Record<string, string> };

const queueState = vi.hoisted(() => ({ boss: null as PgBoss | null }));
const objects = vi.hoisted(() => new Map<string, StoredObject>());

vi.mock('../services/job-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/job-queue')>()),
  getJobQueue: () => queueState.boss,
}));
vi.mock('../storage/s3', () => ({
  isS3Configured: () => true,
  getS3ObjectMetadata: async (_bucket: string, key: string) => {
    const object = objects.get(key);
    return object
      ? {
          contentType: object.contentType,
          contentLength: object.body.length,
          lastModified: new Date(),
          metadata: object.metadata,
        }
      : null;
  },
  getS3ObjectMetadataStrict: async () => null,
  getFromS3Strict: async (_bucket: string, key: string) => {
    const object = objects.get(key);
    return object
      ? { stream: Readable.from([object.body]), contentType: object.contentType, contentLength: object.body.length }
      : null;
  },
  uploadToS3: async (
    _bucket: string,
    body: Buffer,
    key: string,
    contentType: string,
    options: { cacheControl?: string; metadata?: Record<string, string> },
  ) => {
    objects.set(key, { body, contentType, cacheControl: options.cacheControl, metadata: options.metadata });
    return { key };
  },
  presignGetObject: async (_bucket: string, key: string) => ({
    url: `https://private.example/${key}`,
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
  }),
  copyObjectBetweenBuckets: async () => null,
  deleteFromS3: async () => undefined,
  getPublicUrl: (_bucket: string, key: string) => `https://media.example/${key}`,
}));
vi.mock('../events', () => ({ publishSocialEvent: vi.fn(async () => undefined) }));
vi.mock('../lib/web-revalidate', () => ({ notifyClimbRevalidated: vi.fn(async () => undefined) }));
vi.mock('../utils/rate-limiter', () => ({ checkRateLimit: vi.fn(), resetAllRateLimits: vi.fn() }));
vi.mock('../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: vi.fn().mockResolvedValue(undefined) }));

const { db } = await import('../db/client');
const { sprayWallMutations, sprayWallQueries } = await import('../graphql/resolvers/board/spray-walls');
const { sprayWallPhotoKey } = await import('../handlers/spray-wall-photos');
const { ensureBackgroundJobSchema } = await import('../workers/families/__tests__/provider-sync-fixtures');
const { executeBackgroundJob, handlerForRole } = await import('../workers/jobs');
const { assertWorkerPrivileges } = await import('../services/job-queue-client');
type BackgroundJobPayload = import('../workers/jobs').BackgroundJobPayload;

const OWNER = 'art-owner';
const queue = BACKGROUND_JOB_QUEUES['maintenance-delivery'];
const role = `art_worker_${randomUUID().replaceAll('-', '')}`;
const owner = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const restrictedUrl = new URL(process.env.DATABASE_URL!);
restrictedUrl.searchParams.set('options', `-c role=${role}`);
const restricted = postgres(restrictedUrl.toString(), { max: 2, onnotice: () => {} });
const workerDatabase = drizzle(restricted) as unknown as DbInstance;
const ownerBoss = new PgBoss({
  connectionString: process.env.DATABASE_URL!,
  max: 1,
  migrate: false,
  supervise: false,
  schedule: false,
});
const workerBoss = new PgBoss({
  connectionString: restrictedUrl.toString(),
  max: 1,
  migrate: false,
  supervise: false,
  schedule: false,
});
ownerBoss.on('error', () => {});
workerBoss.on('error', () => {});

const ctx = { connectionId: 'conn-art', isAuthenticated: true, userId: OWNER } as unknown as ConnectionContext;

/** A front-on photo: a 2400 x 1800 grey-to-red gradient with a blue square where the hold is. */
async function photoJpeg(): Promise<Buffer> {
  const width = 2400;
  const height = 1800;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      const onHold = Math.abs(x - 500) < 40 && Math.abs(y - 500) < 40;
      pixels[offset] = onHold ? 0 : Math.round((x / width) * 255);
      pixels[offset + 1] = onHold ? 0 : 128;
      pixels[offset + 2] = onHold ? 255 : 128;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 92 })
    .toBuffer();
}

async function publishWall(anchors: [number, number][] | undefined) {
  const wall = (await sprayWallMutations.createSprayWall(
    {},
    { input: { name: `Art ${uuidv4().slice(0, 6)}`, angle: 40 } },
    ctx,
  )) as { uuid: string; layoutId: number };
  const photoId = uuidv4();
  objects.set(sprayWallPhotoKey(wall.uuid, photoId), {
    body: await photoJpeg(),
    contentType: 'image/jpeg',
    metadata: { width: '2400', height: '1800' },
  });
  const version = (await sprayWallMutations.createSprayWallVersion(
    {},
    { input: { wallUuid: wall.uuid, photoId, ...(anchors ? { anchors } : {}) } },
    ctx,
  )) as { id: string };
  await sprayWallMutations.upsertSprayWallHolds(
    {},
    // Canonical (400, 400) is photo (500, 500) under the pins below: the blue square.
    { input: { wallUuid: wall.uuid, versionId: version.id, holds: [{ cx: 400, cy: 400, r: 40 }] } },
    ctx,
  );
  await sprayWallMutations.publishSprayWallVersion({}, { input: { versionId: version.id } }, ctx);
  return { wall, versionId: Number(version.id) };
}

async function artOf(versionId: number) {
  const [row] = await db
    .select({ art: sprayWallVersions.art })
    .from(sprayWallVersions)
    .where(eq(sprayWallVersions.id, versionId));
  return row.art;
}

const runs = () => db.select().from(backgroundJobRuns).where(eq(backgroundJobRuns.family, 'spray-wall-art'));

beforeAll(async () => {
  await owner.unsafe(`CREATE ROLE "${role}" NOLOGIN`);
  await ensureBackgroundJobSchema(owner, [`maintenance-delivery=${role}`]);
  await ownerBoss.start();
  await workerBoss.start();
  queueState.boss = ownerBoss;
}, 30000);

beforeEach(async () => {
  vi.stubEnv('BATCH_FAMILIES_DISABLED', '');
  objects.clear();
  await ownerBoss.deleteAllJobs(queue);
  await db.delete(backgroundJobRuns).where(eq(backgroundJobRuns.family, 'spray-wall-art'));
  await db.execute(sql`
    TRUNCATE TABLE "spray_walls", "user_boards", "board_layouts", "board_product_sizes",
                   "board_product_sizes_layouts_sets", "board_holes", "board_placements"
    RESTART IDENTITY CASCADE
  `);
  await db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${OWNER}, ${OWNER + '@test.com'}, 'Art owner', now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  queueState.boss = null;
  await workerBoss.stop({ graceful: true, close: true });
  await ownerBoss.stop({ graceful: true, close: true });
  await restricted.end();
  await db.delete(backgroundJobRuns).where(eq(backgroundJobRuns.family, 'spray-wall-art'));
  await owner.unsafe(`DROP OWNED BY "${role}"`);
  await owner.unsafe(`DROP ROLE "${role}"`);
  await owner.end();
});

describe('spray-wall-art', () => {
  it('is queued by the publish and renders both looks under exactly the maintenance grants', async () => {
    const { wall, versionId } = await publishWall([
      [100, 100],
      [2300, 100],
      [2300, 1700],
      [100, 1700],
    ]);
    expect(await artOf(versionId)).toMatchObject({ status: 'pending', recipe: ART_RECIPE });
    const [queued] = await runs();
    expect(queued).toMatchObject({ status: 'queued', singletonKey: `art:${versionId}:${ART_RECIPE}` });

    await assertWorkerPrivileges(workerBoss.getDb());
    const [job] = await workerBoss.fetch<BackgroundJobPayload>(queue, { includeMetadata: true, batchSize: 1 });
    const result = await executeBackgroundJob(
      workerDatabase,
      workerBoss,
      job,
      handlerForRole('maintenance-delivery'),
      new AbortController().signal,
    );
    const [run] = await runs();
    expect({ result, status: run.status, errorCode: run.errorCode }).toEqual({
      result: 'succeeded',
      status: 'succeeded',
      errorCode: null,
    });

    const size = canonicalArtSize({ width: 2200, height: 1600 });
    const stem = `spray-walls/${wall.uuid}/art/${versionId}-r${ART_RECIPE}`;
    expect(await artOf(versionId)).toMatchObject({
      status: 'ready',
      width: size.width,
      height: size.height,
      cropKey: `${stem}-crop.jpg`,
      cutoutKey: `${stem}-cutout.webp`,
      quality: { verdict: 'good' },
    });
    for (const key of [
      `${stem}-crop.jpg`,
      `${stem}-crop.jpg@280.jpg`,
      `${stem}-cutout.webp`,
      `${stem}-cutout.webp@280.webp`,
    ]) {
      expect(objects.get(key)?.cacheControl, key).toBe('private, no-store');
    }

    // The crop is the flattened photo: the blue square lands at canonical (400, 400).
    const crop = await sharp(objects.get(`${stem}-crop.jpg`)!.body)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([crop.info.width, crop.info.height]).toEqual([size.width, size.height]);
    const holdPixel =
      (Math.round(400 * size.scale) * crop.info.width + Math.round(400 * size.scale)) * crop.info.channels;
    expect(crop.data[holdPixel + 2]).toBeGreaterThan(200);
    expect(crop.data[holdPixel]).toBeLessThan(60);

    // The cutout is opaque on the hold and transparent far from it.
    const cutout = await sharp(objects.get(`${stem}-cutout.webp`)!.body)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(cutout.info.channels).toBe(4);
    const alphaAt = (x: number, y: number) =>
      cutout.data[(Math.round(y * size.scale) * cutout.info.width + Math.round(x * size.scale)) * 4 + 3];
    expect(alphaAt(400, 400)).toBeGreaterThan(240);
    expect(alphaAt(1500, 1200)).toBeLessThan(5);

    const art = (await sprayWallQueries.sprayWallArt({}, { uuid: wall.uuid }, ctx)) as { status: string } | null;
    expect(art?.status).toBe('READY');

    // Nothing beyond what the job needs.
    await expect(restricted`SELECT public_photo_key FROM spray_walls LIMIT 1`).rejects.toThrow('permission denied');
    await expect(restricted`UPDATE spray_wall_versions SET photo_key = photo_key WHERE false`).rejects.toThrow(
      'permission denied',
    );
    await expect(restricted`UPDATE spray_wall_holds SET r = r WHERE false`).rejects.toThrow('permission denied');
  }, 60000);

  it('refuses a wall with no corner pins at publish, and queues nothing', async () => {
    const { versionId } = await publishWall(undefined);
    expect(await artOf(versionId)).toMatchObject({ status: 'refused', error: 'no-pins' });
    expect(await runs()).toHaveLength(0);
  });

  it('records a failure the owner can retry when the photo is gone', async () => {
    const { wall, versionId } = await publishWall([
      [100, 100],
      [2300, 100],
      [2300, 1700],
      [100, 1700],
    ]);
    for (const key of [...objects.keys()]) if (key.startsWith(`spray-walls/${wall.uuid}/`)) objects.delete(key);
    const [job] = await workerBoss.fetch<BackgroundJobPayload>(queue, { includeMetadata: true, batchSize: 1 });
    await executeBackgroundJob(
      workerDatabase,
      workerBoss,
      job,
      handlerForRole('maintenance-delivery'),
      new AbortController().signal,
    );
    expect(await artOf(versionId)).toMatchObject({ status: 'failed', error: 'SPRAY_ART_PHOTO_MISSING' });
    const [run] = await runs();
    expect(run).toMatchObject({ status: 'failed', errorCode: 'SPRAY_ART_PHOTO_MISSING' });
  }, 30000);

  it('writes nothing for a wall deleted before the job ran', async () => {
    const { wall, versionId } = await publishWall([
      [100, 100],
      [2300, 100],
      [2300, 1700],
      [100, 1700],
    ]);
    await sprayWallMutations.deleteSprayWall({}, { uuid: wall.uuid }, ctx);
    const before = objects.size;
    const [job] = await workerBoss.fetch<BackgroundJobPayload>(queue, { includeMetadata: true, batchSize: 1 });
    await executeBackgroundJob(
      workerDatabase,
      workerBoss,
      job,
      handlerForRole('maintenance-delivery'),
      new AbortController().signal,
    );
    expect(objects.size).toBe(before);
    expect(await artOf(versionId)).toMatchObject({ status: 'pending' });
    const [run] = await runs();
    expect(run).toMatchObject({ status: 'failed', errorCode: 'SPRAY_ART_VERSION_MISSING' });
  }, 30000);
});
