/// <reference types="node" />

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';

import {
  DEFAULT_CHANNEL_TOLERANCE,
  DEFAULT_MAX_DIFF_RATIO,
  changedFileNames,
  compareScreenshotSets,
  writeGithubOutput,
} from '../compare-screenshots';

/**
 * The probe gate's whole value rests on these thresholds behaving exactly as
 * documented: too loose and a real App Store regression ships unnoticed, too
 * tight and every nightly reds with a false "changed" and fans out anyway.
 *
 * So the boundaries are pinned from both sides — a delta of exactly the channel
 * tolerance is noise, one more is a difference; exactly the ratio is noise, one
 * pixel more is a change. Flipping either `>` to `>=` in the implementation
 * fails a test here.
 */

const GREY = 128;

let workDir: string;

function directory(name: string): string {
  const path = join(workDir, name);
  mkdirSync(path, { recursive: true });
  return path;
}

/** Solid single-colour PNG. */
async function writeSolidPng(file: string, width: number, height: number, grey: number): Promise<void> {
  await sharp({
    create: { width, height, channels: 4, background: { r: grey, g: grey, b: grey, alpha: 1 } },
  })
    .png()
    .toFile(file);
}

/** PNG painted pixel by pixel, so a test can place an exact channel delta. */
async function writePaintedPng(
  file: string,
  width: number,
  height: number,
  paint: (x: number, y: number) => number,
): Promise<void> {
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const value = paint(x, y);
      raw[offset] = value;
      raw[offset + 1] = value;
      raw[offset + 2] = value;
      raw[offset + 3] = 255;
    }
  }
  await sharp(raw, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(file);
}

/** Paints `count` pixels (row-major) a full 255 away from the background. */
function nBrightPixels(count: number, width: number): (x: number, y: number) => number {
  return (x, y) => (y * width + x < count ? 255 : GREY);
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'compare-screenshots-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('compareScreenshotSets', () => {
  it('reports identical captures as unchanged', async () => {
    const baseline = directory('baseline');
    const candidate = directory('candidate');
    await writeSolidPng(join(baseline, '01-discover.png'), 40, 40, GREY);
    await writeSolidPng(join(candidate, '01-discover.png'), 40, 40, GREY);

    const comparison = await compareScreenshotSets({ baselineDir: baseline, candidateDir: candidate });

    expect(comparison.changed).toBe(false);
    expect(comparison.reason).toBe('unchanged');
    expect(comparison.files).toEqual([
      { name: '01-discover.png', status: 'same', differingRatio: 0, width: 40, height: 40 },
    ]);
    expect(comparison.channelTolerance).toBe(DEFAULT_CHANNEL_TOLERANCE);
    expect(comparison.maxDiffRatio).toBe(DEFAULT_MAX_DIFF_RATIO);
  });

  it('ignores a single pixel one channel step away', async () => {
    const baseline = directory('baseline');
    const candidate = directory('candidate');
    await writeSolidPng(join(baseline, '01-discover.png'), 100, 100, GREY);
    await writePaintedPng(join(candidate, '01-discover.png'), 100, 100, (x, y) =>
      x === 0 && y === 0 ? GREY + 1 : GREY,
    );

    const comparison = await compareScreenshotSets({ baselineDir: baseline, candidateDir: candidate });

    expect(comparison.changed).toBe(false);
    expect(comparison.files[0].differingRatio).toBe(0);
  });

  it('treats a delta of exactly the channel tolerance as noise and one more as a difference', async () => {
    const baseline = directory('baseline');
    const atTolerance = directory('at-tolerance');
    const overTolerance = directory('over-tolerance');
    await writeSolidPng(join(baseline, '01-discover.png'), 100, 100, GREY);
    await writePaintedPng(join(atTolerance, '01-discover.png'), 100, 100, (x, y) =>
      x === 0 && y === 0 ? GREY + DEFAULT_CHANNEL_TOLERANCE : GREY,
    );
    await writePaintedPng(join(overTolerance, '01-discover.png'), 100, 100, (x, y) =>
      x === 0 && y === 0 ? GREY + DEFAULT_CHANNEL_TOLERANCE + 1 : GREY,
    );

    const noise = await compareScreenshotSets({ baselineDir: baseline, candidateDir: atTolerance });
    expect(noise.files[0].differingRatio).toBe(0);
    expect(noise.files[0].status).toBe('same');

    // Counted, but one pixel in 10,000 is still far below the ratio, so the file
    // as a whole stays "same".
    const counted = await compareScreenshotSets({ baselineDir: baseline, candidateDir: overTolerance });
    expect(counted.files[0].differingRatio).toBe(1 / 10_000);
    expect(counted.files[0].status).toBe('same');
    expect(counted.changed).toBe(false);
  });

  it('holds the diff-ratio boundary at exactly maxDiffRatio', async () => {
    const baseline = directory('baseline');
    const atRatio = directory('at-ratio');
    const overRatio = directory('over-ratio');
    await writeSolidPng(join(baseline, '01-discover.png'), 100, 100, GREY);
    // 100x100 = 10,000 px, so 10 differing pixels is exactly 0.001.
    await writePaintedPng(join(atRatio, '01-discover.png'), 100, 100, nBrightPixels(10, 100));
    await writePaintedPng(join(overRatio, '01-discover.png'), 100, 100, nBrightPixels(11, 100));

    const at = await compareScreenshotSets({ baselineDir: baseline, candidateDir: atRatio });
    expect(at.files[0].differingRatio).toBe(0.001);
    expect(at.files[0].status).toBe('same');
    expect(at.changed).toBe(false);

    const over = await compareScreenshotSets({ baselineDir: baseline, candidateDir: overRatio });
    expect(over.files[0].differingRatio).toBeCloseTo(0.0011, 10);
    expect(over.files[0].status).toBe('changed');
    expect(over.changed).toBe(true);
  });

  it('catches a UI element that moved five pixels', async () => {
    const baseline = directory('baseline');
    const candidate = directory('candidate');
    const rectangle =
      (left: number) =>
      (x: number, y: number): number =>
        x >= left && x < left + 20 && y >= 10 && y < 30 ? 255 : GREY;
    await writePaintedPng(join(baseline, '01-discover.png'), 100, 100, rectangle(10));
    await writePaintedPng(join(candidate, '01-discover.png'), 100, 100, rectangle(15));

    const comparison = await compareScreenshotSets({ baselineDir: baseline, candidateDir: candidate });

    expect(comparison.changed).toBe(true);
    expect(comparison.files[0].status).toBe('changed');
    // Two 5x20 slivers moved: 200 of 10,000 pixels.
    expect(comparison.files[0].differingRatio).toBe(0.02);
  });

  it('writes a diff PNG for every changed file', async () => {
    const baseline = directory('baseline');
    const candidate = directory('candidate');
    const diffs = join(workDir, 'diffs');
    await writeSolidPng(join(baseline, '01-discover.png'), 100, 100, GREY);
    await writePaintedPng(join(candidate, '01-discover.png'), 100, 100, nBrightPixels(500, 100));

    const comparison = await compareScreenshotSets({
      baselineDir: baseline,
      candidateDir: candidate,
      diffOutDir: diffs,
    });

    expect(comparison.changed).toBe(true);
    expect(existsSync(join(diffs, '01-discover.png'))).toBe(true);
    const { data, info } = await sharp(join(diffs, '01-discover.png'))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(100);
    // The first pixel differed, so it is masked pure red; a later untouched pixel
    // is the dimmed candidate.
    expect([data[0], data[1], data[2]]).toEqual([255, 0, 0]);
    const quietOffset = 9_999 * info.channels;
    expect(data[quietOffset]).toBe(Math.round(GREY * 0.25));
  });

  it('flags files that only exist on one side, and files that changed size', async () => {
    const baseline = directory('baseline');
    const candidate = directory('candidate');
    await writeSolidPng(join(baseline, '01-shared.png'), 40, 40, GREY);
    await writeSolidPng(join(candidate, '01-shared.png'), 40, 60, GREY);
    await writeSolidPng(join(baseline, '02-dropped.png'), 40, 40, GREY);
    await writeSolidPng(join(candidate, '03-added.png'), 40, 40, GREY);

    const comparison = await compareScreenshotSets({ baselineDir: baseline, candidateDir: candidate });

    expect(comparison.changed).toBe(true);
    expect(comparison.files.map((file) => [file.name, file.status])).toEqual([
      ['01-shared.png', 'resized'],
      ['02-dropped.png', 'missing'],
      ['03-added.png', 'extra'],
    ]);
  });

  it('reports no-baseline when the baseline directory is missing or empty', async () => {
    const candidate = directory('candidate');
    await writeSolidPng(join(candidate, '01-discover.png'), 40, 40, GREY);

    const missing = await compareScreenshotSets({
      baselineDir: join(workDir, 'nope'),
      candidateDir: candidate,
    });
    expect(missing.changed).toBe(true);
    expect(missing.reason).toBe('no-baseline');
    expect(missing.files.map((file) => file.status)).toEqual(['extra']);

    const empty = await compareScreenshotSets({ baselineDir: directory('empty'), candidateDir: candidate });
    expect(empty.changed).toBe(true);
    expect(empty.reason).toBe('no-baseline');
  });

  it('reports the whole set as changed when only one of several files moved', async () => {
    const baseline = directory('baseline');
    const candidate = directory('candidate');
    await writeSolidPng(join(baseline, '01-quiet.png'), 100, 100, GREY);
    await writeSolidPng(join(candidate, '01-quiet.png'), 100, 100, GREY);
    await writeSolidPng(join(baseline, '02-loud.png'), 100, 100, GREY);
    await writePaintedPng(join(candidate, '02-loud.png'), 100, 100, nBrightPixels(500, 100));

    const comparison = await compareScreenshotSets({ baselineDir: baseline, candidateDir: candidate });

    expect(comparison.files.map((file) => file.status)).toEqual(['same', 'changed']);
    expect(comparison.changed).toBe(true);
    expect(changedFileNames(comparison)).toEqual(['02-loud.png']);
  });

  it('pairs files by their path relative to each root', async () => {
    const baseline = directory('baseline');
    const candidate = directory('candidate');
    mkdirSync(join(baseline, 'en-US'), { recursive: true });
    mkdirSync(join(candidate, 'en-US'), { recursive: true });
    await writeSolidPng(join(baseline, 'en-US', '01-discover.png'), 40, 40, GREY);
    await writeSolidPng(join(candidate, 'en-US', '01-discover.png'), 40, 40, GREY);

    const comparison = await compareScreenshotSets({ baselineDir: baseline, candidateDir: candidate });

    expect(comparison.files.map((file) => file.name)).toEqual([join('en-US', '01-discover.png')]);
    expect(comparison.changed).toBe(false);
  });
});

describe('writeGithubOutput', () => {
  it('writes the exact two lines the workflow reads', async () => {
    const baseline = directory('baseline');
    const candidate = directory('candidate');
    await writeSolidPng(join(baseline, '01-quiet.png'), 100, 100, GREY);
    await writeSolidPng(join(candidate, '01-quiet.png'), 100, 100, GREY);
    await writeSolidPng(join(baseline, '02-loud.png'), 100, 100, GREY);
    await writePaintedPng(join(candidate, '02-loud.png'), 100, 100, nBrightPixels(500, 100));
    await writeSolidPng(join(candidate, '03-added.png'), 100, 100, GREY);

    const comparison = await compareScreenshotSets({ baselineDir: baseline, candidateDir: candidate });
    const outputFile = join(workDir, 'github-output');
    writeGithubOutput(outputFile, comparison);

    expect(readFileSync(outputFile, 'utf8')).toBe('changed=true\nchanged_files=02-loud.png,03-added.png\n');
  });

  it('writes an empty changed_files list when nothing moved', async () => {
    const baseline = directory('baseline');
    const candidate = directory('candidate');
    await writeSolidPng(join(baseline, '01-quiet.png'), 40, 40, GREY);
    await writeSolidPng(join(candidate, '01-quiet.png'), 40, 40, GREY);

    const comparison = await compareScreenshotSets({ baselineDir: baseline, candidateDir: candidate });
    const outputFile = join(workDir, 'github-output');
    writeGithubOutput(outputFile, comparison);

    expect(readFileSync(outputFile, 'utf8')).toBe('changed=false\nchanged_files=\n');
  });
});
