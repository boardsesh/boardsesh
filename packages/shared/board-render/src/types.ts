// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Boardsesh

import type {
  FillConfig,
  GlowFalloff,
  GlowTuningFields,
  GlyphsMode,
  LedCoverConfig,
  MarkStyle,
  VeilConfig,
} from '@boardsesh/board-look';
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
  { color: string; displayColor?: string; boardseshDisplayColor?: string; renderStyle?: string; name?: string }
>;

/**
 * `classic` (default, unset) is today's marker-only overlay — untouched by
 * issue #2202. `aura` draws a veil + glow treatment over traced hold
 * silhouettes; see `docs/ai-design-guidelines.md` for the visual language.
 */
export type RenderMode = 'classic' | 'aura';

/**
 * The `aura` config vocabulary is owned by `@boardsesh/board-look`, which is
 * where the look's tuning lives — the app, the web worker and this pipeline all
 * build the same block from it. Re-exported here so the renderer's own types
 * still read as one vocabulary at the call site.
 */
export type {
  FillConfig,
  GlowFalloff,
  GlowTuningFields,
  GlyphsMode,
  LedCoverConfig,
  MarkStyle,
  VeilConfig,
} from '@boardsesh/board-look';

/** The four hold roles `aura` mode draws a distinct glyph/role treatment for. */
export type HoldRole = 'starting' | 'hand' | 'finish' | 'foot';

/**
 * `RenderableHold` plus the per-hold silhouette geometry `buildRenderConfig`
 * attaches to lit holds (and their mirror partners) in `aura` mode. All of them
 * are optional and only ever set when the caller passes `holdGeometry`, read per
 * board config from `@boardsesh/board-art-geometry`.
 */
export type WasmRenderHold = RenderableHold & {
  /** Flat `[x0, y0, x1, y1, …]` outline, in units of `r` relative to the hold centre. */
  outline?: number[];
  /**
   * Inner boundary of this hold's LED base plate — the hold proper — in the
   * same units and flat, implicitly-closed form as `outline`. The renderer
   * lights `outline` MINUS this ring, which is the part a real board's LED
   * shines through. Set only where somebody has traced the plate; without it
   * the whole silhouette lights, exactly as before.
   */
  led_inner?: number[];
  /** `[dx, dy]` LED position offset, in units of `r` relative to the hold centre. */
  led?: [number, number];
  /** 0–1 lightness of the board photo under this hold's silhouette. */
  silhouette_lightness?: number;
};

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
  /**
   * Multiplies the renderer's base hold-marker size. Optional — defaults to
   * 1.0 when omitted, same as mobile's accessibility shape-size override
   * (`DEFAULT_HOLD_SHAPE_SIZE` in `packages/mobile/src/lib/hold-color-overrides.ts`).
   * `buildRenderConfig` always emits 1 explicitly so web/OG share mobile's
   * default rather than relying on the renderer's own (issue #2202 drift fix).
   */
  shape_size_multiplier?: number;
  /**
   * Set only in `aura` mode — see `RenderMode`. Unset (classic) renders exactly
   * as before. The whole block comes from `buildAuraRenderFields`
   * (`@boardsesh/board-look`), so every renderer sends the same tuning.
   */
  render_mode?: RenderMode;
  veil?: VeilConfig;
  mark_style?: MarkStyle;
  glow_falloff?: GlowFalloff;
  /** Glow geometry — the Rust `GlowTuning` fields. Omitted fields stay at their neutral defaults. */
  glow?: GlowTuningFields;
  /** The role-colour fill drawn over the silhouette (`fill` and `glow-fill`). */
  fill?: FillConfig;
  glyphs?: GlyphsMode;
  led_cover?: LedCoverConfig;
  holds: WasmRenderHold[];
  hold_state_map: Record<number, { color: string; renderStyle?: string; role?: HoldRole }>;
};
