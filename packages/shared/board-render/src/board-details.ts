// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Boardsesh

import type { BoardName } from '@boardsesh/shared-schema';
import { boardSupportsMirroring } from '@boardsesh/play-view';
import {
  PRODUCT_SIZES,
  getProductSize,
  getLayout,
  getSetsForLayoutAndSize,
  getImageFilename,
  getHolePlacements,
} from '@boardsesh/board-constants/product-sizes';
import {
  BOARD_IMAGE_DIMENSIONS,
  getMoonBoardDetails,
  getWoodsBoardDetails,
  type SetIdList,
} from '@boardsesh/board-config';
import type { BoardRenderDetails, RenderableHold } from './types';

/** Tuple stored per hold in the generated placement tables. */
type HoldTuple = [number, number | null, number, number];

type BoardDetailsParams = {
  board_name: BoardName;
  layout_id: number;
  size_id: number;
  set_ids: SetIdList;
};

/**
 * Compute board geometry + hold placements for an Aurora board (Kilter,
 * Tension, and the smaller Aurora-derived boards). Pure computation, no DB.
 */
export const getBoardDetails = ({
  board_name,
  layout_id,
  size_id,
  set_ids,
}: BoardDetailsParams): BoardRenderDetails => {
  const sizeData = getProductSize(board_name, size_id);
  if (!sizeData) {
    const availableSizes = Object.keys(PRODUCT_SIZES[board_name] || {});
    throw new Error(
      `Size dimensions not found for board_name=${board_name}, size_id=${size_id}. Available sizes: [${availableSizes.join(', ')}]`,
    );
  }

  const layoutData = getLayout(board_name, layout_id);
  const setsResult = getSetsForLayoutAndSize(board_name, layout_id, size_id);

  const imagesToHolds: Record<string, HoldTuple[]> = {};
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

  const holdsData: RenderableHold[] = Object.values(imagesToHolds).flatMap((holds: HoldTuple[]) =>
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

/**
 * Get board details for any board type (Aurora, MoonBoard, or Woods). Routes to
 * `getMoonBoardDetails` for MoonBoard and `getWoodsBoardDetails` for Woods (both
 * carry their own art + hold geometry); to `getBoardDetails` for Aurora boards.
 */
export function getBoardDetailsForBoard(params: {
  board_name: string;
  layout_id: number;
  size_id: number;
  set_ids: SetIdList;
}): BoardRenderDetails {
  if (params.board_name === 'moonboard') {
    return getMoonBoardDetails({
      layout_id: params.layout_id,
      set_ids: params.set_ids,
    });
  }
  if (params.board_name === 'woods') {
    return getWoodsBoardDetails({ size_id: params.size_id });
  }
  return getBoardDetails(params as BoardDetailsParams);
}
