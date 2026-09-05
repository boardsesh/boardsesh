// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Boardsesh

export type {
  BoardseshRenderSettings,
  GlowFalloffSetting,
  HoldShapeSetting,
  MarkStyleSetting,
  ThumbnailStyleSetting,
  VeilSetting,
} from './settings';
export {
  AURA_GLOW_TUNING,
  BOARD_FIELD_COLORS,
  BOARD_RENDER_SETTING_BOUNDS,
  BOARDSESH_SMALL_HOLD_MAX_BOOST,
  BOARDSESH_SMALL_HOLD_NO_BOOST,
  BOARDSESH_SOFT_DISC_OPACITY,
  DEFAULT_BOARDSESH_RENDER_SETTINGS,
  GLOW_FALLOFF_SETTINGS,
  HOLD_SHAPE_SETTINGS,
  MARK_STYLE_SETTINGS,
  THUMBNAIL_STYLE_SETTINGS,
  VEIL_SETTING_OPACITY,
  VEIL_SETTINGS,
  boardFieldColorForScheme,
  resolveVeilOpacity,
} from './settings';
export type {
  AuraRenderFields,
  AuraRenderFieldsInput,
  FillConfig,
  GlowFalloff,
  GlowTuningFields,
  GlyphsMode,
  LedCoverConfig,
  MarkStyle,
  VeilConfig,
} from './aura-fields';
export { buildAuraRenderFields } from './aura-fields';
