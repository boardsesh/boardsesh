import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dns.lookup before importing the module under test so the lookup call
// is intercepted. The real resolver returns external IPs for IG/TikTok hosts
// in CI, but we want tests to run offline and to deterministically exercise
// the private-IP rejection path.
const { mockDnsLookup } = vi.hoisted(() => ({
  mockDnsLookup: vi.fn<typeof import('node:dns/promises').lookup>(),
}));

vi.mock('node:dns/promises', () => ({
  lookup: mockDnsLookup,
}));

import { assertAllowedImageHost, fetchAllowedImage, isPrivateIp, UnsafeImageHostError } from '../lib/safe-image-fetch';

const lookupResolves = (addr: string, family = 4) => {
  // dns.lookup overload returning all addresses when called with `{ all: true }`.
  // The default overload signature returns a single address; we cast via
  // unknown to mock the all-addresses overload our module uses.
  mockDnsLookup.mockResolvedValue([{ address: addr, family }] as unknown as Awaited<
    ReturnType<typeof import('node:dns/promises').lookup>
  >);
};

describe('isPrivateIp', () => {
  it('detects RFC1918 IPv4 ranges', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('172.16.5.5')).toBe(true);
    expect(isPrivateIp('172.31.255.254')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
  });

  it('detects loopback and link-local IPv4', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('169.254.169.254')).toBe(true); // AWS IMDS
    expect(isPrivateIp('169.254.1.1')).toBe(true);
  });

  it('detects CGNAT, multicast, and 0.0.0.0/8', () => {
    expect(isPrivateIp('100.64.0.1')).toBe(true);
    expect(isPrivateIp('100.127.255.254')).toBe(true);
    expect(isPrivateIp('224.0.0.1')).toBe(true);
    expect(isPrivateIp('239.255.255.255')).toBe(true);
    expect(isPrivateIp('0.0.0.0')).toBe(true);
  });

  it('passes public IPv4 through', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('157.240.0.0')).toBe(false); // Facebook
    expect(isPrivateIp('172.32.0.1')).toBe(false); // outside 172.16-31
    expect(isPrivateIp('172.15.255.255')).toBe(false);
  });

  it('detects loopback, link-local, and ULA IPv6', () => {
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('::')).toBe(true);
    expect(isPrivateIp('fe80::1')).toBe(true);
    expect(isPrivateIp('fc00::1')).toBe(true);
    expect(isPrivateIp('fdff::beef')).toBe(true);
  });

  it('passes public IPv6 through', () => {
    expect(isPrivateIp('2001:db8::1')).toBe(false);
    expect(isPrivateIp('2620:2d:4000:1::1')).toBe(false);
  });

  it('rejects IPv4-mapped IPv6 addresses with private embedded IPv4', () => {
    expect(isPrivateIp('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIp('::ffff:8.8.8.8')).toBe(false);
  });
});

describe('assertAllowedImageHost', () => {
  beforeEach(() => {
    mockDnsLookup.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('accepts known FB CDN / IG hosts when DNS resolves to a public IP', async () => {
    lookupResolves('157.240.241.63');
    await expect(
      assertAllowedImageHost('https://scontent.cdninstagram.com/foo.jpg', 'instagram'),
    ).resolves.toBeUndefined();
    await expect(
      assertAllowedImageHost('https://scontent-iad3-1.fbcdn.net/x.jpg', 'instagram'),
    ).resolves.toBeUndefined();
  });

  it('accepts known TikTok CDN hosts', async () => {
    lookupResolves('150.101.34.180');
    await expect(
      assertAllowedImageHost('https://p16-common-sign.tiktokcdn.com/photo.jpg', 'tiktok'),
    ).resolves.toBeUndefined();
    await expect(
      assertAllowedImageHost('https://p16-sign.tiktokcdn-us.com/photo.jpg', 'tiktok'),
    ).resolves.toBeUndefined();
    // EU CDN — thumbnails served to European clients land on tiktokcdn-eu.com.
    // The dev proxy already treats this suffix as valid; the S3-cache path
    // must too, otherwise EU-region TikTok thumbnails silently fail to cache.
    await expect(
      assertAllowedImageHost('https://p16-sign.tiktokcdn-eu.com/photo.jpg', 'tiktok'),
    ).resolves.toBeUndefined();
  });

  it('rejects non-https URLs', async () => {
    await expect(
      assertAllowedImageHost('http://scontent.cdninstagram.com/foo.jpg', 'instagram'),
    ).rejects.toBeInstanceOf(UnsafeImageHostError);
  });

  it('rejects unparseable URLs', async () => {
    await expect(assertAllowedImageHost('not-a-url', 'instagram')).rejects.toBeInstanceOf(UnsafeImageHostError);
  });

  it('rejects hosts outside the platform allowlist', async () => {
    await expect(assertAllowedImageHost('https://example.com/foo.jpg', 'instagram')).rejects.toBeInstanceOf(
      UnsafeImageHostError,
    );
    await expect(assertAllowedImageHost('https://localhost/foo.jpg', 'instagram')).rejects.toBeInstanceOf(
      UnsafeImageHostError,
    );
  });

  it('rejects an IG host when called with kind: tiktok and vice versa', async () => {
    await expect(assertAllowedImageHost('https://scontent.cdninstagram.com/foo.jpg', 'tiktok')).rejects.toBeInstanceOf(
      UnsafeImageHostError,
    );
    await expect(assertAllowedImageHost('https://p16-sign.tiktokcdn.com/foo.jpg', 'instagram')).rejects.toBeInstanceOf(
      UnsafeImageHostError,
    );
  });

  it('rejects allowlisted hostnames that resolve to a private IP (DNS rebinding defense)', async () => {
    lookupResolves('169.254.169.254');
    await expect(
      assertAllowedImageHost('https://scontent.cdninstagram.com/foo.jpg', 'instagram'),
    ).rejects.toBeInstanceOf(UnsafeImageHostError);
  });

  it('rejects when DNS resolution itself fails', async () => {
    mockDnsLookup.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(
      assertAllowedImageHost('https://scontent.cdninstagram.com/foo.jpg', 'instagram'),
    ).rejects.toBeInstanceOf(UnsafeImageHostError);
  });
});

describe('assertAllowedImageHost avatar kind', () => {
  beforeEach(() => mockDnsLookup.mockReset());

  it.each(['https://media.boardsesh.com/avatars/a.jpg', 'https://lh3.googleusercontent.com/a/x=s96-c'])(
    'accepts %s',
    async (url) => {
      lookupResolves('172.253.115.132');
      await expect(assertAllowedImageHost(url, 'avatar')).resolves.toBeUndefined();
    },
  );

  it.each([
    'https://evil.com/a.jpg',
    'https://ws.boardsesh.com/static/avatars/a.jpg',
    'https://media.boardsesh.com.evil.com/a.jpg',
    'https://backend.railway.internal/a.jpg',
    'http://media.boardsesh.com/avatars/a.jpg',
  ])('refuses %s without resolving it', async (url) => {
    await expect(assertAllowedImageHost(url, 'avatar')).rejects.toBeInstanceOf(UnsafeImageHostError);
    expect(mockDnsLookup).not.toHaveBeenCalled();
  });

  it('refuses an allowed host that resolves to a private address', async () => {
    lookupResolves('10.0.0.8');
    await expect(assertAllowedImageHost('https://media.boardsesh.com/a.jpg', 'avatar')).rejects.toThrow(/private IP/);
  });
});

describe('fetchAllowedImage', () => {
  const AVATAR_URL = 'https://media.boardsesh.com/avatars/a.jpg';
  const options = { timeoutMs: 1000, maxBytes: 1024 };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockDnsLookup.mockReset();
    lookupResolves('104.18.1.1');
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const imageResponse = (body: BodyInit | null, headers: Record<string, string> = { 'content-type': 'image/jpeg' }) =>
    new Response(body, { status: 200, headers });

  it('returns the bytes of an allowed image', async () => {
    fetchMock.mockResolvedValue(imageResponse(new Uint8Array([1, 2, 3])));

    await expect(fetchAllowedImage(AVATAR_URL, 'avatar', options)).resolves.toEqual(Buffer.from([1, 2, 3]));
  });

  it('refuses to follow redirects', async () => {
    fetchMock.mockResolvedValue(imageResponse(new Uint8Array([1])));

    await fetchAllowedImage(AVATAR_URL, 'avatar', options);

    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });

  it('checks the host before making the request', async () => {
    await expect(fetchAllowedImage('https://evil.com/a.jpg', 'avatar', options)).rejects.toBeInstanceOf(
      UnsafeImageHostError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a non-200', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 404, headers: { 'content-type': 'image/jpeg' } }));

    await expect(fetchAllowedImage(AVATAR_URL, 'avatar', options)).rejects.toThrow(/answered 404/);
  });

  it('rejects a non-image content type even with a body', async () => {
    fetchMock.mockResolvedValue(imageResponse('<html>', { 'content-type': 'text/html' }));

    await expect(fetchAllowedImage(AVATAR_URL, 'avatar', options)).rejects.toThrow(/non-image/);
  });

  it('rejects a zero-byte body, which is a real 200 with image/jpeg', async () => {
    fetchMock.mockResolvedValue(imageResponse(new Uint8Array()));

    await expect(fetchAllowedImage(AVATAR_URL, 'avatar', options)).rejects.toThrow(/empty/);
  });

  it('rejects an oversized declared length before reading it', async () => {
    fetchMock.mockResolvedValue(
      imageResponse(new Uint8Array([1]), { 'content-type': 'image/jpeg', 'content-length': '999999' }),
    );

    await expect(fetchAllowedImage(AVATAR_URL, 'avatar', options)).rejects.toThrow(/exceeds/);
  });

  it('rejects a body larger than the cap whose length was not declared', async () => {
    fetchMock.mockResolvedValue(imageResponse(new Uint8Array(2048)));

    await expect(fetchAllowedImage(AVATAR_URL, 'avatar', options)).rejects.toThrow(/byte cap/);
  });
});
