import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Probe real encoded footage before extracting full-size, one-based 30fps frames. */
export function extractTutorialFrames(
  options: {
    takeId: string;
    takeDir: string;
    trim: number;
    recordedSeconds: number;
    geometry: { width: number; height: number };
    env: NodeJS.ProcessEnv;
  },
  command: (binary: string, args: string[], timeout?: number) => string,
): { seconds: number; frameCount: number } {
  const { takeId, takeDir, trim, recordedSeconds, geometry, env } = options;
  const rawPath = join(takeDir, 'raw.mp4');
  const encoded = JSON.parse(
    command(env.FFPROBE_BIN ?? 'ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height:format=duration',
      '-of',
      'json',
      rawPath,
    ]),
  ) as { streams?: { width: number; height: number }[]; format?: { duration?: string } };
  if (encoded.streams?.[0]?.width !== geometry.width || encoded.streams?.[0]?.height !== geometry.height)
    throw new Error(`Capture ${takeId} encoded dimensions differ from measured screen.`);
  const rawSeconds = Number(encoded.format?.duration);
  if (!Number.isFinite(rawSeconds) || rawSeconds <= trim)
    throw new Error(`Capture ${takeId} has invalid or truncated raw recording.`);
  const seconds = Math.min(rawSeconds - trim, recordedSeconds);
  command(
    env.FFMPEG_BIN ?? 'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-i',
      rawPath,
      '-an',
      '-vf',
      `fps=30,trim=start=${trim.toFixed(3)}:duration=${seconds.toFixed(3)},setpts=PTS-STARTPTS,format=yuvj420p`,
      '-q:v',
      '3',
      '-start_number',
      '1',
      join(takeDir, 'frames', '%06d.jpg'),
    ],
    180_000,
  );
  const frameCount = readdirSync(join(takeDir, 'frames')).filter((name) => /^\d{6}\.jpg$/.test(name)).length;
  return { seconds, frameCount };
}
