import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MIN_BYTES,
  DEFAULT_MIN_RATIO,
  type CandidateFile,
  findContentOffenders,
  parseContentArguments,
} from '../assert-screenshot-content';

/**
 * The content gate is the last line of defense before ios-finalize's automatic
 * App Store Connect upload: the dimension gate only proves a PNG is the right
 * pixel size, not that it isn't a blank frame or a mid-load skeleton. These
 * tests pin the two thresholds (an absolute byte floor, and a ratio against the
 * same relative path's size in the baseline) directly against the pure decision
 * function — no filesystem involved.
 */

function file(relativePath: string, size: number): CandidateFile {
  return { relativePath, size };
}

describe('findContentOffenders', () => {
  it('passes a file exactly at the absolute floor', () => {
    const offenders = findContentOffenders(
      [file('en-US/iphone-16-pro-max/01-home.png', DEFAULT_MIN_BYTES)],
      new Map(),
      { minBytes: DEFAULT_MIN_BYTES, minRatio: DEFAULT_MIN_RATIO },
    );
    expect(offenders).toEqual([]);
  });

  it('fails a file one byte under the absolute floor', () => {
    const offenders = findContentOffenders(
      [file('en-US/iphone-16-pro-max/01-home.png', DEFAULT_MIN_BYTES - 1)],
      new Map(),
      { minBytes: DEFAULT_MIN_BYTES, minRatio: DEFAULT_MIN_RATIO },
    );
    expect(offenders).toHaveLength(1);
    expect(offenders[0].reason).toMatch(/under the 61440-byte floor/);
  });

  it('passes a file exactly at 40% of the baseline size', () => {
    const relativePath = 'en-US/iphone-16-pro-max/02-discover.png';
    const baseline = new Map([[relativePath, 100000]]);
    const offenders = findContentOffenders([file(relativePath, 40000)], baseline, {
      minBytes: 1000,
      minRatio: 0.4,
    });
    expect(offenders).toEqual([]);
  });

  it('fails a file one byte under 40% of the baseline size', () => {
    const relativePath = 'en-US/iphone-16-pro-max/02-discover.png';
    const baseline = new Map([[relativePath, 100000]]);
    const offenders = findContentOffenders([file(relativePath, 39999)], baseline, {
      minBytes: 1000,
      minRatio: 0.4,
    });
    expect(offenders).toHaveLength(1);
    expect(offenders[0].reason).toMatch(/under 40% of the baseline's 100000 bytes/);
    expect(offenders[0].baselineSize).toBe(100000);
  });

  it('checks the floor only when the baseline has no matching file', () => {
    // No entry for this path at all (a brand-new screen, or no baseline
    // published yet) — must not be judged against a ratio it has no basis for,
    // only the absolute floor, which it clears here.
    const offenders = findContentOffenders([file('en-US/iphone-16-pro-max/09-new-screen.png', 1500)], new Map(), {
      minBytes: 1000,
      minRatio: 0.4,
    });
    expect(offenders).toEqual([]);
  });

  it('fails a floor-only file that is itself blank, even with no baseline', () => {
    const offenders = findContentOffenders([file('en-US/iphone-16-pro-max/09-new-screen.png', 500)], new Map(), {
      minBytes: 1000,
      minRatio: 0.4,
    });
    expect(offenders).toHaveLength(1);
    expect(offenders[0].baselineSize).toBeUndefined();
  });

  it('fails an empty directory with a "no screenshots" offender', () => {
    const offenders = findContentOffenders([], new Map(), {
      minBytes: DEFAULT_MIN_BYTES,
      minRatio: DEFAULT_MIN_RATIO,
    });
    expect(offenders).toHaveLength(1);
    expect(offenders[0].reason).toMatch(/no screenshots/);
  });

  it('reports one offender per bad file, not aggregated', () => {
    const relativePath = 'en-US/iphone-16-pro-max/02-discover.png';
    const baseline = new Map([[relativePath, 100000]]);
    const offenders = findContentOffenders(
      [file('en-US/iphone-16-pro-max/01-home.png', 100), file(relativePath, 39999)],
      baseline,
      { minBytes: 1000, minRatio: 0.4 },
    );
    expect(offenders).toHaveLength(2);
    expect(offenders.map((offender) => offender.file)).toEqual(['en-US/iphone-16-pro-max/01-home.png', relativePath]);
  });
});

describe('parseContentArguments', () => {
  it('requires --dir', () => {
    expect(() => parseContentArguments([])).toThrow(/--dir is required/);
  });

  it('defaults --min-bytes and --min-ratio and leaves --baseline-dir unset', () => {
    const options = parseContentArguments(['--dir', 'app-stores/apple/screenshots']);
    expect(options).toEqual({
      dir: 'app-stores/apple/screenshots',
      baselineDir: null,
      minBytes: DEFAULT_MIN_BYTES,
      minRatio: DEFAULT_MIN_RATIO,
    });
  });

  it('accepts an explicit baseline dir and thresholds', () => {
    const options = parseContentArguments([
      '--dir',
      'captured',
      '--baseline-dir',
      'baseline',
      '--min-bytes',
      '2048',
      '--min-ratio',
      '0.5',
    ]);
    expect(options).toEqual({ dir: 'captured', baselineDir: 'baseline', minBytes: 2048, minRatio: 0.5 });
  });

  it('rejects an unknown flag', () => {
    expect(() => parseContentArguments(['--dir', 'x', '--nope', 'y'])).toThrow(/Unknown argument: --nope/);
  });
});
