/// <reference types="node" />

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { REFERENCE_CARD, REFERENCE_PLAY_FIELD } from './generate-dark-board-art';

/**
 * Golden guard for scripts/generate-dark-board-art.ts.
 *
 * The committed `.dark.webp` files are what actually ship — the generator only has to be
 * re-run when the source art changes. These assertions pin the *rendered result*, so a
 * sharp upgrade, an encoder default change, or an accidental edit to the transform values
 * fails here rather than silently shifting MoonBoard's dark-mode tone (issue #3885).
 *
 * Reference backgrounds are sampled from real device screenshots: `#221A33` is the
 * elevated card the board preview and list thumbnails sit on, `#140E1E` is the play-view
 * field. The card is the brighter of the two and therefore the worst case for art we are
 * lifting up, so it is what the bounds below are stated against.
 */

const IMAGES_DIR = path.resolve(import.meta.dirname, '../packages/web/public/images');

function channelToLinear(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(red: number, green: number, blue: number): number {
  return 0.2126 * channelToLinear(red) + 0.7152 * channelToLinear(green) + 0.0722 * channelToLinear(blue);
}

function hexLuminance(hex: string): number {
  const value = hex.replace('#', '');
  return relativeLuminance(
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  );
}

function contrastRatio(a: number, b: number): number {
  const [high, low] = a > b ? [a, b] : [b, a];
  return (high + 0.05) / (low + 0.05);
}

type Body = { medianLuminance: number; redInterQuartileRange: number };

/**
 * Statistics over the SOLID body of the art (alpha > 200), deliberately excluding
 * antialiased edges: edge pixels are half-transparent, so including them reports a
 * luminance the eye never actually sees on a filled shape.
 */
async function measureBody(relativePath: string): Promise<Body> {
  const { data, info } = await sharp(path.join(IMAGES_DIR, relativePath))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const luminances: number[] = [];
  const reds: number[] = [];
  for (let offset = 0; offset < data.length; offset += info.channels) {
    if (data[offset + 3] <= 200) continue;
    luminances.push(relativeLuminance(data[offset], data[offset + 1], data[offset + 2]));
    reds.push(data[offset]);
  }
  luminances.sort((a, b) => a - b);
  reds.sort((a, b) => a - b);
  const at = (sorted: number[], quantile: number) => sorted[Math.floor(sorted.length * quantile)];
  return {
    medianLuminance: at(luminances, 0.5),
    redInterQuartileRange: at(reds, 0.75) - at(reds, 0.25),
  };
}

const CARD = hexLuminance(REFERENCE_CARD);
const PLAY_FIELD = hexLuminance(REFERENCE_PLAY_FIELD);

const LABEL_SOURCES = ['moonboard/moonboard-bg.webp', 'moonboard/minimoonboard-bg.webp'];
const BLACK_HOLD_SOURCES = [
  'moonboard/moonboard2016/holdsetb.webp',
  'moonboard/moonboardmasters2017/holdsetb.webp',
  'moonboard/moonboardmasters2019/holdsetb.webp',
];
const darkVariant = (relativePath: string) => relativePath.replace(/\.webp$/, '.dark.webp');

describe('dark board-art variants are committed', () => {
  for (const source of [...LABEL_SOURCES, ...BLACK_HOLD_SOURCES]) {
    it(`${darkVariant(source)} exists`, () => {
      expect(existsSync(path.join(IMAGES_DIR, darkVariant(source)))).toBe(true);
    });
  }
});

describe('coordinate labels clear AA against both surfaces', () => {
  for (const source of LABEL_SOURCES) {
    it(`${source} goes from invisible to comfortably readable`, async () => {
      const before = await measureBody(source);
      const after = await measureBody(darkVariant(source));

      expect(contrastRatio(before.medianLuminance, CARD)).toBeLessThan(1.3);
      // Beta is spoken as "F5 start, K13 finish", so these are text-equivalent. Authored
      // well past the 4.5:1 AA bar because 1-2px glyph stems lose some of it to
      // antialiasing once rendered.
      expect(contrastRatio(after.medianLuminance, CARD)).toBeGreaterThan(6.5);
      expect(contrastRatio(after.medianLuminance, PLAY_FIELD)).toBeGreaterThan(6.5);
    });
  }

  it('is a flat tint, because the source carries exactly one colour value', async () => {
    // Not laziness: moonboard-bg.webp is 0.39% opaque, every visible pixel #000000, with
    // no run longer than a glyph — it is lettering, not a grid, and all of its softness
    // lives in the alpha channel. A floor/ceiling range here would be dead config.
    const { data, info } = await sharp(path.join(IMAGES_DIR, 'moonboard/moonboard-bg.webp'))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const distinct = new Set<number>();
    for (let offset = 0; offset < data.length; offset += info.channels) {
      if (data[offset + 3] <= 200) continue;
      distinct.add(data[offset]);
    }
    expect(distinct).toEqual(new Set([0]));
  });
});

describe('black hold sheets sit at the achievable contrast optimum', () => {
  it('pale set A is left alone — it already reads', async () => {
    const setA = await measureBody('moonboard/moonboard2016/holdseta.webp');
    expect(contrastRatio(setA.medianLuminance, CARD)).toBeGreaterThan(3);
    expect(existsSync(path.join(IMAGES_DIR, 'moonboard/moonboard2016/holdseta.dark.webp'))).toBe(false);
  });

  for (const source of BLACK_HOLD_SOURCES) {
    it(`${source} roughly doubles against the card while staying darker than pale set A`, async () => {
      const setA = await measureBody('moonboard/moonboard2016/holdseta.webp');
      const before = await measureBody(source);
      const after = await measureBody(darkVariant(source));

      expect(contrastRatio(before.medianLuminance, CARD)).toBeLessThan(1.3);

      // Deliberately NOT 3:1. Both hold families share one background, so
      // min(hold-vs-card, hold-vs-paleA) is capped at 2.49:1 by arithmetic — chasing
      // WCAG 1.4.11's 3:1 would push these to within 2.0:1 of the pale sheets and start
      // dissolving the black-vs-pale distinction, which is the only cue that survives
      // colour-vision deficiency. These bounds bracket that optimum from both sides.
      expect(contrastRatio(after.medianLuminance, CARD)).toBeGreaterThan(2.4);
      expect(contrastRatio(after.medianLuminance, PLAY_FIELD)).toBeGreaterThan(2.75);
      expect(contrastRatio(setA.medianLuminance, after.medianLuminance)).toBeGreaterThan(2.3);
    });

    it(`${source} ends up with MORE modelling than the source, not less`, async () => {
      // The failure mode that ruled out expo-image tintColor was holds reading as flat
      // stickers. A plain linear remap of this art does the same thing by accident: its
      // detail is crushed against black (body IQR 16/255), so mapping 0-255 onto a
      // narrow band compresses it further. The gamma < 1 expands the dark end instead.
      // Compare IQR directly against the source — an absolute floor would let a
      // compressing curve pass.
      const before = await measureBody(source);
      const after = await measureBody(darkVariant(source));

      expect(after.redInterQuartileRange).toBeGreaterThan(before.redInterQuartileRange * 1.5);
      expect(after.redInterQuartileRange).toBeGreaterThan(25);
    });
  }
});
