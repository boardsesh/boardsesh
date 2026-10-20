/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { createStoreCreativesClient, STORE_CREATIVES_BUCKET } from './store-creatives-r2';
import {
  LIVE_ACTIVITY_FIXTURE_ROOT,
  LIVE_ACTIVITY_MANIFEST,
  loadFullScreenLiveActivityFixture,
  nativeCaptureSha256,
  readLiveActivityManifest,
  type LiveActivityFootageSource,
} from './lib/screenshot-live-activity';
import {
  SHOWCASE_FPS,
  SHOWCASE_LOCALES,
  showcaseVariantWorkDirs,
  type ShowcaseMarksFile,
} from './lib/showcase-video/contract';
import { renderWorkDirs } from './lib/showcase-video/render';
import {
  storeSearchNativeLockScreenProblems,
  storeSearchRecordingProblems,
  storeSearchTakeSegments,
} from './lib/showcase-video/store-search';

const MAX_SOURCE_FRAMES = 30_000;
const MAX_SOURCE_UNCOMPRESSED_BYTES = 1024 ** 3;

type Target = 'kilter' | 'tension';
interface OriginalFrame {
  file: string;
  receivedSeconds: number;
  sha256?: string;
}
export interface ReviewedFootage {
  version: 1;
  target: Target;
  /** One inclusive, contiguous range in the original MJPEG stream. */
  firstFrame: string;
  lastFrame: string;
  frames: OriginalFrame[];
  marks: ShowcaseMarksFile;
  review: { reviewedAt: string; reviewedBy: string; contiguousRangeVerified: true; nativePixelsUnmodified: true };
}

/** Do not discard interior frames or invent timing between native transitions. */
export function reviewedFootageFrames(source: ReviewedFootage): OriginalFrame[] {
  if (source.version !== 1 || !['kilter', 'tension'].includes(source.target) || !Array.isArray(source.frames))
    throw new Error('Invalid physical Live Activity footage provenance');
  const review = source.review;
  if (
    !review ||
    review.contiguousRangeVerified !== true ||
    review.nativePixelsUnmodified !== true ||
    !review.reviewedBy?.trim() ||
    !Number.isFinite(Date.parse(review.reviewedAt))
  )
    throw new Error('Physical footage requires review of unchanged pixels and a contiguous range');
  let previousNumber: number | undefined;
  let previousTimestamp = -Infinity;
  for (const frame of source.frames) {
    if (!/^\d+\.jpg$/.test(frame.file) || !Number.isFinite(frame.receivedSeconds) || frame.receivedSeconds < 0)
      throw new Error('Raw footage requires simple numbered JPEGs and actual received timestamps');
    const frameNumber = Number(frame.file.slice(0, -4));
    if (
      (previousNumber !== undefined && frameNumber !== previousNumber + 1) ||
      frame.receivedSeconds <= previousTimestamp
    )
      throw new Error('Raw MJPEG frames must be consecutive with strictly increasing received timestamps');
    previousNumber = frameNumber;
    previousTimestamp = frame.receivedSeconds;
  }
  const firstIndex = source.frames.findIndex((frame) => frame.file === source.firstFrame);
  const lastIndex = source.frames.findIndex((frame) => frame.file === source.lastFrame);
  if (firstIndex < 0 || lastIndex <= firstIndex) throw new Error('Reviewed MJPEG range is unavailable');
  const frames = source.frames.slice(firstIndex, lastIndex + 1);
  if (frames.length > MAX_SOURCE_FRAMES) throw new Error(`Reviewed source exceeds ${MAX_SOURCE_FRAMES} JPEGs`);
  if (frames.at(-1)!.receivedSeconds - frames[0].receivedSeconds < 6)
    throw new Error('Reviewed native range must contain at least six seconds');
  resampledFrameCount(frames);
  return frames;
}

function resampledFrameCount(frames: readonly OriginalFrame[]): number {
  const count = Math.floor((frames.at(-1)!.receivedSeconds - frames[0].receivedSeconds) * SHOWCASE_FPS);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_SOURCE_FRAMES)
    throw new Error(`Physical footage exceeds ${MAX_SOURCE_FRAMES} resampled frames`);
  return count;
}

/** Nearest received timestamp preserves observed timing, including native transition blur. */
export function resampledFrameIndices(frames: readonly OriginalFrame[]): number[] {
  if (frames.length < 2) throw new Error('No physical source frames');
  const start = frames[0].receivedSeconds;
  const frameCount = resampledFrameCount(frames);
  const indices: number[] = [];
  let sourceIndex = 0;
  for (let outputIndex = 0; outputIndex < frameCount; outputIndex++) {
    const timestamp = start + outputIndex / SHOWCASE_FPS;
    while (
      sourceIndex + 1 < frames.length &&
      Math.abs(frames[sourceIndex + 1].receivedSeconds - timestamp) <
        Math.abs(frames[sourceIndex].receivedSeconds - timestamp)
    )
      sourceIndex++;
    indices.push(sourceIndex);
  }
  return indices;
}

function adjustedMarks(source: ReviewedFootage, frames: readonly OriginalFrame[]): ShowcaseMarksFile {
  const offset = frames[0].receivedSeconds;
  return {
    ...source.marks,
    marks: Object.fromEntries(Object.entries(source.marks.marks).map(([name, seconds]) => [name, seconds - offset])),
    ...(source.marks.editorialStartSeconds !== undefined
      ? { editorialStartSeconds: source.marks.editorialStartSeconds - offset }
      : {}),
  };
}

async function validateSource(source: ReviewedFootage, directory: string, root: string): Promise<OriginalFrame[]> {
  const frames = reviewedFootageFrames(source);
  let frameBytes = 0;
  for (const frame of frames) {
    frameBytes += statSync(join(directory, frame.file)).size;
    if (frameBytes > MAX_SOURCE_UNCOMPRESSED_BYTES) throw new Error('Source archive exceeds 1 GiB');
  }
  const marks = adjustedMarks(source, frames);
  const problems = storeSearchRecordingProblems(marks, 'lock-screen', marks.locale!, source.target);
  if (problems.length) throw new Error(`Physical source: ${problems.join('; ')}`);
  const fixture = loadFullScreenLiveActivityFixture(source.target, marks.locale!, root);
  for (const frame of frames) {
    const bytes = readFileSync(join(directory, frame.file));
    if (frame.sha256 !== undefined && frame.sha256 !== nativeCaptureSha256(bytes))
      throw new Error(`Original JPEG hash mismatch: ${frame.file}`);
    const dimensions = await sharp(bytes).metadata();
    if (dimensions.format !== 'jpeg' || dimensions.width !== 1170 || dimensions.height !== 2532)
      throw new Error(`Original JPEG must retain native 1170x2532 dimensions: ${frame.file}`);
  }
  const fixtureProblems = storeSearchNativeLockScreenProblems(marks, { width: 1170, height: 2532 }, fixture.provenance);
  if (fixtureProblems.length) throw new Error(fixtureProblems.join('; '));
  storeSearchTakeSegments(
    source.target,
    'island',
    'lock-screen',
    180,
    {
      frameCount: resampledFrameIndices(frames).length,
      presentation: marks.presentation,
      editorialStartSeconds: marks.editorialStartSeconds,
    },
    marks.marks,
  );
  return frames;
}

const packPython = `import sys,zipfile,pathlib,json
root=pathlib.Path(sys.argv[1]); metadata=json.loads((root/'source.json').read_text())
names=['source.json']+[frame['file'] for frame in metadata['frames']]
if len(names)>${MAX_SOURCE_FRAMES + 1}: raise ValueError('Invalid source archive entries')
if sum((root/name).stat().st_size for name in names)>${MAX_SOURCE_UNCOMPRESSED_BYTES}: raise ValueError('Source archive exceeds 1 GiB')
with zipfile.ZipFile(sys.argv[2],'w',compression=zipfile.ZIP_STORED) as archive:
 for name in names:
  entry=zipfile.ZipInfo(name,date_time=(1980,1,1,0,0,0)); entry.external_attr=0o100644 << 16
  archive.writestr(entry,(root/name).read_bytes())
`;
const unpackPython = `import sys,zipfile,pathlib,re
root=pathlib.Path(sys.argv[2])
with zipfile.ZipFile(sys.argv[1]) as archive:
 names=archive.namelist()
 if len(names)!=len(set(names)) or 'source.json' not in names or len(names)>${MAX_SOURCE_FRAMES + 1}: raise ValueError('Invalid source archive entries')
 if any(name!='source.json' and not re.fullmatch(r'[0-9]+[.]jpg',name) for name in names): raise ValueError('Unsafe source archive entry')
 if sum(entry.file_size for entry in archive.infolist())>${MAX_SOURCE_UNCOMPRESSED_BYTES}: raise ValueError('Source archive exceeds 1 GiB')
 for name in names: (root/name).write_bytes(archive.read(name))
`;

export async function importLiveActivityFootage(
  input: string,
  provenancePath: string,
  root = LIVE_ACTIVITY_FIXTURE_ROOT,
  upload: (key: string, bytes: Buffer) => Promise<void> = uploadSource,
): Promise<LiveActivityFootageSource> {
  const source = JSON.parse(readFileSync(provenancePath, 'utf8')) as ReviewedFootage;
  const frames = await validateSource(source, input, root);
  // Reject hidden interior omissions, even if the reviewer accidentally omitted their timestamp entries.
  const names = readdirSync(input).filter((name) => /^\d+\.jpg$/.test(name));
  const firstNumber = Number(source.firstFrame.slice(0, -4));
  const lastNumber = Number(source.lastFrame.slice(0, -4));
  if (
    names.filter((name) => Number(name.slice(0, -4)) >= firstNumber && Number(name.slice(0, -4)) <= lastNumber)
      .length !== frames.length
  )
    throw new Error('Reviewed range omits original interior JPEGs');
  const temporary = mkdtempSync(join(tmpdir(), 'store-live-activity-'));
  try {
    // Only publish the reviewed capture contract, never adjacent private AX/account metadata.
    const originalMarks = source.marks;
    const archived: ReviewedFootage = {
      version: 1,
      target: source.target,
      firstFrame: source.firstFrame,
      lastFrame: source.lastFrame,
      review: {
        reviewedAt: source.review.reviewedAt,
        reviewedBy: source.review.reviewedBy,
        contiguousRangeVerified: true,
        nativePixelsUnmodified: true,
      },
      marks: {
        takeId: 'lock-screen',
        locale: originalMarks.locale,
        kind: originalMarks.kind,
        platform: 'ios',
        recordedAt: originalMarks.recordedAt,
        validated: true,
        boardKind: originalMarks.boardKind,
        presentation: originalMarks.presentation,
        captureSurface: originalMarks.captureSurface,
        nativeFixtureSourcePngSha256: originalMarks.nativeFixtureSourcePngSha256,
        ...(originalMarks.editorialStartSeconds !== undefined
          ? { editorialStartSeconds: originalMarks.editorialStartSeconds }
          : {}),
        marks: Object.fromEntries(
          ['activity-ready', 'next-tapped', 'next-changed', 'next-settled'].map((name) => [
            name,
            originalMarks.marks[name],
          ]),
        ),
      },
      frames: frames.map((frame) => ({
        file: frame.file,
        receivedSeconds: frame.receivedSeconds,
        sha256: nativeCaptureSha256(readFileSync(join(input, frame.file))),
      })),
    };
    writeFileSync(join(temporary, 'source.json'), `${JSON.stringify(archived, null, 2)}\n`);
    for (const frame of frames) copyFileSync(join(input, frame.file), join(temporary, frame.file));
    const archivePath = join(temporary, 'footage.zip');
    execFileSync('python3', ['-c', packPython, temporary, archivePath]);
    const bytes = readFileSync(archivePath);
    const sha256 = nativeCaptureSha256(bytes);
    const retained: LiveActivityFootageSource = {
      sha256,
      key: `sources/live-activity/${sha256}.zip`,
      boardFamily: source.target,
      sourceLocale: source.marks.locale!,
      nativeFixtureSourcePngSha256: source.marks.nativeFixtureSourcePngSha256!,
      frameCount: frames.length,
      durationSeconds: frames.at(-1)!.receivedSeconds - frames[0].receivedSeconds,
      reviewedAt: source.review.reviewedAt,
      reviewedBy: source.review.reviewedBy,
    };
    await upload(retained.key, bytes);
    updateLiveActivityFootageManifest(root, source.target, retained);
    return retained;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Serialize the short manifest commit across independent importer processes. */
export function updateLiveActivityFootageManifest(
  root: string,
  target: Target,
  retained: LiveActivityFootageSource,
): void {
  const manifestPath = join(root, LIVE_ACTIVITY_MANIFEST);
  const lockPath = `${manifestPath}.lock`;
  try {
    mkdirSync(lockPath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new Error(
        `Live Activity manifest is locked at ${lockPath}; retry after the active importer finishes. Inspect a leftover lock before retrying; it is never removed automatically.`,
      );
    throw error;
  }
  const lockIdentity = lstatSync(lockPath);
  const pendingPath = `${manifestPath}.pending-${randomUUID()}`;
  let pendingIdentity: Stats | undefined;
  try {
    const manifest = readLiveActivityManifest(root);
    manifest.footage = { ...manifest.footage, [target]: retained };
    const descriptor = openSync(pendingPath, 'wx');
    try {
      pendingIdentity = fstatSync(descriptor);
      writeFileSync(descriptor, `${JSON.stringify(manifest, null, 2)}\n`);
    } finally {
      closeSync(descriptor);
    }
    renameSync(pendingPath, manifestPath);
    pendingIdentity = undefined;
  } finally {
    try {
      if (pendingIdentity && ownsPath(pendingPath, pendingIdentity)) unlinkSync(pendingPath);
    } finally {
      if (ownsPath(lockPath, lockIdentity)) rmdirSync(lockPath);
    }
  }
}

async function uploadSource(key: string, bytes: Buffer): Promise<void> {
  const client = createStoreCreativesClient();
  try {
    await client.send(new HeadObjectCommand({ Bucket: STORE_CREATIVES_BUCKET, Key: key }));
    return;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('$metadata' in error) ||
      (error as Error & { $metadata: { httpStatusCode?: number } }).$metadata.httpStatusCode !== 404
    )
      throw error;
  }
  await client.send(
    new PutObjectCommand({ Bucket: STORE_CREATIVES_BUCKET, Key: key, Body: bytes, ContentType: 'application/zip' }),
  );
}

function ownsPath(path: string, expected: Stats): boolean {
  try {
    const actual = lstatSync(path);
    return actual.dev === expected.dev && actual.ino === expected.ino;
  } catch {
    return false;
  }
}

export async function hydrateLiveActivityFootage(
  target: Target,
  kind: 'default' | Target,
  locale: (typeof SHOWCASE_LOCALES)[number],
  baseUrl: string,
  workDir?: string,
  root = LIVE_ACTIVITY_FIXTURE_ROOT,
  download: (url: string) => Promise<Buffer> = async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Retained physical footage download failed: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  },
): Promise<void> {
  if ((kind === 'default' ? 'kilter' : kind) !== target)
    throw new Error('Native footage target must match the creative board family');
  const retained = readLiveActivityManifest(root).footage?.[target];
  if (!retained)
    throw new Error(
      `Missing retained physical Live Activity footage for ${target}; import one reviewed take before running this train.`,
    );
  const url = new URL(`${baseUrl.replace(/\/$/, '')}/${retained.key}`);
  if (url.protocol !== 'https:') throw new Error('Physical source base URL must use HTTPS');
  const dirs = workDir ? renderWorkDirs('ios', workDir) : showcaseVariantWorkDirs(kind, locale);
  const output = join(dirs.footage, 'lock-screen');
  const marksPath = join(dirs.marks, 'lock-screen.json');
  if (existsSync(output) || existsSync(marksPath))
    throw new Error(`Native ending already exists: ${output}; use an empty recording work directory.`);
  const temporary = mkdtempSync(join(tmpdir(), 'store-live-hydrate-'));
  let stagedFrames: string | undefined;
  let stagedMarks: string | undefined;
  let reservedOutput: Stats | undefined;
  let publishedMarks: Stats | undefined;
  try {
    const bytes = await download(url.href);
    if (nativeCaptureSha256(bytes) !== retained.sha256)
      throw new Error(`Retained physical footage SHA-256 mismatch: ${target}`);
    const archivePath = join(temporary, 'footage.zip');
    writeFileSync(archivePath, bytes);
    execFileSync('python3', ['-c', unpackPython, archivePath, temporary]);
    const source = JSON.parse(readFileSync(join(temporary, 'source.json'), 'utf8')) as ReviewedFootage;
    if (
      source.target !== target ||
      source.marks.locale !== retained.sourceLocale ||
      source.marks.nativeFixtureSourcePngSha256 !== retained.nativeFixtureSourcePngSha256
    )
      throw new Error('Retained footage identity differs from the reviewed manifest');
    const frames = await validateSource(source, temporary, root);
    mkdirSync(dirs.footage, { recursive: true });
    mkdirSync(dirs.marks, { recursive: true });
    stagedFrames = mkdtempSync(join(dirs.footage, '.lock-screen-staging-'));
    stagedMarks = mkdtempSync(join(dirs.marks, '.lock-screen-staging-'));
    for (const [index, frameIndex] of resampledFrameIndices(frames).entries())
      copyFileSync(
        join(temporary, frames[frameIndex].file),
        join(stagedFrames, `${String(index + 1).padStart(5, '0')}.jpg`),
      );
    const marks: ShowcaseMarksFile = {
      ...adjustedMarks(source, frames),
      sharedNativeSource: { sha256: retained.sha256, sourceLocale: retained.sourceLocale, boardFamily: target },
    };
    const stagedMarksPath = join(stagedMarks, 'marks.json');
    writeFileSync(stagedMarksPath, `${JSON.stringify(marks, null, 2)}\n`);
    // Reserve exclusively: rename alone would overwrite an existing empty directory.
    mkdirSync(output);
    reservedOutput = lstatSync(output);
    const stagedMarksIdentity = lstatSync(stagedMarksPath);
    linkSync(stagedMarksPath, marksPath);
    publishedMarks = stagedMarksIdentity;
    if (!ownsPath(output, reservedOutput)) throw new Error('Native ending changed during hydration');
    renameSync(stagedFrames, output);
    reservedOutput = undefined;
    publishedMarks = undefined;
  } catch (error) {
    if (publishedMarks && ownsPath(marksPath, publishedMarks)) unlinkSync(marksPath);
    if (reservedOutput && ownsPath(output, reservedOutput)) {
      // rmdir removes only our empty reservation, never files added by another writer.
      try {
        rmdirSync(output);
      } catch {
        /* Preserve concurrent contents. */
      }
    }
    throw error;
  } finally {
    if (stagedFrames) rmSync(stagedFrames, { recursive: true, force: true });
    if (stagedMarks) rmSync(stagedMarks, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
}

export async function main(arguments_: readonly string[] = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = arguments_;
  const options: Record<string, string> = {};
  const allowed = new Set([
    '--input',
    '--provenance',
    '--output-root',
    '--target',
    '--kind',
    '--locale',
    '--base-url',
    '--work-dir',
  ]);
  for (let index = 0; index < rest.length; index += 2) {
    if (!allowed.has(rest[index]) || !rest[index + 1] || rest[index + 1].startsWith('--'))
      throw new Error(`Invalid option: ${rest[index]}`);
    options[rest[index]] = rest[index + 1];
  }
  if (command === 'import' && options['--input'] && options['--provenance']) {
    const retained = await importLiveActivityFootage(
      resolve(options['--input']),
      resolve(options['--provenance']),
      options['--output-root'],
    );
    console.log(`Retained reviewed ${retained.boardFamily} source: ${retained.key}`);
  } else if (
    command === 'hydrate' &&
    ['kilter', 'tension'].includes(options['--target']) &&
    ['default', 'kilter', 'tension'].includes(options['--kind']) &&
    SHOWCASE_LOCALES.includes(options['--locale'] as (typeof SHOWCASE_LOCALES)[number])
  ) {
    const creatives = JSON.parse(readFileSync(resolve('app-stores/apple/creative-assets.json'), 'utf8')) as {
      storage?: { baseUrl?: string };
    };
    const baseUrl = options['--base-url'] ?? creatives.storage?.baseUrl;
    if (!baseUrl) throw new Error('Configure storage.baseUrl or pass --base-url for retained physical sources');
    await hydrateLiveActivityFootage(
      options['--target'] as Target,
      options['--kind'] as 'default' | Target,
      options['--locale'] as (typeof SHOWCASE_LOCALES)[number],
      baseUrl,
      options['--work-dir'],
      options['--output-root'],
    );
  } else
    throw new Error(
      'Usage: import --input <raw-jpegs> --provenance <reviewed.json>; hydrate --target kilter|tension --kind default|kilter|tension --locale en-US|es|fr|de [--work-dir <dir>] [--base-url <https-url>]',
    );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
