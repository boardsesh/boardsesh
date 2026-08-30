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
 * Two transforms, because the two kinds of layer are genuinely different:
 *
 *   `tint`  — the coordinate-label sheets carry exactly ONE colour value (#000000; every
 *             soft edge lives in the alpha channel, not the RGB). A range would be dead
 *             config, so these get a single grey and say so.
 *   `curve` — the black hold sheets DO carry modelling, but it is crushed against black:
 *             the body inter-quartile range is only 16 levels out of 255. A plain linear
 *             remap compresses that further (16 -> 10) and the holds come out looking like
 *             flat stickers, which is exactly the failure mode that ruled out `expo-image`
 *             `tintColor` / `PorterDuff.SRC_IN` in the first place. A gamma < 1 expands the
 *             dark end instead, so the shipped sheets end up with MORE visible modelling
 *             than the source (body IQR 16 -> 29).
 *
 * Alpha is never touched by either transform.
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

/**
 * Suffix that marks a dark-mode sibling. Must match `DARK_VARIANT_SUFFIX` in
 * background-image-cache.ts, and `DARK_SUFFIX` in scripts/generate-woods-dark-art.ts, which
 * writes the same kind of sibling through a different transform. Deliberately not shared by
 * import: this module runs its generator on load, so importing it from the Woods script
 * would regenerate the MoonBoard art as a side effect.
 */
const DARK_SUFFIX = '.dark.webp';

/**
 * Reference backgrounds these values were tuned against, sampled from real device
 * screenshots rather than assumed: `#221A33` is the elevated card the board preview and
 * the list thumbnails sit on, `#140E1E` is the play-view field. The card is the brighter
 * of the two, so it is the worst case for art we are lifting *up*, and every ratio quoted
 * below is against it.
 */
export const REFERENCE_CARD = '#221A33';
/** Play-view field, the darker of the two surfaces the art composites onto. */
export const REFERENCE_PLAY_FIELD = '#140E1E';

type Transform =
  | {
      readonly kind: 'tint';
      /** Single grey every visible pixel becomes. */
      readonly value: number;
    }
  | {
      readonly kind: 'curve';
      readonly floor: number;
      readonly ceiling: number;
      /** < 1 expands the dark end, which is where all of this art's detail lives. */
      readonly gamma: number;
    };

/**
 * The A-K / 1-18 coordinate labels. Not a grid — these sheets are 0.39% opaque with no run
 * longer than a glyph, i.e. lettering only. Every visible pixel is exactly `#000000`
 * (one unique value; the soft edges are alpha), so this is a tint and pretending otherwise
 * would be dead config.
 *
 * They are the most-referenced pixels on a MoonBoard — beta is spoken as "F5 start, K13
 * finish" — so they are text-equivalent. `#A8A8A8` is 7.0:1 against the card as authored;
 * 1-2px glyph stems lose some of that to antialiasing when rendered, landing comfortably
 * past the 4.5:1 AA bar rather than just scraping it.
 */
const LABEL_TINT: Transform = { kind: 'tint', value: 0xa8 };

/**
 * The black plastic hold sheets.
 *
 * These cannot hit 3:1 against the background AND stay clearly darker than the pale set A
 * sheets, and that is arithmetic, not tuning: both hold families sit on ONE background, so
 * the best achievable `min(hold-vs-card, hold-vs-paleA)` is **2.49:1**, at body luminance
 * Y=0.107. Chasing WCAG 1.4.11's 3:1 against the card would push the black sheets to within
 * 2.0:1 of the pale ones and start dissolving the black-vs-pale distinction — a real
 * MoonBoard product fact, and the only cue that survives colour-vision deficiency.
 *
 * So this sits deliberately near that optimum: body median 2.58:1 against the card and
 * 2.40:1 against pale set A, up from 1.17:1 before. gamma 0.5 over a wide 56-250 band also
 * takes the body inter-quartile range from 16 levels in the source to 29 in the output, so
 * the holds read as moulded rather than as flat silhouettes. All three bounds are pinned by
 * scripts/generate-dark-board-art.test.ts.
 */
const BLACK_HOLD_CURVE: Transform = { kind: 'curve', floor: 56, ceiling: 250, gamma: 0.5 };

type ArtGroup = {
  readonly transform: Transform;
  /** Paths relative to packages/web/public/images, full-resolution variant. */
  readonly sources: readonly string[];
};

const ART_GROUPS: readonly ArtGroup[] = [
  {
    transform: LABEL_TINT,
    sources: ['moonboard/moonboard-bg.webp', 'moonboard/minimoonboard-bg.webp'],
  },
  {
    transform: BLACK_HOLD_CURVE,
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
 *   - `moonboardmasters2017|2019/screw-onfeet` — small mid-tone screw-on footholds; they read
 *     already, and lifting them would crowd the lifted set B they sit between.
 *   - `woodenholds*` — mid-tone wood.
 *   - `woods/woods-8x10-bg` / `woods-12x12-bg` — hold sprites on an opaque white ground, not
 *     a near-black transparent layer. There is nothing to lift and both transforms above
 *     would only wash the wood grain out, so those two get their own generator:
 *     scripts/generate-woods-dark-art.ts keys the white ground out instead. It writes the
 *     same `.dark.webp` siblings, which is why the suffix is exported from here.
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
 * Apply a group's transform to every visible pixel, alpha preserved.
 *
 * Fully transparent pixels are skipped: their RGB is meaningless but webp still stores
 * it, and rewriting it would churn the encoder output for no visual change.
 */
async function renderDarkVariant(absoluteSource: string, transform: Transform): Promise<Buffer> {
  const { data, info } = await sharp(absoluteSource).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  if (info.channels !== 4) {
    throw new Error(`Expected RGBA for ${absoluteSource}, got ${info.channels} channels`);
  }

  const mapChannel =
    transform.kind === 'tint'
      ? () => transform.value
      : (channel: number) => {
          const span = transform.ceiling - transform.floor;
          return transform.floor + Math.round((channel / 255) ** transform.gamma * span);
        };

  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] === 0) continue;
    data[offset] = mapChannel(data[offset]);
    data[offset + 1] = mapChannel(data[offset + 1]);
    data[offset + 2] = mapChannel(data[offset + 2]);
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
      const rendered = await renderDarkVariant(absoluteSource, group.transform);

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
