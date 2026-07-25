/// <reference types="node" />

/**
 * Generate dark-mode variants of the board-art layers that are drawn in near-black.
 *
 * Usage:
 *   vp run generate:dark-board-art            # write/refresh the .dark.webp siblings
 *   vp run generate:dark-board-art -- --check  # verify they are up to date (CI / tests)
 *
 * Why this exists (issue #3885, #1449)
 * ------------------------------------
 * Every board's art is a stack of ~96-99% transparent layers composited over the app's
 * own background. Kilter, Tension, Decoy and friends draw their holds in mid-tone
 * greys (mean visible luminance ~72-89), so they survive the dark play field
 * (`#181225`). MoonBoard is the exception: it is drawn for a white wall, so its grid
 * frame and row/column labels are *pure* `#000000`, and its "set B" hold sheets are
 * ~72% `#000000`/`#101010`. Over the dark field those measure 1.02-1.15:1 and vanish.
 *
 * Rather than painting an opaque wall behind the whole board — which fixes the art but
 * collapses the lit-climb markers (the green start ring drops from 13.57:1 to 1.09:1
 * against a yellow field) — we lift *only* the offending layers, and only in dark mode.
 *
 * The transform is a per-channel linear remap of the visible pixels into `[lo, hi]`,
 * leaving alpha untouched. It is a floor-lift, not a flat fill: each hold keeps its
 * internal shading, so black plastic still reads as a moulded hold rather than a flat
 * sticker (which is what `expo-image`'s `tintColor` / `PorterDuff.SRC_IN` would give).
 *
 * The output files are committed. `scripts/sync-mobile-board-backgrounds.sh` derives a
 * manifest key per file path, so `holdsetb.dark.webp` becomes its own key with no
 * change to that script; `packages/mobile/src/lib/background-image-cache.ts` then
 * prefers the `.dark.webp` sibling when the colour scheme is dark, and falls back to
 * the original whenever no sibling is bundled. That fallback is what keeps every other
 * board — and light mode — byte-identical.
 *
 * Adding a board here is deliberately a manual, reviewed act rather than a luminance
 * threshold: independent measurements of these same sheets disagreed by 8-10 points,
 * which is enough to flip a cutoff, and a luminance-only rule would also have caught
 * MoonBoard Masters' *red* set C. Measure, look at it, then add it to the list.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const IMAGES_DIR = path.join(ROOT_DIR, 'packages/web/public/images');

/** Suffix that marks a dark-mode sibling. Must match `DARK_VARIANT_SUFFIX` in background-image-cache.ts. */
const DARK_SUFFIX = '.dark.webp';

type RemapRange = {
  /** Output value for a source channel of 0 (the black floor gets lifted to here). */
  readonly floor: number;
  /** Output value for a source channel of 255. */
  readonly ceiling: number;
};

/**
 * The grid frame and the A-K / 1-18 coordinate labels. 100% pure `#000000`, and the
 * most-referenced pixels on a MoonBoard — beta is spoken as "F5 start, K13 finish", so
 * these are text-equivalent and get the higher floor: 5.4:1 mean against the dark field,
 * clearing WCAG AA for body text with margin. (Mean over visible pixels is a deliberately
 * conservative measure — antialiased glyph edges drag it down and the solid strokes sit
 * well above it.)
 */
const FRAME_REMAP: RemapRange = { floor: 140, ceiling: 240 };

/**
 * The black plastic hold sheets. Lifted to 3.2:1 against the dark field (WCAG 1.4.11 for
 * non-text) while staying 2.3:1 *darker* than the pale set A sheets. Both bounds bind: a
 * higher floor buys field contrast but collapses the black-vs-pale distinction, which is a
 * real MoonBoard product fact and the only one that survives colour-vision deficiency.
 * 92/175 is the range that clears 3:1 on all three sheets with the most separation left
 * over — see scripts/generate-dark-board-art.test.ts, which pins both bounds.
 */
const BLACK_HOLD_REMAP: RemapRange = { floor: 92, ceiling: 175 };

type ArtGroup = {
  readonly remap: RemapRange;
  /** Paths relative to packages/web/public/images, full-resolution variant. */
  readonly sources: readonly string[];
};

const ART_GROUPS: readonly ArtGroup[] = [
  {
    remap: FRAME_REMAP,
    sources: ['moonboard/moonboard-bg.webp', 'moonboard/minimoonboard-bg.webp'],
  },
  {
    remap: BLACK_HOLD_REMAP,
    sources: [
      'moonboard/moonboard2016/holdsetb.webp',
      'moonboard/moonboardmasters2017/holdsetb.webp',
      'moonboard/moonboardmasters2019/holdsetb.webp',
    ],
  },
];

/**
 * Deliberately NOT treated, recorded here so the next person doesn't have to re-derive it:
 *   - `holdseta` / `originalschoolholds` — pale and gold, already 6.9:1 and 6.5:1.
 *   - `moonboardmasters2017/holdsetc` — 73-76% saturation. It is a RED set; a
 *     luminance-only rule would have grey-tinted it and lost the colour.
 *   - `moonboard2024/holdsetd|e|f` — blue `#2080C0`, already 4.3:1.
 *   - `woodenholds*` — mid-tone wood.
 *   - Every non-MoonBoard board — mid-tone by construction.
 */

/** Insert a `thumbs/` segment before the filename, matching manifestKeyForVariant(). */
function thumbSibling(relativePath: string): string {
  const lastSlash = relativePath.lastIndexOf('/');
  if (lastSlash < 0) return `thumbs/${relativePath}`;
  return `${relativePath.slice(0, lastSlash)}/thumbs/${relativePath.slice(lastSlash + 1)}`;
}

/** Every source we treat: the full-resolution file plus its `thumbs/` sibling when one is bundled. */
function expandSources(sources: readonly string[]): string[] {
  const expanded: string[] = [];
  for (const source of sources) {
    expanded.push(source);
    const thumb = thumbSibling(source);
    if (existsSync(path.join(IMAGES_DIR, thumb))) expanded.push(thumb);
  }
  return expanded;
}

function darkVariantPath(relativePath: string): string {
  return `${relativePath.replace(/\.webp$/, '')}${DARK_SUFFIX}`;
}

/**
 * Linear per-channel remap of visible pixels into [floor, ceiling], alpha preserved.
 *
 * Fully transparent pixels are skipped: their RGB is meaningless but webp still stores
 * it, and rewriting it would churn the encoder output for no visual change.
 */
async function renderDarkVariant(absoluteSource: string, remap: RemapRange): Promise<Buffer> {
  const { data, info } = await sharp(absoluteSource).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  if (info.channels !== 4) {
    throw new Error(`Expected RGBA for ${absoluteSource}, got ${info.channels} channels`);
  }

  const span = remap.ceiling - remap.floor;
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] === 0) continue;
    data[offset] = remap.floor + Math.round((data[offset] / 255) * span);
    data[offset + 1] = remap.floor + Math.round((data[offset + 1] / 255) * span);
    data[offset + 2] = remap.floor + Math.round((data[offset + 2] / 255) * span);
  }

  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .webp({ quality: 88, alphaQuality: 100, effort: 6 })
    .toBuffer();
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes('--check');
  const stale: string[] = [];
  let written = 0;

  for (const group of ART_GROUPS) {
    for (const relativeSource of expandSources(group.sources)) {
      const absoluteSource = path.join(IMAGES_DIR, relativeSource);
      if (!existsSync(absoluteSource)) {
        throw new Error(`Source art missing: ${relativeSource} (expected under packages/web/public/images)`);
      }

      const relativeTarget = darkVariantPath(relativeSource);
      const absoluteTarget = path.join(IMAGES_DIR, relativeTarget);
      const rendered = await renderDarkVariant(absoluteSource, group.remap);

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
        `ERROR: ${stale.length} dark board-art variant(s) are stale or missing:\n` +
          stale.map((file) => `  - ${file}`).join('\n') +
          `\nRun: vp run generate:dark-board-art`,
      );
      process.exit(1);
    }
    // eslint-disable-next-line no-console
    console.log('==> Dark board-art variants are up to date.');
    return;
  }

  // eslint-disable-next-line no-console
  console.log(
    written === 0
      ? '==> Dark board-art variants already up to date.'
      : `==> Wrote ${written} dark board-art variant(s). Re-run scripts/sync-mobile-board-backgrounds.sh to refresh the manifest.`,
  );
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
