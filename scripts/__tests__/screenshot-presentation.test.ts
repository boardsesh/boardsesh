/// <reference types="node" />

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { IOS_SCREENSHOT_DEVICES, deviceSlug } from '../mobile-screenshots';
import { frameDirectory, frameScreenshot, main, parseFrameArguments } from '../frame-screenshots';
import { ACCEPTED_SIZES, readPngDimensions } from '../assert-screenshot-dimensions';
import { readPngSizesRecursively, findContentOffenders } from '../assert-screenshot-content';
import { decideProbeScope } from '../screenshot-probe-scope';
import {
  PRESENTATION_MANIFEST,
  CAPTION_IDS,
  STORE_CAPTION_LOCALES,
  captionLocaleForStore,
  readCaptionCatalog,
  readPresentationManifest,
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

  it('rejects unknown Apple locales instead of silently using English', () => {
    expect(captionLocaleForStore('ios', 'es-MX')).toBe('es');
    expect(captionLocaleForStore('android', '')).toBe('en-US');
    expect(() => captionLocaleForStore('ios', 'it-IT')).toThrow('No screenshot captions');
  });

  it('frames a complete directory with verifiable metadata and a review sheet', async () => {
    const input = directory();
    const output = directory();
    // Keep enough image detail to clear the content gate without spending
    // minutes compressing full-screen noise in a directory-contract test.
    const raw = await sharp({ create: { width: 1080, height: 1920, channels: 3, background: '#164c39' } })
      .composite([{ input: randomBytes(256 * 128 * 3), raw: { width: 256, height: 128, channels: 3 } }])
      .png()
      .toBuffer();
    const names = Object.keys(screenshotCaptions('android', 'pixel-2'));
    for (const name of names) writeFileSync(join(input, name), raw);

    const saved = await frameDirectory({ platform: 'android', device: 'pixel-2', locale: 'en-US', input, output });

    expect(saved).toEqual(names.map((name) => join(output, name)));
    expect(readPngSizesRecursively(output)).toEqual(names.map((relativePath) => ({ relativePath, size: raw.length })));
    const manifest = readPresentationManifest(output);
    for (const name of names) {
      const framed = readFileSync(join(output, name));
      expect(readPngDimensions(framed)).toEqual({ width: 1080, height: 1920 });
      expect(manifest.files[name]).toEqual({
        rawBytes: raw.length,
        rawSha256: sha256Screenshot(raw),
        framedSha256: sha256Screenshot(framed),
      });
      expect(readFileSync(join(input, name))).toEqual(raw);
    }
    expect((await sharp(join(output, 'contact-sheet.jpg')).metadata()).format).toBe('jpeg');
  }, 60_000);
  it('discovers Apple locale/device folders and uses their localized captions', async () => {
    const input = directory();
    const output = directory();
    const device = 'iphone-16-pro-max';
    const shard = join('es-MX', device);
    mkdirSync(join(input, shard), { recursive: true });
    const raw = await sharp({ create: { width: 1320, height: 2868, channels: 3, background: '#164c39' } })
      .composite([{ input: randomBytes(256 * 128 * 3), raw: { width: 256, height: 128, channels: 3 } }])
      .png()
      .toBuffer();
    const names = Object.keys(screenshotCaptions('ios', device));
    for (const name of names) writeFileSync(join(input, shard, name), raw);

    expect(await main(['--platform', 'ios', '--input', input, '--output', output])).toBe(0);

    const manifest = readPresentationManifest(join(output, shard));
    expect(manifest.locale).toBe('es');
    expect(Object.keys(manifest.files)).toEqual(names);
    const first = names[0];
    expect(readFileSync(join(output, shard, first))).toEqual(
      await frameScreenshot(raw, readCaptionCatalog('es')[screenshotCaptions('ios', device)[first]]),
    );
  }, 60_000);

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

  it('identifies the shard when its presentation metadata cannot be parsed', () => {
    const shard = directory();
    const manifest = join(shard, PRESENTATION_MANIFEST);
    writeFileSync(manifest, '{invalid json');
    expect(() => readPresentationManifest(shard)).toThrow(manifest);
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
