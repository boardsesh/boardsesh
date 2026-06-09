import { getProductSize, getImageFilename, getHolePlacements } from '@boardsesh/board-constants/product-sizes';
import { BOARD_IMAGE_DIMENSIONS, MOONBOARD_SIZE, getMoonBoardDetails } from '@boardsesh/board-config';
import type { BoardName } from '@boardsesh/shared-schema';
import type { HoldPlacement } from '../components/board-renderer/types';
import { WEB_BASE_URL } from './env';

type BoardRenderData = {
  boardWidth: number;
  boardHeight: number;
  // Board playing-surface edges in placement-grid coordinates (the `edge_*`
  // columns / BoardDetails). The zone search filter maps its grid-space box to
  // SVG pixels through these.
  edgeLeft: number;
  edgeRight: number;
  edgeBottom: number;
  edgeTop: number;
  imageUrls: string[];
  holdsData: HoldPlacement[];
};

// `getBoardRenderData` is pure but does O(n) work over ~1400 hold tuples (a
// filter plus per-hold coordinate math) on the PlayDrawer-open critical path and
// on every carousel swap. The underlying placement data is static, so memoize by
// board-config key. A session only ever touches a handful of distinct boards;
// the cap just bounds memory if a picker churns through many.
const RENDER_DATA_CACHE_LIMIT = 16;
const renderDataCache = new Map<string, BoardRenderData | null>();

/**
 * Computes board rendering data (dimensions, image URLs, hold positions)
 * from board config parameters. Mirrors the web's `getBoardDetails()`.
 * Cached by board config — the placement data behind it never changes.
 */
export function getBoardRenderData(params: {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: number[];
}): BoardRenderData | null {
  const { boardName, layoutId, sizeId, setIds } = params;

  const cacheKey = `${boardName}-${layoutId}-${sizeId}-${setIds.join(',')}`;
  const cached = renderDataCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const result = computeBoardRenderData(params);
  if (renderDataCache.size >= RENDER_DATA_CACHE_LIMIT) {
    const oldestKey = renderDataCache.keys().next().value;
    if (oldestKey !== undefined) renderDataCache.delete(oldestKey);
  }
  renderDataCache.set(cacheKey, result);
  return result;
}

/**
 * Clears the render-data memo. Production never needs this (the placement data
 * behind a board key is static), but tests mock different board data under the
 * same config key and must reset between cases.
 */
export function clearBoardRenderDataCache(): void {
  renderDataCache.clear();
}

function computeBoardRenderData(params: {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: number[];
}): BoardRenderData | null {
  const { boardName, layoutId, sizeId, setIds } = params;

  if (boardName === 'moonboard') {
    return getMoonBoardRenderData({ layoutId, sizeId, setIds });
  }

  const sizeData = getProductSize(boardName, sizeId);
  if (!sizeData) return null;

  const { edgeLeft, edgeRight, edgeBottom, edgeTop } = sizeData;

  const imageFilenames: string[] = [];
  const allHoldTuples: Array<[number, number | null, number, number]> = [];

  for (const setId of setIds) {
    const imageFilename = getImageFilename(boardName, layoutId, sizeId, setId);
    if (!imageFilename) continue;

    imageFilenames.push(imageFilename);
    const holdTuples = getHolePlacements(boardName, layoutId, setId);
    allHoldTuples.push(...holdTuples);
  }

  if (imageFilenames.length === 0) return null;

  const firstImageFilename = imageFilenames[0];
  const dimensions = BOARD_IMAGE_DIMENSIONS[boardName]?.[firstImageFilename];
  const boardWidth = dimensions?.width ?? 1080;
  const boardHeight = dimensions?.height ?? 1920;

  const xSpacing = boardWidth / (edgeRight - edgeLeft);
  const ySpacing = boardHeight / (edgeTop - edgeBottom);

  const holdsData: HoldPlacement[] = allHoldTuples
    .filter(([, , x, y]) => x > edgeLeft && x < edgeRight && y > edgeBottom && y < edgeTop)
    .map(([holdId, mirroredHoldId, x, y]) => ({
      id: holdId,
      mirroredHoldId,
      cx: (x - edgeLeft) * xSpacing,
      cy: boardHeight - (y - edgeBottom) * ySpacing,
      r: xSpacing * 4,
    }));

  const imageUrls = imageFilenames.map((filename) => `${WEB_BASE_URL}/images/${boardName}/${filename}`);

  return { boardWidth, boardHeight, edgeLeft, edgeRight, edgeBottom, edgeTop, imageUrls, holdsData };
}

function getMoonBoardRenderData(params: {
  layoutId: number;
  sizeId: number;
  setIds: number[];
}): BoardRenderData | null {
  const { layoutId, sizeId, setIds } = params;
  if (sizeId !== MOONBOARD_SIZE.id) return null;

  try {
    const details = getMoonBoardDetails({ layout_id: layoutId, set_ids: setIds });
    const imageUrls = Object.keys(details.images_to_holds).map(
      (filename) => `${WEB_BASE_URL}/images/moonboard/${filename}`,
    );
    const holdsData: HoldPlacement[] = details.holdsData.map((hold) => ({
      id: hold.id,
      mirroredHoldId: hold.mirroredHoldId,
      cx: hold.cx,
      cy: hold.cy,
      r: hold.r,
    }));

    return {
      boardWidth: details.boardWidth,
      boardHeight: details.boardHeight,
      edgeLeft: details.edge_left,
      edgeRight: details.edge_right,
      edgeBottom: details.edge_bottom,
      edgeTop: details.edge_top,
      imageUrls,
      holdsData,
    };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(
      '[board-details] MoonBoard render data unavailable:',
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

export function getBoardAspectRatio(params: {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: number[];
}): number {
  const { boardName, layoutId, sizeId, setIds } = params;

  if (boardName === 'moonboard') {
    const renderData = getBoardRenderData(params);
    return renderData ? renderData.boardWidth / renderData.boardHeight : 1080 / 1920;
  }

  for (const setId of setIds) {
    const imageFilename = getImageFilename(boardName, layoutId, sizeId, setId);
    if (!imageFilename) continue;

    const dimensions = BOARD_IMAGE_DIMENSIONS[boardName]?.[imageFilename];
    if (dimensions) {
      return dimensions.width / dimensions.height;
    }
  }

  return 1080 / 1920;
}
