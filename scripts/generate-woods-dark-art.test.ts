/// <reference types="node" />

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

/**
 * Golden guard for scripts/generate-woods-dark-art.ts.
 *
 * The committed `.dark.webp` files are what actually ship — the generator only has to be
 * re-run when the source art changes. These assertions pin the *rendered result*, so a sharp
 * upgrade, an encoder default change, or an accidental edit to the keying threshold, the
 * erode, or the dim fails here rather than silently shipping a glaring or a shredded board.
 *
 * Reference backgrounds match scripts/generate-dark-board-art.test.ts, sampled from real
 * device screenshots: `#221A33` is the elevated card the board preview and list thumbnails
 * sit on, `#140E1E` is the play-view field. They are inlined rather than imported because
 * that module runs its generator on load.
 */

const IMAGES_DIR = path.resolve(import.meta.dirname, '../packages/web/public/images');

const REFERENCE_CARD = '#221A33';
const REFERENCE_PLAY_FIELD = '#140E1E';

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

type Body = {
  width: number;
  height: number;
  /** Share of the whole image that survives as solid art, 0-1. */
  opaqueFraction: number;
  medianLuminance: number;
  redInterQuartileRange: number;
  /** Share of the solid body that is still near-white, 0-1 — i.e. leftover board ground. */
  nearWhiteFraction: number;
};

/**
 * Statistics over the SOLID body of the art (alpha > 200), deliberately excluding
 * antialiased edges: after the downscale a thumbnail's edges are half-transparent, so
 * including them reports a luminance the eye never actually sees on a filled shape.
 */
async function measureBody(relativePath: string): Promise<Body> {
  const { data, info } = await sharp(path.join(IMAGES_DIR, relativePath))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const luminances: number[] = [];
  const reds: number[] = [];
  let nearWhite = 0;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    if (data[offset + 3] <= 200) continue;
    luminances.push(relativeLuminance(data[offset], data[offset + 1], data[offset + 2]));
    reds.push(data[offset]);
    if (data[offset] >= 245 && data[offset + 1] >= 245 && data[offset + 2] >= 245) nearWhite++;
  }
  luminances.sort((a, b) => a - b);
  reds.sort((a, b) => a - b);
  const at = (sorted: number[], quantile: number) => sorted[Math.floor(sorted.length * quantile)];
  return {
    width: info.width,
    height: info.height,
    opaqueFraction: luminances.length / (info.width * info.height),
    medianLuminance: at(luminances, 0.5),
    redInterQuartileRange: at(reds, 0.75) - at(reds, 0.25),
    nearWhiteFraction: nearWhite / luminances.length,
  };
}

const CARD = hexLuminance(REFERENCE_CARD);
const PLAY_FIELD = hexLuminance(REFERENCE_PLAY_FIELD);

const SIZES = [
  { source: 'woods/woods-8x10-bg.webp', thumbWidth: 416, thumbHeight: 578 },
  { source: 'woods/woods-12x12-bg.webp', thumbWidth: 416, thumbHeight: 475 },
] as const;

const darkVariant = (relativePath: string) => relativePath.replace(/\.webp$/, '.dark.webp');
const thumbVariant = (relativePath: string) => relativePath.replace(/\/([^/]+)$/, '/thumbs/$1');

describe('Woods dark art is committed', () => {
  for (const { source } of SIZES) {
    for (const relativePath of [darkVariant(source), darkVariant(thumbVariant(source))]) {
      it(`${relativePath} exists`, () => {
        expect(existsSync(path.join(IMAGES_DIR, relativePath))).toBe(true);
      });
    }
  }

  for (const { source, thumbWidth, thumbHeight } of SIZES) {
    it(`${darkVariant(thumbVariant(source))} matches the light thumb's dimensions`, async () => {
      const thumb = await measureBody(darkVariant(thumbVariant(source)));
      expect([thumb.width, thumb.height]).toEqual([thumbWidth, thumbHeight]);
    });
  }
});

describe('the white board ground is gone', () => {
  for (const { source } of SIZES) {
    it(`${source} starts as a solid white-ground sheet`, async () => {
      const light = await measureBody(source);

      // The whole problem: opaque everywhere, and the median pixel is the ground itself,
      // which is why dark mode renders a lit rectangle.
      expect(light.opaqueFraction).toBe(1);
      expect(light.nearWhiteFraction).toBeGreaterThan(0.6);
      expect(contrastRatio(light.medianLuminance, CARD)).toBeGreaterThan(15);
    });

    for (const relativePath of [darkVariant(source), darkVariant(thumbVariant(source))]) {
      it(`${relativePath} keeps the holds and drops everything else`, async () => {
        const dark = await measureBody(relativePath);

        // Not one pixel of ground survives the flood fill and the 1px erode. A leftover
        // rim is the halo failure mode: every hold outlined in white on a dark surface.
        expect(dark.nearWhiteFraction).toBe(0);

        // The holds themselves are still there. A flood fill that leaked into hold bodies
        // collapses this; one that never started leaves it near 1.
        expect(dark.opaqueFraction).toBeGreaterThan(0.2);
        expect(dark.opaqueFraction).toBeLessThan(0.35);
      });
    }
  }
});

describe('the holds read on both dark surfaces without glaring', () => {
  for (const { source } of SIZES) {
    for (const relativePath of [darkVariant(source), darkVariant(thumbVariant(source))]) {
      it(`${relativePath} lands between washed out and glaring`, async () => {
        const dark = await measureBody(relativePath);

        // Lower bound: the holds have to separate from the card they sit on. Upper bound is
        // the point of the dim — the source is 16.6:1 against that same card, which is what
        // reads as a lit rectangle. Both bounds bracket 82% brightness / 90% saturation.
        expect(contrastRatio(dark.medianLuminance, CARD)).toBeGreaterThan(2);
        expect(contrastRatio(dark.medianLuminance, CARD)).toBeLessThan(4);
        expect(contrastRatio(dark.medianLuminance, PLAY_FIELD)).toBeGreaterThan(2.4);
      });

      it(`${relativePath} keeps its modelling through the dim`, async () => {
        // Woods holds are distinguished by grain and by the black/grey/tan families, so the
        // flat-sticker failure mode costs real information here. Dimming multiplies the
        // spread as well as the level, so this is where over-dimming shows up first.
        const dark = await measureBody(relativePath);
        expect(dark.redInterQuartileRange).toBeGreaterThan(30);
      });
    }
  }
});
