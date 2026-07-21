import { AURORA_BOARDS, SUPPORTED_BOARDS, type AuroraBoardName } from '@boardsesh/shared-schema';
import { getBoardDetails as computeBoardDetails } from '@boardsesh/board-render';
import type { BoardDetails } from '@/app/lib/types';
import type { SetIdList } from '@/app/lib/board-data';
import type { BoardName } from './types';

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

// The Aurora board-details computation lives in the shared @boardsesh/board-render
// package (also consumed by the always-on backend OG renderer). Web keeps this
// export + its BoardDetails return type so every existing importer is unchanged.
export const getBoardDetails = (params: {
  board_name: BoardName;
  layout_id: number;
  size_id: number;
  set_ids: SetIdList;
}): BoardDetails => computeBoardDetails(params);
