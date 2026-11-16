import { describe, expect, it } from 'vitest';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyFixtureOverlay, validateFixtureOverlayReference } from '../lib/screenshot-fixture-overlay';
import { snapshotHash, readFixtureSnapshotReference } from '../lib/screenshot-fixture-snapshot';
import type { ScreenshotFixtureManifest } from '../lib/screenshot-fixtures';

const baseSha = 'a'.repeat(64);
const manifest: ScreenshotFixtureManifest = {
  formatVersion: 1,
  recordedAt: '2026-11-15T00:00:00Z',
  frozenNow: '2026-11-15T00:00:00Z',
  upstream: 'https://ws.boardsesh.com',
  accountEmail: 'test@example.com',
  accountUserId: 'test-user',
  flow: 'smoke',
  graphql: [],
  static: [],
};
const entry = {
  operationName: 'GetCrewFeed',
  documentHash: 'document',
  variablesHash: 'variables',
  file: 'graphql/GetCrewFeed/example.json',
};
const fixture = { variables: { input: { limit: 20 } }, response: { data: { crewFeed: { items: [] } } } };
const base = new Map([['manifest.json', Buffer.from(JSON.stringify(manifest))]]);
function overlay(
  changes: Record<string, string> = {
    'manifest.json': JSON.stringify({ ...manifest, graphql: [entry] }),
    [entry.file]: JSON.stringify(fixture),
  },
  baseline = baseSha,
) {
  const bytes = gzipSync(
    JSON.stringify({
      version: 1,
      baseSha256: baseline,
      files: Object.fromEntries(
        Object.entries(changes).map(([path, text]) => [path, Buffer.from(text).toString('base64')]),
      ),
    }),
  );
  const sha256 = snapshotHash(bytes);
  return {
    bytes,
    reference: {
      path: `app-stores/screenshot-fixture-overlays/${sha256}.json.gz`,
      sha256,
      bytes: bytes.length,
      files: 2,
    },
  };
}
describe('recorded replay overlays', () => {
  it('adds sanitized recordings without changing archived bytes', () => {
    const { bytes, reference } = overlay();
    const merged = applyFixtureOverlay(base, baseSha, bytes, reference);
    expect(merged.size).toBe(2);
    expect(base.size).toBe(1);
    expect(JSON.parse(merged.get(entry.file)!.toString())).toEqual(fixture);
  });
  it('rejects tampered bytes and a different baseline', () => {
    const { bytes, reference } = overlay();
    expect(() => applyFixtureOverlay(base, baseSha, Buffer.concat([bytes, Buffer.from('x')]), reference)).toThrow(
      'checksum',
    );
    expect(() => applyFixtureOverlay(base, 'b'.repeat(64), bytes, reference)).toThrow('baseline');
  });
  it('rejects replacing a recorded response', () => {
    const { bytes, reference } = overlay();
    expect(() =>
      applyFixtureOverlay(new Map([...base, [entry.file, Buffer.from('{}')]]), baseSha, bytes, reference),
    ).toThrow('replace');
  });
  it('rejects changing account provenance or including credentials', () => {
    let candidate = overlay({
      'manifest.json': JSON.stringify({ ...manifest, accountUserId: 'another', graphql: [entry] }),
      [entry.file]: JSON.stringify(fixture),
    });
    expect(() => applyFixtureOverlay(base, baseSha, candidate.bytes, candidate.reference)).toThrow('provenance');
    candidate = overlay({
      'manifest.json': JSON.stringify({ ...manifest, graphql: [entry] }),
      [entry.file]: JSON.stringify({ ...fixture, variables: { password: 'not-a-real-secret' } }),
    });
    expect(() => applyFixtureOverlay(base, baseSha, candidate.bytes, candidate.reference)).toThrow('unsanitized');
  });
  it('rejects paths outside the committed overlay directory', () => {
    const { reference } = overlay();
    expect(() => validateFixtureOverlayReference({ ...reference, path: '../../private' })).toThrow('Invalid');
  });
  it('pins genuine crew recordings and dependent requests in the repository artifact', () => {
    const reference = readFixtureSnapshotReference();
    expect(reference.overlay).toBeDefined();
    const bytes = readFileSync(resolve(import.meta.dirname, '../../', reference.overlay!.path));
    expect(snapshotHash(bytes)).toBe(reference.overlay!.sha256);
    expect(bytes.length).toBe(reference.overlay!.bytes);
    const archive = JSON.parse(gunzipSync(bytes).toString()) as { baseSha256: string; files: Record<string, string> };
    expect(archive.baseSha256).toBe(reference.sha256);
    const recordings = Object.entries(archive.files)
      .filter(([name]) => name.startsWith('graphql/'))
      .map(([, content]) => JSON.parse(Buffer.from(content, 'base64').toString()));
    const manifest = JSON.parse(Buffer.from(archive.files['manifest.json'], 'base64').toString()) as {
      static: Array<{ file: string; bytes: number }>;
    };
    const bundledImages = Object.entries(archive.files).filter(([name]) => name.startsWith('static/'));
    expect(bundledImages).toHaveLength(5);
    for (const [file, encoded] of bundledImages) {
      expect(Buffer.from(encoded, 'base64').byteLength).toBe(
        manifest.static.find((entry) => entry.file === file)?.bytes,
      );
    }
    expect(recordings.filter((recording) => recording.operationName === 'GetCrewFeed')).toHaveLength(4);
    for (const recording of recordings) {
      expect(recording.status).toBe(200);
      expect(recording.upstream).toBe('https://ws.boardsesh.com');
      expect(recording.response.errors).toBeUndefined();
    }
    for (const recording of recordings.filter((recording) => recording.operationName === 'GetCrewFeed'))
      expect(recording.response.data.crewFeed.items).toHaveLength(20);
    expect(recordings.some((recording) => recording.operationName === 'GetSessionWorkoutHeadlines')).toBe(true);
  });
});
