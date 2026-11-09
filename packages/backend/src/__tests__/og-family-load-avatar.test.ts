import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchImage } = vi.hoisted(() => ({ fetchImage: vi.fn() }));
vi.mock('../lib/safe-image-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/safe-image-fetch')>()),
  fetchAllowedImage: fetchImage,
}));
vi.mock('../storage/s3', () => ({ getMediaPublicBaseUrl: () => 'https://media.boardsesh.com' }));

import { UnsafeImageHostError } from '../lib/safe-image-fetch';
import {
  decodeCardAvatar,
  loadCardAvatar,
  resetAvatarCache,
  resolveAvatarFetchUrl,
} from '../services/og-family/load-avatar';

const MEDIA_BASE = 'https://media.boardsesh.com';

async function jpegBytes(): Promise<Buffer> {
  return sharp({ create: { width: 400, height: 300, channels: 3, background: '#335577' } })
    .jpeg()
    .toBuffer();
}

describe('resolveAvatarFetchUrl', () => {
  it('maps a stored relative avatar path to the media CDN, keeping its version', () => {
    expect(resolveAvatarFetchUrl('/static/avatars/abc.jpg?v=1', MEDIA_BASE)).toBe(`${MEDIA_BASE}/avatars/abc.jpg?v=1`);
  });

  it('maps a backend-absolute avatar URL to the CDN and drops the resize instruction', () => {
    expect(resolveAvatarFetchUrl('https://ws.boardsesh.com/static/avatars/a.jpg?size=80&v=9', MEDIA_BASE)).toBe(
      `${MEDIA_BASE}/avatars/a.jpg?v=9`,
    );
  });

  it('passes a foreign URL through for the host allowlist to judge', () => {
    expect(resolveAvatarFetchUrl('https://lh3.googleusercontent.com/a/x=s96-c', MEDIA_BASE)).toBe(
      'https://lh3.googleusercontent.com/a/x=s96-c',
    );
  });

  it('refuses path traversal in the file name', () => {
    expect(resolveAvatarFetchUrl('/static/avatars/..%2f..%2fetc/passwd', MEDIA_BASE)).toBeNull();
  });

  it('refuses another of our own routes and any relative path that is not an avatar', () => {
    expect(resolveAvatarFetchUrl('/api/internal/secrets', MEDIA_BASE)).toBeNull();
    expect(resolveAvatarFetchUrl('https://ws.boardsesh.com/graphql', MEDIA_BASE)).not.toContain('/static/avatars/');
  });

  it('has nothing to fetch without a media base and for empty input', () => {
    expect(resolveAvatarFetchUrl('/static/avatars/a.jpg', null)).toBeNull();
    expect(resolveAvatarFetchUrl('   ', MEDIA_BASE)).toBeNull();
  });
});

describe('decodeCardAvatar', () => {
  it('produces a square PNG with a stable digest', async () => {
    const decoded = await decodeCardAvatar(await jpegBytes());
    const metadata = await sharp(decoded!.png).metadata();

    expect(metadata).toMatchObject({ format: 'png', width: 160, height: 160 });
    expect((await decodeCardAvatar(await jpegBytes()))!.digest).toBe(decoded!.digest);
  });

  it('refuses SVG even though sharp can read it', async () => {
    await expect(
      decodeCardAvatar(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>')),
    ).resolves.toBeNull();
  });

  it('throws on bytes that are not an image', async () => {
    await expect(decodeCardAvatar(Buffer.from('not an image at all'))).rejects.toThrow();
  });
});

describe('loadCardAvatar', () => {
  beforeEach(() => {
    resetAvatarCache();
    fetchImage.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('draws nothing for a user without an avatar and never fetches', async () => {
    await expect(loadCardAvatar(null)).resolves.toBeNull();
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it('returns the decoded avatar for a good image', async () => {
    fetchImage.mockResolvedValue(await jpegBytes());

    expect((await loadCardAvatar('/static/avatars/a.jpg'))?.png).toBeInstanceOf(Buffer);
  });

  it.each([
    ['a disallowed host', new UnsafeImageHostError('Host evil.com is not in the avatar allowlist')],
    ['a timeout', new DOMException('aborted', 'TimeoutError')],
    ['a zero-byte body', new UnsafeImageHostError('Image response was empty')],
  ])('returns null, never throws, on %s', async (_label, failure) => {
    fetchImage.mockRejectedValue(failure);

    await expect(loadCardAvatar('/static/avatars/broken.jpg')).resolves.toBeNull();
  });

  it('returns null for an image sharp cannot decode', async () => {
    fetchImage.mockResolvedValue(Buffer.from('still not an image'));

    await expect(loadCardAvatar('/static/avatars/garbage.jpg')).resolves.toBeNull();
  });

  it('remembers a failure so a dead host costs one timeout, not one per request', async () => {
    fetchImage.mockRejectedValue(new Error('down'));

    await loadCardAvatar('/static/avatars/dead.jpg');
    await loadCardAvatar('/static/avatars/dead.jpg');

    expect(fetchImage).toHaveBeenCalledTimes(1);
  });
});
