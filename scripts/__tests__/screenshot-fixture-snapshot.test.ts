import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeFixtureSnapshot,
  ensureScreenshotFixtures,
  fetchFixtureSnapshotReference,
  installFixtureSnapshotReference,
  snapshotHash,
  type FixtureSnapshotReference,
} from '../lib/screenshot-fixture-snapshot';

const directories: string[] = [];
function cacheDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'fixture-snapshot-'));
  directories.push(directory);
  return directory;
}
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function snapshot(
  files: Record<string, string> = { 'manifest.json': '{}', 'graphql/GetClimbs/abc.json': '{"climbs":[]}' },
) {
  const bytes = gzipSync(
    JSON.stringify({
      version: 1,
      files: Object.fromEntries(
        Object.entries(files).map(([path, body]) => [path, Buffer.from(body).toString('base64')]),
      ),
    }),
  );
  const reference: FixtureSnapshotReference = {
    version: 1,
    url: 'https://example.com/fixtures.json.gz',
    sha256: snapshotHash(bytes),
    bytes: bytes.length,
    files: Object.keys(files).length,
  };
  return { bytes, reference };
}

describe('pinned screenshot fixture snapshots', () => {
  it('validates a candidate reference before downloading its archive through ordinary integrity checks', async () => {
    const { bytes, reference } = snapshot();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(reference)))
      .mockResolvedValueOnce(new Response(new Uint8Array(bytes)));
    const candidate = await fetchFixtureSnapshotReference('https://example.com/reference.json', request);
    const directory = await ensureScreenshotFixtures(candidate, cacheDirectory(), request);
    expect(readFileSync(join(directory, 'graphql/GetClimbs/abc.json'), 'utf8')).toBe('{"climbs":[]}');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    'http://example.com/reference.json',
    'https://localhost/reference.json',
    'https://127.0.0.1/reference.json',
    'https://user:secret@example.com/reference.json',
  ])('rejects a nonpublic candidate reference URL before network access: %s', async (url) => {
    const request = vi.fn<typeof fetch>();
    await expect(fetchFixtureSnapshotReference(url, request)).rejects.toThrow('public HTTPS');
    expect(request).not.toHaveBeenCalled();
  });

  it('bounds the reference response before parsing and rejects an invalid archive pin', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(' '.repeat(16 * 1024 + 1)));
    await expect(fetchFixtureSnapshotReference('https://example.com/reference.json', request)).rejects.toThrow(
      '16 KiB',
    );
    const invalid = { ...snapshot().reference, sha256: 'fake', bytes: 0 };
    request.mockResolvedValueOnce(new Response(JSON.stringify(invalid)));
    await expect(fetchFixtureSnapshotReference('https://example.com/reference.json', request)).rejects.toThrow(
      'Invalid fixture snapshot reference',
    );
  });

  it('rejects an HTTP error and a candidate pin pointing at a private archive', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('missing', { status: 404 }));
    await expect(fetchFixtureSnapshotReference('https://example.com/reference.json', request)).rejects.toThrow(
      'HTTP 404',
    );
    request.mockResolvedValueOnce(
      new Response(JSON.stringify({ ...snapshot().reference, url: 'https://localhost/archive.gz' })),
    );
    await expect(fetchFixtureSnapshotReference('https://example.com/reference.json', request)).rejects.toThrow(
      'public HTTPS',
    );
  });

  it('never replaces the committed pin when a candidate archive checksum fails', async () => {
    const { bytes, reference } = snapshot();
    const directory = cacheDirectory();
    const pin = join(directory, 'pinned-reference.json');
    const previous = JSON.stringify(snapshot({ 'manifest.json': '{"old":true}' }).reference);
    writeFileSync(pin, previous);
    bytes[bytes.length - 1] ^= 1;
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(reference)))
      .mockResolvedValueOnce(new Response(new Uint8Array(bytes)));
    await expect(
      installFixtureSnapshotReference('https://example.com/candidate.json', pin, join(directory, 'cache'), request),
    ).rejects.toThrow('checksum');
    expect(readFileSync(pin, 'utf8')).toBe(previous);
  });

  it('installs a verified candidate pin and preserves the old content-addressed cache', async () => {
    const old = snapshot({ 'manifest.json': '{"old":true}' });
    const candidate = snapshot();
    const directory = cacheDirectory();
    const pin = join(directory, 'pinned-reference.json');
    const oldRequest = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(old.bytes)));
    const previousCache = await ensureScreenshotFixtures(old.reference, directory, oldRequest);
    writeFileSync(pin, JSON.stringify(old.reference));
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(candidate.reference)))
      .mockResolvedValueOnce(new Response(new Uint8Array(candidate.bytes)));
    const candidateCache = await installFixtureSnapshotReference(
      'https://example.com/candidate.json',
      pin,
      directory,
      request,
    );
    expect(JSON.parse(readFileSync(pin, 'utf8'))).toEqual(candidate.reference);
    expect(candidateCache).not.toBe(previousCache);
    expect(readFileSync(join(previousCache, 'manifest.json'), 'utf8')).toBe('{"old":true}');
  });

  it('downloads once, verifies offline cache bytes, and repairs an altered extracted file', async () => {
    const { bytes, reference } = snapshot();
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(bytes)));
    const cache = cacheDirectory();
    const directory = await ensureScreenshotFixtures(reference, cache, request);
    const fixture = join(directory, 'graphql/GetClimbs/abc.json');
    expect(readFileSync(fixture, 'utf8')).toBe('{"climbs":[]}');
    writeFileSync(fixture, 'corrupt');
    const offline = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    expect(await ensureScreenshotFixtures(reference, cache, offline)).toBe(directory);
    expect(readFileSync(fixture, 'utf8')).toBe('{"climbs":[]}');
    expect(request).toHaveBeenCalledOnce();
    expect(offline).not.toHaveBeenCalled();
  });

  it('refuses corrupt downloads before creating any cache files', async () => {
    const { bytes, reference } = snapshot();
    bytes[bytes.length - 1] ^= 1;
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(bytes)));
    const cache = cacheDirectory();
    await expect(ensureScreenshotFixtures(reference, cache, request)).rejects.toThrow('checksum');
    expect(readdirSync(cache)).toEqual([]);
  });

  it('refuses oversized downloads before creating any cache files', async () => {
    const { bytes, reference } = snapshot();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(new Uint8Array(Buffer.concat([bytes, bytes]))));
    const cache = cacheDirectory();
    await expect(ensureScreenshotFixtures(reference, cache, request)).rejects.toThrow('exceeds');
    expect(readdirSync(cache)).toEqual([]);
  });

  it.each(['../secret', '/tmp/secret', 'graphql/../../secret', 'static//secret', 'credentials.env'])(
    'rejects snapshot paths outside fixture content: %s',
    (path) => {
      const { bytes, reference } = snapshot({ 'manifest.json': '{}', [path]: 'payload' });
      expect(() => decodeFixtureSnapshot(bytes, reference)).toThrow('path');
    },
  );

  it('keeps earlier snapshot versions intact when the pin changes', async () => {
    const first = snapshot();
    const second = snapshot({ 'manifest.json': '{"next":true}', 'graphql/GetClimbs/abc.json': '{"climbs":[1]}' });
    const cache = cacheDirectory();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(new Uint8Array(first.bytes)))
      .mockResolvedValueOnce(new Response(new Uint8Array(second.bytes)));
    const previous = await ensureScreenshotFixtures(first.reference, cache, request);
    const current = await ensureScreenshotFixtures(second.reference, cache, request);
    expect(current).not.toBe(previous);
    expect(readFileSync(join(previous, 'manifest.json'), 'utf8')).toBe('{}');
    expect(readFileSync(join(current, 'manifest.json'), 'utf8')).toBe('{"next":true}');
  });
});
