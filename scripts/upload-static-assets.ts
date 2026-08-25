import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { STATIC_ASSET_MANIFEST, STATIC_ASSET_ORIGIN } from '../packages/shared/static-assets/src';
import type { StaticAssetRecord } from '../packages/shared/static-assets/src';
import {
  buildStaticAssetManifest,
  discoverStaticAssetSources,
  renderStaticAssetJson,
  STATIC_ASSET_KEY_PREFIX,
} from './lib/static-asset-catalog';
import {
  assertRemoteStaticAssetAuditMetadata,
  assertRemoteStaticAssetMetadata,
  assertPublicStaticAssetHeaders,
  calculatePublicValidationDelay,
  createRequestStartLimiter,
  hasStaticAssetUploadFlag,
  isNonRetryablePublicStatus,
  planStaticAssetUploads,
  putImmutableObjectIfMissing,
  STATIC_ASSET_AUDIT_CACHE_CONTROL,
  STATIC_ASSET_AUDIT_MANIFEST_KEY,
  STATIC_ASSET_CACHE_CONTROL,
  summarizeStaticAssetManifest,
  uniqueStaticAssets,
  type RemoteStaticAsset,
  type RequestStartLimiter,
} from './lib/static-asset-upload';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_VALIDATION_ATTEMPTS = 6;
const MAX_REQUEST_STARTS_PER_SECOND = 5;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function assertGeneratedManifestIsCurrent(): void {
  const freshManifest = buildStaticAssetManifest(repoRoot);
  if (renderStaticAssetJson(freshManifest) !== renderStaticAssetJson(STATIC_ASSET_MANIFEST)) {
    throw new Error('Generated static asset catalog is stale; run `vp run generate:static-assets`');
  }
}

async function listRemoteStaticAssets(
  client: S3Client,
  bucket: string,
  beforeRequest: RequestStartLimiter,
): Promise<RemoteStaticAsset[]> {
  const objects: RemoteStaticAsset[] = [];
  let continuationToken: string | undefined;
  do {
    await beforeRequest();
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `${STATIC_ASSET_KEY_PREFIX}/`,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of response.Contents ?? []) {
      if (object.Key) objects.push({ key: object.Key, bytes: object.Size });
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

function sourcePathsByLogicalPath(): ReadonlyMap<string, string> {
  return new Map(discoverStaticAssetSources(repoRoot).map((source) => [source.logicalPath, source.sourcePath]));
}

async function uploadAsset(
  client: S3Client,
  bucket: string,
  asset: StaticAssetRecord,
  sourcePath: string,
  beforeRequest: RequestStartLimiter,
): Promise<boolean> {
  const contents = readFileSync(resolve(repoRoot, sourcePath));
  const digest = createHash('sha256').update(contents).digest();
  if (digest.toString('hex') !== asset.sha256) throw new Error(`Static asset changed during upload: ${sourcePath}`);
  return putImmutableObjectIfMissing(async () => {
    await beforeRequest();
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: asset.objectKey,
        Body: contents,
        ContentType: asset.contentType,
        CacheControl: STATIC_ASSET_CACHE_CONTROL,
        ChecksumSHA256: digest.toString('base64'),
        IfNoneMatch: '*',
      }),
    );
  });
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function validateRemoteAsset(
  client: S3Client,
  bucket: string,
  asset: StaticAssetRecord,
  beforeRequest: RequestStartLimiter,
): Promise<void> {
  await beforeRequest();
  const response = await client.send(
    new HeadObjectCommand({ Bucket: bucket, Key: asset.objectKey, ChecksumMode: 'ENABLED' }),
  );
  assertRemoteStaticAssetMetadata(asset, {
    bytes: response.ContentLength,
    contentType: response.ContentType,
    cacheControl: response.CacheControl,
    checksumSha256: response.ChecksumSHA256,
  });
}

async function validatePublicAsset(asset: StaticAssetRecord, beforeRequest: RequestStartLimiter): Promise<void> {
  const url = `${STATIC_ASSET_ORIGIN}/${asset.objectKey}`;
  let lastError: unknown;
  for (let attempt = 1; attempt <= PUBLIC_VALIDATION_ATTEMPTS; attempt += 1) {
    try {
      await beforeRequest();
      const response = await fetch(url, {
        headers: { Origin: 'https://www.boardsesh.com' },
      });
      if (!response.ok) {
        const httpError = new Error(`HTTP ${response.status}`);
        if (isNonRetryablePublicStatus(response.status)) throw Object.assign(httpError, { nonRetryable: true });
        throw httpError;
      }
      assertPublicStaticAssetHeaders(asset, response.headers);
      const contents = new Uint8Array(await response.arrayBuffer());
      const sha256 = createHash('sha256').update(contents).digest('hex');
      if (sha256 !== asset.sha256) throw new Error(`SHA-256 mismatch: expected ${asset.sha256}, received ${sha256}`);
      return;
    } catch (error) {
      lastError = error;
      if (error && typeof error === 'object' && 'nonRetryable' in error) break;
      if (attempt < PUBLIC_VALIDATION_ATTEMPTS) {
        await delay(calculatePublicValidationDelay(attempt));
      }
    }
  }
  throw new Error(`Public CDN validation failed for ${asset.logicalPath}: ${String(lastError)}`);
}

async function uploadAuditManifest(
  client: S3Client,
  bucket: string,
  beforeRequest: RequestStartLimiter,
): Promise<void> {
  const contents = Buffer.from(renderStaticAssetJson(STATIC_ASSET_MANIFEST));
  const checksumSha256 = createHash('sha256').update(contents).digest('base64');
  await beforeRequest();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: STATIC_ASSET_AUDIT_MANIFEST_KEY,
      Body: contents,
      ContentType: 'application/json',
      CacheControl: STATIC_ASSET_AUDIT_CACHE_CONTROL,
      ChecksumSHA256: checksumSha256,
    }),
  );
  await beforeRequest();
  const response = await client.send(
    new HeadObjectCommand({ Bucket: bucket, Key: STATIC_ASSET_AUDIT_MANIFEST_KEY, ChecksumMode: 'ENABLED' }),
  );
  assertRemoteStaticAssetAuditMetadata(
    { bytes: contents.byteLength, checksumSha256 },
    {
      bytes: response.ContentLength,
      contentType: response.ContentType,
      cacheControl: response.CacheControl,
      checksumSha256: response.ChecksumSHA256,
    },
  );
}

async function main(): Promise<void> {
  assertGeneratedManifestIsCurrent();
  if (hasStaticAssetUploadFlag(process.argv, '--dry-run')) {
    const summary = summarizeStaticAssetManifest(STATIC_ASSET_MANIFEST);
    console.log(
      `Dry run: catalog is current (${summary.records} records, ${summary.uniqueObjects} unique objects, ${summary.uniqueBytes} unique bytes); no remote requests performed.`,
    );
    return;
  }
  const bucket = requiredEnvironment('STATIC_ASSETS_S3_BUCKET_NAME');
  const endpoint = requiredEnvironment('STATIC_ASSETS_AWS_ENDPOINT_URL');
  const region = requiredEnvironment('STATIC_ASSETS_AWS_REGION');
  const accessKeyId = requiredEnvironment('STATIC_ASSETS_AWS_ACCESS_KEY_ID');
  const secretAccessKey = requiredEnvironment('STATIC_ASSETS_AWS_SECRET_ACCESS_KEY');
  const client = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
    maxAttempts: 5,
    retryMode: 'adaptive',
  });
  const beforeRequest = createRequestStartLimiter(MAX_REQUEST_STARTS_PER_SECOND);

  const remoteObjects = await listRemoteStaticAssets(client, bucket, beforeRequest);
  const plan = planStaticAssetUploads(STATIC_ASSET_MANIFEST, remoteObjects);
  if (plan.corrupt.length > 0) {
    const detail = plan.corrupt
      .map(({ asset, remoteBytes }) => `${asset.objectKey}: local=${asset.bytes}, remote=${remoteBytes ?? 'unknown'}`)
      .join('\n');
    throw new Error(`Content-addressed static assets have unexpected remote sizes:\n${detail}`);
  }

  const sourcePaths = sourcePathsByLogicalPath();
  let uploadedCount = 0;
  for (const [assetIndex, asset] of plan.missing.entries()) {
    const sourcePath = sourcePaths.get(asset.logicalPath);
    if (!sourcePath) throw new Error(`No source path for static asset: ${asset.logicalPath}`);
    console.log(`[${assetIndex + 1}/${plan.missing.length}] Uploading ${asset.logicalPath}`);
    const uploaded = await uploadAsset(client, bucket, asset, sourcePath, beforeRequest);
    if (uploaded) uploadedCount += 1;
    else console.log(`${asset.logicalPath} appeared during sync; validating the existing object.`);
  }

  const validationAssets = uniqueStaticAssets(STATIC_ASSET_MANIFEST);
  if (validationAssets.length === 0) throw new Error('Static asset catalog is empty');
  for (const [assetIndex, asset] of validationAssets.entries()) {
    if (assetIndex % 25 === 0 || assetIndex === validationAssets.length - 1) {
      console.log(`[${assetIndex + 1}/${validationAssets.length}] Validating immutable catalog objects`);
    }
    await validateRemoteAsset(client, bucket, asset, beforeRequest);
    await validatePublicAsset(asset, beforeRequest);
  }
  // Publication marker is deliberately last: seeing this audit catalog means
  // every newly referenced immutable object passed both S3 and public-CDN QA.
  await uploadAuditManifest(client, bucket, beforeRequest);
  console.log(`Static asset sync complete: ${uploadedCount} uploaded, ${remoteObjects.length} already stored.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
