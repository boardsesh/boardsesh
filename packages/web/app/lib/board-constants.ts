import { AURORA_BOARDS, SUPPORTED_BOARDS, type AuroraBoardName } from '@boardsesh/shared-schema';
import { boardSupportsMirroring } from '@boardsesh/play-view';
import type { HoldRenderData } from '@/app/components/board-renderer/types';
import type { BoardDetails, ImageFileName } from '@/app/lib/types';
import type { SetIdList } from '@/app/lib/board-data';
import {
  PRODUCT_SIZES,
  getProductSize,
  getLayout,
  getSetsForLayoutAndSize,
  getImageFilename,
  getHolePlacements,
} from '@boardsesh/board-constants/product-sizes';
import { BOARD_IMAGE_DIMENSIONS } from './board-data';
import type { BoardName, HoldTuple } from './types';

export * from '@boardsesh/board-constants/product-sizes';

export const AURORA_BOARD_NAMES = [...AURORA_BOARDS];

/** Default board configs for preview thumbnails when the exact board config is unknown. */
export const FALLBACK_BOARD_PREVIEW_CONFIGS: Record<string, { layout_id: number; size_id: number; set_ids: number[] }> =
  {
    kilter: { layout_id: 1, size_id: 10, set_ids: [1, 20] },
    tension: { layout_id: 1, size_id: 10, set_ids: [1] },
    decoy: { layout_id: 2, size_id: 1, set_ids: [1, 2] },
    touchstone: { layout_id: 1, size_id: 1, set_ids: [1] },
    grasshopper: { layout_id: 1, size_id: 4, set_ids: [1, 2] },
    soill: { layout_id: 1, size_id: 1, set_ids: [1] },
  };
// KILTER_HOMEWALL_LAYOUT_ID / KILTER_HOMEWALL_PRODUCT_ID are re-exported above
// via `export * from '@boardsesh/board-constants/product-sizes'`.
export const BOARD_NAME_PREFIX_REGEX = new RegExp(`^(?:${SUPPORTED_BOARDS.join('|')})\\s*(?:board)?\\s*`, 'i');

export function isAuroraBoardName(boardName: string): boardName is AuroraBoardName {
  return AURORA_BOARD_NAMES.includes(boardName as AuroraBoardName);
}

export const getBoardDetails = ({
  board_name,
  layout_id,
  size_id,
  set_ids,
}: {
  board_name: BoardName;
  layout_id: number;
  size_id: number;
  set_ids: SetIdList;
}): BoardDetails => {
  const sizeData = getProductSize(board_name, size_id);
  if (!sizeData) {
    const availableSizes = Object.keys(PRODUCT_SIZES[board_name] || {});
    throw new Error(
      `Size dimensions not found for board_name=${board_name}, size_id=${size_id}. Available sizes: [${availableSizes.join(', ')}]`,
    );
  }

  const layoutData = getLayout(board_name, layout_id);
  const setsResult = getSetsForLayoutAndSize(board_name, layout_id, size_id);

  const imagesToHolds: Record<ImageFileName, HoldTuple[]> = {};
  for (const setId of set_ids) {
    const imageFilename = getImageFilename(board_name, layout_id, size_id, setId);
    if (!imageFilename) {
      throw new Error(`Could not find image for set_id ${setId} for layout_id: ${layout_id} and size_id: ${size_id}`);
    }
    imagesToHolds[imageFilename] = getHolePlacements(board_name, layout_id, setId);
  }

  const { edgeLeft: edge_left, edgeRight: edge_right, edgeBottom: edge_bottom, edgeTop: edge_top } = sizeData;

  const firstImage = Object.keys(imagesToHolds)[0];
  const dimensions = BOARD_IMAGE_DIMENSIONS[board_name][firstImage];
  const boardWidth = dimensions?.width ?? 1080;
  const boardHeight = dimensions?.height ?? 1920;

  const xSpacing = boardWidth / (edge_right - edge_left);
  const ySpacing = boardHeight / (edge_top - edge_bottom);

  const holdsData: HoldRenderData[] = Object.values(imagesToHolds).flatMap((holds: HoldTuple[]) =>
    holds
      .filter(([, , x, y]) => x > edge_left && x < edge_right && y > edge_bottom && y < edge_top)
      .map(([holdId, mirroredHoldId, x, y]) => ({
        id: holdId,
        mirroredHoldId,
        cx: (x - edge_left) * xSpacing,
        cy: boardHeight - (y - edge_bottom) * ySpacing,
        r: xSpacing * 4,
      })),
  );

  const selectedSets = setsResult.filter((set) => set_ids.includes(set.id));

  return {
    images_to_holds: imagesToHolds,
    holdsData,
    edge_left,
    edge_right,
    edge_bottom,
    edge_top,
    boardHeight,
    boardWidth,
    board_name,
    layout_id,
    size_id,
    set_ids,
    supportsMirroring: boardSupportsMirroring(board_name, layout_id),
    layout_name: layoutData?.name,
    size_name: sizeData.name,
    size_description: sizeData.description,
    set_names: selectedSets.map((set) => set.name),
  };
};
