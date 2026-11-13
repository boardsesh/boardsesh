import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { StaticAssetRecord } from '../../packages/shared/static-assets/src/types';
import {
  assertPublicStaticAssetHeaders,
  assertRemoteStaticAssetMetadata,
  calculatePublicValidationDelay,
  createRequestStartLimiter,
  isNonRetryablePublicStatus,
  putImmutableObjectIfMissing,
  readResponseBodyWithinLimit,
  STATIC_ASSET_CACHE_CONTROL,
  type RequestStartLimiter,
} from './static-asset-upload';

export const NEXT_STATIC_ASSET_ORIGIN = 'https://assets.boardsesh.com';
export const NEXT_STATIC_ASSET_PREFIX = '_next/static/';
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_ASSET_COUNT = 10_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ATTEMPTS = 4;
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.wasm': 'application/wasm',
};

export type NextStaticAsset = StaticAssetRecord & Readonly<{ sourcePath: string }>;
export type NextStaticAssetPublishResult = Readonly<{
  assets: number;
  uploaded: number;
  existing: number;
  bytes: number;
}>;

function assertSafeDirectory(directory: string): string {
  if (!directory.trim() || directory.split(/[\\/]/).includes('..'))
    throw new Error('Asset directory must not contain traversal segments');
  return resolve(directory);
}

async function readRegularFile(sourcePath: string): Promise<Buffer> {
  if ((await realpath(sourcePath)) !== sourcePath) throw new Error(`Symlinks are not allowed: ${sourcePath}`);
  const file = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error(`Not a regular runtime asset: ${sourcePath}`);
    if (metadata.size > MAX_ASSET_BYTES)
      throw new Error(`Runtime asset exceeds ${MAX_ASSET_BYTES} bytes: ${sourcePath}`);
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= metadata.size) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, metadata.size + 1 - totalBytes));
      const { bytesRead } = await file.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    const contents = Buffer.concat(chunks, totalBytes);
    if (contents.byteLength !== metadata.size || contents.byteLength > MAX_ASSET_BYTES)
      throw new Error(`Runtime asset changed while reading: ${sourcePath}`);
    return contents;
  } finally {
    await file.close();
  }
}

/** Validate every local path before making any remote requests. Source maps never leave the build image. */
export async function discoverNextStaticAssets(directory: string): Promise<readonly NextStaticAsset[]> {
  const root = assertSafeDirectory(directory);
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || (await realpath(root)) !== root)
    throw new Error(`Symlinks are not allowed: ${root}`);
  if (!rootMetadata.isDirectory()) throw new Error(`Asset directory is not a directory: ${root}`);
  const assets: NextStaticAsset[] = [];
  async function visit(parent: string): Promise<void> {
    const entries = await readdir(parent, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const sourcePath = resolve(parent, entry.name);
      const relativePath = relative(root, sourcePath);
      if (entry.name.includes('\\') || relativePath.split(sep).includes('..') || isAbsolute(relativePath))
        throw new Error(`Unsafe runtime asset path: ${sourcePath}`);
      const metadata = await lstat(sourcePath);
      if (metadata.isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${sourcePath}`);
      if (metadata.isDirectory()) {
        await visit(sourcePath);
        continue;
      }
      if (!metadata.isFile()) throw new Error(`Not a regular runtime asset: ${sourcePath}`);
      if (extname(entry.name).toLowerCase() === '.map') continue;
      const contentType = CONTENT_TYPES[extname(entry.name).toLowerCase()];
      if (!contentType) throw new Error(`Unsupported runtime asset type: ${relativePath}`);
      if (assets.length >= MAX_ASSET_COUNT) throw new Error(`Runtime asset count exceeds ${MAX_ASSET_COUNT}`);
      const contents = await readRegularFile(sourcePath);
      const objectKey = `${NEXT_STATIC_ASSET_PREFIX}${relativePath.split(sep).join('/')}`;
      assets.push({
        sourcePath,
        logicalPath: `/${objectKey}`,
        objectKey,
        sha256: createHash('sha256').update(contents).digest('hex'),
        bytes: contents.byteLength,
        contentType,
        nativeBundle: false,
      });
    }
  }
  await visit(root);
  if (assets.length === 0) throw new Error('Asset directory contains no runtime files');
  return assets;
}

function storageStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('$metadata' in error)) return undefined;
  const status = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
  return typeof status === 'number' ? status : undefined;
}

function createSerializedLimiter(): RequestStartLimiter {
  const limit = createRequestStartLimiter(5);
  let previous = Promise.resolve();
  return () => {
    const next = previous.then(limit);
    previous = next.catch(() => {});
    return next;
  };
}

export type PublishNextStaticAssetsOptions = {
  directory: string;
  bucket: string;
  client: S3Client;
  cdnOrigin?: string;
  fetchImpl?: typeof fetch;
  beforeRequest?: RequestStartLimiter;
  sleep?: (milliseconds: number) => Promise<void>;
  concurrency?: number;
  requestTimeoutMs?: number;
  attempts?: number;
};

/** Append-only publisher: no listing, overwriting, cache invalidation, or deletion operations. */
export async function publishNextStaticAssets(
  options: PublishNextStaticAssetsOptions,
): Promise<NextStaticAssetPublishResult> {
  const { directory, bucket, client } = options;
  if (!bucket.trim()) throw new Error('Static asset bucket is required');
  const origin = new URL(options.cdnOrigin ?? NEXT_STATIC_ASSET_ORIGIN);
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new Error('Public asset origin must be an HTTPS origin without a path or credentials');
  const concurrency = options.concurrency ?? 4;
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw new Error('Concurrency must be an integer from 1 to 8');
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 6)
    throw new Error('Attempts must be an integer from 1 to 6');
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 120_000)
    throw new Error('Request timeout must be an integer from 1 to 120000 milliseconds');
  const beforeRequest = options.beforeRequest ?? createSerializedLimiter();
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds)));
  const assets = await discoverNextStaticAssets(directory);

  async function storageRequest<Output>(request: (signal: AbortSignal) => Promise<Output>): Promise<Output> {
    for (let attempt = 1; ; attempt++) {
      await beforeRequest();
      try {
        return await request(AbortSignal.timeout(requestTimeoutMs));
      } catch (error) {
        const status = storageStatus(error);
        if (
          attempt >= attempts ||
          (status !== undefined && status >= 400 && status < 500 && ![404, 408, 409, 429].includes(status))
        )
          throw error;
        await sleep(calculatePublicValidationDelay(attempt));
      }
    }
  }

  async function validateStoredAsset(asset: NextStaticAsset): Promise<void> {
    const head = await storageRequest((signal) =>
      client.send(new HeadObjectCommand({ Bucket: bucket, Key: asset.objectKey, ChecksumMode: 'ENABLED' }), {
        abortSignal: signal,
      }),
    );
    const download = await storageRequest(async (signal) => {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: asset.objectKey }), {
        abortSignal: signal,
      });
      if (!response.Body) throw new Error(`S3 GET body missing for ${asset.logicalPath}`);
      const contents = await readResponseBodyWithinLimit(
        new Response(response.Body.transformToWebStream()),
        asset.bytes,
        signal,
      );
      return { response, contents };
    });
    for (const metadata of [head, download.response]) {
      assertRemoteStaticAssetMetadata(
        asset,
        {
          bytes: metadata.ContentLength,
          contentType: metadata.ContentType,
          cacheControl: metadata.CacheControl,
          checksumSha256: metadata.ChecksumSHA256,
        },
        download.contents,
      );
    }
  }

  async function validatePublicAsset(asset: NextStaticAsset, withOrigin: boolean): Promise<void> {
    const url = `${origin.origin}/${asset.objectKey.split('/').map(encodeURIComponent).join('/')}`;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await beforeRequest();
      try {
        const signal = AbortSignal.timeout(requestTimeoutMs);
        const response = await fetchImpl(url, {
          signal,
          redirect: 'error',
          ...(withOrigin ? { headers: { Origin: 'https://www.boardsesh.com' } } : {}),
        });
        if (response.status !== 200) {
          await response.body?.cancel();
          const error = new Error(`HTTP ${response.status}`);
          if (isNonRetryablePublicStatus(response.status)) throw Object.assign(error, { nonRetryable: true });
          throw error;
        }
        try {
          assertPublicStaticAssetHeaders(asset, response.headers, { expectCloudflare: true });
          const cacheDirectives = (response.headers.get('cache-control') ?? '')
            .toLowerCase()
            .split(',')
            .map((directive) => directive.trim());
          const maxAgeDirectives = cacheDirectives.filter((directive) => directive.split('=')[0]?.trim() === 'max-age');
          const sharedMaxAgeDirectives = cacheDirectives.filter(
            (directive) => directive.split('=')[0]?.trim() === 's-maxage',
          );
          if (
            !cacheDirectives.includes('public') ||
            !cacheDirectives.includes('immutable') ||
            maxAgeDirectives.length !== 1 ||
            maxAgeDirectives[0] !== 'max-age=31536000' ||
            sharedMaxAgeDirectives.length > 1 ||
            sharedMaxAgeDirectives.some((directive) => directive !== 's-maxage=31536000') ||
            cacheDirectives.some((directive) =>
              ['private', 'no-store', 'no-cache'].includes(directive.split('=')[0]?.trim() ?? ''),
            )
          )
            throw new Error(`Public asset ${asset.logicalPath} is not publicly cacheable for one immutable year`);
        } catch (error) {
          await response.body?.cancel();
          throw Object.assign(error instanceof Error ? error : new Error(String(error)), { nonRetryable: true });
        }
        const contents = await readResponseBodyWithinLimit(response, asset.bytes, signal);
        if (contents.byteLength !== asset.bytes || createHash('sha256').update(contents).digest('hex') !== asset.sha256)
          throw Object.assign(new Error(`Public CDN byte/hash mismatch for ${asset.logicalPath}`), {
            nonRetryable: true,
          });
        return;
      } catch (error) {
        lastError = error;
        if (error && typeof error === 'object' && 'nonRetryable' in error) break;
        if (attempt < attempts) await sleep(calculatePublicValidationDelay(attempt));
      }
    }
    throw new Error(`Public CDN validation failed for ${asset.logicalPath}: ${String(lastError)}`);
  }

  let nextIndex = 0;
  let uploaded = 0;
  let failure: { error: unknown } | undefined;
  async function worker(): Promise<void> {
    while (failure === undefined) {
      const asset = assets[nextIndex++];
      if (!asset) return;
      try {
        const contents = await readRegularFile(asset.sourcePath);
        if (contents.byteLength !== asset.bytes || createHash('sha256').update(contents).digest('hex') !== asset.sha256)
          throw new Error(`Runtime asset changed before publication: ${asset.sourcePath}`);
        const created = await putImmutableObjectIfMissing(() =>
          storageRequest(async (signal) => {
            await client.send(
              new PutObjectCommand({
                Bucket: bucket,
                Key: asset.objectKey,
                Body: contents,
                ContentType: asset.contentType,
                CacheControl: STATIC_ASSET_CACHE_CONTROL,
                ChecksumSHA256: Buffer.from(asset.sha256, 'hex').toString('base64'),
                IfNoneMatch: '*',
              }),
              { abortSignal: signal },
            );
          }),
        );
        await validateStoredAsset(asset);
        await validatePublicAsset(asset, false);
        await validatePublicAsset(asset, true);
        if (created) uploaded++;
      } catch (error) {
        failure ??= { error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, assets.length) }, () => worker()));
  if (failure !== undefined) throw failure.error;
  return {
    assets: assets.length,
    uploaded,
    existing: assets.length - uploaded,
    bytes: assets.reduce((total, asset) => total + asset.bytes, 0),
  };
}
