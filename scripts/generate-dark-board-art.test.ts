/// <reference types="node" />

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

/**
 * Golden guard for scripts/generate-dark-board-art.ts.
 *
 * The committed `.dark.webp` files are what actually ship — the generator only
 * has to be re-run when the source art changes. These assertions pin the
 * *rendered result*, so a sharp upgrade, an encoder default change, or an
 * accidental edit to the remap ranges fails here rather than silently shifting
 * MoonBoard's dark-mode tone (issue #3885).
 *
 * The numbers below are the contrast targets the fix was designed against, using
 * the dark play field `#181225` (systemColors.secondaryBackground in dark mode).
 */

const IMAGES_DIR = path.resolve(import.meta.dirname, '../packages/web/public/images');
const DARK_FIELD = '#181225';

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

/** Mean relative luminance of the pixels that are actually painted (alpha > 40). */
async function meanVisibleLuminance(relativePath: string): Promise<number> {
  const { data, info } = await sharp(path.join(IMAGES_DIR, relativePath))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let total = 0;
  let count = 0;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    if (data[offset + 3] <= 40) continue;
    total += relativeLuminance(data[offset], data[offset + 1], data[offset + 2]);
    count += 1;
  }
  return count === 0 ? 0 : total / count;
}

const FIELD_LUMINANCE = hexLuminance(DARK_FIELD);

const FRAME_SOURCES = ['moonboard/moonboard-bg.webp', 'moonboard/minimoonboard-bg.webp'];
const BLACK_HOLD_SOURCES = [
  'moonboard/moonboard2016/holdsetb.webp',
  'moonboard/moonboardmasters2017/holdsetb.webp',
  'moonboard/moonboardmasters2019/holdsetb.webp',
];
const darkVariant = (relativePath: string) => relativePath.replace(/\.webp$/, '.dark.webp');

describe('dark board-art variants are committed', () => {
  for (const source of [...FRAME_SOURCES, ...BLACK_HOLD_SOURCES]) {
    it(`${darkVariant(source)} exists`, () => {
      expect(existsSync(path.join(IMAGES_DIR, darkVariant(source)))).toBe(true);
    });
  }
});

describe('frame + label art clears AA against the dark play field', () => {
  for (const source of FRAME_SOURCES) {
    it(`${source} is unreadable before and clears 4.5:1 after`, async () => {
      // The A-K / 1-18 labels are text-equivalent: beta is spoken as
      // "F5 start, K13 finish", so they get the body-text ratio, not the
      // large-text allowance.
      const before = await meanVisibleLuminance(source);
      const after = await meanVisibleLuminance(darkVariant(source));

      expect(contrastRatio(before, FIELD_LUMINANCE)).toBeLessThan(1.3);
      expect(contrastRatio(after, FIELD_LUMINANCE)).toBeGreaterThan(4.5);
    });
  }
});

describe('black hold art clears the non-text ratio without losing its identity', () => {
  it('pale set A is left alone — it already reads', async () => {
    const setA = await meanVisibleLuminance('moonboard/moonboard2016/holdseta.webp');
    expect(contrastRatio(setA, FIELD_LUMINANCE)).toBeGreaterThan(3);
    expect(existsSync(path.join(IMAGES_DIR, 'moonboard/moonboard2016/holdseta.dark.webp'))).toBe(false);
  });

  for (const source of BLACK_HOLD_SOURCES) {
    it(`${source} clears 3:1 after`, async () => {
      const before = await meanVisibleLuminance(source);
      const after = await meanVisibleLuminance(darkVariant(source));

      expect(contrastRatio(before, FIELD_LUMINANCE)).toBeLessThan(1.5);
      expect(contrastRatio(after, FIELD_LUMINANCE)).toBeGreaterThan(3);
    });
  }

  it('stays visibly darker than the pale set it sits beside', async () => {
    // A single shared lift would flatten set B onto set A and destroy the
    // black-vs-pale distinction — a real MoonBoard product fact, and the only
    // one that survives colour-vision deficiency.
    const setA = await meanVisibleLuminance('moonboard/moonboard2016/holdseta.webp');
    const setBDark = await meanVisibleLuminance(darkVariant('moonboard/moonboard2016/holdsetb.webp'));

    expect(setBDark).toBeLessThan(setA);
    expect(contrastRatio(setA, setBDark)).toBeGreaterThan(2);
  });

  it('preserves internal shading rather than flattening to one tone', async () => {
    // The whole reason we ship variant assets instead of expo-image tintColor:
    // SRC_IN would replace every pixel with a single colour and the holds would
    // read as flat stickers. A healthy spread of distinct luminance values is
    // the machine-checkable version of "it still looks moulded".
    const { data, info } = await sharp(path.join(IMAGES_DIR, darkVariant('moonboard/moonboard2016/holdsetb.webp')))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const distinct = new Set<number>();
    for (let offset = 0; offset < data.length; offset += info.channels) {
      if (data[offset + 3] <= 40) continue;
      distinct.add(data[offset]);
    }
    expect(distinct.size).toBeGreaterThan(32);
  });
});
