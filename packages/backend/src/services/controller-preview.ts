import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getLedPlacements } from '@boardsesh/board-constants/led-placements';
import { getSetsForLayoutAndSize } from '@boardsesh/board-constants/product-sizes';
import { getMoonboardSerialPosition } from '@boardsesh/ble-protocol/moonboard';
import {
  getMoonBoardGeometryByLayoutId,
  MOONBOARD_LAYOUTS,
  MOONBOARD_SETS,
  MOONBOARD_SIZE,
} from '@boardsesh/board-config';
import { BoundedLru, createSemaphore, getBackgroundRelPaths, getBoardDetailsForBoard } from '@boardsesh/board-render';
import { composeBoardBaseBuffer } from '@boardsesh/board-render/pipeline';
import sharp from 'sharp';

export const CONTROLLER_PREVIEW_VERSION = 1;
export const CONTROLLER_PREVIEW_MAX_IMAGE_BYTES = 64 * 1024;
export const CONTROLLER_PREVIEW_MAX_POSITIONS = 1024;
const MAX_DIMENSION = 330;
const PREVIEW_PATH = '/render/controller-preview';
export type ControllerPreviewConfig = {
  boardName: 'kilter' | 'tension' | 'moonboard';
  layoutId: number;
  sizeId: number;
  setIds: string;
};
export type ControllerPreviewPosition = { wirePosition: number; x: number; y: number; radius: number };
export type ControllerPreviewAsset = {
  image: Buffer;
  geometry: Buffer;
  width: number;
  height: number;
  positionCount: number;
  imageSha256: string;
  geometrySha256: string;
};

const assets = new BoundedLru<ControllerPreviewAsset>({
  maxEntries: 64,
  maxBytes: 8 * 1024 * 1024,
  sizeOf: (asset) => asset.image.length + asset.geometry.length,
});
const inFlight = new Map<string, Promise<ControllerPreviewAsset>>();
const generation = createSemaphore(2);

/** A catalog-only key; no climb frames, remote URLs or board identities enter it. */
export function normalizeControllerPreviewConfig(input: {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
}): ControllerPreviewConfig {
  const { boardName, layoutId, sizeId, setIds } = input;
  if (
    !['kilter', 'tension', 'moonboard'].includes(boardName) ||
    !Number.isSafeInteger(layoutId) ||
    layoutId <= 0 ||
    !Number.isSafeInteger(sizeId) ||
    sizeId <= 0 ||
    setIds.length > 128 ||
    !/^\d+(,\d+)*$/.test(setIds)
  ) {
    throw new Error('Unsupported controller preview configuration');
  }
  const selectedIds = [...new Set(setIds.split(',').map(Number))].sort((left, right) => left - right);
  if (selectedIds.length > 16 || selectedIds.some((setId) => !Number.isSafeInteger(setId) || setId <= 0)) {
    throw new Error('Invalid controller preview hold sets');
  }
  const supportedName = boardName as ControllerPreviewConfig['boardName'];
  let availableIds: Set<number>;
  if (supportedName === 'moonboard') {
    const layout = Object.entries(MOONBOARD_LAYOUTS).find(([, entry]) => entry.id === layoutId);
    if (!layout || sizeId !== MOONBOARD_SIZE.id) throw new Error('Unknown MoonBoard preview configuration');
    availableIds = new Set(MOONBOARD_SETS[layout[0] as keyof typeof MOONBOARD_SETS].map((set) => set.id));
  } else {
    availableIds = new Set(getSetsForLayoutAndSize(supportedName, layoutId, sizeId).map((set) => set.id));
  }
  if (selectedIds.some((setId) => !availableIds.has(setId))) throw new Error('Unknown controller preview hold set');
  return { boardName: supportedName, layoutId, sizeId, setIds: selectedIds.join(',') };
}

export function encodeControllerGeometry(
  width: number,
  height: number,
  positions: ControllerPreviewPosition[],
): Buffer {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    positions.length === 0 ||
    positions.length > CONTROLLER_PREVIEW_MAX_POSITIONS
  )
    throw new Error('Invalid controller geometry dimensions');
  const sorted = [...positions].sort((left, right) => left.wirePosition - right.wirePosition);
  const geometry = Buffer.alloc(12 + sorted.length * 8);
  geometry.write('BSGM', 0, 'ascii');
  geometry.writeUInt16LE(CONTROLLER_PREVIEW_VERSION, 4);
  geometry.writeUInt16LE(sorted.length, 6);
  geometry.writeUInt16LE(width, 8);
  geometry.writeUInt16LE(height, 10);
  sorted.forEach((position, index) => {
    const { wirePosition, x, y, radius } = position;
    if (
      ![wirePosition, x, y, radius].every(Number.isInteger) ||
      wirePosition < 0 ||
      wirePosition > 65535 ||
      x < 0 ||
      x >= width ||
      y < 0 ||
      y >= height ||
      radius < 1 ||
      radius > MAX_DIMENSION ||
      (index > 0 && sorted[index - 1].wirePosition === wirePosition)
    )
      throw new Error('Invalid controller geometry position');
    const offset = 12 + index * 8;
    geometry.writeUInt16LE(wirePosition, offset);
    geometry.writeUInt16LE(x, offset + 2);
    geometry.writeUInt16LE(y, offset + 4);
    geometry.writeUInt16LE(radius, offset + 6);
  });
  return geometry;
}

export function controllerPreviewGeometry(config: ControllerPreviewConfig) {
  const details = getBoardDetailsForBoard({
    board_name: config.boardName,
    layout_id: config.layoutId,
    size_id: config.sizeId,
    set_ids: config.setIds.split(',').map(Number),
  });
  const scale = Math.min(MAX_DIMENSION / details.boardWidth, MAX_DIMENSION / details.boardHeight);
  const width = Math.max(1, Math.round(details.boardWidth * scale));
  const height = Math.max(1, Math.round(details.boardHeight * scale));
  const placements =
    config.boardName === 'moonboard' ? null : getLedPlacements(config.boardName, config.layoutId, config.sizeId);
  const numRows = getMoonBoardGeometryByLayoutId(config.layoutId).numRows;
  const byPosition = new Map<number, ControllerPreviewPosition>();
  for (const hold of details.holdsData) {
    const wirePosition =
      config.boardName === 'moonboard' ? getMoonboardSerialPosition(hold.id, numRows) : placements?.[hold.id];
    if (wirePosition === undefined) continue;
    const position = {
      wirePosition,
      x: Math.min(width - 1, Math.max(0, Math.round((hold.cx * width) / details.boardWidth))),
      y: Math.min(height - 1, Math.max(0, Math.round((hold.cy * height) / details.boardHeight))),
      radius: Math.max(2, Math.round((hold.r * width) / details.boardWidth)),
    };
    const previous = byPosition.get(wirePosition);
    if (previous && (previous.x !== position.x || previous.y !== position.y))
      throw new Error('Ambiguous controller LED geometry');
    byPosition.set(wirePosition, position);
  }
  const positions = [...byPosition.values()];
  return { details, width, height, positions, geometry: encodeControllerGeometry(width, height, positions) };
}

async function generateControllerPreview(config: ControllerPreviewConfig): Promise<ControllerPreviewAsset> {
  const { details, width, height, positions, geometry } = controllerPreviewGeometry(config);
  const imagesRoot = process.env.BOARD_IMAGES_ROOT || resolve(import.meta.dirname, '../../../web/public');
  const paths = getBackgroundRelPaths(details, false);
  if (paths.length === 0 || paths.some((path) => !existsSync(resolve(imagesRoot, path)))) {
    throw new Error('Controller preview catalog art is unavailable');
  }
  const base = await composeBoardBaseBuffer({
    boardDetails: details,
    width,
    height,
    thumbnail: false,
    dimBackground: 0,
    resolveImagePath: (path) => resolve(imagesRoot, path),
  });
  if (!base) throw new Error('Controller preview catalog art could not be decoded');
  let image: Buffer | undefined;
  for (const quality of [85, 70, 55, 40, 25]) {
    image = await sharp(base, { raw: { width, height, channels: 4 } })
      .flatten({ background: '#181225' })
      .jpeg({ quality, progressive: false, chromaSubsampling: '4:2:0' })
      .toBuffer();
    if (image.length <= CONTROLLER_PREVIEW_MAX_IMAGE_BYTES) break;
  }
  if (!image || image.length > CONTROLLER_PREVIEW_MAX_IMAGE_BYTES)
    throw new Error('Controller preview exceeds image budget');
  return {
    image,
    geometry,
    width,
    height,
    positionCount: positions.length,
    imageSha256: createHash('sha256').update(image).digest('hex'),
    geometrySha256: createHash('sha256').update(geometry).digest('hex'),
  };
}

export function getControllerPreview(configInput: ControllerPreviewConfig): Promise<ControllerPreviewAsset> {
  const config = normalizeControllerPreviewConfig(configInput);
  const key = `${config.boardName}/${config.layoutId}/${config.sizeId}/${config.setIds}`;
  const cached = assets.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = inFlight.get(key);
  if (pending) return pending;
  if (inFlight.size >= 12) return Promise.reject(new Error('Controller preview queue is full'));
  const requested = generation
    .run(async () => {
      const preview = await generateControllerPreview(config);
      assets.set(key, preview);
      return preview;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, requested);
  return requested;
}

export function controllerPreviewDescriptor(config: ControllerPreviewConfig, asset: ControllerPreviewAsset) {
  const base = process.env.CONTROLLER_PREVIEW_BASE_URL || 'https://ws.boardsesh.com';
  const assetUrl = (kind: string, hash: string) => {
    const url = new URL(PREVIEW_PATH, base);
    url.search = new URLSearchParams({
      board_name: config.boardName,
      layout_id: String(config.layoutId),
      size_id: String(config.sizeId),
      set_ids: config.setIds,
      kind,
      v: hash,
    }).toString();
    return url.toString();
  };
  return {
    imageUrl: assetUrl('image', asset.imageSha256),
    geometryUrl: assetUrl('geometry', asset.geometrySha256),
    imageSha256: asset.imageSha256,
    geometrySha256: asset.geometrySha256,
    imageBytes: asset.image.length,
    geometryBytes: asset.geometry.length,
    width: asset.width,
    height: asset.height,
    positionCount: asset.positionCount,
  };
}
