import { existsSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Where the simulator operator drops raw `xcrun simctl io <udid> recordVideo`
 * output. Gitignored, like every other device capture: a 6-second portrait
 * recording off an iPhone 16 Pro Max is 3–8 MB before it is touched, and only
 * the converted web assets are worth a commit.
 */
export const HELP_CLIP_RAW_DIR = resolve(REPO_ROOT, '.boardsesh/help-clips/raw');

/** Shipped video pair, one `<name>.mp4` + `<name>.webm` per clip. */
export const HELP_CLIP_VIDEO_DIR = resolve(REPO_ROOT, 'packages/web/public/videos/help');

/**
 * Poster frames. They live under `images/` rather than beside the videos so the
 * static-asset catalog's existing webp walk picks them up with no special case,
 * and so a poster is served by the same image pipeline as a help still.
 */
export const HELP_CLIP_POSTER_DIR = resolve(REPO_ROOT, 'packages/web/public/images/help/clips');

/**
 * ffmpeg and ffprobe, wherever this machine keeps them. `FFMPEG_BIN` /
 * `FFPROBE_BIN` in the environment win; then PATH; then the usual Homebrew and
 * /usr/local prefixes, because not every shell that runs this has Homebrew on
 * PATH. A bare name is the last resort so the error names the missing tool.
 */
export function resolveMediaBinary(name: 'ffmpeg' | 'ffprobe', env: NodeJS.ProcessEnv = process.env): string {
  const override = env[`${name.toUpperCase()}_BIN`];
  if (override) return override;
  const directories = [...(env.PATH ?? '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  for (const directory of directories) {
    if (directory && existsSync(join(directory, name))) return join(directory, name);
  }
  return name;
}
export const FFMPEG_BIN = resolveMediaBinary('ffmpeg');
export const FFPROBE_BIN = resolveMediaBinary('ffprobe');

/** Seconds into the source, and where to stop. Both are source-relative. */
export type HelpClipTrim = Readonly<{ start: number; end: number }>;

export type HelpClipEntry = Readonly<{
  /** Shipped stem: `/videos/help/<name>.mp4`. */
  name: string;
  /** Raw capture stem inside the raw directory, without `.mov`. */
  source: string;
  /** Optional source-relative trim. Omitted means the whole recording. */
  trim?: HelpClipTrim;
  /**
   * Seconds into the TRIMMED clip to lift the poster from. Omitted means the
   * first frame. Set it when two clips open on the same screen, so their
   * posters do not come out byte-identical, or when the first frame is a
   * transition.
   */
  poster?: number;
  /** One line, for the conversion table and docs — not user-facing copy. */
  description: string;
}>;

/**
 * The single source of truth for the clip set: what the operator records, what
 * the converter writes, and what a help page may name.
 *
 * A gesture is the whole reason these exist. Anything a still already teaches
 * stays a still — `HelpScreenshot` is cheaper for the reader and for the page.
 * Entries that no page ends up using get pruned; an unused entry costs the
 * operator a recording session, so prune rather than keep "just in case".
 *
 * Trim is source-relative and optional. Leave it off while the operator is
 * still shooting: a clean 5–12 second take needs no trim, and a trim that
 * guesses at a take nobody has seen is worse than none.
 */
export const HELP_CLIPS = [
  {
    name: 'long-press-climb-actions',
    source: 'long-press-climb-actions',
    description: 'Press and hold a climb row until the actions sheet rises.',
  },
  {
    name: 'swipe-row-queue-playlist',
    source: 'swipe-row-queue-playlist',
    // The first frame is the same climbs list the long-press clip opens on; 3 s
    // in, the first swipe has landed and the "Climb added to queue" toast is up.
    poster: 3,
    description: 'Swipe a climb row to reveal queue and playlist actions.',
  },
  {
    name: 'remove-from-playlist',
    source: 'remove-from-playlist',
    description: 'Take a climb back out of a playlist.',
  },
  {
    name: 'logbook-swipe-edit-delete',
    source: 'logbook-swipe-edit-delete',
    description: 'Swipe a logbook entry to edit or delete the tick.',
  },
  {
    name: 'hold-filter-paint',
    source: 'hold-filter-paint',
    description: 'Paint holds on the board to filter the catalogue.',
  },
  {
    name: 'zone-filter-drag',
    source: 'zone-filter-drag',
    description: 'Drag a zone across the board to filter by area.',
  },
  {
    name: 'grade-range-tap',
    source: 'grade-range-tap',
    description: 'Tap two grades on the grade rail to set a range.',
  },
  {
    name: 'preview-browsing',
    source: 'preview-browsing',
    description: 'Browse the next climb without losing the one on the wall.',
  },
  {
    name: 'start-playlist-queue',
    source: 'start-playlist-queue',
    description: 'Start a playlist and watch it fill the queue.',
  },
] as const satisfies readonly HelpClipEntry[];

/**
 * The names a help page may reference. `packages/web/app/lib/help-clips.ts`
 * declares the same union for the browser (it cannot import from `scripts/`);
 * `scripts/__tests__/help-clips.test.ts` holds the two together.
 */
export type HelpClipName = (typeof HELP_CLIPS)[number]['name'];

/**
 * Encoder settings. Fixed here rather than at each call site so the mp4 and the
 * webm can never drift into describing different pixels, and so a test can pin
 * the exact argument vector without running ffmpeg.
 */
export const HELP_CLIP_WIDTH = 736;
/**
 * The box every clip must land in. The page CSS (`aspect-ratio: 736 / 1600`) and
 * the poster resize both assume it, so the converter checks the encoded stream
 * rather than letting a capture from a different device silently ship a video
 * whose intrinsic size disagrees with the page.
 */
export const HELP_CLIP_HEIGHT = 1600;
export const HELP_CLIP_FPS = 30;
export const HELP_CLIP_MP4_CRF = 24;
export const HELP_CLIP_MP4_PRESET = 'slow';
export const HELP_CLIP_WEBM_CRF = 34;

/** Same Sharp call as `help:convert-shots`, so a poster and a still match. */
export const HELP_CLIP_POSTER_RESIZE = { height: 1600, withoutEnlargement: true } as const;
export const HELP_CLIP_POSTER_ENCODE = { quality: 87, effort: 6 } as const;

/**
 * Per-file budget. A 6-second portrait screen recording at these settings lands
 * around 200–600 KB; anything past this is a clip that should have been trimmed
 * or a recording that caught a full-screen board render mid-animation.
 */
export const HELP_CLIP_MAX_BYTES = 1_500_000;

/** Recording length the operator is asked for. Enforced as a warning, not a gate. */
export const HELP_CLIP_MIN_SECONDS = 5;
export const HELP_CLIP_MAX_SECONDS = 12;

/**
 * Accepts only a plain lowercase hyphenated stem. The name becomes a public URL
 * path segment and a TypeScript union member, so nothing else may reach either.
 */
export function assertHelpClipStem(stem: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(stem)) throw new Error(`Not a usable help clip name: ${stem}`);
  return stem;
}

/** Strips `.mov` (the simctl default) and validates what is left. */
export function helpClipSourceName(filename: string): string {
  const name = basename(filename);
  const stem = name.toLowerCase().endsWith('.mov') ? name.slice(0, -4) : name;
  return assertHelpClipStem(stem);
}

export function findHelpClip(name: string): HelpClipEntry | undefined {
  return HELP_CLIPS.find((clip) => clip.name === name);
}

/**
 * Validates the table itself: names and source stems must be URL-safe and
 * unique, and a trim must describe a real, forward window. Called before any
 * conversion so a typo fails the run rather than one silent clip.
 */
export function assertHelpClipTableValid(clips: readonly HelpClipEntry[] = HELP_CLIPS): void {
  const seenNames = new Set<string>();
  for (const clip of clips) {
    assertHelpClipStem(clip.name);
    assertHelpClipStem(clip.source);
    if (seenNames.has(clip.name)) throw new Error(`Duplicate help clip name: ${clip.name}`);
    seenNames.add(clip.name);
    if (!clip.description.trim()) throw new Error(`Help clip ${clip.name} has no description`);
    if (!clip.trim) continue;
    const { start, end } = clip.trim;
    if (!Number.isFinite(start) || start < 0) throw new Error(`Help clip ${clip.name} has an invalid trim start`);
    if (!Number.isFinite(end) || end <= start) {
      throw new Error(`Help clip ${clip.name} trims to an empty window: ${start}s to ${end}s`);
    }
  }
}

/**
 * ffmpeg's seek pair for a clip: `-ss` before the input (fast, and accurate for
 * a re-encode) plus a duration rather than an end timestamp, because `-t` after
 * an input seek is relative and `-to` is not.
 */
export function helpClipSeekArgs(trim: HelpClipTrim | undefined): string[] {
  if (!trim) return [];
  return ['-ss', String(trim.start), '-t', String(trim.end - trim.start)];
}

/**
 * `fps` before `scale` so the scaler only works on frames that survive, and
 * `-2` for the height so the encoder always gets even dimensions — yuv420p
 * rejects an odd one, and a 1320x2868 capture scales to a fractional height.
 */
export function helpClipVideoFilter(): string {
  return `fps=${HELP_CLIP_FPS},scale=${HELP_CLIP_WIDTH}:-2`;
}

export type HelpClipConversion = Readonly<{ input: string; output: string; trim?: HelpClipTrim; poster?: number }>;

/** H.264 for Safari and every older browser; `+faststart` so it plays before it finishes loading. */
export function buildHelpClipMp4Args({ input, output, trim }: HelpClipConversion): string[] {
  return [
    '-y',
    '-loglevel',
    'error',
    ...helpClipSeekArgs(trim),
    '-i',
    input,
    '-an',
    '-vf',
    helpClipVideoFilter(),
    '-c:v',
    'libx264',
    '-crf',
    String(HELP_CLIP_MP4_CRF),
    '-preset',
    HELP_CLIP_MP4_PRESET,
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    output,
  ];
}

/** VP9 for the browsers that prefer it; `-b:v 0` is what makes `-crf` constant-quality. */
export function buildHelpClipWebmArgs({ input, output, trim }: HelpClipConversion): string[] {
  return [
    '-y',
    '-loglevel',
    'error',
    ...helpClipSeekArgs(trim),
    '-i',
    input,
    '-an',
    '-vf',
    helpClipVideoFilter(),
    '-c:v',
    'libvpx-vp9',
    '-crf',
    String(HELP_CLIP_WEBM_CRF),
    '-b:v',
    '0',
    '-row-mt',
    '1',
    '-pix_fmt',
    'yuv420p',
    output,
  ];
}

/**
 * One frame of the trimmed clip as a PNG on stdout, for Sharp to encode: the
 * first frame unless the entry names a `poster` offset.
 *
 * This ffmpeg has no libwebp encoder, and the poster has to come out of the
 * same Sharp call as every other help asset anyway, so the frame is piped
 * rather than written. Full source resolution: Sharp does the downsample.
 */
export function buildHelpClipPosterFrameArgs({ input, trim, poster }: Omit<HelpClipConversion, 'output'>): string[] {
  const seek = (trim?.start ?? 0) + (poster ?? 0);
  return [
    '-loglevel',
    'error',
    ...(seek > 0 ? ['-ss', String(seek)] : []),
    '-i',
    input,
    '-frames:v',
    '1',
    '-f',
    'image2pipe',
    '-c:v',
    'png',
    '-',
  ];
}

/** Duration in seconds, printed bare, for the conversion table. */
export function buildHelpClipProbeArgs(file: string): string[] {
  return ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file];
}

/** Encoded stream width and height, one per line, for the dimension check. */
export function buildHelpClipDimensionsProbeArgs(file: string): string[] {
  return [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    file,
  ];
}

export function parseHelpClipDimensions(probeOutput: string): { width: number; height: number } {
  const [width, height] = probeOutput
    .trim()
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10));
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error(`Could not read dimensions from: ${probeOutput}`);
  }
  return { width, height };
}

/** The encoded clip has to fit the page's box exactly; anything else is a capture from the wrong device. */
export function assertHelpClipDimensions(name: string, dimensions: { width: number; height: number }): void {
  if (dimensions.width !== HELP_CLIP_WIDTH || dimensions.height !== HELP_CLIP_HEIGHT) {
    throw new Error(
      `${name} encoded at ${dimensions.width}x${dimensions.height}, not ${HELP_CLIP_WIDTH}x${HELP_CLIP_HEIGHT}. ` +
        'Help clips are shot on an iPhone 16 Pro Max (1320x2868); re-record on that device.',
    );
  }
}

export function parseHelpClipDuration(probeOutput: string): number {
  const seconds = Number.parseFloat(probeOutput.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`Could not read a duration from: ${probeOutput}`);
  return seconds;
}

export type ResolvedHelpClip = Readonly<{
  entry: HelpClipEntry;
  /** Absolute path to the raw `.mov`. */
  input: string;
  mp4: string;
  webm: string;
  poster: string;
}>;

export function helpClipOutputs(name: string): Pick<ResolvedHelpClip, 'mp4' | 'webm' | 'poster'> {
  return {
    mp4: resolve(HELP_CLIP_VIDEO_DIR, `${name}.mp4`),
    webm: resolve(HELP_CLIP_VIDEO_DIR, `${name}.webm`),
    poster: resolve(HELP_CLIP_POSTER_DIR, `${name}.webp`),
  };
}

export type HelpClipSet = Readonly<{
  present: readonly ResolvedHelpClip[];
  missing: readonly string[];
}>;

/**
 * Resolves the clip set inside `inputDir`, reporting every absent recording at
 * once rather than one failed conversion at a time.
 *
 * The operator delivers incrementally, so `allowPartial` converts what has
 * arrived and names the rest. Without it a gap is fatal, because a help page
 * that references a clip nobody shot renders a broken player.
 */
export function resolveHelpClipSet(
  inputDir: string,
  options: { only?: string; allowPartial?: boolean } = {},
  fileExists: (path: string) => boolean = existsSync,
): HelpClipSet {
  assertHelpClipTableValid();
  const wanted = options.only
    ? [
        findHelpClip(options.only) ??
          (() => {
            throw new Error(
              `Unknown help clip: ${options.only}\nKnown clips:\n` +
                HELP_CLIPS.map((clip) => `  - ${clip.name}`).join('\n'),
            );
          })(),
      ]
    : HELP_CLIPS;

  const present: ResolvedHelpClip[] = [];
  const missing: string[] = [];
  for (const entry of wanted) {
    const input = resolve(inputDir, `${entry.source}.mov`);
    if (fileExists(input)) present.push({ entry, input, ...helpClipOutputs(entry.name) });
    else missing.push(`${entry.source}.mov`);
  }

  if (missing.length && !options.allowPartial) {
    throw new Error(
      `Missing ${missing.length} of ${wanted.length} help clip recording(s) in ${inputDir}:\n` +
        missing.map((filename) => `  - ${filename}`).join('\n') +
        '\nRecord them, or pass --allow-partial to convert what has arrived.',
    );
  }
  return { present, missing };
}

export type HelpClipArgs = Readonly<{
  inputDir: string;
  only?: string;
  allowPartial: boolean;
  dryRun: boolean;
  help: boolean;
}>;

export function parseHelpClipArgs(argv: readonly string[]): HelpClipArgs {
  let inputDir = HELP_CLIP_RAW_DIR;
  let only: string | undefined;
  let allowPartial = false;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    // `vp run <task> -- --flag` forwards the separator itself; drop it.
    if (argument === '--') continue;
    if (argument === '--help' || argument === '-h') return { inputDir, only, allowPartial, dryRun, help: true };
    if (argument === '--allow-partial') allowPartial = true;
    else if (argument === '--dry-run') dryRun = true;
    else if (argument === '--only' || argument === '--input') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) throw new Error(`${argument} needs a value`);
      if (argument === '--only') only = assertHelpClipStem(value);
      else inputDir = resolve(value);
      index += 1;
    } else if (argument.startsWith('-')) throw new Error(`Unknown option: ${argument}`);
    // A bare positional is the raw directory, matching `help:convert-shots`.
    else inputDir = resolve(argument);
  }
  return { inputDir, only, allowPartial, dryRun, help: false };
}
