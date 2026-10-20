import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hydrateLiveActivityFootage,
  importLiveActivityFootage,
  resampledFrameIndices,
  reviewedFootageFrames,
  updateLiveActivityFootageManifest,
  type ReviewedFootage,
} from '../import-live-activity-footage';
import {
  LIVE_ACTIVITY_FIXTURE_ROOT,
  readLiveActivityManifest,
  type LiveActivityFootageSource,
} from '../lib/screenshot-live-activity';
import { storeSearchRecordingProblems } from '../lib/showcase-video/store-search';

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, renameSync: vi.fn(original.renameSync) };
});

const directories: string[] = [];
function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), 'live-footage-test-'));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  vi.mocked(renameSync).mockReset();
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

function retainedSource(target: 'kilter' | 'tension'): LiveActivityFootageSource {
  const fixture = readLiveActivityManifest().fixtures[`${target}/en-US`];
  const sha256 = (target === 'kilter' ? 'a' : 'b').repeat(64);
  return {
    sha256,
    key: `sources/live-activity/${sha256}.zip`,
    boardFamily: target,
    sourceLocale: 'en-US',
    nativeFixtureSourcePngSha256: fixture.sourcePngSha256,
    frameCount: 15,
    durationSeconds: 7,
    reviewedAt: fixture.review.reviewedAt,
    reviewedBy: 'Synthetic concurrent-writer regression',
  };
}

function manifestWriter(root: string, target: 'kilter' | 'tension', hold = false) {
  const script = `
    import fs from 'node:fs';
    import { join } from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    // --eval has no script filename: the first user argument is argv[1].
    const [root, target, payload, mode] = process.argv.slice(1);
    const importer = await import(${JSON.stringify(new URL('../import-live-activity-footage.ts', import.meta.url).href)});
    const { updateLiveActivityFootageManifest } = importer.default ?? importer;
    if (mode === 'hold') {
      const originalRead = fs.readFileSync;
      fs.readFileSync = (path, ...options) => {
        if (path === join(root, 'manifest.json')) {
          fs.writeFileSync(join(root, 'writer-ready'), 'lock acquired');
          const deadline = Date.now() + 20_000;
          while (!fs.existsSync(join(root, 'writer-release'))) {
            if (Date.now() > deadline) throw new Error('Timed out waiting for writer release');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
        return originalRead(path, ...options);
      };
      syncBuiltinESMExports();
    }
    try { updateLiveActivityFootageManifest(root, target, JSON.parse(payload)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  `;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      script,
      root,
      target,
      JSON.stringify(retainedSource(target)),
      hold ? 'hold' : 'publish',
    ],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const finished = new Promise<{ code: number | null; stderr: string }>((resolveResult) => {
    child.once('error', (error) => resolveResult({ code: -1, stderr: error.message }));
    child.once('close', (code) => resolveResult({ code, stderr }));
  });
  return { child, finished };
}

describe('retained physical Live Activity footage', () => {
  it('excludes another process from the manifest update and merges both entries on retry', async () => {
    const root = temporary();
    const manifest = readLiveActivityManifest();
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ version: 1, fixtures: manifest.fixtures }));
    const before = readFileSync(join(root, 'manifest.json'));
    const first = manifestWriter(root, 'kilter', true);
    try {
      await Promise.race([
        vi.waitFor(() => expect(existsSync(join(root, 'writer-ready'))).toBe(true), {
          timeout: 10_000,
          interval: 20,
        }),
        first.finished.then((result) => {
          throw new Error(`Manifest writer exited before the lock barrier: ${JSON.stringify(result)}`);
        }),
      ]);
      const lockInode = statSync(join(root, 'manifest.json.lock')).ino;
      const competing = await manifestWriter(root, 'tension').finished;
      expect(competing.code).toBe(1);
      expect(competing.stderr).toContain('manifest is locked');
      expect(statSync(join(root, 'manifest.json.lock')).ino).toBe(lockInode);
      expect(readFileSync(join(root, 'manifest.json'))).toEqual(before);
      writeFileSync(join(root, 'writer-release'), 'continue');
      expect(await first.finished).toEqual({ code: 0, stderr: '' });
      expect(readLiveActivityManifest(root).footage).toEqual({ kilter: retainedSource('kilter') });
      expect(await manifestWriter(root, 'tension').finished).toEqual({ code: 0, stderr: '' });
      expect(readLiveActivityManifest(root).footage).toEqual({
        kilter: retainedSource('kilter'),
        tension: retainedSource('tension'),
      });
      expect(readdirSync(root).filter((name) => name.includes('.pending-') || name.endsWith('.lock'))).toEqual([]);
    } finally {
      if (first.child.exitCode === null) first.child.kill();
      await first.finished;
    }
  }, 30_000);

  it('cleans only owned staging and releases its lock after a manifest publication failure', () => {
    const root = temporary();
    const manifest = readLiveActivityManifest();
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ version: 1, fixtures: manifest.fixtures }));
    const before = readFileSync(join(root, 'manifest.json'));
    const foreignPending = join(root, 'manifest.json.pending-another-writer');
    writeFileSync(foreignPending, 'preserve existing staging');
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error('simulated manifest publication failure');
    });
    expect(() => updateLiveActivityFootageManifest(root, 'kilter', retainedSource('kilter'))).toThrow(
      'simulated manifest publication failure',
    );
    expect(readFileSync(join(root, 'manifest.json'))).toEqual(before);
    expect(readFileSync(foreignPending, 'utf8')).toBe('preserve existing staging');
    expect(readdirSync(root).sort()).toEqual(['manifest.json', 'manifest.json.pending-another-writer']);
    updateLiveActivityFootageManifest(root, 'kilter', retainedSource('kilter'));
    expect(readLiveActivityManifest(root).footage).toEqual({ kilter: retainedSource('kilter') });
  });

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

  it('rejects long timestamp gaps before allocating resampled output', () => {
    expect(
      resampledFrameIndices([
        { file: '1.jpg', receivedSeconds: 0 },
        { file: '2.jpg', receivedSeconds: 1000 },
      ]),
    ).toHaveLength(30_000);
    expect(() =>
      resampledFrameIndices([
        { file: '1.jpg', receivedSeconds: 0 },
        { file: '2.jpg', receivedSeconds: 1001 },
      ]),
    ).toThrow('30000 resampled frames');
    const source = provenance();
    source.frames.at(-1)!.receivedSeconds = 10_000;
    expect(() => reviewedFootageFrames(source)).toThrow('30000 resampled frames');
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
    const failedPublication = temporary();
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('No space left on device'), { code: 'ENOSPC' });
    });
    await expect(
      hydrateLiveActivityFootage(
        'kilter',
        'kilter',
        'fr',
        'https://creatives.example',
        failedPublication,
        root,
        async () => archive!,
      ),
    ).rejects.toThrow('No space left');
    expect(existsSync(join(failedPublication, 'footage/lock-screen'))).toBe(false);
    expect(existsSync(join(failedPublication, 'marks/lock-screen.json'))).toBe(false);
    expect(readdirSync(join(failedPublication, 'footage'))).toEqual([]);
    expect(readdirSync(join(failedPublication, 'marks'))).toEqual([]);
    await hydrateLiveActivityFootage(
      'kilter',
      'kilter',
      'fr',
      'https://creatives.example',
      failedPublication,
      root,
      async () => archive!,
    );
    expect(readFileSync(join(failedPublication, 'footage/lock-screen/00001.jpg'))).toEqual(original);

    const existingOutput = temporary();
    const existingDirectory = join(existingOutput, 'footage/lock-screen');
    mkdirSync(existingDirectory, { recursive: true });
    const existingInode = statSync(existingDirectory).ino;
    await expect(
      hydrateLiveActivityFootage(
        'kilter',
        'kilter',
        'fr',
        'https://creatives.example',
        existingOutput,
        root,
        async () => archive!,
      ),
    ).rejects.toThrow('Native ending already exists');
    expect(statSync(existingDirectory).ino).toBe(existingInode);
    expect(readdirSync(existingDirectory)).toEqual([]);
    const existingMarks = temporary();
    mkdirSync(join(existingMarks, 'marks'));
    writeFileSync(join(existingMarks, 'marks/lock-screen.json'), 'preserve existing marks');
    await expect(
      hydrateLiveActivityFootage(
        'kilter',
        'kilter',
        'fr',
        'https://creatives.example',
        existingMarks,
        root,
        async () => archive!,
      ),
    ).rejects.toThrow('Native ending already exists');
    expect(readFileSync(join(existingMarks, 'marks/lock-screen.json'), 'utf8')).toBe('preserve existing marks');

    for (const concurrentDestination of ['frames', 'marks'] as const) {
      const concurrentWork = temporary();
      const concurrentPath = join(
        concurrentWork,
        concurrentDestination === 'frames' ? 'footage/lock-screen' : 'marks/lock-screen.json',
      );
      let concurrentInode: number | undefined;
      await expect(
        hydrateLiveActivityFootage(
          'kilter',
          'kilter',
          'fr',
          'https://creatives.example',
          concurrentWork,
          root,
          async () => {
            mkdirSync(dirname(concurrentPath), { recursive: true });
            if (concurrentDestination === 'frames') mkdirSync(concurrentPath);
            else writeFileSync(concurrentPath, 'preserve concurrent marks');
            concurrentInode = statSync(concurrentPath).ino;
            return archive!;
          },
        ),
      ).rejects.toMatchObject({ code: 'EEXIST' });
      expect(statSync(concurrentPath).ino).toBe(concurrentInode);
      expect(readdirSync(join(concurrentWork, 'footage'))).toEqual(
        concurrentDestination === 'frames' ? ['lock-screen'] : [],
      );
      expect(readdirSync(join(concurrentWork, 'marks'))).toEqual(
        concurrentDestination === 'marks' ? ['lock-screen.json'] : [],
      );
      if (concurrentDestination === 'marks')
        expect(readFileSync(concurrentPath, 'utf8')).toBe('preserve concurrent marks');
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
