import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';

vi.mock('../storage/s3', () => ({
  isS3Configured: vi.fn(() => true),
  getPublicUrl: vi.fn((_bucket: string, key: string) => `https://example-bucket.s3.amazonaws.com/${key}`),
  uploadToS3: vi.fn(async (_bucket: string, _buffer: Buffer, key: string) => ({ key })),
}));

// Bypass the SSRF allowlist + DNS lookup in this test so we exercise the
// caching path without hitting the network. The guard is unit-tested in
// safe-image-fetch.test.ts.
vi.mock('../lib/safe-image-fetch', async () => {
  const actual = await vi.importActual<typeof import('../lib/safe-image-fetch')>('../lib/safe-image-fetch');
  return {
    ...actual,
    assertAllowedImageHost: vi.fn(async () => {}),
  };
});

import {
  cacheInstagramThumbnail,
  cacheTikTokThumbnail,
  getDevProxyThumbnailUrl,
  instagramThumbnailKey,
  isOurS3Url,
  LEGACY_THUMBNAIL_URL_PREFIXES,
  tiktokThumbnailKey,
} from '../lib/beta-link-thumbnails';
import { uploadToS3 } from '../storage/s3';

describe('beta-link-thumbnails: key + url helpers', () => {
  it('builds Instagram and TikTok S3 keys', () => {
    expect(instagramThumbnailKey('ABC123')).toBe('beta-link-thumbnails/instagram/ABC123.jpg');
    expect(tiktokThumbnailKey('cache_xyz')).toBe('beta-link-thumbnails/tiktok/cache_xyz.jpg');
  });

  it('builds dev proxy thumbnail URL with encoded source', () => {
    const remote = 'https://scontent.cdninstagram.com/img.jpg?foo=bar';
    expect(getDevProxyThumbnailUrl(remote)).toBe(`/api/internal/beta-link-thumbnail?url=${encodeURIComponent(remote)}`);
  });

  it('isOurS3Url recognizes the new /static/ prefix and the legacy bucket prefix', () => {
    // Canonical (post-fix) form
    expect(isOurS3Url('/static/beta-link-thumbnails/instagram/ABC.jpg')).toBe(true);
    expect(isOurS3Url('/static/beta-link-thumbnails/tiktok/cache_42.jpg')).toBe(true);
    // Legacy direct-bucket form (still recognized so the resolver short-circuit
    // holds for rows that haven't been backfilled yet).
    expect(isOurS3Url('https://example-bucket.s3.amazonaws.com/beta-link-thumbnails/instagram/ABC.jpg')).toBe(true);
    // Foreign URLs
    expect(isOurS3Url('https://scontent.cdninstagram.com/foo.jpg')).toBe(false);
    expect(isOurS3Url(null)).toBe(false);
  });

  it('recognizes the retired Railway bucket regardless of where storage points now', () => {
    // The pinned list is what keeps this true after storage moved to R2: with
    // recognition derived only from getPublicUrl, a surviving legacy row would
    // look foreign and the resolver would re-fetch and re-cache the image from
    // Instagram — silently, and for every read.
    expect(LEGACY_THUMBNAIL_URL_PREFIXES).toContain('https://t3.storageapi.dev/structured-parcel-ei3jl8g/');
    expect(
      isOurS3Url('https://t3.storageapi.dev/structured-parcel-ei3jl8g/beta-link-thumbnails/instagram/ABC.jpg'),
    ).toBe(true);
    // A different bucket on the same host is NOT ours.
    expect(isOurS3Url('https://t3.storageapi.dev/someone-elses-bucket/beta-link-thumbnails/instagram/ABC.jpg')).toBe(
      false,
    );
  });
});

function mockFetchImageOnce(opts: { ok?: boolean; contentType?: string; body?: Uint8Array } = {}) {
  const { ok = true, contentType = 'image/jpeg', body = new Uint8Array([0xff, 0xd8, 0xff]) } = opts;
  const fetchMock = vi.fn().mockResolvedValueOnce({
    ok,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: () => Promise.resolve(body.buffer),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('cacheInstagramThumbnail', () => {
  beforeEach(() => {
    vi.mocked(uploadToS3).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uploads fetched image to the expected S3 key and returns the static proxy URL', async () => {
    mockFetchImageOnce({ contentType: 'image/jpeg' });

    const url = await cacheInstagramThumbnail('ABC123', 'https://scontent.cdninstagram.com/photo.jpg');

    // Returns the backend-relative /static/ URL (proxied through
    // handleStaticBetaThumbnail), not the direct S3 URL — Tigris on Railway
    // doesn't honor public-read ACLs.
    expect(url).toBe('/static/beta-link-thumbnails/instagram/ABC123.jpg');
    expect(uploadToS3).toHaveBeenCalledTimes(1);
    const [, buffer, key, contentType] = vi.mocked(uploadToS3).mock.calls[0];
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(key).toBe('beta-link-thumbnails/instagram/ABC123.jpg');
    expect(contentType).toBe('image/jpeg');
  });

  it('returns null when the source fetch fails (non-OK)', async () => {
    mockFetchImageOnce({ ok: false });
    const url = await cacheInstagramThumbnail('ABC123', 'https://scontent.cdninstagram.com/photo.jpg');
    expect(url).toBeNull();
    expect(uploadToS3).not.toHaveBeenCalled();
  });

  it('returns null when fetch throws (network error)', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('boom'));
    vi.stubGlobal('fetch', fetchMock);
    const url = await cacheInstagramThumbnail('ABC123', 'https://scontent.cdninstagram.com/photo.jpg');
    expect(url).toBeNull();
    expect(uploadToS3).not.toHaveBeenCalled();
  });

  it('returns null when uploadToS3 throws', async () => {
    mockFetchImageOnce();
    vi.mocked(uploadToS3).mockRejectedValueOnce(new Error('s3 down'));
    const url = await cacheInstagramThumbnail('ABC123', 'https://scontent.cdninstagram.com/photo.jpg');
    expect(url).toBeNull();
  });

  it('falls back to image/jpeg when content-type header is missing', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
    });
    vi.stubGlobal('fetch', fetchMock);

    await cacheInstagramThumbnail('ABC123', 'https://scontent.cdninstagram.com/photo.jpg');

    const [, , , contentType] = vi.mocked(uploadToS3).mock.calls[0];
    expect(contentType).toBe('image/jpeg');
  });
});

describe('cacheTikTokThumbnail', () => {
  beforeEach(() => {
    vi.mocked(uploadToS3).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uploads to the TikTok key prefix', async () => {
    mockFetchImageOnce({ contentType: 'image/webp' });

    const url = await cacheTikTokThumbnail('cache_42', 'https://p16-sign.tiktokcdn.com/photo.webp');

    expect(url).toBe('/static/beta-link-thumbnails/tiktok/cache_42.jpg');
    const [, , key, contentType] = vi.mocked(uploadToS3).mock.calls[0];
    expect(key).toBe('beta-link-thumbnails/tiktok/cache_42.jpg');
    expect(contentType).toBe('image/webp');
  });
});
