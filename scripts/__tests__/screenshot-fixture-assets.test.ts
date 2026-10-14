import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import {
  bindFixtureAssetUrls,
  captureFixturePhoto,
  SCREENSHOT_FIXTURE_ASSET_ORIGIN,
} from '../lib/screenshot-fixture-assets';
import { sprayDraftPurpose, sprayPhotoObjectIdentity } from '../../packages/mobile/src/lib/spray/spray-draft-purpose';

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

  it('preserves the native hold-edit decision through portable transport and local binding', async () => {
    const bytes = await imageBytes();
    const objectPath = `/spray-walls/${wallUuid}/00000000-0000-4000-8000-000000000048.jpg`;
    const source = `https://private.example.r2.cloudflarestorage.com${objectPath}?X-Amz-Signature=private`;
    const capture = (url: string) =>
      captureFixturePhoto(
        { url, expiresAt: '2026-10-01T00:00:00Z' },
        wallUuid,
        vi.fn<typeof fetch>(async () => new Response(new Uint8Array(bytes))),
      );
    const published = await capture(source);
    const draft = await capture(source.replace('Signature=private', 'Signature=renewed'));
    const otherPhoto = await capture(source.replace('000000000048.jpg', '000000000049.jpg'));
    const local = (captured: Awaited<ReturnType<typeof capture>>) =>
      JSON.parse(
        bindFixtureAssetUrls(
          JSON.stringify(captured.photo),
          'http://localhost:12345',
          captured.assets.map(({ path }) => path),
        ),
      ) as { url: string };
    const version = (url: string) => ({
      photo: { url, thumbUrl: null, expiresAt: '9999-12-31T23:59:59.000Z', width: 3, height: 3 },
      anchors: null,
      homography: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    });
    expect(sprayPhotoObjectIdentity(local(published).url)).toBe(objectPath.slice(1));
    expect(sprayDraftPurpose(version(local(draft).url), version(local(published).url))).toBe('hold-edit');
    // Equal bytes do not make different original objects the same photo.
    expect(otherPhoto.assets[0].file).toBe(published.assets[0].file);
    expect(otherPhoto.assets[0].path).not.toBe(published.assets[0].path);
    expect(sprayDraftPurpose(version(local(otherPhoto).url), version(local(published).url))).toBe('reset');
    const changedGeometry = { ...version(local(draft).url), homography: [2, 0, 0, 0, 1, 0, 0, 0, 1] };
    expect(sprayDraftPurpose(changedGeometry, version(local(published).url))).toBe('reset');
    for (const captured of [published, draft, otherPhoto]) {
      expect(captured.assets[0].bytes).toEqual(bytes);
      expect(JSON.stringify(captured.photo)).not.toContain('Signature');
    }
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

  it.each([
    `/static/campaign-spray/${'a'.repeat(64)}/spray-walls/${wallUuid}/not-a-photo.jpg`,
    `/static/campaign-spray/${'a'.repeat(64)}/spray-walls/${wallUuid}/00000048.jpg/extra`,
    `/static/campaign-spray/${'a'.repeat(64)}/spray-walls/${wallUuid}/00000048.jpg?token=private`,
    `/static/campaign-spray/${'a'.repeat(64)}/spray-walls/${wallUuid}/00000048.jpg#fragment`,
    `/static/campaign-spray/${'a'.repeat(64)}/spray-walls/${wallUuid}/%2e%2e/00000048.jpg`,
    `/static/campaign-spray/${'a'.repeat(63)}/spray-walls/${wallUuid}/00000048.jpg`,
  ])('rejects malformed object-preserving references even when listed: %s', (path) => {
    expect(() =>
      bindFixtureAssetUrls(JSON.stringify({ url: `${SCREENSHOT_FIXTURE_ASSET_ORIGIN}${path}` }), 'http://localhost', [
        path,
      ]),
    ).toThrow(/Invalid reserved/);
  });
});
