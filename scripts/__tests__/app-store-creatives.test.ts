/// <reference types="node" />
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { renderStoreCreatives, parseCreativeArguments } from '../app-store-creatives';
import { frameShowcaseComposition, renderShowcaseText, STORE_CREATIVE_PLACEMENTS } from '../frame-screenshots';
import {
  CAPTION_LOCALES,
  IOS_CAMPAIGN_CAPTURE_NAMES,
  PRESENTATION_ROOT,
  readCaptionCatalog,
  resolveScreenshotRecipes,
  sha256Screenshot,
} from '../lib/screenshot-presentation';

const directories: string[] = [];
const directory = () => {
  const pathname = mkdtempSync(join(tmpdir(), 'store-creative-'));
  directories.push(pathname);
  return pathname;
};
afterEach(() => {
  for (const pathname of directories.splice(0)) rmSync(pathname, { recursive: true, force: true });
});

async function capture(width = 1206, height = 2622): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#214736' } })
    .composite([{ input: randomBytes(256 * 128 * 3), raw: { width: 256, height: 128, channels: 3 } }])
    .png()
    .toBuffer();
}

describe('multiboard App Store campaign', () => {
  it.each([
    [1206, 2622],
    [1320, 2868],
  ])('keeps Island controls and excludes system labels at %i×%i', async (width, height) => {
    const source = await sharp({ create: { width, height, channels: 3, background: '#ff0000' } })
      .composite([
        {
          input: await sharp({ create: { width, height: 480, channels: 3, background: '#214736' } })
            .png()
            .toBuffer(),
          left: 0,
          top: 0,
        },
        {
          input: await sharp({ create: { width: 200, height: 40, channels: 3, background: '#00ff00' } })
            .png()
            .toBuffer(),
          left: 100,
          top: 400,
        },
      ])
      .png()
      .toBuffer();
    const framed = await frameShowcaseComposition([source], readCaptionCatalog('en-US').storeIsland, 'store-island');
    const pixels = await sharp(framed).removeAlpha().raw().toBuffer();
    let controlPixels = 0;
    let systemPixels = 0;
    for (let offset = 0; offset < pixels.length; offset += 3) {
      if (pixels[offset] === 0 && pixels[offset + 1] === 255 && pixels[offset + 2] === 0) controlPixels++;
      if (pixels[offset] === 255 && pixels[offset + 1] === 0 && pixels[offset + 2] === 0) systemPixels++;
    }
    expect(controlPixels).toBeGreaterThan(1000);
    expect(systemPixels).toBe(0);
  });

  it('keeps every native footer visible below a longer localized headline', async () => {
    const colors = ['#ff0000', '#00ff00', '#0000ff'];
    const sources = await Promise.all(
      colors.map(async (color) =>
        sharp({ create: { width: 1206, height: 2622, channels: 3, background: '#214736' } })
          .composite([
            {
              input: await sharp({ create: { width: 1206, height: 80, channels: 3, background: color } })
                .png()
                .toBuffer(),
              left: 0,
              top: 2542,
            },
          ])
          .png()
          .toBuffer(),
      ),
    );
    const caption = {
      ...readCaptionCatalog('de').storeMoreBoards,
      headline: 'Mehr Boards.\nDieselbe App.\nFür deine Crew.',
    };
    const framed = await frameShowcaseComposition(sources, caption, 'store-boards', {
      labels: ['Woods', 'Decoy', 'Grasshopper'],
    });
    const pixels = await sharp(framed).raw().toBuffer();
    const footerPixels = [0, 0, 0];
    for (let offset = 0; offset < pixels.length; offset += 3) {
      for (let channel = 0; channel < 3; channel++) {
        if (
          pixels[offset + channel] === 255 &&
          pixels[offset + ((channel + 1) % 3)] === 0 &&
          pixels[offset + ((channel + 2) % 3)] === 0
        )
          footerPixels[channel]++;
      }
    }
    for (const count of footerPixels) expect(count).toBeGreaterThan(1000);
  });

  it('loads Instrument Serif rather than substituting the sans-serif italic face', async () => {
    const sample = 'app. queue.';
    const serif = await renderShowcaseText(sample, 120, 1100, '#FFFFFF', { emphasis: sample });
    const sans = await sharp({
      text: {
        text: '<span foreground="#FFFFFF">app. queue.</span>',
        font: 'Inter Tight Italic 120',
        fontfile: join(PRESENTATION_ROOT, 'fonts', 'InterTight-Regular.ttf'),
        width: 1100,
        dpi: 72,
        rgba: true,
      },
    })
      .png()
      .toBuffer({ resolveWithObject: true });
    // With CoreText fallback both faces have identical pixels and widths.
    // The pinned Instrument Serif glyphs are distinctly narrower than Inter.
    expect(serif.info.width).toBeLessThan(sans.info.width * 0.9);
    expect(sha256Screenshot(serif.data)).not.toBe(sha256Screenshot(sans.data));
  });

  it('requires the complete native scenario and names the exact hardware in source order', () => {
    const recipes = resolveScreenshotRecipes('ios', 'iphone-16-pro', IOS_CAMPAIGN_CAPTURE_NAMES);
    expect(recipes).toHaveLength(9);
    expect(recipes[0].labels).toEqual(['Tension', 'Kilter', 'MoonBoard']);
    expect(recipes[3].labels).toEqual(['Woods', 'Decoy', 'Grasshopper']);
    expect(recipes[3].sources).toContain('12-decoy-board-view.png');
    expect(recipes[7].sources).toEqual(['17-dynamic-island.png']);
    for (const missing of ['14-spray-board-view.png', '12-decoy-board-view.png', '17-dynamic-island.png'])
      expect(() =>
        resolveScreenshotRecipes(
          'ios',
          'iphone-16-pro',
          IOS_CAMPAIGN_CAPTURE_NAMES.filter((name) => name !== missing),
        ),
      ).toThrow('Incomplete or unknown');
    expect(() =>
      resolveScreenshotRecipes('ios', 'iphone-16-pro', [...IOS_CAMPAIGN_CAPTURE_NAMES, 'unknown.png']),
    ).toThrow();
    expect(() =>
      resolveScreenshotRecipes('ios', 'iphone-16-pro', [...IOS_CAMPAIGN_CAPTURE_NAMES, IOS_CAMPAIGN_CAPTURE_NAMES[0]]),
    ).toThrow();
  });

  it.each(CAPTION_LOCALES)(
    'renders localized opening, crew and island without overflowing: %s',
    async (locale) => {
      const raw = await capture();
      const catalog = readCaptionCatalog(locale);
      for (const [caption, layout, labels] of [
        [catalog.storeBoards, 'store-boards', ['Tension', 'Kilter', 'MoonBoard']],
        [catalog.storeCrew, 'store-queue', undefined],
        [catalog.storeIsland, 'store-island', undefined],
      ] as const) {
        const framed = await frameShowcaseComposition(labels ? [raw, raw, raw] : [raw], caption, layout, { labels });
        expect(await sharp(framed).metadata()).toMatchObject({ width: 1206, height: 2622, hasAlpha: false });
      }
    },
    60_000,
  );

  it('exports opaque dedicated placements with source provenance outside screenshot uploads', async () => {
    const input = directory();
    const output = directory();
    const raw = await capture();
    const names = ['01-board-view-2.png', '00-board-view.png', '10-moonboard-board-view.png'];
    for (const name of names) writeFileSync(join(input, name), raw);
    const saved = await renderStoreCreatives({ input, output, locale: 'en-US', device: 'iphone-16-pro' });
    expect(saved.map((pathname) => pathname.slice(output.length + 1))).toEqual(['header.png', 'search-results.png']);
    for (const [placement, dimensions] of Object.entries(STORE_CREATIVE_PLACEMENTS)) {
      const rendered = readFileSync(join(output, `${placement}.png`));
      expect(await sharp(rendered).metadata()).toMatchObject({ ...dimensions, hasAlpha: false });
    }
    const manifest = JSON.parse(readFileSync(join(output, 'creative-assets.json'), 'utf8')) as {
      sources: Record<string, { sha256: string }>;
      assets: Array<{ file: string; sha256: string }>;
    };
    expect(Object.keys(manifest.sources)).toEqual(names);
    expect(manifest.sources[names[0]].sha256).toBe(sha256Screenshot(raw));
    for (const asset of manifest.assets)
      expect(asset.sha256).toBe(sha256Screenshot(readFileSync(join(output, asset.file))));
    await expect(
      renderStoreCreatives({
        input,
        output: 'app-stores/apple/screenshots/en-US',
        locale: 'en-US',
        device: 'iphone-16-pro',
      }),
    ).rejects.toThrow('screenshot upload tree');
    await expect(
      renderStoreCreatives({ input, output: input, locale: 'en-US', device: 'iphone-16-pro' }),
    ).rejects.toThrow('separate');
  }, 60_000);

  it('rejects compressed video frames, blank images, mismatched devices and missing labels', async () => {
    const input = directory();
    const output = directory();
    const raw = await capture(800, 1738);
    for (const name of ['01-board-view-2.png', '00-board-view.png', '10-moonboard-board-view.png'])
      writeFileSync(join(input, name), raw);
    await expect(renderStoreCreatives({ input, output, locale: 'en-US', device: 'iphone-16-pro' })).rejects.toThrow();
    const blank = await sharp({
      create: { width: 1206, height: 2622, channels: 3, background: '#000000' },
    })
      .png()
      .toBuffer();
    for (const name of ['01-board-view-2.png', '00-board-view.png', '10-moonboard-board-view.png'])
      writeFileSync(join(input, name), blank);
    await expect(renderStoreCreatives({ input, output, locale: 'en-US', device: 'iphone-16-pro' })).rejects.toThrow(
      'likely blank',
    );
    const native = await capture();
    await expect(
      frameShowcaseComposition([native, raw, native], readCaptionCatalog('en-US').storeBoards, 'store-boards', {
        labels: ['Tension', 'Kilter', 'MoonBoard'],
      }),
    ).rejects.toThrow('same capture device');
    await expect(
      frameShowcaseComposition([native, native, native], readCaptionCatalog('en-US').storeBoards, 'store-boards'),
    ).rejects.toThrow('compatibility label');
  });

  it('requires an explicit supported locale and capture device', () => {
    const args = [
      '--input',
      '/tmp/native',
      '--output',
      '/tmp/creatives',
      '--device',
      'iphone-16-pro',
      '--locale',
      'es',
    ];
    expect(parseCreativeArguments(args)).toMatchObject({ locale: 'es', device: 'iphone-16-pro' });
    expect(() => parseCreativeArguments(args.slice(0, -2))).toThrow('Usage');
    expect(() => parseCreativeArguments([...args, '--locale', 'en-US'])).toThrow('Invalid');
    expect(() => parseCreativeArguments([...args.slice(0, -1), 'it'])).toThrow('Usage');
  });
});
