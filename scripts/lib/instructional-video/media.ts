import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { resolveMediaBinary } from '../help-clips';
import { tutorialContentHash, type TutorialCut, type TutorialVoice } from './timeline';
import { TUTORIAL_FPS } from './types';

const execFileAsync = promisify(execFile);

export async function probeTutorialMedia(
  path: string,
): Promise<{ seconds: number; hasAudio: boolean; width?: number; height?: number; fps?: number }> {
  const { stdout } = await execFileAsync(resolveMediaBinary('ffprobe'), [
    '-v',
    'error',
    '-show_entries',
    'format=duration:stream=codec_type,width,height,r_frame_rate',
    '-of',
    'json',
    path,
  ]);
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; width?: number; height?: number; r_frame_rate?: string }[];
  };
  const seconds = Number(parsed.format?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`Empty or unreadable media: ${path}`);
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  const rate = video?.r_frame_rate?.split('/').map(Number);
  return {
    seconds,
    hasAudio: parsed.streams?.some((stream) => stream.codec_type === 'audio') ?? false,
    ...(video
      ? { width: video.width, height: video.height, fps: rate && rate[1] ? rate[0] / rate[1] : undefined }
      : {}),
  };
}

export async function tutorialVoice(path: string): Promise<TutorialVoice> {
  const media = await probeTutorialMedia(path);
  if (!media.hasAudio) throw new Error(`Recording contains no audio: ${path}`);
  return { path, seconds: media.seconds, sha256: tutorialContentHash(readFileSync(path)) };
}

/** Argument vectors only: filenames are never passed through a shell. */
export function tutorialMixArgs(cut: TutorialCut, musicPath: string | null, output: string, draft: boolean): string[] {
  const duration = cut.totalFrames / TUTORIAL_FPS;
  if (draft)
    return [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-t',
      String(duration),
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      output,
    ];
  const missing = cut.beats.filter((beat) => !beat.voice).map((beat) => beat.id);
  if (missing.length || !musicPath)
    throw new Error(
      `Final audio needs ${missing.length ? `recordings: ${missing.join(', ')}` : 'the supplied music file'}.`,
    );
  const inputs = cut.beats.flatMap((beat) => ['-i', beat.voice!.path]);
  inputs.push('-stream_loop', '-1', '-i', musicPath);
  const filters = cut.beats.flatMap((beat, index) => {
    const offset = beat.startFrame / TUTORIAL_FPS;
    const normalized = `[${index}:a]aresample=48000,aformat=channel_layouts=stereo,loudnorm=I=-16:TP=-1.5:LRA=7,aresample=48000,asetpts=N/SR/TB`;
    const padding = `apad,atrim=duration=${duration}[voice${index}]`;
    // Finite silence gives amix continuous timestamps even when loudnorm buffers a whole recording.
    return offset > 0
      ? [
          `${normalized}[recording${index}]`,
          `anullsrc=channel_layout=stereo:sample_rate=48000:d=${offset}[lead${index}]`,
          `[lead${index}][recording${index}]concat=n=2:v=0:a=1,${padding}`,
        ]
      : [`${normalized},${padding}`];
  });
  const voiceLabels = cut.beats.map((_, index) => `[voice${index}]`).join('');
  filters.push(
    `${voiceLabels}amix=inputs=${cut.beats.length}:duration=longest:normalize=0,apad,atrim=duration=${duration}[spoken]`,
  );
  const narrationIntervals = cut.beats
    .map(
      (beat) => `between(t,${beat.startFrame / TUTORIAL_FPS},${beat.startFrame / TUTORIAL_FPS + beat.voice!.seconds})`,
    )
    .join('+');
  // Duck supplied music during the known narration intervals.
  const musicVolume = `if(gt(${narrationIntervals},0),0.035,0.14)`;
  filters.push(
    `[${cut.beats.length}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=${duration},volume='${musicVolume}':eval=frame,afade=t=in:d=0.5,afade=t=out:st=${Math.max(0, duration - 1)}:d=1[bed]`,
  );
  filters.push(
    `[spoken][bed]amix=inputs=2:duration=longest:normalize=0,apad,atrim=duration=${duration},alimiter=limit=0.84:level=false[mixed]`,
  );
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...inputs,
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[mixed]',
    '-t',
    String(duration),
    '-ar',
    '48000',
    '-ac',
    '2',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    output,
  ];
}

export async function mixTutorialAudio(
  cut: TutorialCut,
  musicPath: string | null,
  output: string,
  draft: boolean,
): Promise<void> {
  await execFileAsync(resolveMediaBinary('ffmpeg'), tutorialMixArgs(cut, musicPath, output, draft), {
    maxBuffer: 4 * 1024 * 1024,
  });
}
