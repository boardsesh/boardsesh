/// <reference types="node" />

/**
 * Content gate for the App Store screenshots ios-finalize uploads automatically.
 *
 * The dimension gate (assert-screenshot-dimensions.ts) only proves a PNG is the
 * right pixel size for its slot — it says nothing about what is actually drawn
 * inside it. A blank or mid-load capture (a spinner, a skeleton, a half-rendered
 * board) can clear the dimension gate cleanly and still be wrong, and iOS has no
 * equivalent of the Android capture job's absolute-floor + relative-to-committed
 * checks ("Assert screenshots are not blank" in mobile-screenshots-android.yml) —
 * because iOS never commits its screenshots to git, there was nothing to compare
 * a fresh capture against. There is now: the `screenshots-baseline` prerelease
 * (scripts/screenshot-baseline.ts) that the probe gate already reads.
 *
 * Two checks, same as Android:
 *   1. Absolute floor — a PNG under `--min-bytes` is treated as blank/near-empty
 *      regardless of what came before it.
 *   2. Baseline-relative floor — a PNG under `--min-ratio` of the same relative
 *      path's size in `--baseline-dir` (when that file exists there) is treated
 *      as a mid-load capture: a static skeleton/spinner can pass a pixel-diff
 *      "settled" check on a slow CI runner while still being wrong, and that
 *      usually shows up as a much smaller file than a fully rendered screen.
 *
 * A file with no baseline counterpart (first capture of a new screen, or no
 * baseline published yet) is checked against the floor only — there is nothing
 * to take a ratio against, and that is not itself suspicious.
 *
 * Usage:
 *   vp run screenshot:assert-content -- --dir <captured root> \
 *     [--baseline-dir <root>] [--min-bytes 61440] [--min-ratio 0.4]
 *
 * Exit code 0 means every PNG under `--dir` cleared both checks. Exit code 1
 * means at least one offender was found (or `--dir` held no PNGs at all).
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const LOG = '[screenshot:assert-content]';

/** Below this many bytes a PNG is treated as blank/near-empty outright. */
export const DEFAULT_MIN_BYTES = 61440;

/** Below this share of the baseline's size for the same path, a PNG reads as a mid-load capture. */
export const DEFAULT_MIN_RATIO = 0.4;

export interface CandidateFile {
  /** Path relative to the captured root, e.g. `en-US/iphone-16-pro-max/01-home.png`. */
  relativePath: string;
  size: number;
}

export interface ContentGateOptions {
  minBytes: number;
  minRatio: number;
}

export interface ContentOffender {
  file: string;
  reason: string;
  size: number;
  baselineSize?: number;
}

/**
 * Pure: apply the absolute floor and the baseline-relative ratio check to a
 * captured tree. No I/O — `candidates` and `baselineSizeByPath` are read from
 * disk by the caller, which is what makes this testable without a filesystem.
 *
 * `baselineSizeByPath` is keyed by the same relative path as `candidates`; a
 * candidate missing from it is checked against the floor only.
 */
export function findContentOffenders(
  candidates: readonly CandidateFile[],
  baselineSizeByPath: ReadonlyMap<string, number>,
  options: ContentGateOptions,
): ContentOffender[] {
  if (candidates.length === 0) {
    return [{ file: '(none)', reason: 'no screenshots found under the given directory', size: 0 }];
  }

  const offenders: ContentOffender[] = [];
  for (const { relativePath, size } of candidates) {
    if (size < options.minBytes) {
      offenders.push({
        file: relativePath,
        size,
        reason: `is ${size} bytes, under the ${options.minBytes}-byte floor — likely a blank/failed capture`,
      });
      continue;
    }

    const baselineSize = baselineSizeByPath.get(relativePath);
    if (baselineSize === undefined) continue;

    const minRelativeBytes = baselineSize * options.minRatio;
    if (size < minRelativeBytes) {
      offenders.push({
        file: relativePath,
        size,
        baselineSize,
        reason:
          `is ${size} bytes, under ${Math.round(options.minRatio * 100)}% of the baseline's ${baselineSize} bytes ` +
          `(${minRelativeBytes} bytes) — likely a mid-load capture`,
      });
    }
  }
  return offenders;
}

/** Every `*.png` under `root`, as `{relativePath, size}` relative to it. Missing root = []. */
export function readPngSizesRecursively(root: string): CandidateFile[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const found: CandidateFile[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }
      if (entry.name.toLowerCase().endsWith('.png')) {
        found.push({ relativePath: relative(root, entryPath), size: statSync(entryPath).size });
      }
    }
  };
  walk(root);
  return found;
}

/** `relativePath -> size` for every baseline PNG. `null`/missing root = an empty map (floor-only checks). */
export function readBaselineSizeMap(baselineDir: string | null): Map<string, number> {
  const sizes = new Map<string, number>();
  if (!baselineDir) return sizes;
  for (const { relativePath, size } of readPngSizesRecursively(baselineDir)) {
    sizes.set(relativePath, size);
  }
  return sizes;
}

interface CliOptions {
  dir: string;
  baselineDir: string | null;
  minBytes: number;
  minRatio: number;
}

function parseNumberFlag(flag: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative number (got "${raw}")`);
  }
  return parsed;
}

export function parseContentArguments(argv: readonly string[]): CliOptions {
  const args = argv.filter((argument) => argument !== '--');
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag.startsWith('--')) throw new Error(`Unknown argument: ${flag}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    values.set(flag, value);
    index++;
  }

  const known = ['--dir', '--baseline-dir', '--min-bytes', '--min-ratio'];
  for (const flag of values.keys()) {
    if (!known.includes(flag)) throw new Error(`Unknown argument: ${flag}`);
  }

  const dir = values.get('--dir');
  if (!dir) throw new Error('--dir is required');

  return {
    dir,
    baselineDir: values.get('--baseline-dir') ?? null,
    minBytes: parseNumberFlag('--min-bytes', values.get('--min-bytes'), DEFAULT_MIN_BYTES),
    minRatio: parseNumberFlag('--min-ratio', values.get('--min-ratio'), DEFAULT_MIN_RATIO),
  };
}

function main(argv: readonly string[] = process.argv.slice(2)): number {
  let options: CliOptions;
  try {
    options = parseContentArguments(argv);
  } catch (error) {
    console.error(`${LOG} ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const candidates = readPngSizesRecursively(options.dir);
  const baselineSizeByPath = readBaselineSizeMap(options.baselineDir);
  const offenders = findContentOffenders(candidates, baselineSizeByPath, {
    minBytes: options.minBytes,
    minRatio: options.minRatio,
  });

  if (offenders.length > 0) {
    for (const offender of offenders) {
      console.error(`::error::${offender.file}: ${offender.reason}`);
    }
    console.error(
      `${LOG} FAILED: ${offenders.length} of ${candidates.length} screenshot(s) failed the content gate` +
        (options.baselineDir ? ` (baseline: ${options.baselineDir}).` : ' (no baseline — floor check only).'),
    );
    return 1;
  }

  console.log(
    `${LOG} OK: ${candidates.length} screenshot(s) cleared the ${options.minBytes}-byte floor` +
      (options.baselineDir
        ? ` and the ${Math.round(options.minRatio * 100)}% baseline-relative check (baseline: ${options.baselineDir}).`
        : ' (no baseline — floor check only).'),
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
