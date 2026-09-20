import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertHelpClipStem,
  assertHelpClipTableValid,
  buildHelpClipMp4Args,
  buildHelpClipPosterFrameArgs,
  buildHelpClipProbeArgs,
  buildHelpClipWebmArgs,
  HELP_CLIP_POSTER_DIR,
  HELP_CLIP_RAW_DIR,
  HELP_CLIP_VIDEO_DIR,
  HELP_CLIPS,
  helpClipOutputs,
  helpClipSeekArgs,
  helpClipSourceName,
  parseHelpClipArgs,
  parseHelpClipDuration,
  resolveHelpClipSet,
  type HelpClipEntry,
} from '../lib/help-clips';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const rawDir = '/captures';
const present = (filenames: readonly string[]) => (path: string) => filenames.includes(path);

describe('help clip table', () => {
  it('names the gestures the help pages teach', () => {
    expect(HELP_CLIPS.map((clip) => clip.name)).toEqual([
      'long-press-climb-actions',
      'swipe-row-queue-playlist',
      'remove-from-playlist',
      'logbook-swipe-edit-delete',
      'hold-filter-paint',
      'zone-filter-drag',
      'grade-range-tap',
      'preview-browsing',
      'start-playlist-queue',
    ]);
  });

  it('accepts the shipped table', () => {
    expect(() => assertHelpClipTableValid()).not.toThrow();
  });

  it('offers every clip name to the web component', () => {
    // The browser file cannot import from scripts/, so the union is declared
    // twice. Reading it as text is what keeps the two copies honest.
    const webUnion = readFileSync(join(REPO_ROOT, 'packages/web/app/lib/help-clips.ts'), 'utf8');
    for (const clip of HELP_CLIPS) expect(webUnion).toContain(`'${clip.name}'`);
  });

  it('rejects a duplicate name', () => {
    const duplicated: HelpClipEntry[] = [
      { name: 'swipe-row', source: 'a', description: 'first' },
      { name: 'swipe-row', source: 'b', description: 'second' },
    ];
    expect(() => assertHelpClipTableValid(duplicated)).toThrow(/Duplicate help clip name: swipe-row/);
  });

  it('rejects a trim that ends before it starts', () => {
    const inverted: HelpClipEntry[] = [
      { name: 'swipe-row', source: 'swipe-row', description: 'x', trim: { start: 4, end: 2 } },
    ];
    expect(() => assertHelpClipTableValid(inverted)).toThrow(/empty window/);
  });

  it('rejects a name that could escape its URL path', () => {
    expect(() => assertHelpClipStem('../secrets')).toThrow(/Not a usable help clip name/);
    expect(() => assertHelpClipStem('Swipe Row')).toThrow(/Not a usable help clip name/);
    expect(assertHelpClipStem('swipe-row-2')).toBe('swipe-row-2');
  });

  it('reads a capture stem out of the simctl filename', () => {
    expect(helpClipSourceName('/raw/hold-filter-paint.mov')).toBe('hold-filter-paint');
    expect(helpClipSourceName('/raw/hold-filter-paint.MOV')).toBe('hold-filter-paint');
    expect(() => helpClipSourceName('/raw/Screen Recording.mov')).toThrow();
  });

  it('writes both encodings and the poster under the public directories', () => {
    const outputs = helpClipOutputs('zone-filter-drag');
    expect(outputs.mp4).toBe(join(HELP_CLIP_VIDEO_DIR, 'zone-filter-drag.mp4'));
    expect(outputs.webm).toBe(join(HELP_CLIP_VIDEO_DIR, 'zone-filter-drag.webm'));
    expect(outputs.poster).toBe(join(HELP_CLIP_POSTER_DIR, 'zone-filter-drag.webp'));
  });
});

describe('ffmpeg argument builders', () => {
  const conversion = { input: '/raw/hold-filter-paint.mov', output: '/out/hold-filter-paint.mp4' };

  it('seeks with an input -ss and a relative duration', () => {
    expect(helpClipSeekArgs({ start: 1.5, end: 8 })).toEqual(['-ss', '1.5', '-t', '6.5']);
    expect(helpClipSeekArgs(undefined)).toEqual([]);
  });

  it('encodes the mp4 silently, at 736 px wide and 30 fps, with faststart', () => {
    expect(buildHelpClipMp4Args(conversion)).toEqual([
      '-y',
      '-loglevel',
      'error',
      '-i',
      '/raw/hold-filter-paint.mov',
      '-an',
      '-vf',
      'fps=30,scale=736:-2',
      '-c:v',
      'libx264',
      '-crf',
      '24',
      '-preset',
      'slow',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '/out/hold-filter-paint.mp4',
    ]);
  });

  it('puts the trim before the input so the seek is cheap', () => {
    const args = buildHelpClipMp4Args({ ...conversion, trim: { start: 2, end: 9 } });
    expect(args.slice(0, 8)).toEqual(['-y', '-loglevel', 'error', '-ss', '2', '-t', '7', '-i']);
  });

  it('encodes the webm at constant quality, which needs -b:v 0', () => {
    const args = buildHelpClipWebmArgs({ ...conversion, output: '/out/hold-filter-paint.webm' });
    expect(args).toContain('libvpx-vp9');
    expect(args.slice(args.indexOf('-crf'), args.indexOf('-crf') + 4)).toEqual(['-crf', '34', '-b:v', '0']);
    expect(args.slice(args.indexOf('-row-mt'), args.indexOf('-row-mt') + 2)).toEqual(['-row-mt', '1']);
    expect(args).not.toContain('+faststart');
  });

  it('pipes one full-resolution PNG frame from the start of the trim', () => {
    expect(buildHelpClipPosterFrameArgs({ input: conversion.input, trim: { start: 2, end: 9 } })).toEqual([
      '-loglevel',
      'error',
      '-ss',
      '2',
      '-i',
      '/raw/hold-filter-paint.mov',
      '-frames:v',
      '1',
      '-f',
      'image2pipe',
      '-c:v',
      'png',
      '-',
    ]);
    // No trim means the first frame of the recording, and no -t: one frame is one frame.
    expect(buildHelpClipPosterFrameArgs({ input: conversion.input })).not.toContain('-ss');
    expect(buildHelpClipPosterFrameArgs({ input: conversion.input, poster: 3 })).toContain('-ss');
    expect(buildHelpClipPosterFrameArgs({ input: conversion.input, trim: { start: 2, end: 9 }, poster: 3 })).toEqual(
      expect.arrayContaining(['-ss', '5']),
    );
  });

  it('reads a bare duration out of ffprobe', () => {
    expect(buildHelpClipProbeArgs('/out/a.mp4')).toContain('format=duration');
    expect(parseHelpClipDuration('6.533333\n')).toBeCloseTo(6.533333);
    expect(() => parseHelpClipDuration('N/A')).toThrow(/Could not read a duration/);
  });
});

describe('resolving a delivery', () => {
  const everything = HELP_CLIPS.map((clip) => join(rawDir, `${clip.source}.mov`));

  it('resolves the whole set when every recording has landed', () => {
    const { present: resolved, missing } = resolveHelpClipSet(rawDir, {}, present(everything));
    expect(resolved).toHaveLength(HELP_CLIPS.length);
    expect(missing).toEqual([]);
    expect(resolved[0].input).toBe(join(rawDir, 'long-press-climb-actions.mov'));
  });

  it('names every absent recording at once rather than failing one at a time', () => {
    expect(() => resolveHelpClipSet(rawDir, {}, present(everything.slice(0, 2)))).toThrow(
      /Missing 7 of 9 help clip recording\(s\)/,
    );
  });

  it('converts what has arrived under --allow-partial', () => {
    const { present: resolved, missing } = resolveHelpClipSet(
      rawDir,
      { allowPartial: true },
      present(everything.slice(0, 2)),
    );
    expect(resolved.map((clip) => clip.entry.name)).toEqual(['long-press-climb-actions', 'swipe-row-queue-playlist']);
    expect(missing).toHaveLength(7);
    expect(missing[0]).toBe('remove-from-playlist.mov');
  });

  it('narrows to one clip with --only', () => {
    const { present: resolved } = resolveHelpClipSet(rawDir, { only: 'grade-range-tap' }, present(everything));
    expect(resolved.map((clip) => clip.entry.name)).toEqual(['grade-range-tap']);
  });

  it('rejects an --only name that is not in the table', () => {
    expect(() => resolveHelpClipSet(rawDir, { only: 'pinch-to-zoom' }, present(everything))).toThrow(
      /Unknown help clip: pinch-to-zoom/,
    );
  });
});

describe('argument parsing', () => {
  it('defaults to the gitignored raw directory', () => {
    expect(parseHelpClipArgs([])).toEqual({
      inputDir: HELP_CLIP_RAW_DIR,
      only: undefined,
      allowPartial: false,
      dryRun: false,
      help: false,
    });
  });

  it('drops the separator vp forwards', () => {
    expect(parseHelpClipArgs(['--', '--allow-partial']).allowPartial).toBe(true);
  });

  it('takes the raw directory as a flag or a bare positional', () => {
    expect(parseHelpClipArgs(['--input', '/tmp/clips']).inputDir).toBe('/tmp/clips');
    expect(parseHelpClipArgs(['/tmp/clips']).inputDir).toBe('/tmp/clips');
  });

  it('validates --only before anything touches the disk', () => {
    expect(parseHelpClipArgs(['--only', 'zone-filter-drag']).only).toBe('zone-filter-drag');
    expect(() => parseHelpClipArgs(['--only', '../etc'])).toThrow(/Not a usable help clip name/);
    expect(() => parseHelpClipArgs(['--only'])).toThrow(/--only needs a value/);
  });

  it('rejects an unknown flag instead of treating it as a directory', () => {
    expect(() => parseHelpClipArgs(['--fast'])).toThrow(/Unknown option: --fast/);
  });
});
