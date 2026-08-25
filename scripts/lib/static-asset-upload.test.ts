/// <reference types="node" />

import { describe, expect, it, vi } from 'vitest';
import type { StaticAssetManifest } from '../../packages/shared/static-assets/src/types';
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
} from './static-asset-upload';

const asset = {
  logicalPath: '/images/kilter/wall.webp',
  objectKey: `static/v1/${'a'.repeat(64)}.webp`,
  sha256: 'a'.repeat(64),
  bytes: 42,
  contentType: 'image/webp',
  nativeBundle: true,
} as const;
const manifest: StaticAssetManifest = { [asset.logicalPath]: asset };

describe('static asset upload planning', () => {
  it('does no PUT work when the immutable object already exists', () => {
    expect(planStaticAssetUploads(manifest, [{ key: asset.objectKey, bytes: asset.bytes }])).toEqual({
      missing: [],
      corrupt: [],
    });
  });

  it('selects a missing content-addressed object', () => {
    expect(planStaticAssetUploads(manifest, []).missing).toEqual([asset]);
  });

  it('uploads identical bytes only once when multiple logical paths share an object key', () => {
    const alias = { ...asset, logicalPath: '/images/kilter/wall-alias.webp' };
    expect(planStaticAssetUploads({ ...manifest, [alias.logicalPath]: alias }, []).missing).toEqual([asset]);
  });

  it('fails closed on an impossible size mismatch at an existing hash key', () => {
    expect(planStaticAssetUploads(manifest, [{ key: asset.objectKey, bytes: 41 }]).corrupt).toEqual([
      { asset, remoteBytes: 41 },
    ]);
  });
});

describe('public static asset validation', () => {
  it('accepts the required browser-visible headers', () => {
    const headers = new Headers({
      'content-type': 'image/webp',
      'cache-control': 'public, max-age=31536000, immutable',
      'access-control-allow-origin': '*',
    });
    expect(() => assertPublicStaticAssetHeaders(asset, headers)).not.toThrow();
  });

  it('rejects missing CORS and unsafe cache metadata', () => {
    const headers = new Headers({ 'content-type': 'image/webp', 'cache-control': 'public, max-age=300' });
    expect(() => assertPublicStaticAssetHeaders(asset, headers)).toThrow('immutable one-year caching');
  });

  it('rejects missing CORS even when the cache metadata is valid', () => {
    const headers = new Headers({
      'content-type': 'image/webp',
      'cache-control': 'public, max-age=31536000, immutable',
    });
    expect(() => assertPublicStaticAssetHeaders(asset, headers)).toThrow('Access-Control-Allow-Origin');
  });

  it('fails auth and other permanent 4xx responses without retrying them', () => {
    expect(isNonRetryablePublicStatus(400)).toBe(true);
    expect(isNonRetryablePublicStatus(403)).toBe(true);
    expect(isNonRetryablePublicStatus(404)).toBe(false);
    expect(isNonRetryablePublicStatus(429)).toBe(false);
    expect(isNonRetryablePublicStatus(503)).toBe(false);
  });

  it('uses bounded exponential full jitter for retryable propagation failures', () => {
    expect(calculatePublicValidationDelay(1, () => 0.5)).toBe(250);
    expect(calculatePublicValidationDelay(2, () => 0.5)).toBe(500);
    expect(calculatePublicValidationDelay(6, () => 0.5)).toBe(4_000);
    expect(calculatePublicValidationDelay(20, () => 1)).toBe(8_000);
  });

  it('validates signed S3 HEAD metadata including checksums', () => {
    expect(() =>
      assertRemoteStaticAssetMetadata(asset, {
        bytes: asset.bytes,
        contentType: asset.contentType,
        cacheControl: STATIC_ASSET_CACHE_CONTROL,
        checksumSha256: Buffer.from(asset.sha256, 'hex').toString('base64'),
      }),
    ).not.toThrow();
    expect(() =>
      assertRemoteStaticAssetMetadata(asset, {
        bytes: asset.bytes,
        contentType: asset.contentType,
        cacheControl: 'public, max-age=60',
        checksumSha256: undefined,
      }),
    ).toThrow('Cache-Control mismatch');
    expect(() =>
      assertRemoteStaticAssetMetadata(asset, {
        bytes: asset.bytes,
        contentType: asset.contentType,
        cacheControl: STATIC_ASSET_CACHE_CONTROL,
        checksumSha256: undefined,
      }),
    ).toThrow('checksum missing');
  });
});

describe('upload command contracts', () => {
  it('recognizes dry runs without needing credentials', () => {
    expect(hasStaticAssetUploadFlag(['--', '--dry-run'], '--dry-run')).toBe(true);
    expect(hasStaticAssetUploadFlag([], '--dry-run')).toBe(false);
  });

  it('reports logical records separately from deduplicated upload objects', () => {
    const alias = { ...asset, logicalPath: '/images/kilter/wall-alias.webp' };
    expect(summarizeStaticAssetManifest({ ...manifest, [alias.logicalPath]: alias })).toEqual({
      records: 2,
      uniqueObjects: 1,
      uniqueBytes: asset.bytes,
    });
  });

  it('includes existing objects in the full publication validation set', () => {
    const alias = { ...asset, logicalPath: '/images/kilter/wall-alias.webp' };
    const second = {
      ...asset,
      logicalPath: '/images/kilter/other.webp',
      objectKey: `static/v1/${'b'.repeat(64)}.webp`,
      sha256: 'b'.repeat(64),
    };
    const completeManifest = { ...manifest, [alias.logicalPath]: alias, [second.logicalPath]: second };

    expect(planStaticAssetUploads(completeManifest, [{ key: asset.objectKey, bytes: asset.bytes }]).missing).toEqual([
      second,
    ]);
    expect(uniqueStaticAssets(completeManifest)).toEqual([asset, second]);
  });

  it('treats only a raced conditional PUT as already present for later validation', async () => {
    const racedPut = vi.fn().mockRejectedValue({ $metadata: { httpStatusCode: 412 } });
    await expect(putImmutableObjectIfMissing(racedPut)).resolves.toBe(false);
    expect(racedPut).toHaveBeenCalledOnce();

    await expect(
      putImmutableObjectIfMissing(async () => {
        throw { $metadata: { httpStatusCode: 403 } };
      }),
    ).rejects.toEqual({ $metadata: { httpStatusCode: 403 } });
  });

  it('keeps immutable objects and the audit marker on distinct cache policies', () => {
    expect(STATIC_ASSET_CACHE_CONTROL).toContain('immutable');
    expect(STATIC_ASSET_AUDIT_CACHE_CONTROL).toContain('max-age=60');
    expect(STATIC_ASSET_AUDIT_CACHE_CONTROL).not.toContain('immutable');
    expect(STATIC_ASSET_AUDIT_MANIFEST_KEY).toBe('static/v1/manifest.json');
  });

  it('validates every audit marker HEAD field and reports a missing size precisely', () => {
    const expected = { bytes: 128, checksumSha256: 'audit-checksum' };
    const validMetadata = {
      bytes: expected.bytes,
      contentType: 'application/json',
      cacheControl: STATIC_ASSET_AUDIT_CACHE_CONTROL,
      checksumSha256: expected.checksumSha256,
    };

    expect(() => assertRemoteStaticAssetAuditMetadata(expected, validMetadata)).not.toThrow();
    expect(() => assertRemoteStaticAssetAuditMetadata(expected, { ...validMetadata, bytes: undefined })).toThrow(
      'size missing',
    );
    expect(() =>
      assertRemoteStaticAssetAuditMetadata(expected, { ...validMetadata, checksumSha256: undefined }),
    ).toThrow('checksum missing');
  });
});

describe('request start limiting', () => {
  it('paces sequential request starts to at most five per second', async () => {
    let currentTime = 1_000;
    const waits: number[] = [];
    const limiter = createRequestStartLimiter(5, {
      now: () => currentTime,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        currentTime += milliseconds;
      },
    });

    await limiter();
    await limiter();
    await limiter();

    expect(waits).toEqual([200, 200]);
  });

  it('paces from the actual start time when a timer oversleeps', async () => {
    let currentTime = 1_000;
    const waits: number[] = [];
    const limiter = createRequestStartLimiter(5, {
      now: () => currentTime,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        currentTime += milliseconds + 300;
      },
    });

    await limiter();
    await limiter();
    await limiter();

    expect(waits).toEqual([200, 200]);
  });
});
