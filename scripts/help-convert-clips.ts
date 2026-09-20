import { execFile } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';
import {
  assertHelpClipTableValid,
  buildHelpClipMp4Args,
  buildHelpClipDimensionsProbeArgs,
  buildHelpClipPosterFrameArgs,
  assertHelpClipDimensions,
  parseHelpClipDimensions,
  buildHelpClipProbeArgs,
  buildHelpClipWebmArgs,
  FFMPEG_BIN,
  FFPROBE_BIN,
  HELP_CLIP_MAX_BYTES,
  HELP_CLIP_MAX_SECONDS,
  HELP_CLIP_MIN_SECONDS,
  HELP_CLIP_POSTER_DIR,
  HELP_CLIP_POSTER_ENCODE,
  HELP_CLIP_POSTER_RESIZE,
  HELP_CLIP_RAW_DIR,
  HELP_CLIP_VIDEO_DIR,
  parseHelpClipArgs,
  parseHelpClipDuration,
  resolveHelpClipSet,
  type ResolvedHelpClip,
} from './lib/help-clips';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);

const USAGE = `Usage: vp run help:convert-clips [-- [--input <dir>] [--only <name>] [--allow-partial] [--dry-run]]

Converts the raw simulator recordings into the assets the help pages ship:
  ${relative(REPO_ROOT, HELP_CLIP_VIDEO_DIR)}/<name>.mp4 + .webm
  ${relative(REPO_ROOT, HELP_CLIP_POSTER_DIR)}/<name>.webp

  --input <dir>     Raw recording directory, also accepted as a bare positional
                    (default: ${HELP_CLIP_RAW_DIR})
  --only <name>     Convert a single clip from the table
  --allow-partial   Convert what has arrived and name the rest, instead of failing
  --dry-run         List the conversions without writing anything
  --help            Show this message

Recording contract and size budget: docs/help-clips.md.`;

/** Buffer cap for the piped poster frame: one full-resolution portrait PNG. */
const POSTER_FRAME_MAX_BYTES = 64 * 1024 * 1024;

async function runFfmpeg(args: readonly string[]): Promise<void> {
  await execFileAsync(FFMPEG_BIN, [...args]);
}

async function probeDurationSeconds(file: string): Promise<number> {
  const { stdout } = await execFileAsync(FFPROBE_BIN, buildHelpClipProbeArgs(file));
  return parseHelpClipDuration(stdout);
}

async function assertEncodedDimensions(name: string, file: string): Promise<void> {
  const { stdout } = await execFileAsync(FFPROBE_BIN, buildHelpClipDimensionsProbeArgs(file));
  assertHelpClipDimensions(name, parseHelpClipDimensions(stdout));
}

async function captureFirstFrame(clip: ResolvedHelpClip): Promise<Buffer> {
  const { stdout } = await execFileAsync(
    FFMPEG_BIN,
    buildHelpClipPosterFrameArgs({ input: clip.input, trim: clip.entry.trim, poster: clip.entry.poster }),
    { encoding: 'buffer', maxBuffer: POSTER_FRAME_MAX_BYTES },
  );
  if (!stdout.length) throw new Error(`No poster frame came out of ${clip.entry.source}.mov`);
  return stdout;
}

type ConvertedHelpClip = Readonly<{
  name: string;
  seconds: number;
  mp4Bytes: number;
  webmBytes: number;
  posterBytes: number;
}>;

async function convertClip(clip: ResolvedHelpClip): Promise<ConvertedHelpClip> {
  const { trim } = clip.entry;
  await runFfmpeg(buildHelpClipMp4Args({ input: clip.input, output: clip.mp4, trim }));
  await assertEncodedDimensions(clip.entry.name, clip.mp4);
  await runFfmpeg(buildHelpClipWebmArgs({ input: clip.input, output: clip.webm, trim }));
  // Same Sharp call as help:convert-shots, so a poster and a still that sit in
  // the same row are encoded identically and cannot look like two sources.
  const poster = await sharp(await captureFirstFrame(clip))
    .resize(HELP_CLIP_POSTER_RESIZE)
    .webp(HELP_CLIP_POSTER_ENCODE)
    .toBuffer();
  writeFileSync(clip.poster, poster);
  return {
    name: clip.entry.name,
    seconds: await probeDurationSeconds(clip.mp4),
    mp4Bytes: statSync(clip.mp4).size,
    webmBytes: statSync(clip.webm).size,
    posterBytes: poster.length,
  };
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function printTable(converted: readonly ConvertedHelpClip[]): void {
  const nameWidth = Math.max(4, ...converted.map((row) => row.name.length));
  console.log(
    `[help:convert-clips] ${'clip'.padEnd(nameWidth)}  ${'dur'.padStart(6)}  ${'mp4'.padStart(8)}  ${'webm'.padStart(8)}  ${'poster'.padStart(8)}`,
  );
  for (const row of converted) {
    console.log(
      `[help:convert-clips] ${row.name.padEnd(nameWidth)}  ${`${row.seconds.toFixed(1)}s`.padStart(6)}  ` +
        `${formatBytes(row.mp4Bytes).padStart(8)}  ${formatBytes(row.webmBytes).padStart(8)}  ` +
        `${formatBytes(row.posterBytes).padStart(8)}`,
    );
  }
}

/**
 * Everything past this point is advice, not a gate: an over-budget clip is a
 * judgement call for the person committing it, and failing the run would leave
 * them with no converted file to look at while they decide.
 */
function warnAboutBudgets(converted: readonly ConvertedHelpClip[]): void {
  for (const row of converted) {
    for (const [label, bytes] of [
      ['mp4', row.mp4Bytes],
      ['webm', row.webmBytes],
      ['poster', row.posterBytes],
    ] as const) {
      if (bytes > HELP_CLIP_MAX_BYTES) {
        console.warn(
          `[help:convert-clips] ${row.name}.${label} is ${formatBytes(bytes)}, over the ` +
            `${formatBytes(HELP_CLIP_MAX_BYTES)} budget — trim the take or cut the motion before committing`,
        );
      }
    }
    if (row.seconds < HELP_CLIP_MIN_SECONDS || row.seconds > HELP_CLIP_MAX_SECONDS) {
      console.warn(
        `[help:convert-clips] ${row.name} runs ${row.seconds.toFixed(1)}s, outside the ` +
          `${HELP_CLIP_MIN_SECONDS}–${HELP_CLIP_MAX_SECONDS}s window a gesture clip should hold`,
      );
    }
  }
}

async function main(): Promise<void> {
  const { inputDir, only, allowPartial, dryRun, help } = parseHelpClipArgs(process.argv.slice(2));
  if (help) {
    console.log(USAGE);
    return;
  }
  assertHelpClipTableValid();

  // Throws naming every absent recording, before a single file is written,
  // unless the operator is still delivering and asked for a partial run.
  const { present, missing } = resolveHelpClipSet(inputDir, { only, allowPartial });
  for (const filename of missing) console.log(`[help:convert-clips] not recorded yet: ${filename}`);
  if (!present.length) {
    console.log(`[help:convert-clips] nothing to convert in ${inputDir}`);
    return;
  }
  if (dryRun) {
    for (const clip of present) console.log(`[help:convert-clips] would write ${clip.entry.name}.{mp4,webm,webp}`);
    return;
  }

  mkdirSync(HELP_CLIP_VIDEO_DIR, { recursive: true });
  mkdirSync(HELP_CLIP_POSTER_DIR, { recursive: true });
  const converted: ConvertedHelpClip[] = [];
  for (const clip of present) converted.push(await convertClip(clip));

  printTable(converted);
  warnAboutBudgets(converted);
  console.log(
    `[help:convert-clips] ${converted.length} clip(s) converted; ` +
      'run `vp run generate:static-assets` and commit the regenerated catalog',
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Help clip conversion failed');
  process.exitCode = 1;
});
