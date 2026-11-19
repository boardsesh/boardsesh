import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acceptedSizesForFile, EXPECTED_APP_STORE_DEVICE_SLUGS } from '../assert-screenshot-dimensions';
import { resolveAppStoreLocaleTargets } from '../mobile-screenshots';
import { prepareSelectedIosScreenshots } from '../prepare-selected-ios-screenshots';
import {
  IOS_CAMPAIGN_CAPTURE_NAMES,
  PRESENTATION_MANIFEST,
  resolveScreenshotRecipes,
  screenshotCaptions,
  sha256Screenshot,
  sha256ScreenshotSources,
  type PresentationManifest,
} from '../lib/screenshot-presentation';
import { loadFullScreenLiveActivityFixture } from '../lib/screenshot-live-activity';
import type { Locale } from '../../packages/shared/i18n/src/config';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(appLocale: Locale = 'zh-CN') {
  const root = mkdtempSync(join(tmpdir(), 'selected-ios-upload-'));
  directories.push(root);
  const source = join(root, 'source');
  const output = join(root, 'staged');
  for (const { appStoreLocales } of resolveAppStoreLocaleTargets([appLocale])) {
    for (const storeLocale of appStoreLocales) {
      for (const device of EXPECTED_APP_STORE_DEVICE_SLUGS) {
        const directory = join(source, storeLocale, device);
        mkdirSync(directory, { recursive: true });
        const captures =
          device.startsWith('iphone-') && device !== 'iphone-duo'
            ? IOS_CAMPAIGN_CAPTURE_NAMES
            : Object.keys(screenshotCaptions('ios', device));
        const presentation: PresentationManifest = { version: 1, locale: appLocale, files: {} };
        for (const recipe of resolveScreenshotRecipes('ios', device, captures, appLocale)) {
          const filename = recipe.output;
          const sizes = acceptedSizesForFile(device, filename);
          if (typeof sizes === 'string') throw new Error(sizes);
          const pixels = Buffer.alloc(32);
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(pixels);
          pixels.write('IHDR', 12);
          pixels.writeUInt32BE(sizes[0].width, 16);
          pixels.writeUInt32BE(sizes[0].height, 20);
          writeFileSync(join(directory, filename), pixels);
          presentation.files[filename] = {
            rawBytes: 70_000,
            rawSha256: 'a'.repeat(64),
            framedSha256: sha256Screenshot(pixels),
          };
          if (recipe.sources.length > 1) {
            const sources = Object.fromEntries(
              recipe.sources.map((name) => [name, { rawBytes: 70_000, rawSha256: 'a'.repeat(64) }]),
            );
            presentation.files[filename].sources = sources;
            presentation.files[filename].rawSha256 = sha256ScreenshotSources(sources);
          }
          if (recipe.liveActivity) {
            const native = loadFullScreenLiveActivityFixture(recipe.liveActivity.boardFamily, appLocale);
            presentation.files[filename].rawBytes = native.pixels.length;
            presentation.files[filename].rawSha256 = native.provenance.sha256;
            presentation.files[filename].liveActivity = {
              fixture: native.provenance,
              manifestSha256: native.manifestSha256,
              outputCanvas: sizes[0],
            };
          }
        }
        writeFileSync(join(directory, PRESENTATION_MANIFEST), JSON.stringify(presentation));
        writeFileSync(join(directory, 'contact-sheet.jpg'), 'review only');
      }
    }
  }
  return { root, source, output, appLocales: [appLocale] };
}

describe('selected iOS screenshot upload preflight', () => {
  it('stages only Chinese, preserving every source locale and excluding review files', () => {
    const options = fixture();
    const english = join(options.source, 'en-US', 'iphone-16-pro');
    mkdirSync(english, { recursive: true });
    writeFileSync(join(english, 'unchanged.png'), 'previous English pixels');
    const result = prepareSelectedIosScreenshots(options);
    expect(result.locales).toEqual(['zh-Hans']);
    expect(result.screenshots).toBe(38);
    expect(readdirSync(options.output)).toEqual(['zh-Hans']);
    expect(readdirSync(join(options.output, 'zh-Hans')).sort()).toEqual([...EXPECTED_APP_STORE_DEVICE_SLUGS].sort());
    expect(readFileSync(join(english, 'unchanged.png'), 'utf8')).toBe('previous English pixels');
    expect(existsSync(join(options.output, 'zh-Hans', 'iphone-16-pro', 'contact-sheet.jpg'))).toBe(false);
    expect(readFileSync(join(options.output, 'zh-Hans', 'iphone-16-pro', '07-session-detail.png'))).toEqual(
      readFileSync(join(options.source, 'zh-Hans', 'iphone-16-pro', '07-session-detail.png')),
    );
  });

  it('includes both Apple Spanish regions when Spanish is selected', () => {
    const options = fixture('es');
    const result = prepareSelectedIosScreenshots(options);
    expect(result.locales).toEqual(['es-ES', 'es-MX']);
    expect(result.screenshots).toBe(76);
    expect(readdirSync(result.path).sort()).toEqual(['es-ES', 'es-MX']);
  });

  it.each([
    'missing device',
    'missing screenshot',
    'wrong language',
    'bad dimensions',
    'blank raw source',
    'changed pixels',
    'missing composite sources',
    'wrong composite sources',
  ])('refuses %s before staging any upload files', (problem) => {
    const options = fixture();
    const device = join(options.source, 'zh-Hans', 'iphone-16-pro');
    const screenshot = join(device, '00-your-boards.png');
    const manifestPath = join(device, PRESENTATION_MANIFEST);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PresentationManifest;
    if (problem === 'missing device')
      rmSync(join(options.source, 'zh-Hans', 'ipad-pro-11-inch-m5'), { recursive: true });
    if (problem === 'missing screenshot') rmSync(screenshot);
    if (problem === 'wrong language') manifest.locale = 'en-US';
    const composite = manifest.files['00-your-boards.png'];
    if (problem === 'blank raw source') {
      composite.sources!['00-board-view.png'].rawBytes = 100;
      composite.rawBytes = 100;
      composite.rawSha256 = sha256ScreenshotSources(composite.sources!);
    }
    if (problem === 'missing composite sources') {
      delete composite.sources;
      composite.rawSha256 = 'a'.repeat(64);
    }
    if (problem === 'wrong composite sources') {
      composite.sources!['unrelated.png'] = composite.sources!['00-board-view.png'];
      delete composite.sources!['00-board-view.png'];
      composite.rawSha256 = sha256ScreenshotSources(composite.sources!);
    }
    if (problem === 'bad dimensions' || problem === 'changed pixels') {
      const pixels = readFileSync(screenshot);
      if (problem === 'bad dimensions') pixels.writeUInt32BE(1, 16);
      else pixels[31] = 1;
      writeFileSync(screenshot, pixels);
      if (problem === 'bad dimensions') manifest.files['00-your-boards.png'].framedSha256 = sha256Screenshot(pixels);
    }
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => prepareSelectedIosScreenshots(options)).toThrow();
    expect(existsSync(options.output)).toBe(false);
  });

  it('requires the physical provenance of a recipe that advertises Live Activity', () => {
    const options = fixture('es');
    const filename = join(options.source, 'es-ES', 'iphone-16-pro', PRESENTATION_MANIFEST);
    const manifest = JSON.parse(readFileSync(filename, 'utf8')) as PresentationManifest;
    delete manifest.files['07-live-activity.png'].liveActivity;
    writeFileSync(filename, JSON.stringify(manifest));
    expect(() => prepareSelectedIosScreenshots(options)).toThrow('Live Activity provenance');
    expect(existsSync(options.output)).toBe(false);
  });

  it('rejects borrowed Live Activity provenance in the Chinese native session slot', () => {
    const options = fixture();
    const filename = join(options.source, 'zh-Hans', 'iphone-16-pro', PRESENTATION_MANIFEST);
    const manifest = JSON.parse(readFileSync(filename, 'utf8')) as PresentationManifest;
    const native = loadFullScreenLiveActivityFixture('kilter', 'es');
    const entry = manifest.files['07-session-detail.png'];
    entry.rawBytes = native.pixels.length;
    entry.rawSha256 = native.provenance.sha256;
    entry.liveActivity = {
      fixture: { ...native.provenance, appLocale: 'zh-CN' },
      manifestSha256: native.manifestSha256,
      outputCanvas: { width: 1206, height: 2622 },
    };
    writeFileSync(filename, JSON.stringify(manifest));
    expect(() => prepareSelectedIosScreenshots(options)).toThrow('Live Activity provenance');
    expect(existsSync(options.output)).toBe(false);
  });

  it('applies the existing content ratio when a selected-language baseline exists', () => {
    const options = fixture();
    const baseline = join(options.root, 'baseline');
    const directory = join(baseline, 'zh-Hans', 'iphone-16-pro');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, '00-your-boards.png'), Buffer.alloc(200_000));
    expect(() => prepareSelectedIosScreenshots({ ...options, baseline })).toThrow('baseline');
    expect(existsSync(options.output)).toBe(false);
  });

  it.each([{ appLocales: [] }, { appLocales: ['zh-Hans'] }, { appLocales: ['zh-CN', 'unknown'] }])(
    'rejects invalid app locale lists: $appLocales',
    ({ appLocales }) => {
      const options = fixture();
      expect(() => prepareSelectedIosScreenshots({ ...options, appLocales })).toThrow('supported app languages');
      expect(existsSync(options.output)).toBe(false);
    },
  );
});
