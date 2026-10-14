import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertCppThumbnailRequestLimit,
  cppBetaThumbnailRequest,
  createCppThumbnailRecording,
} from '../lib/cpp-beta-thumbnails';

afterEach(() => vi.restoreAllMocks());
const path = '/static/beta-link-thumbnails/instagram/C6-VpKiLFfN.jpg';
const request = `${path}?size=280`;
const upstream = 'https://ws.boardsesh.com';
const destination = 'https://media.boardsesh.com/beta-link-thumbnails/instagram/C6-VpKiLFfN.jpg@280.jpg';
const png = () =>
  sharp({ create: { width: 2, height: 3, channels: 3, background: '#234567' } })
    .png()
    .toBuffer();

describe('bounded genuine CPP thumbnail downloads', () => {
  it('uses the exact native cached-thumbnail request and ignores absent thumbnails', () => {
    expect(cppBetaThumbnailRequest(path)).toBe(request);
    expect(cppBetaThumbnailRequest('/static/beta-link-thumbnails/tiktok/123456.jpg')?.endsWith('?size=280')).toBe(true);
    expect(cppBetaThumbnailRequest(null)).toBeNull();
    expect(cppBetaThumbnailRequest('')).toBeNull();
  });
  it.each([
    'https://untrusted.invalid/image.jpg',
    '//127.0.0.1/secret',
    '/static/avatars/user.jpg',
    '/static/beta-link-thumbnails/instagram/../private.jpg',
    '/static/beta-link-thumbnails/instagram/a%2fb.jpg',
    `${path}?size=999`,
    `${path}?token=private`,
    `${path}#fragment`,
    '/api/internal/beta-link-thumbnail?url=private',
    undefined,
  ])('rejects unsupported source %s before fetching', (source) => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    expect(() => cppBetaThumbnailRequest(source)).toThrow('cached native source');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('bounds the complete distinct request set', () => {
    expect(() =>
      assertCppThumbnailRequestLimit(new Set(Array.from({ length: 257 }, (_, index) => String(index)))),
    ).toThrow('request limit');
  });
  it('records unchanged raster bytes after the exact public media redirect without forwarding credentials', async () => {
    const bytes = await png();
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: destination } }))
      .mockResolvedValueOnce(
        new Response(Uint8Array.from(bytes), {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': String(bytes.length) },
        }),
      );
    const recording = createCppThumbnailRecording(upstream, new Set([request]));
    expect(await recording.download(path, 'size=280')).toEqual({ bytes, contentType: 'image/png' });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([`${upstream}${request}`, destination]);
    for (const [, options] of fetcher.mock.calls) {
      expect(options?.redirect).toBe('manual');
      expect(options?.headers).toBeUndefined();
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    }
    recording.recorded(
      { path, query: 'size=280', file: 'static/actual.png', bytes: bytes.length, contentType: 'image/png' },
      new Date().toISOString(),
    );
    expect(recording.proofs[0]).toMatchObject({
      request,
      sourceUrl: destination,
      status: 200,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      width: 2,
      height: 3,
    });
    expect(recording.proofs[0].recordedAt).toBeTruthy();
    await expect(recording.download(path, 'size=280')).rejects.toThrow('more than once');
  });
  it.each([
    'https://media.boardsesh.com/beta-link-thumbnails/instagram/another.jpg@280.jpg',
    'https://media.boardsesh.com/beta-link-thumbnails/instagram/C6-VpKiLFfN.jpg',
    'https://media.boardsesh.com.evil.invalid/beta-link-thumbnails/instagram/C6-VpKiLFfN.jpg@280.jpg',
    'http://media.boardsesh.com/beta-link-thumbnails/instagram/C6-VpKiLFfN.jpg@280.jpg',
    'https://user:secret@media.boardsesh.com/beta-link-thumbnails/instagram/C6-VpKiLFfN.jpg@280.jpg',
    'http://127.0.0.1/private',
    `${destination}?signed-secret=hidden`,
  ])('refuses an unexpected redirect without following it', async (location) => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
    const recording = createCppThumbnailRecording(upstream, new Set([request]));
    await expect(recording.download(path, 'size=280')).rejects.toThrow(
      /^CPP beta thumbnail genuine image download failed$/,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(recording.proofs).toEqual([]);
  });
  it('refuses a second redirect and never follows an off-policy CDN hop', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: destination } }))
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://untrusted.invalid/secret' } }),
      );
    await expect(createCppThumbnailRecording(upstream, new Set([request])).download(path, 'size=280')).rejects.toThrow(
      'genuine image download failed',
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects any request absent from the verified response scope before network access', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    await expect(createCppThumbnailRecording(upstream, new Set()).download(path, 'size=280')).rejects.toThrow(
      'verified detail scope',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['declared oversize', 'stream oversize', 'declared mismatch', 'empty', 'wrong MIME', 'truncated'])(
    'rejects %s without issuing a recording receipt',
    async (failure) => {
      const bytes = await png();
      const body =
        failure === 'stream oversize'
          ? new Uint8Array(2 * 1024 * 1024 + 1)
          : failure === 'empty'
            ? new Uint8Array()
            : Uint8Array.from(failure === 'truncated' ? bytes.subarray(0, 20) : bytes);
      const headers: Record<string, string> = { 'content-type': failure === 'wrong MIME' ? 'image/jpeg' : 'image/png' };
      if (failure === 'declared oversize') headers['content-length'] = String(2 * 1024 * 1024 + 1);
      if (failure === 'declared mismatch') headers['content-length'] = String(bytes.length + 1);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200, headers }));
      const recording = createCppThumbnailRecording(upstream, new Set([request]));
      await expect(recording.download(path, 'size=280')).rejects.toThrow('genuine image download failed');
      expect(recording.proofs).toEqual([]);
    },
  );
  it('rejects a recorder receipt whose byte count differs from the downloaded image', async () => {
    const bytes = await png();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(Uint8Array.from(bytes), { headers: { 'content-type': 'image/png' } }),
    );
    const recording = createCppThumbnailRecording(upstream, new Set([request]));
    await recording.download(path, 'size=280');
    expect(() =>
      recording.recorded(
        { path, query: 'size=280', file: 'static/wrong.png', bytes: bytes.length + 1, contentType: 'image/png' },
        new Date().toISOString(),
      ),
    ).toThrow('actual response');
  });
});
