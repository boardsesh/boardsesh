/** Default configs warmed after WASM initialisation, and the board a gym card draws when it has no photo. */
export const FALLBACK_BOARD_PREVIEW_CONFIGS: Record<string, { layout_id: number; size_id: number; set_ids: number[] }> =
  {
    kilter: { layout_id: 1, size_id: 10, set_ids: [1, 20] },
    tension: { layout_id: 10, size_id: 10, set_ids: [12, 13, 14, 15] },
    moonboard: { layout_id: 2, size_id: 1, set_ids: [2, 3, 4] },
    decoy: { layout_id: 2, size_id: 1, set_ids: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20] },
    touchstone: { layout_id: 1, size_id: 1, set_ids: [1] },
    grasshopper: { layout_id: 1, size_id: 4, set_ids: [1, 2] },
    soill: { layout_id: 1, size_id: 1, set_ids: [1] },
    woods: { layout_id: 1, size_id: 2, set_ids: [1] },
  };
