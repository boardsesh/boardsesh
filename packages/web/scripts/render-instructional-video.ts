import { chromium, type Page } from '@playwright/test';
import { brandColorsDark, materialSurfaces } from '@boardsesh/velvet-tokens';
import sharp from 'sharp';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { resolveMediaBinary } from '../../../scripts/lib/help-clips';
import { tutorialOutputDir, tutorialTakeDir, TUTORIAL_REPO_ROOT } from '../../../scripts/lib/instructional-video/paths';
import { mixTutorialAudio, probeTutorialMedia, tutorialVoice } from '../../../scripts/lib/instructional-video/media';
import {
  buildTutorialCuts,
  readTutorialTake,
  sourceFrameIndex,
  tutorialContentHash,
  tutorialRecordingPack,
  tutorialWebVtt,
  voicePath,
  type TutorialTimedBeat,
  type TutorialCut,
  type TutorialVoice,
} from '../../../scripts/lib/instructional-video/timeline';
import {
  TUTORIAL_FPS,
  TUTORIAL_SAFE_AREA,
  TUTORIAL_SIZE,
  type TutorialEpisode,
  type TutorialPlatform,
  type TutorialRect,
  type TutorialTakeManifest,
} from '../../../scripts/lib/instructional-video/types';

const execFileAsync = promisify(execFile);
const stageDirectory = resolve(TUTORIAL_REPO_ROOT, 'marketing/instructional-video');
export type TutorialRenderOptions = Readonly<{
  episode: TutorialEpisode;
  platform: TutorialPlatform;
  workRoot: string;
  chapterIds?: readonly string[];
  draft: boolean;
  audioDir?: string;
  music?: string;
  sourceRef?: string;
}>;
type StageScene = Readonly<{
  title: string;
  draft: boolean;
  totalFrames: number;
  outro?: boolean;
  beat?: TutorialTimedBeat;
  elapsedFrames?: number;
  image?: string;
  width?: number;
  height?: number;
  focus?: TutorialRect;
  anchor?: TutorialRect;
}>;
type BundleAsset = Readonly<{
  filename: string;
  kind: 'video' | 'cover' | 'subtitles' | 'chapters' | 'caption';
  sha256: string;
  bytes: number;
  contentType: string;
  cutId?: string;
}>;

export function writeTutorialRecordingPack(episode: TutorialEpisode, workRoot: string): string {
  const directory = resolve(workRoot, 'audio', episode.id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, 'recording-pack.md'), tutorialRecordingPack(episode));
  writeFileSync(
    resolve(directory, 'recording-pack.json'),
    `${JSON.stringify({ episodeId: episode.id, beats: episode.chapters.flatMap((chapter) => chapter.beats.map((beat) => ({ id: beat.id, filename: `${beat.id}.wav`, narration: beat.narration, targetSeconds: beat.seconds }))) }, null, 2)}\n`,
  );
  return directory;
}

async function renderFrame(page: Page, frame: number, scene: StageScene): Promise<Buffer> {
  await page.evaluate(
    async ({ frameNumber, stageScene }) => {
      const stageWindow = window as unknown as { renderTutorialAt: (frame: number, scene: unknown) => Promise<void> };
      await stageWindow.renderTutorialAt(frameNumber, stageScene);
    },
    { frameNumber: frame, stageScene: scene },
  );
  return page.screenshot({ type: 'png' });
}

async function assertSafeText(page: Page): Promise<void> {
  const overflow = await page.locator('[data-safe]:visible').evaluateAll(
    (elements, safe) =>
      elements.flatMap((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.left < safe.left ||
          bounds.top < safe.top ||
          bounds.right > 1080 - safe.right ||
          bounds.bottom > 1920 - safe.bottom
          ? [element.id]
          : [];
      }),
    TUTORIAL_SAFE_AREA,
  );
  if (overflow.length) throw new Error(`Reel safe area exceeded by: ${overflow.join(', ')}`);
}

async function encodeSegment(
  page: Page,
  output: string,
  frames: number,
  sceneAt: (frame: number) => StageScene,
): Promise<void> {
  const partial = `${output}.partial.mp4`;
  const encoder = spawn(
    resolveMediaBinary('ffmpeg'),
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'image2pipe',
      '-vcodec',
      'png',
      '-framerate',
      String(TUTORIAL_FPS),
      '-i',
      'pipe:0',
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-r',
      String(TUTORIAL_FPS),
      '-movflags',
      '+faststart',
      partial,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
  let diagnostics = '';
  encoder.stderr.on('data', (chunk: Buffer) => {
    diagnostics = `${diagnostics}${chunk.toString()}`.slice(-16_384);
  });
  let encoderError: Error | undefined;
  encoder.on('error', (error) => {
    encoderError = error;
  });
  encoder.stdin.on('error', (error) => {
    encoderError = error;
  });
  const finished = new Promise<number | null>((accept) => encoder.on('close', accept));
  try {
    for (let frame = 0; frame < frames; frame++) {
      if (encoderError || encoder.exitCode !== null) throw encoderError ?? new Error(`Encoder exited: ${diagnostics}`);
      const png = await renderFrame(page, frame, sceneAt(frame));
      if (frame === 0 || frame === Math.floor(frames / 2)) await assertSafeText(page);
      if (!encoder.stdin.write(png)) await once(encoder.stdin, 'drain');
    }
    encoder.stdin.end();
    const status = await finished;
    if (status !== 0 || encoderError) throw new Error(`Video encoding failed: ${encoderError?.message ?? diagnostics}`);
    renameSync(partial, output);
  } catch (error) {
    encoder.kill('SIGTERM');
    await finished;
    throw error;
  }
}

/** Content-addressed segments let new narration or a single changed chapter reuse other footage. */
export async function renderTutorial(options: TutorialRenderOptions): Promise<string> {
  const { episode, platform, workRoot, draft } = options;
  writeTutorialRecordingPack(episode, workRoot);
  if (episode.releaseVersion && !options.sourceRef)
    throw new Error('Release video requires --source-ref naming its reviewed release commit.');
  const voices = new Map<string, TutorialVoice>();
  const selected = episode.chapters.filter((chapter) => !options.chapterIds || options.chapterIds.includes(chapter.id));
  for (const beat of selected.flatMap((chapter) => chapter.beats)) {
    const recording = voicePath(workRoot, episode.id, beat.id, options.audioDir);
    if (recording && !draft) voices.set(beat.id, await tutorialVoice(recording));
    else if (!draft)
      throw new Error(`Record ${beat.id}.wav before final rendering; --draft produces a silent review only.`);
  }
  if (!draft && (!options.music || !existsSync(options.music)))
    throw new Error('Final rendering requires the supplied music file: --music <path>.');
  if (!draft && options.music && !(await probeTutorialMedia(options.music)).hasAudio)
    throw new Error('Music file contains no audio.');
  const cuts = buildTutorialCuts(episode, voices, options.chapterIds);
  const manifests = new Map<string, TutorialTakeManifest>();
  const frameSetHashes = new Map<string, string>();
  for (const beat of cuts.flatMap((cut) => cut.beats)) {
    const manifest = manifests.get(beat.takeId) ?? readTutorialTake(workRoot, platform, beat.takeId);
    manifests.set(beat.takeId, manifest);
    if (episode.releaseVersion && manifest.sourceDirty !== false)
      throw new Error(
        `Release take ${beat.takeId} lacks proof of clean app sources. Recapture it at the pinned release.`,
      );
    if (options.sourceRef && manifest.sourceCommit !== options.sourceRef)
      throw new Error(
        `Take ${beat.takeId} was captured at ${manifest.sourceCommit}, not pinned ${options.sourceRef}. Recapture the release.`,
      );
    sourceFrameIndex(beat, manifest, 0);
    if (beat.anchor && !manifest.anchors[beat.anchor]?.length)
      throw new Error(`Take ${beat.takeId} needs measured anchor ${beat.anchor}; recapture it.`);
    if (!frameSetHashes.has(beat.takeId)) {
      const digest = createHash('sha256');
      for (let frame = 1; frame <= manifest.frameCount; frame++) {
        const framePath = resolve(
          tutorialTakeDir(workRoot, platform, beat.takeId),
          'frames',
          `${String(frame).padStart(6, '0')}.jpg`,
        );
        if (!existsSync(framePath)) throw new Error(`Take ${beat.takeId} is missing frame ${frame}.`);
        digest.update(readFileSync(framePath));
      }
      frameSetHashes.set(beat.takeId, digest.digest('hex'));
    }
  }
  const outputDirectory = tutorialOutputDir(workRoot, platform, episode.id);
  const cacheDirectory = resolve(workRoot, 'work', platform, 'segments');
  mkdirSync(outputDirectory, { recursive: true });
  mkdirSync(cacheDirectory, { recursive: true });
  const stageHash = tutorialContentHash(
    ['index.html', 'stage.css', 'stage.mjs']
      .map((filename) => readFileSync(resolve(stageDirectory, filename), 'utf8'))
      .join('\n') +
      readFileSync(resolve(TUTORIAL_REPO_ROOT, 'marketing/showcase-video/anim.mjs'), 'utf8') +
      readFileSync(fileURLToPath(import.meta.url), 'utf8') +
      ['InterTight-latin-var.woff2', 'InstrumentSerif-Italic-latin.woff2', 'GeistMono-latin-var.woff2']
        .map((filename) =>
          tutorialContentHash(readFileSync(resolve(TUTORIAL_REPO_ROOT, 'marketing/showcase-video/fonts', filename))),
        )
        .join(''),
  );
  const palette = {
    surface: materialSurfaces.dark.background,
    ink: materialSurfaces.dark.label,
    accent: brandColorsDark.primary,
    glow: brandColorsDark.primaryFill,
    phone: materialSurfaces.dark.secondaryBackground,
  };
  const browser = await chromium.launch({ headless: true, args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage({ viewport: TUTORIAL_SIZE, deviceScaleFactor: 1 });
  const assets: BundleAsset[] = [];
  const register = (filename: string, kind: BundleAsset['kind'], contentType: string, cutId: string): void => {
    const contents = readFileSync(resolve(outputDirectory, filename));
    assets.push({ filename, kind, contentType, cutId, bytes: contents.length, sha256: tutorialContentHash(contents) });
  };
  try {
    await page.goto(pathToFileURL(resolve(stageDirectory, 'index.html')).href);
    await page.evaluate(async (colors) => {
      for (const [name, color] of Object.entries(colors))
        document.documentElement.style.setProperty(`--${name}`, color);
      await document.fonts.ready;
    }, palette);
    await page.waitForFunction(
      () => typeof (window as unknown as { renderTutorialAt?: unknown }).renderTutorialAt === 'function',
    );
    for (const cut of cuts) {
      const firstBeat = cut.beats[0];
      if (!firstBeat) throw new Error(`Cut ${cut.id} has no teaching beats.`);
      const segmentPaths: string[] = [];
      const coverFrame = Math.floor(firstBeat.frames / 2);
      let firstBeatCoverScene: StageScene | undefined;
      const segment = async (
        identity: unknown,
        frames: number,
        sceneAt: (frame: number) => StageScene,
      ): Promise<void> => {
        const hash = tutorialContentHash(JSON.stringify({ identity, frames, stageHash, palette, draft }));
        const output = resolve(cacheDirectory, `${hash}.mp4`);
        let cached = false;
        if (existsSync(output)) {
          try {
            const media = await probeTutorialMedia(output);
            cached =
              media.width === 1080 &&
              media.height === 1920 &&
              media.fps === 30 &&
              Math.abs(media.seconds - frames / TUTORIAL_FPS) <= 0.05;
          } catch {
            /* A damaged partial cache is regenerated. */
          }
        }
        if (!cached) {
          console.log(`Rendering ${cut.id}: ${frames / TUTORIAL_FPS}s segment`);
          await encodeSegment(page, output, frames, sceneAt);
        }
        segmentPaths.push(output);
      };
      await segment({ title: cut.title, intro: true }, cut.introFrames, () => ({
        title: cut.title,
        draft,
        totalFrames: cut.introFrames,
      }));
      for (const beat of cut.beats) {
        const manifest = manifests.get(beat.takeId)!;
        const sceneAt = (frame: number): StageScene => {
          const index = sourceFrameIndex(beat, manifest, frame);
          const sourceSeconds = index / TUTORIAL_FPS;
          const anchorTrack = beat.anchor ? manifest.anchors[beat.anchor] : undefined;
          const anchor = anchorTrack?.filter((candidate) => candidate.t <= sourceSeconds).at(-1) ?? anchorTrack?.[0];
          // Recorder anchors are normalized to the measured capture geometry.
          const focus =
            beat.focus ??
            (anchor
              ? {
                  x: Math.max(0, anchor.x - 0.12),
                  y: Math.max(0, anchor.y - 0.12),
                  width: Math.min(1 - Math.max(0, anchor.x - 0.12), anchor.width + 0.24),
                  height: Math.min(1 - Math.max(0, anchor.y - 0.12), anchor.height + 0.24),
                }
              : undefined);
          return {
            title: cut.title,
            draft,
            totalFrames: beat.frames,
            beat,
            elapsedFrames: frame,
            image: pathToFileURL(
              resolve(
                tutorialTakeDir(workRoot, platform, beat.takeId),
                'frames',
                `${String(index + 1).padStart(6, '0')}.jpg`,
              ),
            ).href,
            width: manifest.width,
            height: manifest.height,
            focus,
            anchor,
          };
        };
        if (beat === firstBeat) firstBeatCoverScene = sceneAt(coverFrame);
        // Cut position does not affect beat visuals; reuse the same beat across overview/master.
        await segment(
          {
            ...beat,
            startFrame: 0,
            frameSetSha256: frameSetHashes.get(beat.takeId),
            fingerprint: manifest.fingerprint,
            marks: manifest.marks,
            anchors: manifest.anchors,
          },
          beat.frames,
          sceneAt,
        );
      }
      await segment({ title: cut.title, outro: true }, cut.outroFrames, () => ({
        title: cut.title,
        draft,
        outro: true,
        totalFrames: cut.outroFrames,
      }));
      const concatFile = resolve(cacheDirectory, `${cut.id}-concat.txt`);
      writeFileSync(concatFile, segmentPaths.map((path) => `file '${path.replaceAll("'", "'\\''")}'`).join('\n'));
      const audioPath = resolve(cacheDirectory, `${cut.id}-${draft ? 'draft' : 'final'}.m4a`);
      await mixTutorialAudio(cut, options.music ?? null, audioPath, draft);
      const videoName = `${cut.id}.mp4`;
      const partialVideo = resolve(outputDirectory, `${cut.id}.partial.mp4`);
      await execFileAsync(resolveMediaBinary('ffmpeg'), [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        concatFile,
        '-i',
        audioPath,
        '-map',
        '0:v',
        '-map',
        '1:a',
        '-c',
        'copy',
        '-t',
        String(cut.totalFrames / TUTORIAL_FPS),
        '-movflags',
        '+faststart',
        partialVideo,
      ]);
      const encoded = await probeTutorialMedia(partialVideo);
      if (
        encoded.width !== 1080 ||
        encoded.height !== 1920 ||
        encoded.fps !== 30 ||
        !encoded.hasAudio ||
        Math.abs(encoded.seconds - cut.totalFrames / TUTORIAL_FPS) > 0.12
      )
        throw new Error(`Invalid delivery encoding for ${cut.id}.`);
      renameSync(partialVideo, resolve(outputDirectory, videoName));
      register(videoName, 'video', 'video/mp4', cut.id);
      if (!firstBeatCoverScene) throw new Error(`Cut ${cut.id} has no cover scene.`);
      await renderFrame(page, coverFrame, firstBeatCoverScene);
      await sharp(await page.screenshot())
        .webp({ quality: 90 })
        .toFile(resolve(outputDirectory, `${cut.id}.webp`));
      register(`${cut.id}.webp`, 'cover', 'image/webp', cut.id);
      writeCutFiles(cut, outputDirectory, episode);
      register(`${cut.id}.vtt`, 'subtitles', 'text/vtt', cut.id);
      register(`${cut.id}.chapters.json`, 'chapters', 'application/json', cut.id);
      register(`${cut.id}.caption.txt`, 'caption', 'text/plain', cut.id);
      console.log(`Ready: ${resolve(outputDirectory, videoName)} (${encoded.seconds.toFixed(1)}s)`);
    }
  } finally {
    await browser.close();
  }
  const bundle = {
    formatVersion: 1,
    episodeId: episode.id,
    title: episode.title,
    platform,
    draft,
    ...(options.sourceRef ? { sourceRef: options.sourceRef } : {}),
    createdAt: new Date().toISOString(),
    cuts: cuts.map((cut) => ({ id: cut.id, kind: cut.kind, seconds: cut.totalFrames / TUTORIAL_FPS })),
    assets,
    captureProvenance: [...manifests.values()],
  };
  writeFileSync(resolve(outputDirectory, 'bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`);
  return outputDirectory;
}

function writeCutFiles(cut: TutorialCut, outputDirectory: string, episode: TutorialEpisode): void {
  writeFileSync(resolve(outputDirectory, `${cut.id}.vtt`), tutorialWebVtt(cut));
  const seen = new Set<string>();
  const chapters = cut.beats.flatMap((beat) => {
    if (seen.has(beat.chapterId)) return [];
    seen.add(beat.chapterId);
    return [{ id: beat.chapterId, title: beat.chapterTitle, seconds: beat.startFrame / TUTORIAL_FPS }];
  });
  writeFileSync(
    resolve(outputDirectory, `${cut.id}.chapters.json`),
    `${JSON.stringify({ title: cut.title, chapters }, null, 2)}\n`,
  );
  writeFileSync(
    resolve(outputDirectory, `${cut.id}.caption.txt`),
    `${cut.title}\n\n${cut.beats.map((beat) => beat.title).join(' · ')}\n\nSave this for your next session. ${episode.releaseVersion ? `Boardsesh ${episode.releaseVersion}. ` : ''}boardsesh.com\n#boardsesh #boardclimbing #bouldering\n`,
  );
}
