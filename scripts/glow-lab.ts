/**
 * Glow lab: render real climbs through the Rust boardsesh renderer and build
 * labelled comparison montages, so glow-tuning variants can be judged on real
 * board art without a device or a dev server.
 *
 * Usage (from repo root):
 *   ./node_modules/.bin/tsx scripts/glow-lab.ts                 # baseline only
 *   ./node_modules/.bin/tsx scripts/glow-lab.ts --variants scripts/glow-lab-variants.example.json
 *   ./node_modules/.bin/tsx scripts/glow-lab.ts --out .boardsesh/glow-lab
 *   ./node_modules/.bin/tsx scripts/glow-lab.ts --board tension/10-6 \
 *     --frames p1234r2p1240r1 --climb-name Prime
 *
 * A variants file is `[{ "name": "...", "overrides": { ...RenderConfig subset } }]`;
 * each variant's overrides are merged over the production-shaped config (one
 * level deep, so `{"glow": {"reach_scale": 1.3}}` keeps the other glow fields).
 * Every montage carries the `baseline` panel first.
 *
 * The board defaults to the Kilter Homewall 10x12 (layout 8, size 25) and the
 * climbs to the set frozen in `scripts/glow-lab-fixtures.ts`. `--board
 * <boardName>/<layoutId>-<sizeId>` renders any other catalogue config, and
 * `--frames` (with an optional `--climb-name` for the output slug) swaps the
 * frozen set for one ad-hoc climb — the pair a cross-board comparison needs,
 * since the frozen climbs only exist on the Kilter Homewall. Output per climb:
 *   <out>/<climb-slug>/<variant>.png            full board composite
 *   <out>/<climb-slug>/<variant>.thumb.png      200px thumbnail arm composite
 *   <out>/compare-<climb-slug>.png              montage: full boards + zoom crops + thumbs
 *
 * The overlay itself comes from the dev-only cargo example
 * `packages/board-renderer/core/examples/render_overlay.rs`, built once per run.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

import type { BoardName } from '../packages/shared-schema/src/types/board-config';
import { HOLD_STATE_MAP, getHoldDisplayColor } from '../packages/board-constants/src/hold-states';
import { loadBoardArtGeometry, getWallLightness } from '../packages/shared/board-art-geometry/src/loader';
import { veilOpacityFor } from '../packages/shared/board-art-geometry/src/veil';
import { getBoardDetailsForBoard } from '../packages/shared/board-render/src/board-details';
import { getBackgroundRelPaths } from '../packages/shared/board-render/src/background';
import { buildRenderConfig, THUMBNAIL_WIDTH } from '../packages/shared/board-render/src/render-config';
import { listCatalogueEntries } from '../packages/shared/board-render/src/render-version-projection';
import { GLOW_LAB_BOARD, GLOW_LAB_CLIMBS, type GlowLabClimb } from './glow-lab-fixtures';

/** The dark play field the mobile play view composites over (`BOARD_FIELD_COLORS.dark`). */
const FIELD_COLOR = '#181225';
const REPO_ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'packages/web/public');
const RENDERER_DIR = path.join(REPO_ROOT, 'packages/board-renderer');
const RENDERER_BINARY = path.join(RENDERER_DIR, 'target/release/examples/render_overlay');
/** Panel width in the montage; full renders are ~1080px wide. */
const PANEL_WIDTH = 540;
/** Square crop (in board px) around the densest lit cluster, shown at 2x. */
const CROP_SIZE = 420;

type GlowVariant = {
  name: string;
  /** Merged one level deep over the baseline RenderConfig JSON. */
  overrides: Record<string, unknown>;
};

type LabBoard = { boardName: BoardName; layoutId: number; sizeId: number };

type CliArguments = {
  variantsPath: string | null;
  outDir: string;
  renderScale: number;
  /** `--board kilter/8-25`; null keeps the pinned `GLOW_LAB_BOARD`. */
  board: LabBoard | null;
  /** `--frames`; null keeps the frozen `GLOW_LAB_CLIMBS` set. */
  frames: string | null;
  climbName: string;
};

/** `<boardName>/<layoutId>-<sizeId>`, the same shape as a board-art-geometry shard key. */
function parseBoardArgument(raw: string): LabBoard {
  const match = /^([a-z]+)\/(\d+)-(\d+)$/.exec(raw);
  if (!match) throw new Error(`--board must look like kilter/8-25, got ${raw}`);
  return { boardName: match[1] as BoardName, layoutId: Number(match[2]), sizeId: Number(match[3]) };
}

function parseCliArguments(): CliArguments {
  const cliArguments = process.argv.slice(2);
  let variantsPath: string | null = null;
  let outDir = path.join(REPO_ROOT, '.boardsesh/glow-lab');
  // The overlay is rasterized from vectors, so scaling `output_width` gives a
  // genuinely sharper glow; the board photo underneath is upscaled (its native
  // resolution is the ceiling for the art itself).
  let renderScale = 1;
  let board: LabBoard | null = null;
  let frames: string | null = null;
  let climbName = 'custom';
  for (let index = 0; index < cliArguments.length; index += 1) {
    if (cliArguments[index] === '--variants') variantsPath = cliArguments[++index];
    else if (cliArguments[index] === '--out') outDir = path.resolve(cliArguments[++index]);
    else if (cliArguments[index] === '--board') board = parseBoardArgument(cliArguments[++index]);
    else if (cliArguments[index] === '--frames') frames = cliArguments[++index];
    else if (cliArguments[index] === '--climb-name') climbName = cliArguments[++index];
    else if (cliArguments[index] === '--scale') {
      renderScale = Number(cliArguments[++index]);
      if (!Number.isInteger(renderScale) || renderScale < 1 || renderScale > 4) {
        throw new Error('--scale must be an integer 1..4');
      }
    } else throw new Error(`unknown argument ${cliArguments[index]}`);
  }
  if (frames !== null && !/^(p\d+r\d+)+$/.test(frames)) {
    throw new Error(`--frames must be a single frame like p1234r43p1235r42, got ${frames}`);
  }
  return { variantsPath, outDir, renderScale, board, frames, climbName };
}

function loadVariants(variantsPath: string | null): GlowVariant[] {
  const baseline: GlowVariant = { name: 'baseline', overrides: {} };
  if (!variantsPath) return [baseline];
  const parsed = JSON.parse(fs.readFileSync(variantsPath, 'utf8')) as GlowVariant[];
  for (const variant of parsed) {
    if (!variant.name || typeof variant.overrides !== 'object') {
      throw new Error(`variant needs a name and an overrides object: ${JSON.stringify(variant)}`);
    }
    if (/[^a-z0-9._-]/i.test(variant.name)) {
      throw new Error(`variant name must be filename-safe: ${variant.name}`);
    }
  }
  return [baseline, ...parsed.filter((variant) => variant.name !== 'baseline')];
}

/** One level deep so a partial `glow` override keeps the other glow fields. */
function mergeOverrides(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const current = merged[key];
    merged[key] =
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current)
        ? { ...(current as Record<string, unknown>), ...(value as Record<string, unknown>) }
        : value;
  }
  return merged;
}

function ensureRendererBinary(): void {
  execFileSync('cargo', ['build', '--release', '--example', 'render_overlay'], {
    cwd: path.join(RENDERER_DIR, 'core'),
    stdio: 'inherit',
  });
}

function renderOverlay(config: Record<string, unknown>, workDir: string, label: string): string {
  const configPath = path.join(workDir, `${label}.config.json`);
  const overlayPath = path.join(workDir, `${label}.overlay.png`);
  fs.writeFileSync(configPath, JSON.stringify(config));
  execFileSync(RENDERER_BINARY, [configPath, overlayPath], { stdio: 'inherit' });
  return overlayPath;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Densest lit cluster: the lit hold whose k nearest lit neighbours are closest. */
function cropCenterForClimb(
  frames: string,
  holds: Array<{ id: number; cx: number; cy: number }>,
): { cx: number; cy: number } {
  const litIds = new Set([...frames.matchAll(/p(\d+)r\d+/g)].map((match) => Number(match[1])));
  const litHolds = holds.filter((hold) => litIds.has(hold.id));
  if (litHolds.length === 0) return { cx: 0, cy: 0 };
  let best = litHolds[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of litHolds) {
    const neighbourDistances = litHolds
      .filter((other) => other !== candidate)
      .map((other) => Math.hypot(other.cx - candidate.cx, other.cy - candidate.cy))
      .sort((a, b) => a - b)
      .slice(0, 3);
    const score = neighbourDistances.reduce((sum, distance) => sum + distance, 0);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return { cx: best.cx, cy: best.cy };
}

function labelBanner(text: string, width: number, height: number): Buffer {
  const safeText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#0B0B10"/>
      <text x="12" y="${height - 12}" font-family="monospace" font-size="22" fill="#EDE9FE">${safeText}</text>
    </svg>`,
  );
}

async function main(): Promise<void> {
  const { variantsPath, outDir, renderScale, board, frames, climbName } = parseCliArguments();
  const variants = loadVariants(variantsPath);
  fs.mkdirSync(outDir, { recursive: true });
  ensureRendererBinary();

  const labBoard: LabBoard = board ?? GLOW_LAB_BOARD;
  const climbs: GlowLabClimb[] = frames ? [{ uuid: '', name: climbName, frames }] : GLOW_LAB_CLIMBS;
  const { boardName, layoutId, sizeId } = labBoard;
  const catalogueEntry = listCatalogueEntries().find(
    (entry) => entry.boardName === boardName && entry.layoutId === layoutId && entry.sizeId === sizeId,
  );
  if (!catalogueEntry) throw new Error(`no catalogue entry for ${boardName}/${layoutId}-${sizeId}`);

  const boardDetails = getBoardDetailsForBoard({
    board_name: boardName,
    layout_id: layoutId,
    size_id: sizeId,
    set_ids: catalogueEntry.setIds,
  });
  const geometry = loadBoardArtGeometry(labBoard);
  if (!geometry) throw new Error(`no board-art-geometry shard for ${boardName}/${layoutId}-${sizeId}`);
  const wallLightness = getWallLightness(labBoard);
  const veilOpacity = wallLightness
    ? veilOpacityFor({
        wallLightness: wallLightness.mean,
        coverage: wallLightness.coverage,
        fieldColor: FIELD_COLOR,
      })
    : 0;

  // Board art composite, built once: dark play field, then every art layer.
  const { boardWidth, boardHeight } = boardDetails;
  const artLayers = getBackgroundRelPaths(boardDetails, false).map((relativePath) => ({
    input: path.join(PUBLIC_DIR, relativePath),
  }));
  const boardArt = await sharp({
    create: { width: boardWidth, height: boardHeight, channels: 4, background: FIELD_COLOR },
  })
    .composite(artLayers)
    .png()
    .toBuffer();
  // For --scale > 1 the overlay rasterizes natively sharp at the scaled size;
  // the photo underneath can only be upscaled.
  const scaledBoardArt =
    renderScale === 1
      ? boardArt
      : await sharp(boardArt)
          .resize(boardWidth * renderScale, boardHeight * renderScale, { kernel: 'lanczos3' })
          .png()
          .toBuffer();

  const boardStates = HOLD_STATE_MAP[boardName];

  for (const climb of climbs) {
    const climbSlug = slugify(climb.name);
    const climbDir = path.join(outDir, climbSlug);
    fs.mkdirSync(climbDir, { recursive: true });

    const buildBaseConfig = (thumbnail: boolean): Record<string, unknown> => {
      const { config } = buildRenderConfig({
        boardName,
        boardDetails,
        frames: climb.frames,
        thumbnail,
        isOgVariant: false,
        boardStates,
        renderMode: 'aura',
        glowFalloff: 'soft',
        // Production thumbnails take the fill under the glow (`glow-fill`);
        // the play view takes the bare glow.
        markStyle: thumbnail ? 'glow-fill' : 'glow',
        ...(veilOpacity > 0 ? { veil: { color: FIELD_COLOR, opacity: veilOpacity } } : {}),
        // The lab layers spill overrides onto the built config, so the unlit
        // neighbour outlines must be present.
        spillNeighbourOutlines: true,
        holdGeometry: {
          outlines: geometry.outlines,
          ledInner: geometry.ledInner,
          ledBright: geometry.ledBright,
          silhouetteLightness: geometry.silhouetteLightness,
        },
      });
      // Mobile prefers the boardsesh display palette (e.g. Tension's lifted
      // HAND blue); the shared builder only knows displayColor. No-op on Kilter.
      const holdStateMap = config.hold_state_map as Record<string, { color: string }>;
      for (const [code, stateInfo] of Object.entries(boardStates)) {
        if (holdStateMap[code]) holdStateMap[code].color = getHoldDisplayColor(stateInfo, 'aura');
      }
      return config as unknown as Record<string, unknown>;
    };

    const fullBase = { ...buildBaseConfig(false), output_width: boardWidth * renderScale };
    const thumbBase = buildBaseConfig(true);
    const cropCenter = cropCenterForClimb(climb.frames, boardDetails.holdsData);
    const scaledCrop = CROP_SIZE * renderScale;
    const cropLeft = Math.max(
      0,
      Math.min(boardWidth * renderScale - scaledCrop, Math.round(cropCenter.cx * renderScale - scaledCrop / 2)),
    );
    const cropTop = Math.max(
      0,
      Math.min(boardHeight * renderScale - scaledCrop, Math.round(cropCenter.cy * renderScale - scaledCrop / 2)),
    );

    const fullPanels: Buffer[] = [];
    const cropPanels: Buffer[] = [];
    const thumbPanels: Buffer[] = [];

    for (const variant of variants) {
      const overlayPath = renderOverlay(mergeOverrides(fullBase, variant.overrides), climbDir, variant.name);
      const composedFull = await sharp(scaledBoardArt)
        .composite([{ input: overlayPath }])
        .png()
        .toBuffer();
      await sharp(composedFull).toFile(path.join(climbDir, `${variant.name}.png`));

      const thumbOverlayPath = renderOverlay(
        mergeOverrides(thumbBase, variant.overrides),
        climbDir,
        `${variant.name}.thumb`,
      );
      const thumbHeight = Math.round((boardHeight / boardWidth) * THUMBNAIL_WIDTH);
      const composedThumb = await sharp(boardArt)
        .resize(THUMBNAIL_WIDTH, thumbHeight, { fit: 'fill' })
        .composite([{ input: thumbOverlayPath }])
        .png()
        .toBuffer();
      await sharp(composedThumb).toFile(path.join(climbDir, `${variant.name}.thumb.png`));

      const panelHeight = Math.round((boardHeight / boardWidth) * PANEL_WIDTH);
      fullPanels.push(
        await sharp(composedFull)
          .resize(PANEL_WIDTH, panelHeight)
          .extend({ top: 40, background: '#0B0B10' })
          .composite([{ input: labelBanner(variant.name, PANEL_WIDTH, 40), top: 0, left: 0 }])
          .png()
          .toBuffer(),
      );
      cropPanels.push(
        await sharp(composedFull)
          .extract({ left: cropLeft, top: cropTop, width: scaledCrop, height: scaledCrop })
          .resize(PANEL_WIDTH, PANEL_WIDTH, { kernel: 'nearest' })
          .png()
          .toBuffer(),
      );
      // Thumbnail arm at the size a list row shows (~76px CSS => 200px raster
      // displayed small); render it 2x for the sheet so banding stays visible.
      thumbPanels.push(
        await sharp(composedThumb)
          .resize(THUMBNAIL_WIDTH * 2, null, { kernel: 'nearest' })
          .png()
          .toBuffer(),
      );
    }

    const panelHeight = Math.round((boardHeight / boardWidth) * PANEL_WIDTH) + 40;
    const gutter = 10;
    const montageWidth = variants.length * (PANEL_WIDTH + gutter) - gutter;
    const thumbPanelHeight = Math.round((boardHeight / boardWidth) * THUMBNAIL_WIDTH * 2);
    const montageHeight = panelHeight + gutter + PANEL_WIDTH + gutter + thumbPanelHeight;
    const rows = [
      { panels: fullPanels, top: 0 },
      { panels: cropPanels, top: panelHeight + gutter },
      { panels: thumbPanels, top: panelHeight + gutter + PANEL_WIDTH + gutter },
    ];
    await sharp({
      create: { width: montageWidth, height: montageHeight, channels: 4, background: '#0B0B10' },
    })
      .composite(
        rows.flatMap((row) =>
          row.panels.map((panel, index) => ({
            input: panel,
            left: index * (PANEL_WIDTH + gutter),
            top: row.top,
          })),
        ),
      )
      .png()
      .toFile(path.join(outDir, `compare-${climbSlug}.png`));
    console.log(`${climb.name}: ${variants.length} variant(s) -> ${path.join(outDir, `compare-${climbSlug}.png`)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
