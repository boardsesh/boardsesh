import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  TUTORIAL_FPS,
  type TutorialBeat,
  type TutorialChapter,
  type TutorialEpisode,
  type TutorialPlatform,
  type TutorialTakeManifest,
} from './types';
import { tutorialAudioDir, tutorialTakeDir } from './paths';

export type TutorialVoice = Readonly<{ path: string; seconds: number; sha256: string }>;
export type TutorialTimedBeat = TutorialBeat &
  Readonly<{ chapterId: string; chapterTitle: string; startFrame: number; frames: number; voice?: TutorialVoice }>;
export type TutorialCut = Readonly<{
  id: string;
  kind: 'master' | 'overview' | 'chapter';
  title: string;
  beats: readonly TutorialTimedBeat[];
  introFrames: number;
  outroFrames: number;
  totalFrames: number;
}>;

export function voicePath(workRoot: string, episodeId: string, beatId: string, directory?: string): string | null {
  const audioDirectory = directory ?? tutorialAudioDir(workRoot, episodeId);
  const matches = ['wav', 'm4a', 'mp3']
    .map((extension) => resolve(audioDirectory, `${beatId}.${extension}`))
    .filter(existsSync);
  if (matches.length > 1) throw new Error(`More than one recording for ${beatId}; keep one WAV, M4A or MP3 file.`);
  return matches[0] ?? null;
}

export function selectedChapters(episode: TutorialEpisode, chapterIds?: readonly string[]): readonly TutorialChapter[] {
  if (!chapterIds) return episode.chapters;
  if (chapterIds.length === 0 || new Set(chapterIds).size !== chapterIds.length)
    throw new Error('Select at least one chapter, without duplicates.');
  const chapters = chapterIds.map((id) => {
    const chapter = episode.chapters.find((candidate) => candidate.id === id);
    if (!chapter) throw new Error(`Unknown chapter ${id} in ${episode.id}.`);
    return chapter;
  });
  return chapters;
}

export function buildTutorialCuts(
  episode: TutorialEpisode,
  voices: ReadonlyMap<string, TutorialVoice> = new Map(),
  chapterIds?: readonly string[],
): readonly TutorialCut[] {
  const chapters = selectedChapters(episode, chapterIds);
  const timedCut = (
    id: string,
    kind: TutorialCut['kind'],
    title: string,
    chosen: readonly TutorialChapter[],
    overview = false,
  ): TutorialCut => {
    const introFrames = kind === 'chapter' ? 45 : kind === 'overview' ? 90 : 135;
    const outroFrames = introFrames;
    let cursor = introFrames;
    const beats: TutorialTimedBeat[] = [];
    for (const chapter of chosen) {
      for (const beat of chapter.beats) {
        if (overview && !beat.overview) continue;
        const voice = voices.get(beat.id);
        if (voice && (!Number.isFinite(voice.seconds) || voice.seconds <= 0 || voice.seconds > 30))
          throw new Error(`Recording ${beat.id} must contain between 0 and 30 seconds of speech.`);
        const frames = Math.ceil(Math.max(beat.seconds, (voice?.seconds ?? 0) + 0.25) * TUTORIAL_FPS);
        beats.push({
          ...beat,
          chapterId: chapter.id,
          chapterTitle: chapter.title,
          startFrame: cursor,
          frames,
          ...(voice ? { voice } : {}),
        });
        cursor += frames;
      }
    }
    if (beats.length === 0) throw new Error(`Cut ${id} has no teaching beats.`);
    return { id, kind, title, beats, introFrames, outroFrames, totalFrames: cursor + outroFrames };
  };
  const cuts: TutorialCut[] = chapters.map((chapter) => timedCut(chapter.id, 'chapter', chapter.title, [chapter]));
  if (!chapterIds) {
    cuts.unshift(timedCut('overview', 'overview', episode.title, chapters, true));
    cuts.unshift(timedCut('master', 'master', episode.title, chapters));
  }
  for (const cut of cuts) {
    const seconds = cut.totalFrames / TUTORIAL_FPS;
    const limits = cut.kind === 'master' ? episode.master : cut.kind === 'overview' ? episode.overview : null;
    if (limits && (seconds < limits.minSeconds || seconds > limits.maxSeconds))
      throw new Error(
        `${cut.id} is ${seconds.toFixed(1)} seconds; ${episode.id} requires ${limits.minSeconds}–${limits.maxSeconds}. Shorten the named recordings or revise the chapter selection.`,
      );
  }
  return cuts;
}

export function readTutorialTake(workRoot: string, platform: TutorialPlatform, takeId: string): TutorialTakeManifest {
  const directory = tutorialTakeDir(workRoot, platform, takeId);
  const path = resolve(directory, 'manifest.json');
  if (!existsSync(path)) throw new Error(`Missing recorded take ${takeId}. Capture it before rendering: ${path}`);
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const isRecord = (input: unknown): input is Readonly<Record<string, unknown>> =>
    !!input && typeof input === 'object' && !Array.isArray(input);
  if (!isRecord(parsed)) throw new Error(`Invalid take manifest: ${path}`);
  const manifest = parsed as TutorialTakeManifest;
  if (
    manifest.formatVersion !== 1 ||
    manifest.takeId !== takeId ||
    manifest.platform !== platform ||
    manifest.fps !== TUTORIAL_FPS ||
    !Number.isInteger(manifest.frameCount) ||
    manifest.frameCount <= 0 ||
    !Number.isFinite(manifest.seconds) ||
    manifest.seconds <= 0 ||
    Math.abs(manifest.frameCount - manifest.seconds * TUTORIAL_FPS) > 1 ||
    !Number.isFinite(manifest.width) ||
    manifest.width <= 0 ||
    !Number.isFinite(manifest.height) ||
    manifest.height <= 0 ||
    !isRecord(manifest.screen) ||
    !Number.isFinite(manifest.screen.width) ||
    manifest.screen.width <= 0 ||
    !Number.isFinite(manifest.screen.height) ||
    manifest.screen.height <= 0 ||
    !isRecord(manifest.marks) ||
    !isRecord(manifest.anchors) ||
    !manifest.sourceCommit ||
    !/^[a-f0-9]{64}$/.test(manifest.nativeArtifactSha256) ||
    !manifest.fingerprint
  ) {
    throw new Error(`Invalid capture metadata for ${takeId}: ${path}`);
  }
  for (const [markName, seconds] of Object.entries(manifest.marks)) {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > manifest.seconds)
      throw new Error(`Invalid capture mark ${markName} for ${takeId}: ${path}`);
  }
  const roundingEpsilon = 0.0001;
  for (const [anchorName, samples] of Object.entries(manifest.anchors)) {
    if (!Array.isArray(samples)) throw new Error(`Invalid capture anchor ${anchorName} for ${takeId}: ${path}`);
    for (const sample of samples) {
      if (
        !isRecord(sample) ||
        typeof sample.t !== 'number' ||
        typeof sample.x !== 'number' ||
        typeof sample.y !== 'number' ||
        typeof sample.width !== 'number' ||
        typeof sample.height !== 'number' ||
        ![sample.t, sample.x, sample.y, sample.width, sample.height].every(Number.isFinite) ||
        sample.t < 0 ||
        sample.t > manifest.seconds + 1 / TUTORIAL_FPS ||
        sample.x < -roundingEpsilon ||
        sample.y < -roundingEpsilon ||
        sample.width <= 0 ||
        sample.height <= 0 ||
        sample.x + sample.width > 1 + roundingEpsilon ||
        sample.y + sample.height > 1 + roundingEpsilon
      ) {
        throw new Error(`Invalid capture anchor ${anchorName} for ${takeId}: ${path}`);
      }
    }
  }
  return manifest;
}

/** Stop at the next demonstrated action rather than playing unrelated footage. */
export function sourceFrameIndex(beat: TutorialBeat, manifest: TutorialTakeManifest, elapsedFrames: number): number {
  const start = manifest.marks[beat.fromMark];
  if (!Number.isFinite(start) || start < 0 || start >= manifest.seconds)
    throw new Error(`Take ${manifest.takeId} is missing a valid mark ${beat.fromMark}.`);
  const end = beat.toMark
    ? manifest.marks[beat.toMark]
    : Math.min(manifest.seconds, ...Object.values(manifest.marks).filter((seconds) => seconds > start + 0.05));
  if (!Number.isFinite(end) || end <= start || end > manifest.seconds + 1 / TUTORIAL_FPS)
    throw new Error(`Take ${manifest.takeId} has an invalid ending mark for ${beat.id}.`);
  return Math.min(
    manifest.frameCount - 1,
    Math.max(0, Math.floor(Math.min(start + elapsedFrames / TUTORIAL_FPS, end - 1 / TUTORIAL_FPS) * TUTORIAL_FPS)),
  );
}

export const tutorialContentHash = (contents: string | Uint8Array): string =>
  createHash('sha256').update(contents).digest('hex');

export function subtitleTimestamp(frames: number): string {
  const milliseconds = Math.round((frames * 1000) / TUTORIAL_FPS);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds / 60_000) % 60;
  const seconds = Math.floor(milliseconds / 1000) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
}

export function wrapTutorialCaption(sentence: string, columns = 52): string {
  const lines: string[] = [];
  for (const word of sentence.trim().split(/\s+/)) {
    const last = lines.length - 1;
    if (last < 0 || lines[last].length + word.length + 1 > columns) lines.push(word);
    else lines[last] += ` ${word}`;
  }
  return lines.join('\n');
}

export function tutorialWebVtt(cut: TutorialCut): string {
  return `WEBVTT\n\n${cut.beats.map((beat) => `${beat.id}\n${subtitleTimestamp(beat.startFrame)} --> ${subtitleTimestamp(beat.startFrame + beat.frames)}\n${wrapTutorialCaption(beat.narration).replaceAll('-->', '→')}\n`).join('\n')}`;
}

export function tutorialRecordingPack(episode: TutorialEpisode): string {
  return `# ${episode.title}: voice recording pack\n\nRecord one short sentence per file, using your own voice. Aim for 5–8 seconds, with a short pause before and after speaking. Use WAV, M4A or MP3; keep one format per beat. The filenames below use WAV as an example.\n\n${episode.chapters.map((chapter) => `## ${chapter.title}\n\n${chapter.beats.map((beat, index) => `${index + 1}. **${beat.id}.wav** (${beat.seconds} seconds): “${beat.narration}”`).join('\n\n')}`).join('\n\n')}\n\nSupply the music as a separate file. The pipeline mixes it beneath your voice; keep the same recording files to regenerate shorter cuts.\n`;
}
