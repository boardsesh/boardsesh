import type { BoardName } from '@boardsesh/shared-schema';
import type { SetIdList } from '@boardsesh/board-config';

/** Minimal hold shape the WASM overlay config consumes. */
export type RenderableHold = {
  id: number;
  mirroredHoldId: number | null;
  cx: number;
  cy: number;
  r: number;
};

/**
 * Structural subset of board details the render pipeline reads. Web's
 * `BoardDetails` and the shared `getBoardDetails` / `getMoonBoardDetails`
 * results all satisfy this — the renderer never touches the metadata fields
 * (layout_name, size_name, …), only geometry + background image keys.
 */
export type RenderableBoardDetails = {
  board_name: string;
  boardWidth: number;
  boardHeight: number;
  holdsData: RenderableHold[];
  images_to_holds: Record<string, unknown>;
  layoutFolder?: string;
  holdSetImages?: string[];
};

/**
 * Full board details returned by `getBoardDetails` / `getBoardDetailsForBoard`.
 * Field-for-field compatible with web's `BoardDetails` so web can re-export the
 * shared implementation without changing its public surface.
 */
export type BoardRenderDetails = {
  images_to_holds: Record<string, Array<[number, number | null, number, number]>>;
  holdsData: RenderableHold[];
  edge_left: number;
  edge_right: number;
  edge_bottom: number;
  edge_top: number;
  boardHeight: number;
  boardWidth: number;
  board_name: BoardName;
  layout_id: number;
  size_id: number;
  set_ids: SetIdList;
  supportsMirroring?: boolean;
  layout_name?: string;
  size_name?: string;
  size_description?: string;
  set_names?: string[];
  layoutFolder?: string;
  holdSetImages?: string[];
};

export type OutputFormat = 'webp' | 'png' | 'jpeg';

/** Per-board hold-state colour/style map (subset of board-constants HoldStateInfo). */
export type HoldStateRecord = Record<
  number | string,
  { color: string; displayColor?: string; displayColorDark?: string; renderStyle?: string; name?: string }
>;

/** The JSON payload the WASM `render_overlay` entry point consumes. */
export type WasmRenderConfig = {
  board_name: string;
  board_width: number;
  board_height: number;
  output_width: number;
  frames: string;
  mirrored: boolean;
  thumbnail: boolean;
  /**
   * Multiplies the renderer's base hold-outline stroke width (clamped
   * 0.5–2.0 by the renderer itself). Optional — the Rust/WASM renderer
   * defaults to 1.0 when omitted. See `getBoardStrokeWidthMultiplier`
   * (issue #2202: Grasshopper's darker, busier board photo needs a heavier
   * default outline to stay legible).
   */
  stroke_width_multiplier?: number;
  holds: RenderableHold[];
  hold_state_map: Record<number, { color: string; renderStyle?: string }>;
};
