/**
 * Generate the dark-mode Woods board art.
 *
 * Woods is the one board whose art is hold sprites composited on a flat, fully opaque
 * #FFFFFF ground — 67.5% of the 8x10's pixels are near-white and its median pixel is pure
 * white, 16.6:1 against the dark card. In dark mode that reads as a lit rectangle in an
 * otherwise dark UI (issue #4753).
 *
 * scripts/generate-dark-board-art.ts cannot help here: its two transforms lift a near-black
 * TRANSPARENT layer and are documented never to touch alpha. This one does the opposite —
 * it creates alpha by keying the white ground out, so the holds sit straight on whatever
 * surface is behind them, which is the same transparent-art shape MoonBoard's dark siblings
 * already have. Output naming and encoder settings match that script exactly, so
 * scripts/sync-mobile-board-backgrounds.sh and background-image-cache.ts pick these up with
 * no change (see the notes in generate-dark-board-art.ts).
 *
 * The pipeline, and why each step is there:
 *
 *   1. FLOOD FILL from the four corners, 4-connected, over pixels that are >= GROUND_FLOOR
 *      on every channel. Connected-only is the whole point: pale holds carry near-white
 *      specular highlights, and a global "near-white => transparent" rule punches holes in
 *      them. Nothing reachable from a corner is a hold. Verified insensitive — moving the
 *      threshold across 235/225/... shifts the filled fraction by under a point on both
 *      sizes, i.e. there is no hold body sitting near the cutoff.
 *
 *   2. ERODE the remaining opaque region by one pixel. Sprite edges are antialiased against
 *      white, so the outermost opaque ring is a white-ish blend that survives step 1 and
 *      renders as a bright halo around every hold on a dark background. One pixel is enough
 *      and costs nothing visible at these sizes (holds are 30px+).
 *
 *   3. DIM to 82% brightness / 90% saturation. Undimmed, this art is punchy enough against
 *      #140E1E to glare; much below 82% the wood grain and the black/grey/tan distinction
 *      start going muddy. Lands at 2.5:1 against the card with the body inter-quartile range
 *      still at 40 levels, i.e. the holds read as moulded rather than as flat stickers.
 *
 * Sources are the LOSSLESS .png files, not the shipped .webp: keying a lossy source leaves
 * its compression ringing behind as white speckle, and keying the lossy 416px thumb is
 * visibly worse again. Key the PNG once, then downscale the keyed pixels for the thumb.
 *
 * The output files are committed; scripts/generate-woods-dark-art.test.ts pins the rendered
 * result so a sharp upgrade or an accidental parameter edit fails there rather than silently
 * shipping. Re-run scripts/sync-mobile-board-backgrounds.sh after regenerating.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const IMAGES_DIR = path.join(ROOT_DIR, 'packages/web/public/images');

/**
 * Suffix that marks a dark-mode sibling. Must match `DARK_VARIANT_SUFFIX` in
 * background-image-cache.ts and `DARK_SUFFIX` in scripts/generate-dark-board-art.ts. Copied
 * rather than imported because that module runs its own generator on load.
 */
const DARK_SUFFIX = '.dark.webp';

/** Full-resolution lossless sources, relative to packages/web/public/images. */
const SOURCES = ['woods/woods-8x10-bg.png', 'woods/woods-12x12-bg.png'] as const;

/** A pixel counts as board ground when every channel is at least this bright. */
const GROUND_FLOOR = 235;

/** Thumbnail width, matching MAX_WIDTH in packages/web/scripts/generate-thumbnails.sh. */
const THUMB_WIDTH = 416;

/** Multipliers applied to the surviving hold pixels. */
const BRIGHTNESS = 0.82;
const SATURATION = 0.9;

/** Full-resolution encoder settings, identical to generate-dark-board-art.ts. */
const FULL_WEBP_OPTIONS = { quality: 88, alphaQuality: 100, effort: 6 } as const;

/**
 * Thumbnails encode softer, and they have to.
 *
 * The light thumbs are cheap because two thirds of them is flat white ground; keying that
 * away leaves 416x578 of nothing but hold detail, and adds an alpha plane with an edge in
 * almost every block. At the full-size settings that lands at 119 KB — half again the size
 * of the 720x1000 file it was downscaled from, for something drawn at ~208 CSS px.
 *
 * quality 75 is what packages/web/scripts/generate-thumbnails.sh already uses for the light
 * thumbs, so this is the same bar, not a looser one; alphaQuality 70 costs no visible edge
 * quality at 4x zoom. Together: 61 KB.
 */
const THUMB_WEBP_OPTIONS = { quality: 75, alphaQuality: 70, effort: 6 } as const;

type Raster = { data: Buffer; width: number; height: number };

/**
 * Zero the alpha of the connected white ground, seeded from the four corners.
 *
 * An explicit stack rather than recursion: the ground is ~2/3 of a 1225x1400 image, which
 * would blow the call stack several times over.
 */
function keyOutGround({ data, width, height }: Raster): void {
  const isGround = (pixel: number) => {
    const offset = pixel * 4;
    return data[offset] >= GROUND_FLOOR && data[offset + 1] >= GROUND_FLOOR && data[offset + 2] >= GROUND_FLOOR;
  };

  const stack = [0, width - 1, (height - 1) * width, height * width - 1];
  while (stack.length > 0) {
    const pixel = stack.pop() as number;
    const offset = pixel * 4;
    if (data[offset + 3] === 0) continue;
    if (!isGround(pixel)) continue;

    data[offset + 3] = 0;
    const x = pixel % width;
    const y = (pixel - x) / width;
    if (x > 0) stack.push(pixel - 1);
    if (x < width - 1) stack.push(pixel + 1);
    if (y > 0) stack.push(pixel - width);
    if (y < height - 1) stack.push(pixel + width);
  }
}

/**
 * Drop every opaque pixel that touches a keyed one, so the antialiased white-ish rim goes
 * with the ground. Reads from a snapshot of the alpha rather than in place, otherwise the
 * first cleared pixel would seed its neighbour and the erode would eat whole holds.
 */
function erodeEdge({ data, width, height }: Raster): void {
  const wasKeyed = new Uint8Array(width * height);
  for (let pixel = 0; pixel < wasKeyed.length; pixel++) {
    wasKeyed[pixel] = data[pixel * 4 + 3] === 0 ? 1 : 0;
  }

  const touchesKeyed = (x: number, y: number) => {
    const maxY = Math.min(height - 1, y + 1);
    const maxX = Math.min(width - 1, x + 1);
    for (let neighbourY = Math.max(0, y - 1); neighbourY <= maxY; neighbourY++) {
      for (let neighbourX = Math.max(0, x - 1); neighbourX <= maxX; neighbourX++) {
        if (wasKeyed[neighbourY * width + neighbourX] === 1) return true;
      }
    }
    return false;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      if (wasKeyed[pixel] === 1) continue;
      if (touchesKeyed(x, y)) data[pixel * 4 + 3] = 0;
    }
  }
}

/** Pull the surviving holds down in brightness and saturation. Keyed pixels are left alone. */
function dimHolds({ data }: Raster): void {
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] === 0) continue;

    const luma = 0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2];
    for (let channel = 0; channel < 3; channel++) {
      const desaturated = luma + (data[offset + channel] - luma) * SATURATION;
      data[offset + channel] = Math.min(255, Math.max(0, Math.round(desaturated * BRIGHTNESS)));
    }
  }
}

async function renderKeyedRaster(absoluteSource: string): Promise<Raster> {
  const { data, info } = await sharp(absoluteSource).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) {
    throw new Error(`Expected RGBA for ${absoluteSource}, got ${info.channels} channels`);
  }

  const raster: Raster = { data, width: info.width, height: info.height };
  keyOutGround(raster);
  erodeEdge(raster);
  dimHolds(raster);
  return raster;
}

function toSharp({ data, width, height }: Raster) {
  return sharp(data, { raw: { width, height, channels: 4 } });
}

/** `woods/woods-8x10-bg.png` -> `woods/woods-8x10-bg.dark.webp`, thumb variant under thumbs/. */
function darkTargetPath(relativeSource: string, variant: 'full' | 'thumb'): string {
  const withoutExtension = relativeSource.replace(/\.png$/, '');
  if (variant === 'full') return `${withoutExtension}${DARK_SUFFIX}`;

  const lastSlash = withoutExtension.lastIndexOf('/');
  return `${withoutExtension.slice(0, lastSlash)}/thumbs/${withoutExtension.slice(lastSlash + 1)}${DARK_SUFFIX}`;
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes('--check');
  const stale: string[] = [];
  let written = 0;

  for (const relativeSource of SOURCES) {
    const absoluteSource = path.join(IMAGES_DIR, relativeSource);
    if (!existsSync(absoluteSource)) {
      throw new Error(`Source art missing: ${relativeSource} (expected under packages/web/public/images)`);
    }

    const keyed = await renderKeyedRaster(absoluteSource);
    const renders: [string, Buffer][] = [
      [darkTargetPath(relativeSource, 'full'), await toSharp(keyed).webp(FULL_WEBP_OPTIONS).toBuffer()],
      [
        darkTargetPath(relativeSource, 'thumb'),
        await toSharp(keyed)
          .resize({ width: THUMB_WIDTH, fit: 'inside', kernel: 'lanczos3' })
          .webp(THUMB_WEBP_OPTIONS)
          .toBuffer(),
      ],
    ];

    for (const [relativeTarget, rendered] of renders) {
      const absoluteTarget = path.join(IMAGES_DIR, relativeTarget);
      const existing = existsSync(absoluteTarget) ? await readFile(absoluteTarget) : null;
      if (existing?.equals(rendered)) continue;

      if (checkOnly) {
        stale.push(relativeTarget);
        continue;
      }

      await writeFile(absoluteTarget, rendered);
      written++;
      // eslint-disable-next-line no-console
      console.log(`  wrote ${relativeTarget} (${(rendered.length / 1024).toFixed(1)} KB)`);
    }
  }

  if (checkOnly) {
    if (stale.length > 0) {
      // eslint-disable-next-line no-console
      console.error(
        `ERROR: ${stale.length} Woods dark art variant(s) are stale or missing:\n` +
          stale.map((file) => `  - ${file}`).join('\n') +
          `\nRun: vp run generate:woods-dark-art`,
      );
      process.exit(1);
    }
    // eslint-disable-next-line no-console
    console.log('==> Woods dark art variants are up to date.');
    return;
  }

  // eslint-disable-next-line no-console
  console.log(
    written === 0
      ? '==> Woods dark art variants already up to date.'
      : `==> Wrote ${written} Woods dark art variant(s). Re-run scripts/sync-mobile-board-backgrounds.sh to refresh the manifest.`,
  );
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
