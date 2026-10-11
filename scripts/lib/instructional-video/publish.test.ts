import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  planTutorialPublication,
  publishTutorialBundle,
  validateTutorialBundle,
  type TutorialBundle,
  type TutorialBundleAsset,
  type TutorialPublisherTransport,
} from './publish';
import type { TutorialTakeManifest } from './types';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const fingerprint = 'b'.repeat(64);
const capture: TutorialTakeManifest = {
  formatVersion: 1,
  takeId: 'crew',
  platform: 'android',
  fps: 30,
  width: 1080,
  height: 1920,
  screen: { width: 1080, height: 1920 },
  frameCount: 300,
  seconds: 10,
  sourceCommit: 'c'.repeat(40),
  sourceDirty: false,
  nativeArtifactSha256: 'a'.repeat(64),
  fingerprint,
  marks: { joined: 0 },
  anchors: {},
};
async function makeBundle(): Promise<{ directory: string; bundle: TutorialBundle }> {
  const directory = await mkdtemp(join(tmpdir(), 'tutorial-publish-test-'));
  temporaryDirectories.push(directory);
  const files: [TutorialBundleAsset['kind'], string, string][] = [
    ['video', 'master.mp4', 'video/mp4'],
    ['cover', 'master.webp', 'image/webp'],
    ['subtitles', 'master.vtt', 'text/vtt'],
    ['chapters', 'chapters.json', 'application/json'],
    ['caption', 'caption.txt', 'text/plain'],
  ];
  const assets: TutorialBundleAsset[] = [];
  for (const [kind, filename, contentType] of files) {
    const bytes = Buffer.from(`sample-reviewed-${kind}`);
    await writeFile(join(directory, filename), bytes);
    assets.push({
      kind,
      filename,
      contentType,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      cutId: 'master',
    });
  }
  const bundle: TutorialBundle = {
    formatVersion: 1,
    episodeId: 'evergreen',
    title: 'Boardsesh walkthrough',
    platform: 'android',
    draft: false,
    createdAt: '2026-10-01T12:00:00Z',
    cuts: [{ id: 'master', kind: 'master', seconds: 150 }],
    assets,
    captureProvenance: [capture],
  };
  await writeFile(join(directory, 'bundle.json'), JSON.stringify(bundle));
  return { directory, bundle };
}

function memoryTransport(options: { failFilename?: string; brokenRange?: boolean } = {}): {
  transport: TutorialPublisherTransport;
  written: string[];
} {
  const objects = new Map<string, { bytes: Buffer; contentType: string }>();
  const written: string[] = [];
  const transport: TutorialPublisherTransport = {
    putImmutable: async (key, bytes, contentType) => {
      written.push(key);
      objects.set(key, { bytes, contentType });
    },
    putLatest: async (key, bytes) => {
      written.push(key);
      objects.set(key, { bytes, contentType: 'application/json' });
    },
    fetch: async (url, init) => {
      const key = new URL(url).pathname.slice(1);
      const object = objects.get(key);
      if (!object) return new Response(null, { status: 404 });
      const range = new Headers(init?.headers).get('Range');
      if (range && !options.brokenRange)
        return new Response(new Uint8Array(object.bytes.subarray(0, 2)), {
          status: 206,
          headers: { 'content-range': `bytes 0-1/${object.bytes.length}` },
        });
      const body = options.failFilename && key.endsWith(options.failFilename) ? Buffer.from('corrupt') : object.bytes;
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: { 'content-type': object.contentType, 'cache-control': 'public, max-age=31536000, immutable' },
      });
    },
  };
  return { transport, written };
}

describe('instructional video publication', () => {
  it('dry runs without credentials or remote requests, producing content-addressed edition URLs', async () => {
    const { directory, bundle } = await makeBundle();
    const plan = await publishTutorialBundle(directory, { dryRun: true, environment: {} });
    expect(plan.assets[0].key).toBe(`tutorials/v1/evergreen/android/objects/${bundle.assets[0].sha256}.mp4`);
    expect(plan.editionKey).toMatch(/editions\/[a-f0-9]{64}\.json$/);
    expect(plan.latestKey).toBe('tutorials/v1/evergreen/android/latest.json');
  });

  it('rejects incomplete, draft, unsafe and unpinned release bundles before publishing', async () => {
    const { bundle } = await makeBundle();
    expect(() => validateTutorialBundle({ ...bundle, draft: true })).toThrow('Draft');
    expect(() => validateTutorialBundle({ ...bundle, episodeId: 'release-2.6.0' })).toThrow('sourceRef');
    expect(() => validateTutorialBundle({ ...bundle, episodeId: 'release-2.6.0', sourceRef: 'd'.repeat(40) })).toThrow(
      'do not match',
    );
    expect(() =>
      validateTutorialBundle({ ...bundle, assets: bundle.assets.map((asset) => ({ ...asset, cutId: 'missing' })) }),
    ).toThrow('missing video');
    expect(() =>
      validateTutorialBundle({ ...bundle, assets: [{ ...bundle.assets[0], filename: '../master.mp4' }] }),
    ).toThrow('unsafe filename');
    expect(() =>
      validateTutorialBundle({ ...bundle, assets: bundle.assets.filter((asset) => asset.kind !== 'subtitles') }),
    ).toThrow('missing subtitles');
    expect(() => validateTutorialBundle({ ...bundle, captureProvenance: [] })).toThrow('capture provenance');
  });

  it('detects local edits before the first upload', async () => {
    const { directory, bundle } = await makeBundle();
    await writeFile(join(directory, bundle.assets[0].filename), Buffer.alloc(bundle.assets[0].bytes, 9));
    const { transport, written } = memoryTransport();
    await expect(publishTutorialBundle(directory, { transport })).rejects.toThrow('checksum changed');
    expect(written).toEqual([]);
  });

  it('requires every release capture to verify clean app sources before any upload', async () => {
    const { directory, bundle } = await makeBundle();
    const release = { ...bundle, episodeId: 'release-2.6.0', sourceRef: capture.sourceCommit };
    expect(validateTutorialBundle(release)).toEqual(release);
    for (const sourceDirty of [undefined, true, null, 'false']) {
      const unverified = {
        ...release,
        captureProvenance: [capture, { ...capture, takeId: 'workouts', sourceDirty }],
      };
      expect(() => validateTutorialBundle(unverified)).toThrow('verified clean app sources');
    }
    await writeFile(
      join(directory, 'bundle.json'),
      JSON.stringify({ ...release, captureProvenance: [{ ...capture, sourceDirty: true }] }),
    );
    const { transport, written } = memoryTransport();
    await expect(publishTutorialBundle(directory, { transport })).rejects.toThrow('verified clean app sources');
    expect(written).toEqual([]);
  });

  it('verifies assets and edition before writing latest, retaining immutable editions', async () => {
    const { directory } = await makeBundle();
    const { transport, written } = memoryTransport();
    const plan = await publishTutorialBundle(directory, { transport });
    expect(written.slice(-2)).toEqual([plan.editionKey, plan.latestKey]);
    expect(written.length).toBe(plan.assets.length + 2);
    const plannedAgain = await planTutorialPublication(directory);
    expect(plannedAgain.editionKey).toBe(plan.editionKey);
  });

  it('leaves latest untouched when public checksums or video seeking fail', async () => {
    const { directory, bundle } = await makeBundle();
    const corrupt = memoryTransport({ failFilename: `${bundle.assets[0].sha256}.mp4` });
    await expect(publishTutorialBundle(directory, { transport: corrupt.transport })).rejects.toThrow(
      'checksum differs',
    );
    expect(corrupt.written.some((key) => key.endsWith('/latest.json'))).toBe(false);
    const unseekable = memoryTransport({ brokenRange: true });
    await expect(publishTutorialBundle(directory, { transport: unseekable.transport })).rejects.toThrow(
      'seeking failed',
    );
    expect(unseekable.written.some((key) => key.endsWith('/latest.json'))).toBe(false);
  });
});
