import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { HOLD_STATE_MAP } from '../packages/board-constants/src/hold-states';
import { loadBoardArtGeometry, getWallLightness } from '../packages/shared/board-art-geometry/src/loader';
import { getBoardDetailsForBoard } from '../packages/shared/board-render/src/board-details';
import { buildRenderConfig } from '../packages/shared/board-render/src/render-config';
import {
  listCatalogueEntries,
  type CatalogueEntry,
} from '../packages/shared/board-render/src/render-version-projection';

/** Same catalogue, calibrated roles and full-resolution geometry as the app. */
export function buildCatalogueGpuConfig(entry: CatalogueEntry) {
  const boardDetails = getBoardDetailsForBoard({
    board_name: entry.boardName,
    layout_id: entry.layoutId,
    size_id: entry.sizeId,
    set_ids: entry.setIds,
  });
  const geometry = loadBoardArtGeometry(entry);
  if (!geometry) throw new Error(`Missing geometry: ${entry.boardName}/${entry.layoutId}-${entry.sizeId}`);
  const { config } = buildRenderConfig({
    boardName: entry.boardName,
    boardDetails,
    frames: '',
    thumbnail: false,
    isOgVariant: false,
    boardStates: HOLD_STATE_MAP[entry.boardName],
    renderMode: 'aura',
    fieldColor: '#181225',
    wallLightness: getWallLightness(entry),
    holdGeometry: geometry,
  });
  // The normal PNG builder only needs lit outlines. An atlas needs all holds.
  return {
    ...config,
    output_width: boardDetails.boardWidth,
    holds: boardDetails.holdsData.map((hold) => ({
      id: hold.id,
      mirroredHoldId: hold.mirroredHoldId,
      cx: hold.cx,
      cy: hold.cy,
      r: hold.r,
      ...(geometry.outlines[hold.id] ? { outline: geometry.outlines[hold.id] } : {}),
      ...(geometry.ledInner?.[hold.id] ? { led_inner: geometry.ledInner[hold.id] } : {}),
      ...(geometry.ledBright[hold.id] ? { led: geometry.ledBright[hold.id] } : {}),
      ...(geometry.silhouetteLightness[hold.id] !== undefined
        ? { silhouette_lightness: geometry.silhouetteLightness[hold.id] }
        : {}),
    })),
  };
}

const CATALOGUE_CONFIGURATION_COUNT = 51;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_ASSEMBLED_GPU_BYTES = 128 * 1024 * 1024;

function validateAtlasReport(
  report: Record<string, unknown>,
  expected: { width: number; height: number; holds: number },
): string[] {
  const failures: string[] = [];
  const integer = (candidate: unknown): candidate is number =>
    typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0;
  if (report.width !== expected.width || report.height !== expected.height) failures.push('Native resolution changed');
  if (!integer(report.width) || report.width > 1536 || !integer(report.height) || report.height > 2304) {
    failures.push('Dimensions exceed native bounds');
  }
  if (report.holds !== expected.holds || expected.holds > 1024) failures.push('Catalogue holds were omitted');
  if (!integer(report.manifestBytes) || report.manifestBytes > MAX_MANIFEST_BYTES)
    failures.push('Manifest exceeds 4 MiB');
  if (
    !integer(report.atlasBytes) ||
    !integer(report.assembledGpuBytes) ||
    report.assembledGpuBytes !== report.atlasBytes + 257 * 4 ||
    report.assembledGpuBytes > MAX_ASSEMBLED_GPU_BYTES
  )
    failures.push('Requested static GPU buffers exceed 128 MiB or do not reconcile');
  if (report.descriptorBytesPerHold !== 224) failures.push('Unexpected dynamic descriptor stride');
  if (typeof report.hostPrepareMs !== 'number' || !Number.isFinite(report.hostPrepareMs) || report.hostPrepareMs < 0) {
    failures.push('Missing host preparation measurement');
  }
  return failures;
}

function main() {
  const outputArgument = process.argv.indexOf('--out');
  if (outputArgument >= 0 && (!process.argv[outputArgument + 1] || process.argv[outputArgument + 1].startsWith('--'))) {
    throw new Error('--out requires a directory');
  }
  const outputDirectory = resolve(outputArgument < 0 ? '/tmp/boardsesh-aura-census' : process.argv[outputArgument + 1]);
  mkdirSync(outputDirectory, { recursive: true });
  const entries = listCatalogueEntries();
  const configsOnly = process.argv.includes('--configs-only');
  const baseline = process.argv.includes('--baseline');
  const rows = entries.map((entry) => {
    const identity = `${entry.boardName}-${entry.layoutId}-${entry.sizeId}`;
    const configPath = resolve(outputDirectory, `${identity}.json`);
    try {
      const config = buildCatalogueGpuConfig(entry);
      writeFileSync(configPath, `${JSON.stringify(config)}\n`);
      if (configsOnly) return { ...entry, configPath };
      const invocation = spawnSync(
        'vp',
        [
          'exec',
          'cargo',
          'run',
          '--quiet',
          '--release',
          '--manifest-path',
          'packages/board-renderer/core/Cargo.toml',
          '--example',
          'prepare_gpu_atlas',
          '--',
          configPath,
        ],
        { encoding: 'utf8' },
      );
      if (invocation.status !== 0)
        throw new Error(invocation.stderr.trim() || invocation.error?.message || 'Atlas preparation failed');
      const parsed: unknown = JSON.parse(invocation.stdout);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid atlas report');
      const result = parsed as Record<string, unknown>;
      const failures = baseline
        ? []
        : validateAtlasReport(result, {
            width: config.output_width,
            height: Math.round((config.output_width * config.board_height) / config.board_width),
            holds: config.holds.length,
          });
      const row = { ...entry, ...result, ...(failures.length > 0 ? { error: failures.join('; ') } : {}) };
      console.log(JSON.stringify(row));
      return row;
    } catch (error) {
      const row = { ...entry, error: error instanceof Error ? error.message : 'Atlas census failed' };
      console.log(JSON.stringify(row));
      return row;
    }
  });
  const failed = rows.filter((row) => 'error' in row).length;
  const complete = entries.length === CATALOGUE_CONFIGURATION_COUNT;
  writeFileSync(
    resolve(outputDirectory, 'census.json'),
    `${JSON.stringify(
      {
        mode: configsOnly ? 'configs-only' : baseline ? 'baseline' : 'candidate',
        entries: rows.length,
        expectedEntries: CATALOGUE_CONFIGURATION_COUNT,
        failed,
        passed: !configsOnly && !baseline && complete && failed === 0,
        limits: { manifestBytes: MAX_MANIFEST_BYTES, assembledGpuBytes: MAX_ASSEMBLED_GPU_BYTES },
        rows,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Wrote ${entries.length} catalogue configurations to ${outputDirectory}`);
  if (!complete || (!baseline && failed > 0)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
