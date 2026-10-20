import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import {
  hydrateLiveActivityFootage,
  importLiveActivityFootage,
  resampledFrameIndices,
  reviewedFootageFrames,
  type ReviewedFootage,
} from '../import-live-activity-footage';
import { LIVE_ACTIVITY_FIXTURE_ROOT, readLiveActivityManifest } from '../lib/screenshot-live-activity';
import { storeSearchRecordingProblems } from '../lib/showcase-video/store-search';

const directories: string[] = [];
function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), 'live-footage-test-'));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function provenance(): ReviewedFootage {
  const fixture = readLiveActivityManifest().fixtures['kilter/en-US'];
  return {
    version: 1,
    target: 'kilter',
    firstFrame: '00001.jpg',
    lastFrame: '00015.jpg',
    frames: Array.from({ length: 15 }, (_, index) => ({
      file: `${String(index + 1).padStart(5, '0')}.jpg`,
      receivedSeconds: 10 + index / 2,
    })),
    marks: {
      takeId: 'lock-screen',
      locale: 'en-US',
      kind: 'kilter',
      platform: 'ios',
      recordedAt: fixture.capturedAt,
      validated: true,
      boardKind: 'kilter',
      presentation: 'native-notification-center',
      captureSurface: 'notification-center',
      nativeFixtureSourcePngSha256: fixture.sourcePngSha256,
      editorialStartSeconds: 10.5,
      marks: { 'activity-ready': 10, 'next-tapped': 11.2, 'next-changed': 11.5, 'next-settled': 12 },
    },
    review: {
      reviewedAt: fixture.review.reviewedAt,
      reviewedBy: 'Synthetic test fixture reviewer',
      contiguousRangeVerified: true,
      nativePixelsUnmodified: true,
    },
  };
}

describe('retained physical Live Activity footage', () => {
  it('rejects more than 30,000 reviewed JPEGs before reading or uploading them', async () => {
    const source = provenance();
    source.frames = Array.from({ length: 30_001 }, (_, index) => ({
      file: `${String(index + 1).padStart(5, '0')}.jpg`,
      receivedSeconds: 10 + index / 30,
    }));
    source.lastFrame = '30000.jpg';
    expect(reviewedFootageFrames(source)).toHaveLength(30_000);
    source.lastFrame = '30001.jpg';
    const input = temporary();
    const root = temporary();
    const provenancePath = join(input, 'reviewed.json');
    writeFileSync(provenancePath, JSON.stringify(source));
    let uploaded = false;
    await expect(
      importLiveActivityFootage(input, provenancePath, root, async () => {
        uploaded = true;
      }),
    ).rejects.toThrow('30000 JPEGs');
    expect(uploaded).toBe(false);
    expect(existsSync(join(root, 'manifest.json'))).toBe(false);
  });

  it('rejects an oversized source before loading JPEG bytes or uploading an unusable archive', async () => {
    const input = temporary();
    const root = temporary();
    const source = provenance();
    const frame = join(input, source.firstFrame);
    writeFileSync(frame, '');
    truncateSync(frame, 1024 ** 3 + 1);
    const provenancePath = join(input, 'reviewed.json');
    writeFileSync(provenancePath, JSON.stringify(source));
    let uploaded = false;
    await expect(
      importLiveActivityFootage(input, provenancePath, root, async () => {
        uploaded = true;
      }),
    ).rejects.toThrow('exceeds 1 GiB');
    expect(uploaded).toBe(false);
    expect(existsSync(join(root, 'manifest.json'))).toBe(false);
  });

  it('requires one contiguous range, observed timing and explicit review', () => {
    const source = provenance();
    expect(reviewedFootageFrames(source)).toHaveLength(15);
    expect(() => reviewedFootageFrames({ ...source, frames: source.frames.filter((_, index) => index !== 3) })).toThrow(
      /consecutive/,
    );
    expect(() =>
      reviewedFootageFrames({
        ...source,
        frames: source.frames.map((frame, index) => (index === 3 ? { ...frame, receivedSeconds: 10 } : frame)),
      }),
    ).toThrow(/timestamps/);
    expect(() => reviewedFootageFrames({ ...source, firstFrame: '../00001.jpg' })).toThrow(/unavailable/);
    expect(() => reviewedFootageFrames({ ...source, review: { ...source.review, reviewedBy: '' } })).toThrow(/review/);
  });

  it('resamples by nearest observed timestamp without removing transition frames', () => {
    const sampled = resampledFrameIndices([
      { file: '1.jpg', receivedSeconds: 3 },
      { file: '2.jpg', receivedSeconds: 3.07 },
      { file: '3.jpg', receivedSeconds: 3.15 },
    ]);
    expect(sampled).toEqual([0, 0, 1, 1]);
  });

  it('retains original JPEGs and reuses one source honestly in all four output locales', async () => {
    const root = temporary();
    const input = temporary();
    const source = provenance();
    const fixture = readLiveActivityManifest().fixtures['kilter/en-US'];
    copyFileSync(join(LIVE_ACTIVITY_FIXTURE_ROOT, fixture.file), join(root, fixture.file));
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ version: 1, fixtures: { 'kilter/en-US': fixture } }));
    // These pixels are synthetic test data, never production capture evidence.
    const original = await sharp({ create: { width: 1170, height: 2532, channels: 3, background: '#112233' } })
      .jpeg()
      .toBuffer();
    for (const frame of source.frames) writeFileSync(join(input, frame.file), original);
    const provenancePath = join(input, 'reviewed.json');
    writeFileSync(
      provenancePath,
      JSON.stringify({ ...source, privateAxPayload: 'private-account-metadata-never-upload' }),
    );
    let archive: Buffer | undefined;
    const retained = await importLiveActivityFootage(input, provenancePath, root, async (_key, bytes) => {
      archive = bytes;
    });
    expect(retained.key).toBe(`sources/live-activity/${retained.sha256}.zip`);
    expect(readLiveActivityManifest(root).footage?.kilter).toEqual(retained);
    expect(archive!.includes(Buffer.from('private-account-metadata-never-upload'))).toBe(false);
    expect(readFileSync(join(input, '00001.jpg'))).toEqual(original);
    for (const locale of ['en-US', 'es', 'fr', 'de'] as const) {
      const work = temporary();
      await hydrateLiveActivityFootage(
        'kilter',
        'kilter',
        locale,
        'https://creatives.example',
        work,
        root,
        async () => archive!,
      );
      expect(readFileSync(join(work, 'footage/lock-screen/00001.jpg'))).toEqual(original);
      const marks = JSON.parse(readFileSync(join(work, 'marks/lock-screen.json'), 'utf8')) as ReviewedFootage['marks'];
      expect(marks.locale).toBe('en-US');
      expect(marks.sharedNativeSource).toEqual({
        sha256: retained.sha256,
        boardFamily: 'kilter',
        sourceLocale: 'en-US',
      });
      expect(marks.marks['next-tapped']).toBeCloseTo(1.2);
      expect(storeSearchRecordingProblems(marks, 'lock-screen', locale, 'kilter')).toEqual([]);
    }
    const corruptedOutput = temporary();
    await expect(
      hydrateLiveActivityFootage(
        'kilter',
        'kilter',
        'fr',
        'https://creatives.example',
        corruptedOutput,
        root,
        async () => Buffer.from('corrupt'),
      ),
    ).rejects.toThrow(/SHA-256 mismatch/);
    expect(existsSync(join(corruptedOutput, 'footage'))).toBe(false);
    await expect(
      hydrateLiveActivityFootage('tension', 'tension', 'fr', 'https://creatives.example', temporary(), root),
    ).rejects.toThrow(/Missing retained physical/);
  });

  it('never shares ordinary simulator takes or footage from another target', () => {
    const marks = {
      ...provenance().marks,
      sharedNativeSource: { sha256: 'a'.repeat(64), sourceLocale: 'en-US' as const, boardFamily: 'kilter' as const },
    };
    expect(storeSearchRecordingProblems(marks, 'lock-screen', 'fr', 'kilter')).toEqual([]);
    expect(storeSearchRecordingProblems(marks, 'lock-screen', 'fr', 'tension')).toContain(
      'Invalid shared native source identity',
    );
    expect(storeSearchRecordingProblems({ ...marks, takeId: 'crew' }, 'crew', 'fr', 'kilter')).toContain(
      'Invalid shared native source identity',
    );
  });
});
