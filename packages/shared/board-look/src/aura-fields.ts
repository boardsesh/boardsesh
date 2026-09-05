// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Boardsesh

import {
  AURA_GLOW_TUNING,
  BOARDSESH_SMALL_HOLD_MAX_BOOST,
  BOARDSESH_SMALL_HOLD_NO_BOOST,
  BOARDSESH_SOFT_DISC_OPACITY,
  type BoardseshRenderSettings,
  type GlowFalloffSetting,
} from './settings';

/** The glow's alpha curve. The renderer defaults to `soft` when omitted. */
export type GlowFalloff = 'soft' | 'plateau';

/** How a lit hold is marked. The renderer defaults to `glow` when omitted. */
export type MarkStyle = 'glow' | 'glow-fill' | 'fill' | 'none';

/** Role glyph (shape-per-role) overlay inside the glow. */
export type GlyphsMode = 'off' | 'role';

/** Translucent wash of the play-field colour over the whole board. */
export type VeilConfig = { color: string; opacity: number };

/** A ring drawn under a hold's LED position. `{}` takes the renderer's own tuned cover. */
export type LedCoverConfig = { radius_fraction?: number; color?: string; opacity?: number };

/**
 * The glow geometry the config carries, as the Rust `GlowTuning` field names.
 * Every field the drawing does not name stays at its neutral Rust default.
 */
export type GlowTuningFields = {
  reach_scale: number;
  plateau_share: number;
  disc_opacity: number;
  small_hold_max_boost: number;
  spread_fraction?: number;
  merge_softness?: number;
  seam_blend_fraction?: number;
  seam_sharpness?: number;
  fringe_deepen?: number;
};

/** The role-colour fill drawn over the silhouette (`fill` and `glow-fill`). */
export type FillConfig = { opacity: number };

/** Everything an Aura render config carries that a classic one does not. */
export type AuraRenderFields = {
  render_mode: 'aura';
  veil?: VeilConfig;
  mark_style: MarkStyle;
  glow_falloff: GlowFalloff;
  glow: GlowTuningFields;
  fill: FillConfig;
  glyphs: GlyphsMode;
  led_cover?: LedCoverConfig;
};

export type AuraRenderFieldsInput = {
  settings: BoardseshRenderSettings;
  /**
   * The falloff, straight from the setting. `'default'` is collapsed here rather
   * than by each caller: it is not a value the renderer understands, and a
   * caller that forgot to resolve it would have handed the string through to
   * Rust with no type error to catch it.
   */
  glowFalloff: GlowFalloffSetting;
  /** The play field the veil washes toward, `#rrggbb`. */
  fieldColor: string;
  /** Already resolved through `resolveVeilOpacity`; 0 omits the veil entirely. */
  veilOpacity: number;
  /**
   * The thumbnail treatment: a bare glow reads faint once scaled to ~76px, and
   * the wider distance field the glow bundle needs is ~2.5× the render for a
   * difference invisible at 200px.
   */
  thumbnail: boolean;
  /** Whether this board's art paints LED pips bright anywhere — see `led_cover`. */
  hasLedOffsets: boolean;
};

/**
 * The board-level half of an Aura render config — everything that is not per
 * hold.
 *
 * One implementation for every renderer: the mobile native module, the web
 * worker's WASM build and the backend's. Before this was shared, the server
 * emitted only `render_mode`/`glow_falloff`/`glyphs` and rode the Rust neutral
 * defaults, so an OG card drew a flatter glow than the app did from the same
 * climb.
 */
export function buildAuraRenderFields({
  settings,
  glowFalloff,
  fieldColor,
  veilOpacity,
  thumbnail,
  hasLedOffsets,
}: AuraRenderFieldsInput): AuraRenderFields {
  return {
    render_mode: 'aura',
    // Omitted entirely at zero rather than sent as `opacity: 0`: a light-mode
    // field is brighter than every board's wall, so there is nothing to quiet.
    ...(veilOpacity > 0 ? { veil: { color: fieldColor, opacity: veilOpacity } } : {}),
    // `'fill'` maps to `'glow-fill'`, not a bare fill, on purpose: the spike
    // measured the filled thumbnail WITH its own small glow (the "veil + tint"
    // arm) as the winner, not the fill alone.
    mark_style: thumbnail ? (settings.thumbnailStyle === 'glow' ? 'glow' : 'glow-fill') : settings.markStyle,
    glow_falloff: glowFalloff === 'default' ? 'soft' : glowFalloff,
    glow: {
      reach_scale: settings.glowReach,
      plateau_share: settings.plateauShare,
      disc_opacity: settings.softDisc ? BOARDSESH_SOFT_DISC_OPACITY : 0,
      small_hold_max_boost: settings.smallHoldBoost ? BOARDSESH_SMALL_HOLD_MAX_BOOST : BOARDSESH_SMALL_HOLD_NO_BOOST,
      ...(thumbnail ? {} : AURA_GLOW_TUNING),
    },
    fill: { opacity: settings.fillOpacity },
    glyphs: settings.roleGlyphs ? 'role' : 'off',
    // `{}` takes the renderer's own tuned cover. Sent only where the board art
    // actually paints LEDs bright — Kilter draws a dark bolt hole, so its table
    // is empty and a cover there would be ink spent on nothing.
    ...(settings.ledDots && hasLedOffsets ? { led_cover: {} } : {}),
  };
}
