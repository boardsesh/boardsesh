/// <reference types="node" />

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { IOS_SCREENSHOT_DEVICES, deviceSlug } from '../mobile-screenshots';
import {
  frameComposition,
  frameDirectory,
  frameScreenshot,
  main,
  parseFrameArguments,
  renderShowcaseText,
} from '../frame-screenshots';
import { CPP_TARGETS, readCppPage } from '../lib/screenshot-cpp';
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
  resolveScreenshotRecipes,
  screenshotCaptions,
  sha256Screenshot,
  sha256ScreenshotSources,
  validateScreenshotBoardLabels,
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

describe('board-specific CPP openings', () => {
  const devices = Object.keys(ACCEPTED_SIZES);
  const headlineByTarget = {
    kilter: 'Supports Kilter',
    tension: 'Supports Tension',
    moonboard: 'Supports MoonBoard',
    spray: 'Supports spray walls',
  };

  it('leads every target and device with its own trio, then three other board families', () => {
    for (const target of CPP_TARGETS) {
      const page = readCppPage(target);
      expect(page.heroBoards.every((board) => board.family === target)).toBe(true);
      expect(new Set(page.otherBoards.map((board) => board.family)).size).toBe(3);
      expect(page.otherBoards.every((board) => board.family !== target)).toBe(true);
      for (const device of devices) {
        const recipes = page.recipes[device.startsWith('ipad-') ? 'ipad' : 'phone'];
        expect(recipes).toHaveLength(9);
        expect(recipes.slice(0, 2).map((recipe) => recipe.layout)).toEqual(['store-boards', 'store-boards']);
        expect(recipes[0].sources).toEqual(
          target === 'kilter' ? ['hero-2.png', 'hero-1.png', 'hero-3.png'] : ['hero-1.png', 'hero-2.png', 'hero-3.png'],
        );
        expect(recipes[1].sources).toEqual(['other-1.png', 'other-2.png', 'other-3.png']);
        expect(recipes[1].caption).toBe('cppOtherBoards');
        const captions = readCaptionCatalog('en-US');
        expect(captions[recipes[0].caption].headline).toBe(headlineByTarget[target]);
        expect(captions[recipes[1].caption]).toEqual({
          headline: 'One app for all your boards',
          description: 'All your logbooks in one place',
        });
        expect(recipes.some((recipe) => recipe.caption === 'board')).toBe(false);
      }
    }
    expect(readCppPage('spray').heroBoards.map((board) => board.selector)).toEqual([
      "Liz's Wall",
      "Cherry's Wall",
      'The Bowlo',
    ]);
  });

  it('keeps the existing seven feature scenes in order for phones and iPads', () => {
    for (const device of devices) {
      const island = device.startsWith('ipad-') ? 'cppKiosk' : 'cppIsland';
      const expected = {
        kilter: [
          'cppKilterGrade',
          'cppKilterLogbookImport',
          'cppQueue',
          device.startsWith('ipad-') ? 'cppKiosk' : 'cppLiveActivity',
          'cppSearch',
          'cppWorkout',
          'cppStatus',
        ],
        tension: [
          'cppTensionQueue',
          'cppTensionLogbookImport',
          device.startsWith('ipad-') ? 'cppKiosk' : 'cppLiveActivity',
          'cppTensionSearch',
          'cppTensionMirrorBoard',
          'cppWorkout',
          'cppStatus',
        ],
        moonboard: [
          'cppMoonboardGrade',
          'cppQueue',
          island,
          'cppSearch',
          'cppMoonboardLogbook',
          'cppWorkout',
          'cppStatus',
        ],
        spray: [
          'cppSpraySetting',
          'cppQueue',
          'cppSprayProjects',
          'cppLogbook',
          'cppSprayHolds',
          'cppSearch',
          'cppSprayWorkout',
        ],
      };
      for (const target of CPP_TARGETS) {
        const page = readCppPage(target);
        const recipes = page.recipes[device.startsWith('ipad-') ? 'ipad' : 'phone'];
        expect(recipes.slice(2).map((recipe) => recipe.caption)).toEqual(expected[target]);
      }
    }
  });

  it('keeps Tension Live Activity tied to its phone fixture without reusing Island or Kilter sources', () => {
    const page = readCppPage('tension');
    const phone = page.recipes.phone[4];
    expect(phone.output).toBe('04-live-activity.png');
    expect(phone.layout).toBe('store-live-activity');
    expect(phone.sources).toEqual([]);
    expect(phone.liveActivity).toEqual({ boardFamily: 'tension' });
    expect(page.recipes.phone.some((recipe) => recipe.sources.includes('08-island.png'))).toBe(false);
    expect(page.recipes.phone.some((recipe) => recipe.liveActivity?.boardFamily === 'kilter')).toBe(false);
    expect(page.recipes.ipad.some((recipe) => recipe.liveActivity !== undefined)).toBe(false);
    expect(page.recipes.ipad[4].sources).toEqual(['08-kiosk.png']);
  });

  it('localizes both opening captions, qualifies MoonBoard CSV import, and never promises spray imports', () => {
    const otherHeadlines = {
      'en-US': 'One app for all your boards',
      es: 'Una app para todos tus plafones',
      fr: 'Une app pour toutes tes boards',
      de: 'Eine App für alle deine Boards',
    };
    for (const locale of ['en-US', 'es', 'fr', 'de'] as const) {
      const catalog = readCaptionCatalog(locale);
      for (const target of CPP_TARGETS) {
        const page = readCppPage(target);
        const first = catalog[page.recipes.phone[0].caption];
        expect(first.headline.trim()).not.toBe('');
        expect(first.description.trim()).not.toBe('');
        expect(catalog[page.recipes.phone[1].caption].headline).toBe(otherHeadlines[locale]);
        if (target === 'moonboard') expect(first.description).toContain('CSV');
        if (target === 'spray') expect(first.description).not.toMatch(/import|CSV/i);
        if (target === 'kilter' || target === 'tension') expect(first.description).toMatch(/import/i);
      }
    }
    expect(readCaptionCatalog('en-US').cppKilterLayouts.description).toBe(
      'We can also import your existing logbook for you',
    );
    expect(readCaptionCatalog('en-US').cppTensionLayouts.description).toBe(
      'We can also import your existing logbook for you',
    );
    expect(readCaptionCatalog('en-US').storeBoards).toEqual({
      headline: 'One app for all your boards',
      description: 'One logbook for every board.',
    });
  });
});

describe('CPP trio board labels', () => {
  it('matches each label to its source slot and keeps Kilter Original in the center', () => {
    for (const target of CPP_TARGETS) {
      const page = readCppPage(target);
      for (const recipes of Object.values(page.recipes)) {
        for (const recipe of recipes.filter((candidate) => candidate.layout === 'store-boards')) {
          const expected = recipe.sources.map((filename) => {
            const [family, slot] = filename.replace('.png', '').split('-');
            return (family === 'hero' ? page.heroBoards : page.otherBoards)[Number(slot) - 1].selector;
          });
          expect(recipe.boardLabels).toEqual(expected);
          expect(validateScreenshotBoardLabels(recipe.boardLabels, recipe.layout, recipe.sources.length)).toEqual(
            expected,
          );
          if (target === 'kilter' && recipe.sources.includes('hero-1.png')) {
            expect(recipe.boardLabels?.[1]).toBe('Kilter Original 12x12');
          }
        }
      }
    }
  });

  it('preserves unlabeled default and Android pixels byte for byte', async () => {
    const raw = await sharp({ create: { width: 1320, height: 2868, channels: 3, background: '#164c39' } })
      .png()
      .toBuffer();
    const caption = readCaptionCatalog('en-US').storeBoards;
    const original = await frameComposition([raw, raw, raw], caption, 'store-boards', true);
    expect(await frameComposition([raw, raw, raw], caption, 'store-boards', true, { boardLabels: undefined })).toEqual(
      original,
    );
    const android = await frameComposition([raw], caption, 'screen');
    expect(await frameComposition([raw], caption, 'screen', false, { boardLabels: undefined })).toEqual(android);
  });

  it('rejects blank names, missing labels, the wrong layout, and overflowing labels', async () => {
    const raw = await sharp({ create: { width: 1320, height: 2868, channels: 3, background: '#164c39' } })
      .png()
      .toBuffer();
    const caption = readCaptionCatalog('en-US').storeBoards;
    for (const boardLabels of [
      ['Kilter', 'MoonBoard'],
      ['Kilter', ' ', 'Tension'],
    ]) {
      await expect(frameComposition([raw, raw, raw], caption, 'store-boards', true, { boardLabels })).rejects.toThrow(
        'three nonblank names',
      );
    }
    await expect(
      frameComposition([raw], caption, 'screen', true, { boardLabels: ['Kilter', 'MoonBoard', 'Tension'] }),
    ).rejects.toThrow('source trio');
    await expect(
      frameComposition([raw, raw], caption, 'store-boards', true, {
        boardLabels: ['Kilter', 'MoonBoard', 'Tension'],
      }),
    ).rejects.toThrow('source trio');
    await expect(
      frameComposition([raw, raw, raw], caption, 'store-boards', true, {
        boardLabels: ['Kilter '.repeat(100), 'MoonBoard', 'Tension'],
      }),
    ).rejects.toThrow('labels overflow');
  });

  it('keeps the bottom of each complete native capture above the label footer', async () => {
    const markerColors = ['#b03040', '#20a0d0', '#e0a030'];
    for (const device of Object.keys(ACCEPTED_SIZES)) {
      const { width, height } = ACCEPTED_SIZES[device][0];
      const captures = await Promise.all(
        markerColors.map((color) =>
          sharp(
            Buffer.from(
              `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#164c39"/><rect y="${Math.floor(height * 0.94)}" width="100%" height="${Math.ceil(height * 0.06)}" fill="${color}"/></svg>`,
            ),
          )
            .png()
            .toBuffer(),
        ),
      );
      const recipe = readCppPage('kilter').recipes[device.startsWith('ipad-') ? 'ipad' : 'phone'].find(
        (candidate) => candidate.caption === 'cppKilterLayouts',
      )!;
      const framed = await frameComposition(
        captures,
        readCaptionCatalog('en-US')[recipe.caption],
        recipe.layout,
        true,
        {
          boardLabels: recipe.boardLabels,
        },
      );
      const reduced = await sharp(framed).resize({ width: 300, kernel: 'nearest' }).raw().toBuffer();
      for (const color of markerColors) {
        const expected = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
        let hits = 0;
        for (let pixel = 0; pixel < reduced.length; pixel += 3) {
          if (expected.every((channel, index) => reduced[pixel + index] === channel)) hits++;
        }
        expect(hits, `${device} must retain the ${color} native footer`).toBeGreaterThan(3);
      }
    }
  });

  it.each(Object.keys(ACCEPTED_SIZES))(
    'fits complete panels and ordered labels on %s in every locale',
    async (device) => {
      const { width, height } = ACCEPTED_SIZES[device][0];
      const raw = await sharp({ create: { width, height, channels: 3, background: '#164c39' } })
        .png()
        .toBuffer();
      for (const locale of ['en-US', 'es', 'fr', 'de'] as const) {
        for (const target of CPP_TARGETS) {
          const page = readCppPage(target);
          for (const recipe of page.recipes[device.startsWith('ipad-') ? 'ipad' : 'phone'].filter(
            (candidate) => candidate.layout === 'store-boards',
          )) {
            const labels = recipe.boardLabels!;
            const caption = readCaptionCatalog(locale)[recipe.caption];
            const framed = await frameComposition([raw, raw, raw], caption, recipe.layout, true, {
              boardLabels: labels,
            });
            expect(readPngDimensions(framed)).toEqual({ width, height });
            const wide = width > height;
            const regionLeft = wide ? width * 0.42 : Math.round(width * 0.06);
            const regionWidth = wide ? width * 0.52 : width - regionLeft * 2;
            const labelSize = Math.round(Math.min(width, height) * (wide ? 0.02 : 0.025));
            const cellWidth = Math.floor(regionWidth / 3);
            const padding = Math.round(labelSize * 0.4);
            const renderedLabels = await Promise.all(
              labels.map((label) =>
                renderShowcaseText(label, labelSize, cellWidth - padding * 2, '#FFFFFF', { bold: true }),
              ),
            );
            const footerHeight = Math.max(...renderedLabels.map((label) => label.info.height));
            const footerTop = Math.floor(height * 0.94 - footerHeight);
            // The footer contains the three exact names in source order, and no
            // native panel pixels. Native captures stay entirely above this band.
            for (const [index, label] of renderedLabels.entries()) {
              const left = Math.round(regionLeft + (index + 0.5) * cellWidth - label.info.width / 2);
              const footer = await sharp(framed)
                .extract({ left, top: footerTop, width: label.info.width, height: label.info.height })
                .raw()
                .toBuffer();
              const mask = await sharp(label.data).ensureAlpha().raw().toBuffer();
              let opaqueInk = 0;
              for (let pixel = 0; pixel < mask.length / 4; pixel++) {
                if (mask[pixel * 4 + 3] !== 255) continue;
                opaqueInk++;
                expect(footer[pixel * 3]).toBeGreaterThan(180);
                expect(footer[pixel * 3 + 1]).toBeGreaterThan(180);
                expect(footer[pixel * 3 + 2]).toBeGreaterThan(180);
              }
              expect(opaqueInk).toBeGreaterThan(0);
            }
            const footerPixels = await sharp(framed)
              .extract({
                left: Math.round(regionLeft),
                top: footerTop,
                width: Math.floor(regionWidth),
                height: footerHeight,
              })
              .raw()
              .toBuffer();
            let nativePixels = 0;
            for (let pixel = 0; pixel < footerPixels.length; pixel += 3) {
              if (footerPixels[pixel] === 22 && footerPixels[pixel + 1] === 76 && footerPixels[pixel + 2] === 57)
                nativePixels++;
            }
            expect(nativePixels).toBe(0);
          }
        }
      }
    },
    120_000,
  );
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

  it('canonicalizes composite source names and field order without ignoring changed provenance', () => {
    const sources = {
      'a.png': { rawBytes: 70000, rawSha256: 'a'.repeat(64) },
      'z.png': { rawBytes: 80000, rawSha256: 'b'.repeat(64) },
    };
    const reordered = {
      'z.png': { rawSha256: sources['z.png'].rawSha256, rawBytes: sources['z.png'].rawBytes },
      'a.png': { rawSha256: sources['a.png'].rawSha256, rawBytes: sources['a.png'].rawBytes },
    };
    const expected = sha256Screenshot(Buffer.from(JSON.stringify(sources)));
    expect(sha256ScreenshotSources(sources)).toBe(expected);
    expect(sha256ScreenshotSources(reordered)).toBe(expected);
    reordered['z.png'].rawSha256 = 'c'.repeat(64);
    expect(sha256ScreenshotSources(reordered)).not.toBe(expected);
  });

  it('reads reordered canonical metadata and legacy insertion-order hashes while rejecting tampered sources', () => {
    const output = directory();
    const sources = {
      'z.png': { rawBytes: 80000, rawSha256: 'b'.repeat(64) },
      'a.png': { rawBytes: 70000, rawSha256: 'a'.repeat(64) },
    };
    const entry = {
      rawBytes: 70000,
      rawSha256: sha256ScreenshotSources(sources),
      framedSha256: 'f'.repeat(64),
      sources,
    };
    const writeManifest = () =>
      writeFileSync(
        join(output, PRESENTATION_MANIFEST),
        JSON.stringify({ version: 1, locale: 'en-US', files: { '00-composite.png': entry } }),
      );
    writeManifest();
    expect(readPresentationManifest(output).files['00-composite.png']).toEqual(entry);
    entry.sources = { 'a.png': sources['a.png'], 'z.png': sources['z.png'] };
    writeManifest();
    expect(readPresentationManifest(output).files['00-composite.png']).toEqual(entry);

    entry.sources = sources;
    entry.rawSha256 = sha256Screenshot(Buffer.from(JSON.stringify(sources)));
    expect(entry.rawSha256).not.toBe(sha256ScreenshotSources(sources));
    writeManifest();
    expect(readPresentationManifest(output).files['00-composite.png']).toEqual(entry);
    entry.sources['z.png'].rawSha256 = 'c'.repeat(64);
    writeManifest();
    expect(() => readPresentationManifest(output)).toThrow('Composite source metadata does not match');
  });

  it('requires every live capture and optionally adds the real MoonBoard capture', () => {
    const legacy = Object.keys(screenshotCaptions('android', 'pixel-2'));
    const live = [...legacy, '09-live-queue.png', '10-live-climb.png', '11-live-climb-peer.png'];
    const recipes = resolveScreenshotRecipes('android', 'pixel-2', live);
    expect(recipes.map((recipe) => recipe.output)).toEqual([
      '00-board-family.png',
      '01-live-queue.png',
      '02-live-climb.png',
      '03-climbs.png',
      '04-discover.png',
      '05-workout-generator.png',
      '06-profile.png',
      '07-board-sheet.png',
    ]);
    expect(recipes[0].sources).toEqual(['00-tension-board-view.png', '01-kilter-board-view.png']);
    expect(
      resolveScreenshotRecipes('android', 'pixel-2', [...live, '08-moonboard-board-view.png'])[0].sources,
    ).toContain('08-moonboard-board-view.png');
    expect(() => resolveScreenshotRecipes('android', 'pixel-2', live.slice(0, -1))).toThrow('Incomplete or unknown');
    expect(() => resolveScreenshotRecipes('android', 'pixel-2', [...live, 'invented.png'])).toThrow(
      'Incomplete or unknown',
    );
    expect(resolveScreenshotRecipes('android', 'pixel-2', legacy).every((recipe) => recipe.sources.length === 1)).toBe(
      true,
    );
  });

  it('selects the distinct wall-status scene without the former matching-session montage', () => {
    const names = [...Object.keys(screenshotCaptions('android', 'pixel-2')), '09-live-queue.png', '10-wall-status.png'];
    const recipes = resolveScreenshotRecipes('android', 'pixel-2', names);
    expect(recipes).toHaveLength(8);
    expect(recipes[2]).toEqual({
      output: '02-wall-status.png',
      caption: 'wallStatus',
      layout: 'wall-status',
      sources: ['10-wall-status.png'],
    });
    expect(
      resolveScreenshotRecipes('android', 'pixel-2', [...names, '08-moonboard-board-view.png'])[0].sources,
    ).toContain('08-moonboard-board-view.png');
    expect(() => resolveScreenshotRecipes('android', 'pixel-2', names.slice(0, -1))).toThrow('Incomplete or unknown');
    expect(() =>
      resolveScreenshotRecipes('android', 'pixel-2', [...names, '10-live-climb.png', '11-live-climb-peer.png']),
    ).toThrow('Incomplete or unknown');
  });

  it.each([false, true])(
    'frames the wall-status set, with MoonBoard=%s, and retires stale output',
    async (moonBoard) => {
      const input = directory();
      const output = directory();
      const capture = await sharp({ create: { width: 1080, height: 1920, channels: 3, background: '#164c39' } })
        .composite([{ input: randomBytes(256 * 128 * 3), raw: { width: 256, height: 128, channels: 3 } }])
        .png()
        .toBuffer();
      const names = [
        ...Object.keys(screenshotCaptions('android', 'pixel-2')),
        '09-live-queue.png',
        '10-wall-status.png',
      ];
      if (moonBoard) names.push('08-moonboard-board-view.png');
      for (const name of names) writeFileSync(join(input, name), capture);
      writeFileSync(join(output, '02-live-climb.png'), 'old composite');
      const saved = await frameDirectory({ platform: 'android', device: 'pixel-2', locale: 'en-US', input, output });
      expect(saved).toHaveLength(8);
      expect(saved[2]).toBe(join(output, '02-wall-status.png'));
      expect(existsSync(join(output, '02-live-climb.png'))).toBe(false);
      const framed = readFileSync(saved[2]);
      expect(readPngDimensions(framed)).toEqual({ width: 1080, height: 1920 });
      expect(readPresentationManifest(output).files['02-wall-status.png']).toEqual({
        rawBytes: capture.length,
        rawSha256: sha256Screenshot(capture),
        framedSha256: sha256Screenshot(framed),
      });
      expect(readFileSync(join(input, '10-wall-status.png'))).toEqual(capture);
    },
    60_000,
  );

  it('enlarges only the captured wall rail and preserves the complete local selection screen', async () => {
    const raw = await sharp(
      Buffer.from(`<svg width="1080" height="1920" xmlns="http://www.w3.org/2000/svg">
      <rect width="1080" height="1920" fill="#164c39"/>
      <rect y="270" width="1080" height="148" fill="#e69a32"/>
      <rect y="1525" width="1080" height="125" fill="#ac3478"/>
      <rect y="1856" width="1080" height="64" fill="#3269e6"/>
    </svg>`),
    )
      .png()
      .toBuffer();
    for (const locale of ['en-US', 'es', 'fr', 'de'] as const) {
      const framed = await frameComposition([raw], readCaptionCatalog(locale).wallStatus, 'wall-status');
      const column = await sharp(framed).extract({ left: 540, top: 0, width: 1, height: 1920 }).raw().toBuffer();
      const regions = (color: readonly number[]) => {
        const matches: Array<{ top: number; height: number }> = [];
        for (let row = 0; row < 1920; row++) {
          if (!color.every((channel, index) => column[row * 3 + index] === channel)) continue;
          const last = matches.at(-1);
          if (last && last.top + last.height === row) last.height += 1;
          else matches.push({ top: row, height: 1 });
        }
        return matches;
      };
      const wallRails = regions([230, 154, 50]);
      const selectedClimb = regions([172, 52, 120]);
      const screenFooter = regions([50, 105, 230]);
      expect(wallRails).toHaveLength(2);
      expect(wallRails[0].height).toBeGreaterThan(wallRails[1].height);
      expect(wallRails[0].top + wallRails[0].height).toBeLessThan(wallRails[1].top);
      expect(selectedClimb).toHaveLength(1);
      expect(screenFooter).toHaveLength(1);
      expect(selectedClimb[0].top).toBeGreaterThan(wallRails[1].top + wallRails[1].height);
      expect(screenFooter[0].top).toBeGreaterThan(selectedClimb[0].top + selectedClimb[0].height);
    }
  });

  it('requires all six hardware captures for the extended board campaign', () => {
    const names = [
      ...Object.keys(screenshotCaptions('android', 'pixel-2')),
      '08-moonboard-board-view.png',
      '09-live-queue.png',
      '10-wall-status.png',
      '11-woods-board-view.png',
      '12-grasshopper-board-view.png',
      '13-moonboard-2024-view.png',
    ];
    const recipes = resolveScreenshotRecipes('android', 'pixel-2', names);
    expect(resolveScreenshotRecipes('android', 'pixel-2', [...names].reverse())).toEqual(recipes);
    expect(() => resolveScreenshotRecipes('android', 'pixel-2', [...names, names[0]])).toThrow('Incomplete or unknown');
    expect(recipes.map(({ output }) => output)).toEqual([
      '00-board-family.png',
      '01-more-boards.png',
      '02-live-queue.png',
      '03-wall-status.png',
      '04-climbs.png',
      '05-discover.png',
      '06-workout-generator.png',
      '07-profile.png',
    ]);
    expect(recipes[1]).toEqual({
      output: '01-more-boards.png',
      caption: 'moreBoards',
      layout: 'more-boards',
      sources: ['11-woods-board-view.png', '12-grasshopper-board-view.png', '13-moonboard-2024-view.png'],
    });
    for (const missing of ['08-moonboard-board-view.png', ...recipes[1].sources]) {
      expect(() =>
        resolveScreenshotRecipes(
          'android',
          'pixel-2',
          names.filter((name) => name !== missing),
        ),
      ).toThrow('Incomplete or unknown');
    }
    expect(() => resolveScreenshotRecipes('android', 'pixel-2', [...names, '11-live-climb-peer.png'])).toThrow(
      'Incomplete or unknown',
    );
  });

  it('requires both history sources and puts the board overview in the foreground', () => {
    const names = [
      ...Object.keys(screenshotCaptions('android', 'pixel-2')),
      '08-moonboard-board-view.png',
      '09-live-queue.png',
      '10-wall-status.png',
      '11-woods-board-view.png',
      '12-grasshopper-board-view.png',
      '13-moonboard-2024-view.png',
      '14-logbook.png',
      '15-session-detail.png',
    ];
    const recipes = resolveScreenshotRecipes('android', 'pixel-2', names);
    expect(recipes).toHaveLength(8);
    expect(recipes.at(-1)).toEqual({
      output: '07-profile.png',
      caption: 'crossBoardLogbook',
      layout: 'cross-board-logbook',
      sources: ['14-logbook.png', '06-profile.png', '15-session-detail.png'],
    });
    for (const missing of ['14-logbook.png', '15-session-detail.png']) {
      expect(() =>
        resolveScreenshotRecipes(
          'android',
          'pixel-2',
          names.filter((name) => name !== missing),
        ),
      ).toThrow('Incomplete or unknown');
    }
    expect(() => resolveScreenshotRecipes('android', 'pixel-2', [...names, '14-logbook.png'])).toThrow(
      'Incomplete or unknown',
    );
  });

  it.each([false, true])(
    'composes the extended campaign with all-board history=%s and source provenance',
    async (history) => {
      const input = directory();
      const output = directory();
      const names = [
        ...Object.keys(screenshotCaptions('android', 'pixel-2')),
        '08-moonboard-board-view.png',
        '09-live-queue.png',
        '10-wall-status.png',
        '11-woods-board-view.png',
        '12-grasshopper-board-view.png',
        '13-moonboard-2024-view.png',
      ];
      if (history) names.push('14-logbook.png', '15-session-detail.png');
      const captures = new Map<string, Buffer>();
      for (const [index, name] of names.entries()) {
        const capture = await sharp({
          create: { width: 1080, height: 1920, channels: 3, background: `rgb(${index * 16},70,90)` },
        })
          .composite([{ input: randomBytes(256 * 128 * 3), raw: { width: 256, height: 128, channels: 3 } }])
          .png()
          .toBuffer();
        captures.set(name, capture);
        writeFileSync(join(input, name), capture);
      }
      const oldNames = ['01-live-queue.png', '02-wall-status.png', '07-board-sheet.png'];
      for (const name of oldNames) writeFileSync(join(output, name), 'previous campaign');
      const recipes = resolveScreenshotRecipes('android', 'pixel-2', names);
      const saved = await frameDirectory({ platform: 'android', device: 'pixel-2', locale: 'en-US', input, output });
      expect(saved).toEqual(recipes.map(({ output: name }) => join(output, name)));
      const manifest = readPresentationManifest(output);
      expect(Object.keys(manifest.files)).toEqual(recipes.map(({ output: name }) => name));
      for (const recipe of recipes) {
        const entry = manifest.files[recipe.output];
        if (recipe.sources.length > 1) {
          expect(entry.sources).toEqual(
            Object.fromEntries(
              recipe.sources.map((name) => [
                name,
                { rawBytes: captures.get(name)!.length, rawSha256: sha256Screenshot(captures.get(name)!) },
              ]),
            ),
          );
          expect(entry.rawSha256).toBe(sha256ScreenshotSources(entry.sources!));
        } else {
          expect(entry.sources).toBeUndefined();
          expect(entry.rawSha256).toBe(sha256Screenshot(captures.get(recipe.sources[0])!));
        }
      }
      for (const name of oldNames) expect(existsSync(join(output, name))).toBe(false);
      for (const [name, bytes] of captures) expect(readFileSync(join(input, name))).toEqual(bytes);
      expect(
        findContentOffenders(readPngSizesRecursively(output), new Map(), { minBytes: 61440, minRatio: 0.4 }),
      ).toEqual([]);
      const originalFramed = readFileSync(saved[1]);
      writeFileSync(join(input, '13-moonboard-2024-view.png'), Buffer.alloc(60));
      await expect(
        frameDirectory({ platform: 'android', device: 'pixel-2', locale: 'en-US', input, output }),
      ).rejects.toThrow();
      expect(readFileSync(saved[1])).toEqual(originalFramed);
    },
    60_000,
  );

  it('preserves all three additional board sources in each localized composition', async () => {
    const colors = ['#164c39', '#ac3478', '#e69a32'];
    const captures = await Promise.all(
      colors.map((background) =>
        sharp({ create: { width: 1080, height: 1920, channels: 3, background } })
          .png()
          .toBuffer(),
      ),
    );
    for (const locale of ['en-US', 'es', 'fr', 'de'] as const) {
      const caption = readCaptionCatalog(locale).moreBoards;
      const framed = await frameComposition(captures, caption, 'more-boards');
      for (const [left, top, expected] of [
        [100, 700, [22, 76, 57]],
        [540, 1300, [172, 52, 120]],
        [950, 700, [230, 154, 50]],
      ] as const) {
        const pixel = await sharp(framed).extract({ left, top, width: 1, height: 1 }).raw().toBuffer();
        expect([...pixel]).toEqual(expected);
      }
      await expect(frameComposition(captures.slice(0, 2), caption, 'more-boards')).rejects.toThrow('source count');
    }
  });

  it('composes eight store images from twelve verified native captures', async () => {
    const input = directory();
    const output = directory();
    const names = [
      ...Object.keys(screenshotCaptions('android', 'pixel-2')),
      '08-moonboard-board-view.png',
      '09-live-queue.png',
      '10-live-climb.png',
      '11-live-climb-peer.png',
    ];
    const captures = new Map<string, Buffer>();
    for (const [index, name] of names.entries()) {
      const capture = await sharp({
        create: { width: 1080, height: 1920, channels: 3, background: `rgb(${index * 20},70,90)` },
      })
        .composite([{ input: randomBytes(256 * 128 * 3), raw: { width: 256, height: 128, channels: 3 } }])
        .png()
        .toBuffer();
      captures.set(name, capture);
      writeFileSync(join(input, name), capture);
    }
    const saved = await frameDirectory({ platform: 'android', device: 'pixel-2', locale: 'en-US', input, output });
    expect(saved).toHaveLength(8);
    const manifest = readPresentationManifest(output);
    const composite = manifest.files['00-board-family.png'];
    expect(Object.keys(composite.sources!)).toEqual([
      '00-tension-board-view.png',
      '01-kilter-board-view.png',
      '08-moonboard-board-view.png',
    ]);
    for (const [sourceName, provenance] of Object.entries(composite.sources!)) {
      expect(provenance).toEqual({
        rawBytes: captures.get(sourceName)!.length,
        rawSha256: sha256Screenshot(captures.get(sourceName)!),
      });
    }
    expect(composite.rawBytes).toBe(Math.min(...Object.values(composite.sources!).map((source) => source.rawBytes)));
    expect(
      findContentOffenders(readPngSizesRecursively(output), new Map(), { minBytes: 61440, minRatio: 0.4 }),
    ).toEqual([]);
    expect(readFileSync(join(input, '08-moonboard-board-view.png'))).toEqual(
      captures.get('08-moonboard-board-view.png'),
    );

    // Decorative peers must never hide a blank native source, or replace the previous valid output.
    const originalFramed = readFileSync(saved[0]);
    writeFileSync(
      join(input, '11-live-climb-peer.png'),
      await sharp({
        create: { width: 1080, height: 1920, channels: 3, background: '#111111' },
      })
        .png()
        .toBuffer(),
    );
    await expect(
      frameDirectory({ platform: 'android', device: 'pixel-2', locale: 'en-US', input, output }),
    ).rejects.toThrow('likely blank');
    expect(readFileSync(saved[0])).toEqual(originalFramed);

    composite.rawBytes += 1;
    writeFileSync(join(output, PRESENTATION_MANIFEST), JSON.stringify(manifest));
    expect(() => readPresentationManifest(output)).toThrow('Composite source metadata does not match');
  }, 60_000);

  it('keeps pixels from both real session views and rejects missing peers', async () => {
    const primary = await sharp({ create: { width: 1080, height: 1920, channels: 3, background: '#164c39' } })
      .png()
      .toBuffer();
    const peer = await sharp(
      Buffer.from(`<svg width="1080" height="1920" xmlns="http://www.w3.org/2000/svg">
      <rect width="1080" height="1920" fill="#111111"/>
      <rect y="120" width="1080" height="280" fill="#ac3478"/>
      <rect y="1520" width="1080" height="140" fill="#e69a32"/>
    </svg>`),
    )
      .png()
      .toBuffer();
    const sources = [primary, peer];
    const caption = readCaptionCatalog('en-US').liveClimb;
    const framed = await frameComposition(sources, caption, 'live-climb');
    for (const [left, top, expected] of [
      [540, 1100, [22, 76, 57]],
      [150, 550, [172, 52, 120]],
      [800, 1760, [230, 154, 50]],
    ] as const) {
      const pixel = await sharp(framed).extract({ left, top, width: 1, height: 1 }).raw().toBuffer();
      expect([...pixel]).toEqual(expected);
    }
    await expect(frameComposition(sources.slice(0, 1), caption, 'live-climb')).rejects.toThrow('source count');
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
      await frameComposition([raw], readCaptionCatalog('es')[screenshotCaptions('ios', device)[first]], 'screen', true),
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

  it('resolves the iPad campaign from the six shell captures', () => {
    const names = Object.keys(screenshotCaptions('ios', 'ipad-pro-13-inch-m5'));
    const recipes = resolveScreenshotRecipes('ios', 'ipad-pro-13-inch-m5', names);
    expect(resolveScreenshotRecipes('ios', 'ipad-pro-11-inch-m5', names)).toEqual(recipes);
    expect(resolveScreenshotRecipes('ios', 'ipad-pro-13-inch-m5', [...names].reverse())).toEqual(recipes);
    expect(recipes[0].caption).toBe('storeBoards');
    expect(readCaptionCatalog('en-US')[recipes[0].caption].headline).toBe('One app for all your boards');
    expect(recipes.map(({ output }) => output)).toEqual([
      '00-wall-kiosk.png',
      '01-wall-status.png',
      '02-home.png',
      '03-discover.png',
      '04-workout-generator.png',
      '05-profile.png',
    ]);
    // The browse capture carries the wall column; nothing else stands in for it,
    // and it is the only capture that feeds two frames.
    expect(recipes[1]).toEqual({
      output: '01-wall-status.png',
      caption: 'wallStatus',
      layout: 'wall-column',
      sources: ['02-climbs.png'],
    });
    expect(recipes.filter((recipe) => recipe.sources.includes('02-climbs.png'))).toHaveLength(1);
    for (const missing of names) {
      expect(() =>
        resolveScreenshotRecipes(
          'ios',
          'ipad-pro-13-inch-m5',
          names.filter((name) => name !== missing),
        ),
      ).toThrow('Incomplete or unknown');
    }
    expect(() => resolveScreenshotRecipes('ios', 'ipad-pro-13-inch-m5', [...names, names[0]])).toThrow(
      'Incomplete or unknown',
    );
  });

  it('leaves the iPhone and Android recipes untouched by the iPad campaign', () => {
    const phone = Object.keys(screenshotCaptions('ios', 'iphone-16-pro-max'));
    const recipes = resolveScreenshotRecipes('ios', 'iphone-16-pro-max', phone);
    expect(recipes).toHaveLength(phone.length);
    for (const recipe of recipes) {
      expect(recipe.layout).toBe('screen');
      expect(recipe.sources).toEqual([recipe.output]);
    }
    // The iPad capture set is not a phone capture set, on either platform.
    const ipad = Object.keys(screenshotCaptions('ios', 'ipad-pro-13-inch-m5'));
    expect(() => resolveScreenshotRecipes('ios', 'iphone-16-pro-max', ipad)).toThrow('Incomplete or unknown');
    expect(() => resolveScreenshotRecipes('android', 'pixel-2', ipad)).toThrow('Incomplete or unknown');
  });

  it('puts the iPad copy beside the capture rather than in a band above it', async () => {
    const raw = await sharp(
      Buffer.from(
        `<svg width="2752" height="2064" xmlns="http://www.w3.org/2000/svg"><rect width="2752" height="2064" fill="#164c39"/></svg>`,
      ),
    )
      .png()
      .toBuffer();
    const framed = await frameComposition([raw], readCaptionCatalog('en-US').wallKiosk, 'screen', true);
    expect(readPngDimensions(framed)).toEqual({ width: 2752, height: 2064 });
    const { data } = await sharp(framed).raw().toBuffer({ resolveWithObject: true });
    const capture = (x: number, y: number) => {
      const at = (y * 2752 + x) * 3;
      return data[at] === 22 && data[at + 1] === 76 && data[at + 2] === 57;
    };
    // The capture occupies the right of the canvas and never the copy column.
    expect(capture(2000, 1032)).toBe(true);
    for (let y = 0; y < 2064; y += 16) expect(capture(400, y)).toBe(false);
    // Copy ink sits in the left column, vertically around the middle.
    const columnInk = (() => {
      for (let y = 0; y < 2064; y += 4) {
        for (let x = 100; x < 900; x += 4) {
          const at = (y * 2752 + x) * 3;
          if (data[at] > 120 && data[at + 1] > 120 && data[at + 2] > 120) return { x, y };
        }
      }
      return null;
    })();
    expect(columnInk).not.toBeNull();
    expect(columnInk!.y).toBeGreaterThan(2064 * 0.2);
  });

  it('lifts the trailing wall column out of the iPad capture and enlarges it', async () => {
    // 600px of the capture width is the shell's 300pt wall column at @2x.
    const raw = await sharp(
      Buffer.from(`<svg width="2752" height="2064" xmlns="http://www.w3.org/2000/svg">
      <rect width="2752" height="2064" fill="#164c39"/>
      <rect x="2152" width="600" height="2064" fill="#ac3478"/>
      <rect x="2152" y="80" width="600" height="160" fill="#e69a32"/>
    </svg>`),
    )
      .png()
      .toBuffer();
    for (const locale of ['en-US', 'es', 'fr', 'de'] as const) {
      const framed = await frameComposition([raw], readCaptionCatalog(locale).wallStatus, 'wall-column', true);
      const { data } = await sharp(framed).raw().toBuffer({ resolveWithObject: true });
      // Widest horizontal run of the "on the wall" band, per side of the canvas.
      let widest = 0;
      let widestStart = 0;
      let narrowest = Number.POSITIVE_INFINITY;
      let narrowestStart = 0;
      for (let y = 0; y < 2064; y += 2) {
        let run = 0;
        for (let x = 0; x <= 2752; x++) {
          const at = (y * 2752 + x) * 3;
          const hit = x < 2752 && data[at] === 230 && data[at + 1] === 154 && data[at + 2] === 50;
          if (hit) {
            run += 1;
            continue;
          }
          if (run > widest) {
            widest = run;
            widestStart = x - run;
          }
          if (run > 0 && run < narrowest) {
            narrowest = run;
            narrowestStart = x - run;
          }
          run = 0;
        }
      }
      // The enlarged column reads clearly bigger than the same pixels in context,
      // and sits to the trailing side of them.
      expect(narrowest).toBeGreaterThan(0);
      expect(widest).toBeGreaterThan(narrowest * 1.4);
      expect(widestStart).toBeGreaterThan(narrowestStart);
    }
  }, 120_000);

  // The sweep above already frames every caption, in every locale, at the FIRST
  // accepted size of each device — which for iPad is 2752x2064 and 2266x1488. What
  // it does not cover is the other four sizes App Store Connect accepts, and those
  // have narrower copy columns relative to their type size. Sweep the longest
  // headline of each locale across them; German's "Live-Warteschlange." is the
  // string that actually breaks, and it breaks at a 0.07 headline scale.
  it('fits the longest iPad headline in every remaining accepted size', async () => {
    const campaign = ['wallKiosk', 'boardFamily', 'wallStatus', 'home', 'discover', 'workout', 'profile'] as const;
    const covered = new Set(
      Object.values(ACCEPTED_SIZES)
        .map((sizes) => `${sizes[0].width}x${sizes[0].height}`)
        .values(),
    );
    const remaining = [...ACCEPTED_SIZES['ipad-pro-13-inch-m5'], ...ACCEPTED_SIZES['ipad-pro-11-inch-m5']].filter(
      (size) => !covered.has(`${size.width}x${size.height}`),
    );
    expect(remaining.length).toBeGreaterThan(0);
    for (const size of remaining) {
      const raw = await sharp({ create: { ...size, channels: 3, background: '#164c39' } })
        .png()
        .toBuffer();
      for (const locale of ['en-US', 'es', 'fr', 'de'] as const) {
        const catalog = readCaptionCatalog(locale);
        const longest = campaign
          .map((id) => catalog[id])
          .reduce((worst, caption) => (caption.headline.length > worst.headline.length ? caption : worst));
        const framed = await frameComposition([raw], longest, 'screen', true);
        expect(readPngDimensions(framed)).toEqual(size);
      }
    }
  }, 120_000);
});
