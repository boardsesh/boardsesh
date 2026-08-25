/// <reference types="node" />

/**
 * Spike (issue #2202): OkLab lightness-stretch of one board's art layers.
 *
 * Usage:
 *   vp run spike:oklab-board-art             # regenerate at the default amounts
 *   vp run spike:oklab-board-art -- 0.4 1    # regenerate at the given contrast amounts
 *
 * Why
 * ---
 * Grasshopper's board art is drawn in a very narrow band of perceived lightness:
 * measured over the visible pixels of the whole 5-layer stack, OkLab L runs
 * p10=0.312 to p90=0.516. Twenty points of lightness out of a hundred is not
 * enough modelling for a hold's 3D shape to survive being composited over a dark
 * play field, which is what the issue is about.
 *
 * So: histogram OkLab L over the *visible* pixels only, take the 10th and 90th
 * percentile (the issue's suggestion — a percentile band rather than min/max, so
 * one white bolt-hole in an otherwise dark hold cannot set the scale), and remap
 * that band onto 0.05..0.95. Hue and chroma ride along untouched; only L moves.
 * Alpha is never touched.
 *
 * The histogram is built from the *composited* stack, not per layer, so every
 * layer gets the same mapping and the stack still reads as one board. The
 * `amount` parameter blends between the original and the fully stretched L,
 * which is what the issue's per-user "contrast amount" setting would drive.
 *
 * This is a spike: it hardcodes one board config, and it writes committed assets
 * that only `packages/mobile/app/board-spike.tsx` reads. If the treatment wins,
 * the real version belongs in the Rust renderer (or a build step over every
 * board), not here.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const SOURCE_DIR = path.join(ROOT_DIR, 'packages/web/public/images/grasshopper/product_sizes_layouts_sets');
const OUTPUT_DIR = path.join(ROOT_DIR, 'packages/mobile/assets/spike/grasshopper');

/** Grasshopper "Master 8 x 12 with Tweeners" — layout 1, size 5, sets 1/2/3/4/6. */
const LAYERS = [
  '8x12-2020-engage.webp',
  '8x12-2020-flow.webp',
  '8x12-2020-power.webp',
  '8x12-2020-gradient.webp',
  '8x12-2020-tweeners-v2.webp',
];

const LOW_PERCENTILE = 0.1;
const HIGH_PERCENTILE = 0.9;
const LOW_TARGET = 0.05;
const HIGH_TARGET = 0.95;
/** Only pixels at least this opaque count toward the histogram. */
const ALPHA_FLOOR = 200;
const BUCKETS = 1024;
const DEFAULT_AMOUNTS = [0.6, 1];

function srgbToLinear(channel: number): number {
  const normalised = channel / 255;
  return normalised <= 0.04045 ? normalised / 12.92 : ((normalised + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(linear: number): number {
  const encoded = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(encoded * 255)));
}

function rgbToOklab(red: number, green: number, blue: number): [number, number, number] {
  const linearRed = srgbToLinear(red);
  const linearGreen = srgbToLinear(green);
  const linearBlue = srgbToLinear(blue);
  const long = Math.cbrt(0.4122214708 * linearRed + 0.5363325363 * linearGreen + 0.0514459929 * linearBlue);
  const medium = Math.cbrt(0.2119034982 * linearRed + 0.6806995451 * linearGreen + 0.1073969566 * linearBlue);
  const short = Math.cbrt(0.0883024619 * linearRed + 0.2817188376 * linearGreen + 0.6299787005 * linearBlue);
  return [
    0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short,
    1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short,
    0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short,
  ];
}

function oklabToRgb(lightness: number, greenRed: number, blueYellow: number): [number, number, number] {
  const long = (lightness + 0.3963377774 * greenRed + 0.2158037573 * blueYellow) ** 3;
  const medium = (lightness - 0.1055613458 * greenRed - 0.0638541728 * blueYellow) ** 3;
  const short = (lightness - 0.0894841775 * greenRed - 1.291485548 * blueYellow) ** 3;
  return [
    linearToSrgb(4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short),
    linearToSrgb(-1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short),
    linearToSrgb(-0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short),
  ];
}

async function main(): Promise<number> {
  const requested = process.argv
    .slice(2)
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0 && value <= 1);
  const amounts = requested.length > 0 ? requested : DEFAULT_AMOUNTS;

  const { width, height } = await sharp(path.join(SOURCE_DIR, LAYERS[0])).metadata();
  if (width === undefined || height === undefined) throw new Error('source layer has no dimensions');
  const rawLayer = { width, height, channels: 4 as const };
  console.log(`[spike] board art ${width}x${height}, ${LAYERS.length} layers`);

  let composite: Buffer | null = null;
  for (const layerName of LAYERS) {
    const layer = await sharp(path.join(SOURCE_DIR, layerName)).ensureAlpha().raw().toBuffer();
    composite =
      composite === null
        ? layer
        : await sharp(composite, { raw: rawLayer })
            .composite([{ input: layer, raw: rawLayer, blend: 'over' }])
            .raw()
            .toBuffer();
  }
  if (composite === null) throw new Error('no layers composited');

  const histogram = new Uint32Array(BUCKETS);
  let visiblePixels = 0;
  for (let offset = 0; offset < composite.length; offset += 4) {
    if (composite[offset + 3] < ALPHA_FLOOR) continue;
    const [lightness] = rgbToOklab(composite[offset], composite[offset + 1], composite[offset + 2]);
    histogram[Math.max(0, Math.min(BUCKETS - 1, Math.round(lightness * (BUCKETS - 1))))] += 1;
    visiblePixels += 1;
  }

  const percentile = (fraction: number): number => {
    const target = visiblePixels * fraction;
    let seen = 0;
    for (let bucket = 0; bucket < BUCKETS; bucket += 1) {
      seen += histogram[bucket];
      if (seen >= target) return bucket / (BUCKETS - 1);
    }
    return 1;
  };
  const lowLightness = percentile(LOW_PERCENTILE);
  const highLightness = percentile(HIGH_PERCENTILE);
  console.log(
    `[spike] visible ${visiblePixels} px (${((visiblePixels / (width * height)) * 100).toFixed(1)}%), ` +
      `OkLab L p10=${lowLightness.toFixed(3)} p50=${percentile(0.5).toFixed(3)} p90=${highLightness.toFixed(3)} ` +
      `-> ${LOW_TARGET}..${HIGH_TARGET}`,
  );

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const span = Math.max(1e-4, highLightness - lowLightness);

  for (const amount of amounts) {
    const lut = new Float64Array(BUCKETS);
    for (let bucket = 0; bucket < BUCKETS; bucket += 1) {
      const lightness = bucket / (BUCKETS - 1);
      const stretched = LOW_TARGET + ((lightness - lowLightness) / span) * (HIGH_TARGET - LOW_TARGET);
      lut[bucket] = Math.max(0, Math.min(1, lightness + (stretched - lightness) * amount));
    }

    const suffix = `c${Math.round(amount * 100)}`;
    for (const layerName of LAYERS) {
      const layer = await sharp(path.join(SOURCE_DIR, layerName)).ensureAlpha().raw().toBuffer();
      for (let offset = 0; offset < layer.length; offset += 4) {
        if (layer[offset + 3] === 0) continue;
        const [lightness, greenRed, blueYellow] = rgbToOklab(layer[offset], layer[offset + 1], layer[offset + 2]);
        const nextLightness = lut[Math.max(0, Math.min(BUCKETS - 1, Math.round(lightness * (BUCKETS - 1))))];
        const [red, green, blue] = oklabToRgb(nextLightness, greenRed, blueYellow);
        layer[offset] = red;
        layer[offset + 1] = green;
        layer[offset + 2] = blue;
      }
      const outputName = `${layerName.replace(/\.webp$/, '')}.${suffix}.webp`;
      await sharp(layer, { raw: rawLayer }).webp({ quality: 90 }).toFile(path.join(OUTPUT_DIR, outputName));
      console.log(`[spike]   wrote ${outputName}`);
    }
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('[spike] failed:', error);
    process.exit(1);
  });
