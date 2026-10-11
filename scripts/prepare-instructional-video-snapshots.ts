/** Real catalogue snapshots for the isolated tutorial; no external storage or database writes. */
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseSnapshotManifest } from '../packages/shared/offline-sync/src/sync/snapshot-manifest';
import { tutorialCaptureSourceHash } from './lib/instructional-video/source';
import {
  assertTutorialSnapshotEnvironment,
  TUTORIAL_SNAPSHOT_BUCKET,
  TUTORIAL_SNAPSHOT_PREFIX,
  tutorialSnapshotSha,
  validTutorialSnapshotCache,
  type TutorialSnapshotCache,
  type TutorialSnapshotObject,
} from './lib/instructional-video/snapshots';
import { readFileSync } from 'node:fs';

type SnapshotSqlPool = {
  begin<T>(
    mode: string,
    callback: (transaction: { unsafe(query: string): Promise<unknown> }) => Promise<T>,
  ): Promise<T>;
};
let closeSnapshotPool: () => Promise<void> = async () => {};

async function main(): Promise<void> {
  assertTutorialSnapshotEnvironment(process.env);
  const repoRoot = resolve(process.argv[2]);
  const seedFile = resolve(process.argv[3]);
  const cacheDirectory = resolve(process.argv[4]);
  await mkdir(cacheDirectory, { recursive: true });
  // Load the real primary client only after isolation checks; its production type graph
  // also includes web globals which do not belong in the root capture tooling.
  const { createPool, closePool } = (await import(resolve(repoRoot, 'packages/db/src/client/index.ts'))) as {
    createPool: () => SnapshotSqlPool;
    closePool: () => Promise<void>;
  };
  closeSnapshotPool = closePool;
  const pool = createPool();
  // Conservative board-wide stats/grades identity catches changes outside this layout too.
  // Count plus cursor extrema detect additions, updates and removals; rows are never changed here.
  const catalogueIdentity = async () =>
    pool.begin('read only', async (transaction) =>
      transaction.unsafe(`
    SELECT 'climbs' AS source, count(*)::text AS rows, max(sync_seq)::text AS seq, max(updated_at)::text AS updated
      FROM board_climbs WHERE board_type='kilter' AND layout_id=1
    UNION ALL SELECT 'stats',count(*)::text,max(sync_seq)::text,max(updated_at)::text
      FROM board_climb_stats WHERE board_type='kilter'
    UNION ALL SELECT 'grades',count(*)::text,max(sync_seq)::text,max(computed_at)::text
      FROM board_climb_grades WHERE board_type='kilter'
    ORDER BY source
  `),
    );
  const identityBefore = JSON.stringify(await catalogueIdentity());
  const inputSha256 = tutorialSnapshotSha(
    JSON.stringify({
      version: 1,
      captureSourceSha256: tutorialCaptureSourceHash(repoRoot),
      seed: await readFile(seedFile, 'utf8'),
      catalogue: identityBefore,
      publicBase: process.env.SNAPSHOT_PUBLIC_BASE_URL,
    }),
  );
  const client = new S3Client({
    endpoint: process.env.SNAPSHOTS_AWS_ENDPOINT_URL,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'tutorial-local', secretAccessKey: 'tutorial-local' },
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
  try {
    await client.send(new HeadBucketCommand({ Bucket: TUTORIAL_SNAPSHOT_BUCKET }));
  } catch (error: unknown) {
    if (
      !(
        error instanceof Error &&
        '$metadata' in error &&
        (error.$metadata as { httpStatusCode?: number }).httpStatusCode === 404
      )
    )
      throw error;
    await client.send(new CreateBucketCommand({ Bucket: TUTORIAL_SNAPSHOT_BUCKET }));
  }
  // Public reads are confined to this fresh tutorial bucket; PRIVATE photo storage stays private.
  await client.send(
    new PutBucketPolicyCommand({
      Bucket: TUTORIAL_SNAPSHOT_BUCKET,
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: '*',
            Action: 's3:GetObject',
            Resource: `arn:aws:s3:::${TUTORIAL_SNAPSHOT_BUCKET}/${TUTORIAL_SNAPSHOT_PREFIX}/*`,
          },
        ],
      }),
    }),
  );
  const cachedFile = resolve(cacheDirectory, 'cache.json');
  let cache: TutorialSnapshotCache | undefined;
  try {
    const candidate: unknown = JSON.parse(await readFile(cachedFile, 'utf8'));
    if (
      validTutorialSnapshotCache(candidate, inputSha256, (filename) => readFileSync(resolve(cacheDirectory, filename)))
    )
      cache = candidate;
  } catch {
    /* An absent or damaged cache is replaced by a real export. */
  }
  const verifyPublicObject = async (object: TutorialSnapshotObject) => {
    const response = await fetch(`${process.env.SNAPSHOT_PUBLIC_BASE_URL}/${object.key}`, {
      signal: AbortSignal.timeout(120_000),
    });
    if (
      !response.ok ||
      response.headers.get('content-type')?.split(';')[0] !== object.contentType ||
      Number(response.headers.get('content-length')) !== object.bytes ||
      (response.headers.get('content-encoding') ?? undefined) !== object.contentEncoding ||
      !response.body
    )
      throw new Error(`Local snapshot object is not publicly readable with its declared metadata: ${object.key}`);
    const hash = createHash('sha256');
    for await (const chunk of response.body) hash.update(chunk);
    const expected =
      object.contentEncoding === 'gzip'
        ? tutorialSnapshotSha(gunzipSync(await readFile(resolve(cacheDirectory, object.filename))))
        : object.sha256;
    if (hash.digest('hex') !== expected) throw new Error(`Local snapshot public bytes differ: ${object.key}`);
  };
  const validateManifest = (objects: readonly TutorialSnapshotObject[]) => {
    const parsed = parseSnapshotManifest(JSON.parse(readFileSync(resolve(cacheDirectory, 'manifest.json'), 'utf8')));
    const entry = parsed?.entries[0];
    if (
      !parsed ||
      parsed.entries.length !== 1 ||
      !entry ||
      entry.boardType !== 'kilter' ||
      entry.layoutId !== 1 ||
      entry.privacyVersion !== 1
    )
      throw new Error('Tutorial snapshot cache has no current, privacy-safe Kilter layout1 manifest');
    for (const artifact of [entry, ...(entry.grades ? [entry.grades] : [])]) {
      const object = objects.find((candidate) => candidate.key === artifact.key);
      if (
        !object ||
        artifact.url !== `${process.env.SNAPSHOT_PUBLIC_BASE_URL}/${artifact.key}` ||
        artifact.bytes !== object.bytes ||
        (artifact.contentEncoding === 'gzip' ? 'gzip' : undefined) !== object.contentEncoding
      )
        throw new Error('Tutorial snapshot manifest differs from its owned cached artifact');
    }
  };
  const started = Date.now();
  if (cache) {
    validateManifest(cache.objects);
    // Moto is ephemeral. Restore immutable artifacts first and the manifest last, checking actual public bytes.
    for (const object of [...cache.objects].sort(
      (left, right) => Number(left.filename === 'manifest.json') - Number(right.filename === 'manifest.json'),
    )) {
      await client.send(
        new PutObjectCommand({
          Bucket: TUTORIAL_SNAPSHOT_BUCKET,
          Key: object.key,
          Body: await readFile(resolve(cacheDirectory, object.filename)),
          ContentType: object.contentType,
          ...(object.contentEncoding ? { ContentEncoding: object.contentEncoding } : {}),
        }),
      );
      await verifyPublicObject(object);
    }
    console.info('[tutorial-snapshots] Restored verified catalogue cache');
  } else {
    const exporterPath = resolve(repoRoot, 'packages/backend/src/scripts/export-board-snapshots.ts');
    const { runExportWithOptions } = (await import(exporterPath)) as {
      runExportWithOptions: (
        options: {
          dryRun: boolean;
          gzip: boolean;
          skipPrune: boolean;
          keyPrefix: string;
          boardFilter: string;
          layoutFilter: number;
        },
        dependencies: { sqlClient: typeof pool },
      ) => Promise<void>;
    };
    await runExportWithOptions(
      {
        dryRun: false,
        gzip: true,
        skipPrune: true,
        keyPrefix: TUTORIAL_SNAPSHOT_PREFIX,
        boardFilter: 'kilter',
        layoutFilter: 1,
      },
      { sqlClient: pool },
    );
    const manifestResult = await client.send(
      new GetObjectCommand({ Bucket: TUTORIAL_SNAPSHOT_BUCKET, Key: `${TUTORIAL_SNAPSHOT_PREFIX}/manifest.json` }),
    );
    if (!manifestResult.Body) throw new Error('Local exporter produced no manifest');
    const manifestBytes = Buffer.from(await manifestResult.Body.transformToByteArray());
    const manifest = parseSnapshotManifest(JSON.parse(manifestBytes.toString('utf8')));
    const entry = manifest?.entries[0];
    if (!manifest || manifest.entries.length !== 1 || !entry || entry.boardType !== 'kilter' || entry.layoutId !== 1)
      throw new Error('Local export scope differs from Kilter layout1');
    const objects: TutorialSnapshotObject[] = [];
    for (const artifact of [entry, ...(entry.grades ? [entry.grades] : [])]) {
      const result = await client.send(new GetObjectCommand({ Bucket: TUTORIAL_SNAPSHOT_BUCKET, Key: artifact.key }));
      if (!result.Body) throw new Error(`Local exporter produced no artifact ${artifact.key}`);
      const bytes = Buffer.from(await result.Body.transformToByteArray());
      const filename = artifact.key.split('/').at(-1)!;
      await writeFile(resolve(cacheDirectory, filename), bytes);
      objects.push({
        key: artifact.key,
        filename,
        bytes: bytes.length,
        sha256: tutorialSnapshotSha(bytes),
        contentType: 'application/x-sqlite3',
        ...(artifact.contentEncoding === 'gzip' ? { contentEncoding: 'gzip' as const } : {}),
      });
    }
    await writeFile(resolve(cacheDirectory, 'manifest.json'), manifestBytes);
    objects.push({
      key: `${TUTORIAL_SNAPSHOT_PREFIX}/manifest.json`,
      filename: 'manifest.json',
      bytes: manifestBytes.length,
      sha256: tutorialSnapshotSha(manifestBytes),
      contentType: 'application/json',
    });
    validateManifest(objects);
    for (const object of objects) await verifyPublicObject(object);
    cache = { formatVersion: 1, inputSha256, objects };
    if (identityBefore === JSON.stringify(await catalogueIdentity())) {
      await writeFile(`${cachedFile}.partial`, JSON.stringify(cache));
      await rename(`${cachedFile}.partial`, cachedFile);
    } else console.info('[tutorial-snapshots] Catalogue changed during export; next startup will rebuild');
  }
  const receipt = { inputSha256, objects: cache.objects.map(({ key, bytes, sha256 }) => ({ key, bytes, sha256 })) };
  await writeFile(resolve(cacheDirectory, 'receipt.json'), JSON.stringify(receipt));
  console.info(
    `[tutorial-snapshots] Ready in ${((Date.now() - started) / 1000).toFixed(1)}s; ${cache.objects.reduce((total, object) => total + object.bytes, 0)} stored bytes`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeSnapshotPool());
