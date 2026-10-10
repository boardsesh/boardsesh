import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import {
  bindFixtureAssetUrls,
  captureFixturePhoto,
  SCREENSHOT_FIXTURE_ASSET_ORIGIN,
} from '../lib/screenshot-fixture-assets';

const wallUuid = '00000000-0000-4000-8000-000000000047';
const signedUrl = `https://private.example.r2.cloudflarestorage.com/spray-walls/${wallUuid}/wall.jpg?X-Amz-Signature=private-signature`;
const assetPath = `/static/campaign-spray/${'a'.repeat(64)}.jpg`;

async function imageBytes() {
  return sharp({ create: { width: 3, height: 3, channels: 3, background: '#83695e' } })
    .jpeg()
    .toBuffer();
}

describe('portable spray photo fixtures', () => {
  it('captures exact genuine bytes, replaces expiring URLs, and keeps geometry', async () => {
    const bytes = await imageBytes();
    const download = vi.fn<typeof fetch>(
      async () => new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    );
    const result = await captureFixturePhoto(
      { url: signedUrl, thumbUrl: signedUrl, expiresAt: '2026-10-01T00:00:00Z', width: 1752, height: 1700 },
      wallUuid,
      download,
    );
    expect(result.assets).toHaveLength(2);
    expect(result.assets[0].bytes.equals(bytes)).toBe(true);
    expect(result.photo).toMatchObject({ width: 1752, height: 1700, expiresAt: '9999-12-31T23:59:59.000Z' });
    expect(result.photo.url).toMatch(
      /^https:\/\/screenshot-fixtures\.boardsesh\.invalid\/static\/campaign-spray\/[a-f0-9]{64}\.jpg$/,
    );
    expect(JSON.stringify(result)).not.toContain('private-signature');
  });

  it.each([
    'https://boardsesh.com/other.jpg',
    'http://private.example.r2.cloudflarestorage.com/spray-walls/wrong/photo.jpg',
    'https://private.example.r2.cloudflarestorage.com/spray-walls/another-wall/photo.jpg',
  ])('refuses an unapproved photo source', async (url) => {
    const download = vi.fn<typeof fetch>();
    await expect(captureFixturePhoto({ url, expiresAt: '' }, wallUuid, download)).rejects.toThrow(/authorized wall/);
    expect(download).not.toHaveBeenCalled();
  });

  it('rejects oversized, failed and nonimage downloads without an expiring fallback', async () => {
    for (const response of [
      new Response('denied', { status: 403 }),
      new Response('html', { status: 200 }),
      new Response('tiny', { status: 200, headers: { 'content-length': String(21 * 1024 * 1024) } }),
    ]) {
      await expect(
        captureFixturePhoto(
          { url: signedUrl, expiresAt: '' },
          wallUuid,
          vi.fn<typeof fetch>(async () => response),
        ),
      ).rejects.toThrow();
    }
  });

  it('does not leak signed URLs through download or stream errors', async () => {
    const failedFetch = vi.fn<typeof fetch>(async () => {
      throw new Error(signedUrl);
    });
    await expect(captureFixturePhoto({ url: signedUrl, expiresAt: '' }, wallUuid, failedFetch)).rejects.toThrow(
      'Could not download the authorized spray photo',
    );
    const failedBody = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error(signedUrl);
      },
    });
    await expect(
      captureFixturePhoto(
        { url: signedUrl, expiresAt: '' },
        wallUuid,
        vi.fn<typeof fetch>(async () => new Response(failedBody)),
      ),
    ).rejects.toThrow('Spray photo download body failed');
  });
});

describe('replay asset URL binding', () => {
  it('binds only bundled reserved URLs to the actual replay port', () => {
    const body = JSON.stringify({
      data: {
        photo: { url: `${SCREENSHOT_FIXTURE_ASSET_ORIGIN}${assetPath}` },
        other: 'https://boardsesh.com/public.jpg',
      },
    });
    expect(JSON.parse(bindFixtureAssetUrls(body, 'http://localhost:12345', [assetPath]))).toEqual({
      data: { photo: { url: `http://localhost:12345${assetPath}` }, other: 'https://boardsesh.com/public.jpg' },
    });
  });
  it('fails before replay for unlisted or malformed reserved references', () => {
    expect(() =>
      bindFixtureAssetUrls(
        JSON.stringify({ url: `${SCREENSHOT_FIXTURE_ASSET_ORIGIN}${assetPath}` }),
        'http://localhost',
        [],
      ),
    ).toThrow(/missing from manifest/);
    expect(() =>
      bindFixtureAssetUrls(JSON.stringify({ url: `${SCREENSHOT_FIXTURE_ASSET_ORIGIN}/graphql` }), 'http://localhost', [
        '/graphql',
      ]),
    ).toThrow(/Invalid reserved/);
    expect(() =>
      bindFixtureAssetUrls(
        JSON.stringify({ url: `${SCREENSHOT_FIXTURE_ASSET_ORIGIN}.evil${assetPath}` }),
        'http://localhost',
        [assetPath],
      ),
    ).toThrow(/Invalid reserved/);
  });
});
