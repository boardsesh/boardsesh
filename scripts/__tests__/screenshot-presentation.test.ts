/// <reference types="node" />

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { IOS_SCREENSHOT_DEVICES, deviceSlug } from '../mobile-screenshots';
import { frameDirectory, frameScreenshot, parseFrameArguments } from '../frame-screenshots';
import { ACCEPTED_SIZES, readPngDimensions } from '../assert-screenshot-dimensions';
import { readPngSizesRecursively, findContentOffenders } from '../assert-screenshot-content';
import { decideProbeScope } from '../screenshot-probe-scope';
import {
  PRESENTATION_MANIFEST,
  CAPTION_IDS,
  STORE_CAPTION_LOCALES,
  readCaptionCatalog,
  screenshotCaptions,
  sha256Screenshot,
} from '../lib/screenshot-presentation';

const directories: string[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'screenshot-presentation-'));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('store screenshot presentation', () => {
  it('maps every device in the actual store capture matrix', () => {
    for (const device of IOS_SCREENSHOT_DEVICES) {
      expect(Object.keys(screenshotCaptions('ios', deviceSlug(device.name))).length).toBeGreaterThan(0);
    }
  });
  it.each(['en-US', 'es', 'fr', 'de'] as const)(
    'fits every %s caption in every store device shape',
    async (locale) => {
      const catalog = readCaptionCatalog(locale);
      expect(Object.keys(catalog)).toEqual([...CAPTION_IDS]);
      const dimensions = [{ width: 1080, height: 1920 }, ...Object.values(ACCEPTED_SIZES).map((sizes) => sizes[0])];
      for (const size of dimensions) {
        const raw = await sharp({ create: { ...size, channels: 3, background: '#164c39' } })
          .png()
          .toBuffer();
        for (const caption of Object.values(catalog)) {
          const framed = await frameScreenshot(raw, caption);
          expect(readPngDimensions(framed)).toEqual(size);
          expect((await sharp(framed).metadata()).hasAlpha).toBe(false);
        }
      }
    },
    120_000,
  );

  it('produces identical pixels for repeated inputs and preserves the complete screen aspect ratio', async () => {
    const size = { width: 1080, height: 1920 };
    const raw = await sharp({ create: { ...size, channels: 3, background: '#164c39' } })
      .png()
      .toBuffer();
    const caption = readCaptionCatalog('en-US').board;
    const first = await frameScreenshot(raw, caption);
    expect(await frameScreenshot(raw, caption)).toEqual(first);
    // Center and near-bottom native content survive; the app is never cropped to make room for copy.
    for (const top of [600, 1800]) {
      const pixel = await sharp(first).extract({ left: 540, top, width: 1, height: 1 }).raw().toBuffer();
      expect([...pixel]).toEqual([22, 76, 57]);
    }
  });

  it('fails on overflowing copy rather than silently clipping it', async () => {
    const raw = await sharp({ create: { width: 1080, height: 1920, channels: 3, background: 'white' } })
      .png()
      .toBuffer();
    await expect(
      frameScreenshot(raw, { headline: 'Very long headline '.repeat(30), description: 'Caption' }),
    ).rejects.toThrow('overflows');
  });

  it('rejects unknown or incomplete flows before replacing previous output', async () => {
    const input = directory();
    const output = directory();
    writeFileSync(join(input, 'unexpected.png'), 'unrecognized screen');
    writeFileSync(join(output, 'previous.png'), 'previous capture');
    await expect(
      frameDirectory({ platform: 'android', device: 'pixel-2', locale: 'en-US', input, output }),
    ).rejects.toThrow('Incomplete or unknown');
    expect(readFileSync(join(output, 'previous.png'), 'utf8')).toBe('previous capture');
    await expect(
      frameDirectory({ platform: 'android', device: 'pixel-2', locale: 'en-US', input, output: input }),
    ).rejects.toThrow('separate');
    writeFileSync(join(input, PRESENTATION_MANIFEST), '{}');
    await expect(
      frameDirectory({ platform: 'android', device: 'pixel-2', locale: 'en-US', input, output }),
    ).rejects.toThrow('already framed');
  });

  it('refuses blank native captures before decorative content is added', async () => {
    const input = directory();
    const raw = await sharp({ create: { width: 1080, height: 1920, channels: 3, background: '#111111' } })
      .png()
      .toBuffer();
    for (const name of Object.keys(screenshotCaptions('android', 'pixel-2'))) writeFileSync(join(input, name), raw);
    await expect(
      frameDirectory({ platform: 'android', device: 'pixel-2', locale: 'en-US', input, output: directory() }),
    ).rejects.toThrow('likely blank');
  });

  it('checks raw capture sizes and refuses stale presentation metadata', () => {
    const input = directory();
    const framed = Buffer.alloc(200_000, 7);
    const path = join(input, '00-board.png');
    writeFileSync(path, framed);
    writeFileSync(
      join(input, PRESENTATION_MANIFEST),
      JSON.stringify({
        version: 1,
        locale: 'en-US',
        files: {
          '00-board.png': { rawBytes: 1000, rawSha256: 'a'.repeat(64), framedSha256: sha256Screenshot(framed) },
        },
      }),
    );
    const candidates = readPngSizesRecursively(input);
    expect(candidates).toEqual([{ relativePath: '00-board.png', size: 1000 }]);
    expect(findContentOffenders(candidates, new Map(), { minBytes: 61440, minRatio: 0.4 })).toHaveLength(1);
    writeFileSync(path, Buffer.alloc(200_000, 8));
    expect(() => readPngSizesRecursively(input)).toThrow('does not match');
  });

  it('keeps Spanish store folders on identical captions and forces all shards on presentation changes', () => {
    expect(STORE_CAPTION_LOCALES['es-ES']).toBe(STORE_CAPTION_LOCALES['es-MX']);
    for (const path of [
      'app-stores/presentation/de.json',
      'app-stores/presentation/fonts/Roboto-Bold.ttf',
      'scripts/frame-screenshots.ts',
    ]) {
      expect(decideProbeScope([path]).forceFull).toBe(true);
    }
  });

  it('requires a locale for a single iOS shard and rejects unknown arguments', () => {
    expect(() =>
      parseFrameArguments([
        '--platform',
        'ios',
        '--input',
        '/raw',
        '--output',
        '/framed',
        '--device',
        'iphone-16-pro-max',
      ]),
    ).toThrow('--locale');
    expect(() => parseFrameArguments(['--unsafe', 'true'])).toThrow('Invalid');
  });
});
