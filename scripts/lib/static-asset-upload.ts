/// <reference types="node" />

import type { StaticAssetManifest, StaticAssetRecord } from '../../packages/shared/static-assets/src/types';

export type RemoteStaticAsset = Readonly<{ key: string; bytes: number | undefined }>;

export type StaticAssetUploadPlan = Readonly<{
  missing: readonly StaticAssetRecord[];
  corrupt: readonly { asset: StaticAssetRecord; remoteBytes: number | undefined }[];
}>;

export type RequestStartLimiter = () => Promise<void>;

export const STATIC_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const STATIC_ASSET_AUDIT_CACHE_CONTROL = 'public, max-age=60, must-revalidate';
export const STATIC_ASSET_AUDIT_MANIFEST_KEY = 'static/v1/manifest.json';

export type RemoteStaticAssetMetadata = Readonly<{
  bytes: number | undefined;
  contentType: string | undefined;
  cacheControl: string | undefined;
  checksumSha256: string | undefined;
}>;

export type RemoteStaticAssetAuditMetadata = Readonly<{
  bytes: number | undefined;
  contentType: string | undefined;
  cacheControl: string | undefined;
  checksumSha256: string | undefined;
}>;

export type StaticAssetManifestSummary = Readonly<{
  records: number;
  uniqueObjects: number;
  uniqueBytes: number;
}>;

export function createRequestStartLimiter(
  startsPerSecond = 5,
  dependencies: {
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): RequestStartLimiter {
  if (!Number.isFinite(startsPerSecond) || startsPerSecond <= 0) {
    throw new Error('startsPerSecond must be a positive finite number');
  }
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const intervalMilliseconds = 1_000 / startsPerSecond;
  let nextStartAt = 0;

  return async () => {
    const currentTime = now();
    const waitMilliseconds = Math.max(0, nextStartAt - currentTime);
    if (waitMilliseconds > 0) await sleep(waitMilliseconds);
    const actualStartTime = waitMilliseconds > 0 ? now() : currentTime;
    nextStartAt = actualStartTime + intervalMilliseconds;
  };
}

export function isNonRetryablePublicStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 404 && status !== 429;
}

export function calculatePublicValidationDelay(failedAttempt: number, random: () => number = Math.random): number {
  if (!Number.isInteger(failedAttempt) || failedAttempt < 1) {
    throw new Error('failedAttempt must be a positive integer');
  }
  const maximumDelayMilliseconds = Math.min(8_000, 1_000 * 2 ** (failedAttempt - 1));
  const minimumDelayMilliseconds = maximumDelayMilliseconds / 2;
  return Math.floor(minimumDelayMilliseconds + random() * minimumDelayMilliseconds);
}

export async function readResponseBodyWithinLimit(response: Response, maximumBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error('maximumBytes must be a non-negative safe integer');
  }

  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  while (true) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    receivedBytes += chunk.byteLength;
    if (receivedBytes > maximumBytes) {
      await reader.cancel();
      throw new Error(`Public asset body exceeds the expected ${maximumBytes} bytes`);
    }
    chunks.push(chunk);
  }

  const contents = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    contents.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return contents;
}

export function hasStaticAssetUploadFlag(arguments_: readonly string[], flag: string): boolean {
  return arguments_.includes(flag);
}

export async function putImmutableObjectIfMissing(putObject: () => Promise<void>): Promise<boolean> {
  try {
    await putObject();
    return true;
  } catch (error) {
    const statusCode =
      error && typeof error === 'object' && '$metadata' in error
        ? (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode
        : undefined;
    if (statusCode === 412) return false;
    throw error;
  }
}

export function summarizeStaticAssetManifest(manifest: StaticAssetManifest): StaticAssetManifestSummary {
  const records = Object.values(manifest);
  const uniqueAssets = uniqueStaticAssets(manifest);
  return {
    records: records.length,
    uniqueObjects: uniqueAssets.length,
    uniqueBytes: uniqueAssets.reduce((sum, asset) => sum + asset.bytes, 0),
  };
}

export function uniqueStaticAssets(manifest: StaticAssetManifest): readonly StaticAssetRecord[] {
  const assetsByObjectKey = new Map<string, StaticAssetRecord>();
  for (const asset of Object.values(manifest)) {
    if (!assetsByObjectKey.has(asset.objectKey)) assetsByObjectKey.set(asset.objectKey, asset);
  }
  return [...assetsByObjectKey.values()];
}

export function assertRemoteStaticAssetMetadata(asset: StaticAssetRecord, metadata: RemoteStaticAssetMetadata): void {
  if (metadata.bytes !== asset.bytes) {
    throw new Error(`S3 HEAD size mismatch for ${asset.logicalPath}: ${metadata.bytes ?? 'missing'}`);
  }
  if (metadata.contentType !== asset.contentType) {
    throw new Error(`S3 HEAD Content-Type mismatch for ${asset.logicalPath}: ${metadata.contentType ?? 'missing'}`);
  }
  if (metadata.cacheControl !== STATIC_ASSET_CACHE_CONTROL) {
    throw new Error(`S3 HEAD Cache-Control mismatch for ${asset.logicalPath}: ${metadata.cacheControl ?? 'missing'}`);
  }
  if (!metadata.checksumSha256) {
    throw new Error(`S3 HEAD checksum missing for ${asset.logicalPath}`);
  }
  const expectedChecksum = Buffer.from(asset.sha256, 'hex').toString('base64');
  if (metadata.checksumSha256 !== expectedChecksum) {
    throw new Error(`S3 HEAD checksum mismatch for ${asset.logicalPath}`);
  }
}

export function assertRemoteStaticAssetAuditMetadata(
  expected: Readonly<{ bytes: number; checksumSha256: string }>,
  metadata: RemoteStaticAssetAuditMetadata,
): void {
  if (metadata.bytes === undefined) {
    throw new Error('S3 HEAD size missing for static asset audit manifest');
  }
  if (metadata.bytes !== expected.bytes) {
    throw new Error(
      `S3 HEAD size mismatch for static asset audit manifest: expected ${expected.bytes}, received ${metadata.bytes}`,
    );
  }
  if (metadata.contentType !== 'application/json') {
    throw new Error(
      `S3 HEAD Content-Type mismatch for static asset audit manifest: ${metadata.contentType ?? 'missing'}`,
    );
  }
  if (metadata.cacheControl !== STATIC_ASSET_AUDIT_CACHE_CONTROL) {
    throw new Error(
      `S3 HEAD Cache-Control mismatch for static asset audit manifest: ${metadata.cacheControl ?? 'missing'}`,
    );
  }
  if (!metadata.checksumSha256) {
    throw new Error('S3 HEAD checksum missing for static asset audit manifest');
  }
  if (metadata.checksumSha256 !== expected.checksumSha256) {
    throw new Error('S3 HEAD checksum mismatch for static asset audit manifest');
  }
}

export function planStaticAssetUploads(
  manifest: StaticAssetManifest,
  remoteObjects: readonly RemoteStaticAsset[],
): StaticAssetUploadPlan {
  const remoteByKey = new Map(remoteObjects.map((object) => [object.key, object]));
  const missing: StaticAssetRecord[] = [];
  const missingKeys = new Set<string>();
  const corrupt: Array<{ asset: StaticAssetRecord; remoteBytes: number | undefined }> = [];

  for (const asset of Object.values(manifest)) {
    const remote = remoteByKey.get(asset.objectKey);
    if (!remote) {
      if (!missingKeys.has(asset.objectKey)) {
        missing.push(asset);
        missingKeys.add(asset.objectKey);
      }
      continue;
    }
    if (remote.bytes !== asset.bytes) corrupt.push({ asset, remoteBytes: remote.bytes });
  }
  return { missing, corrupt };
}

export function assertPublicStaticAssetHeaders(asset: StaticAssetRecord, headers: Headers): void {
  const contentType = headers.get('content-type')?.split(';')[0]?.trim();
  if (contentType !== asset.contentType) {
    throw new Error(`Public asset ${asset.logicalPath} has Content-Type ${contentType ?? '(missing)'}`);
  }
  const contentLength = headers.get('content-length');
  if (contentLength !== String(asset.bytes)) {
    throw new Error(
      `Public asset ${asset.logicalPath} has Content-Length ${contentLength ?? '(missing)'}; expected ${asset.bytes}`,
    );
  }
  const cacheControl = headers.get('cache-control') ?? '';
  if (!cacheControl.includes('max-age=31536000') || !cacheControl.includes('immutable')) {
    throw new Error(`Public asset ${asset.logicalPath} is missing immutable one-year caching`);
  }
  if (headers.get('access-control-allow-origin') !== '*') {
    throw new Error(`Public asset ${asset.logicalPath} is missing Access-Control-Allow-Origin: *`);
  }
}
