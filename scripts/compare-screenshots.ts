/// <reference types="node" />

/**
 * Pixel comparison between a stored screenshot baseline and a fresh capture.
 *
 * This is the gate that makes the iOS App Store screenshot workflow self-sizing:
 * one probe shard (en-US x iPhone 16 Pro Max) is captured first and compared
 * against the shard stored in the `screenshots-baseline` prerelease. Only when
 * the probe differs does the workflow fan out to the other 11 locale x device
 * shards, so a run that changes nothing costs one macOS runner instead of
 * twelve.
 *
 * Usage:
 *   vp run screenshot:compare -- \
 *     --baseline <dir> --candidate <dir> \
 *     [--summary <file.json>] [--diff-out <dir>] \
 *     [--channel-tolerance N] [--max-diff-ratio R]
 *
 * `SCREENSHOT_CHANNEL_TOLERANCE` and `SCREENSHOT_MAX_DIFF_RATIO` set the same
 * two knobs from the environment; an explicit flag wins over the environment,
 * and the environment wins over the defaults below.
 *
 * Exit code is 0 for both outcomes — "changed" is a result, not a failure. A
 * non-zero exit means the comparison itself could not be performed (unreadable
 * directory, corrupt PNG, unwritable summary).
 *
 * ## Calibrating the two thresholds
 *
 * Simulator captures are not bit-identical run to run: text rasterization,
 * shadow compositing and board art vary by a channel step or two, and a handful
 * of pixels move on any given frame. The defaults below are set so that noise
 * reads as "same" while a real UI change reads as "changed". To re-derive them
 * after a renderer or SDK change:
 *
 *   1. Capture the same shard TWICE with no code change in between (two runs of
 *      `vp run mobile:screenshots -- --platform ios --device "iPhone 16 Pro Max"
 *      --locales en-US`), keeping both trees.
 *   2. Compare them with the thresholds switched off:
 *      `vp run screenshot:compare -- --baseline runA --candidate runB \
 *        --channel-tolerance 0 --max-diff-ratio 0 --summary noise.json`
 *   3. Read `noise.json`: set `channelTolerance` to the largest per-channel
 *      delta the noise produced, and `maxDiffRatio` to 3x the largest
 *      `differingRatio`, with a floor of 0.0002 (2 pixels in 10,000) so a
 *      perfectly quiet pair still leaves headroom.
 *
 * A tolerance that is too tight reds every run with a false "changed" and
 * removes the whole point of the probe; one that is too loose lets a real
 * regression ship into the App Store listing. When in doubt, err tight — a
 * false "changed" only costs one extra fan-out.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

const LOG = '[screenshot:compare]';

/** Largest per-channel delta (0-255) still treated as capture noise. */
export const DEFAULT_CHANNEL_TOLERANCE = 8;

/** Largest share of differing pixels in one image still treated as capture noise. */
export const DEFAULT_MAX_DIFF_RATIO = 0.001;

export type ScreenshotFileStatus = 'same' | 'changed' | 'missing' | 'extra' | 'resized';

export interface ScreenshotFileComparison {
  /** Path relative to the two compared roots, e.g. `01-discover.png`. */
  name: string;
  status: ScreenshotFileStatus;
  /** Share of pixels that differ beyond the channel tolerance. 1 when not comparable pixel-wise. */
  differingRatio: number;
  /** Candidate dimensions where available, otherwise the baseline's. */
  width: number;
  height: number;
}

export type ScreenshotComparisonReason = 'no-baseline' | 'changed' | 'unchanged';

export interface ScreenshotComparison {
  changed: boolean;
  reason: ScreenshotComparisonReason;
  channelTolerance: number;
  maxDiffRatio: number;
  files: ScreenshotFileComparison[];
}

export interface CompareScreenshotSetsOptions {
  baselineDir: string;
  candidateDir: string;
  channelTolerance?: number;
  maxDiffRatio?: number;
  /** When set, a red-mask diff PNG is written here for every pixel-wise change. */
  diffOutDir?: string;
}

interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

/** Every `*.png` under `root`, as paths relative to it, sorted. Missing root = []. */
function listPngFiles(root: string): string[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }
      if (entry.name.toLowerCase().endsWith('.png')) found.push(relative(root, entryPath));
    }
  };
  walk(root);
  return found.sort();
}

/** Decode a PNG to straight RGBA bytes. Alpha is read but never compared. */
async function readRawImage(file: string): Promise<RawImage> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/**
 * Mark of every pixel whose R, G or B moved further than `channelTolerance`.
 * Alpha is ignored: a fully opaque screenshot carries no alpha signal, and a
 * premultiplied edge would otherwise report a phantom change.
 */
function findDifferingPixels(baseline: RawImage, candidate: RawImage, channelTolerance: number): Uint8Array {
  const pixelCount = candidate.width * candidate.height;
  // A byte mask rather than boolean[]: a 6.9" capture is 3.8M pixels, and this
  // walks every one of them for every file in the shard.
  const differing = new Uint8Array(pixelCount);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const baselineOffset = pixel * baseline.channels;
    const candidateOffset = pixel * candidate.channels;
    for (let channel = 0; channel < 3; channel++) {
      const delta = Math.abs(baseline.data[baselineOffset + channel] - candidate.data[candidateOffset + channel]);
      if (delta > channelTolerance) {
        differing[pixel] = 1;
        break;
      }
    }
  }
  return differing;
}

/** Red mask over a dimmed copy of the candidate, so a reviewer sees what moved and where. */
async function writeDiffImage(candidate: RawImage, differing: Uint8Array, outFile: string): Promise<void> {
  const pixelCount = candidate.width * candidate.height;
  const diff = Buffer.alloc(pixelCount * 4);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const sourceOffset = pixel * candidate.channels;
    const targetOffset = pixel * 4;
    if (differing[pixel] === 1) {
      diff[targetOffset] = 255;
      diff[targetOffset + 1] = 0;
      diff[targetOffset + 2] = 0;
    } else {
      // Quarter brightness: enough context to place the change, dim enough that
      // the red mask reads at a glance.
      diff[targetOffset] = Math.round(candidate.data[sourceOffset] * 0.25);
      diff[targetOffset + 1] = Math.round(candidate.data[sourceOffset + 1] * 0.25);
      diff[targetOffset + 2] = Math.round(candidate.data[sourceOffset + 2] * 0.25);
    }
    diff[targetOffset + 3] = 255;
  }
  mkdirSync(dirname(outFile), { recursive: true });
  await sharp(diff, { raw: { width: candidate.width, height: candidate.height, channels: 4 } })
    .png()
    .toFile(outFile);
}

/**
 * Compare two screenshot trees file by file. No process state is touched — the
 * caller decides what to do with the summary, which is what makes this testable
 * without a GitHub runner.
 */
export async function compareScreenshotSets(options: CompareScreenshotSetsOptions): Promise<ScreenshotComparison> {
  const channelTolerance = options.channelTolerance ?? DEFAULT_CHANNEL_TOLERANCE;
  const maxDiffRatio = options.maxDiffRatio ?? DEFAULT_MAX_DIFF_RATIO;
  const baselineFiles = listPngFiles(options.baselineDir);
  const candidateFiles = listPngFiles(options.candidateDir);

  // No stored baseline at all (first ever run, or a released asset that has been
  // pruned). Everything is new, so the caller must fan out and refresh it.
  if (baselineFiles.length === 0) {
    const files: ScreenshotFileComparison[] = [];
    for (const name of candidateFiles) {
      const candidate = await readRawImage(join(options.candidateDir, name));
      files.push({ name, status: 'extra', differingRatio: 1, width: candidate.width, height: candidate.height });
    }
    return { changed: true, reason: 'no-baseline', channelTolerance, maxDiffRatio, files };
  }

  const baselineNames = new Set(baselineFiles);
  const candidateNames = new Set(candidateFiles);
  const allNames = [...new Set([...baselineFiles, ...candidateFiles])].sort();
  const files: ScreenshotFileComparison[] = [];

  for (const name of allNames) {
    const inBaseline = baselineNames.has(name);
    const inCandidate = candidateNames.has(name);

    if (inBaseline && !inCandidate) {
      const baseline = await readRawImage(join(options.baselineDir, name));
      files.push({ name, status: 'missing', differingRatio: 1, width: baseline.width, height: baseline.height });
      continue;
    }
    if (!inBaseline && inCandidate) {
      const candidate = await readRawImage(join(options.candidateDir, name));
      files.push({ name, status: 'extra', differingRatio: 1, width: candidate.width, height: candidate.height });
      continue;
    }

    const baseline = await readRawImage(join(options.baselineDir, name));
    const candidate = await readRawImage(join(options.candidateDir, name));
    if (baseline.width !== candidate.width || baseline.height !== candidate.height) {
      files.push({ name, status: 'resized', differingRatio: 1, width: candidate.width, height: candidate.height });
      continue;
    }

    const differing = findDifferingPixels(baseline, candidate, channelTolerance);
    let differingCount = 0;
    for (const marked of differing) differingCount += marked;
    const differingRatio = differingCount / (candidate.width * candidate.height);
    const status: ScreenshotFileStatus = differingRatio > maxDiffRatio ? 'changed' : 'same';
    files.push({ name, status, differingRatio, width: candidate.width, height: candidate.height });

    if (status === 'changed' && options.diffOutDir) {
      await writeDiffImage(candidate, differing, join(options.diffOutDir, name));
    }
  }

  const changed = files.some((file) => file.status !== 'same');
  return { changed, reason: changed ? 'changed' : 'unchanged', channelTolerance, maxDiffRatio, files };
}

/** Files the caller should look at: everything that is not byte-for-byte boring. */
export function changedFileNames(comparison: ScreenshotComparison): string[] {
  return comparison.files.filter((file) => file.status !== 'same').map((file) => file.name);
}

/** GitHub step-summary table: one row per compared file. */
export function renderMarkdownSummary(comparison: ScreenshotComparison): string {
  const heading = comparison.changed
    ? `### Screenshots changed (${comparison.reason})`
    : '### Screenshots unchanged vs baseline';
  const rows = comparison.files.map(
    (file) =>
      `| ${file.name} | ${file.status} | ${(file.differingRatio * 100).toFixed(3)}% | ${file.width}x${file.height} |`,
  );
  return [
    heading,
    '',
    `Channel tolerance ${comparison.channelTolerance}, max diff ratio ${comparison.maxDiffRatio}.`,
    '',
    '| File | Status | Differing | Size |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

interface CliOptions {
  baselineDir: string;
  candidateDir: string;
  summaryFile: string | null;
  diffOutDir: string | null;
  channelTolerance: number;
  maxDiffRatio: number;
}

function readNumericEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number (got "${raw}")`);
  }
  return parsed;
}

export function parseCompareArguments(argv: readonly string[]): CliOptions {
  const args = argv.filter((argument) => argument !== '--');
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag.startsWith('--')) throw new Error(`Unknown argument: ${flag}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    values.set(flag, value);
  }

  const known = ['--baseline', '--candidate', '--summary', '--diff-out', '--channel-tolerance', '--max-diff-ratio'];
  for (const flag of values.keys()) {
    if (!known.includes(flag)) throw new Error(`Unknown argument: ${flag}`);
  }

  const baselineDir = values.get('--baseline');
  const candidateDir = values.get('--candidate');
  if (!baselineDir) throw new Error('--baseline is required');
  if (!candidateDir) throw new Error('--candidate is required');

  const parseNumber = (flag: string, fallback: number): number => {
    const raw = values.get(flag);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative number (got "${raw}")`);
    return parsed;
  };

  return {
    baselineDir: resolve(baselineDir),
    candidateDir: resolve(candidateDir),
    summaryFile: values.get('--summary') ?? null,
    diffOutDir: values.get('--diff-out') ?? null,
    channelTolerance: parseNumber(
      '--channel-tolerance',
      readNumericEnvironment('SCREENSHOT_CHANNEL_TOLERANCE', DEFAULT_CHANNEL_TOLERANCE),
    ),
    maxDiffRatio: parseNumber(
      '--max-diff-ratio',
      readNumericEnvironment('SCREENSHOT_MAX_DIFF_RATIO', DEFAULT_MAX_DIFF_RATIO),
    ),
  };
}

/** `changed=` / `changed_files=` for the workflow step that gates the fan-out. */
export function writeGithubOutput(outputFile: string, comparison: ScreenshotComparison): void {
  const names = changedFileNames(comparison);
  appendFileSync(outputFile, `changed=${comparison.changed}\nchanged_files=${names.join(',')}\n`);
}

async function main(argv: readonly string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCompareArguments(argv);
  } catch (error) {
    console.error(`${LOG} ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const comparison = await compareScreenshotSets({
    baselineDir: options.baselineDir,
    candidateDir: options.candidateDir,
    channelTolerance: options.channelTolerance,
    maxDiffRatio: options.maxDiffRatio,
    diffOutDir: options.diffOutDir ?? undefined,
  });

  if (options.summaryFile) {
    mkdirSync(dirname(resolve(options.summaryFile)), { recursive: true });
    writeFileSync(resolve(options.summaryFile), `${JSON.stringify(comparison, null, 2)}\n`);
  }

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) writeGithubOutput(githubOutput, comparison);

  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) appendFileSync(stepSummary, renderMarkdownSummary(comparison));

  const names = changedFileNames(comparison);
  console.log(
    `${LOG} ${comparison.changed ? 'CHANGED' : 'UNCHANGED'} (${comparison.reason}): ${comparison.files.length} file(s) compared` +
      (names.length > 0 ? `, ${names.length} differing: ${names.join(', ')}` : ''),
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(`${LOG} ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
