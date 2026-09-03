import { veilOpacityFor } from '@boardsesh/board-art-geometry/veil';
import type { WallLightness } from '@boardsesh/board-art-geometry/types';

/**
 * Every knob the Aura board look exposes, and the values it ships at.
 *
 * This module is the single source of the drawing's tuning. It used to live in
 * `packages/mobile/src/lib/board-render-settings.ts`, which also holds the
 * preference store and therefore imports React — so www and the backend could
 * not read it, and their Aura renders drew the renderer's own neutral defaults
 * instead of the look the app ships. Everything here is pure data and pure
 * functions; the preference store, its sanitisers and the capability probe stay
 * in mobile.
 *
 * The identifiers keep the pre-2.4 `boardsesh` spelling on purpose: only the
 * wire values were renamed to `aura`, and renaming the ~90 mobile call sites
 * would buy a string nobody sees. New names added here use `aura`.
 */

/** The glow's alpha curve. `default` defers to the app default, `soft`. */
export type GlowFalloffSetting = 'default' | 'soft' | 'plateau';
/**
 * How hard the field-colour veil washes the unlit wall. `auto` measures the
 * board's own art against the field (`veilOpacityFor`); the rest are fixed.
 */
export type VeilSetting = 'auto' | 'off' | 'soft' | 'strong' | 'custom';
/** What the Aura drawing puts on a lit hold at full size. */
export type MarkStyleSetting = 'glow' | 'glow-fill' | 'fill';
/**
 * The same choice for a list thumbnail, where a bare glow reads faint at
 * ~76px. `fill` renders as `glow-fill`, not a bare fill — the spike's winning
 * thumbnail arm was the filled mark WITH its own small glow ("veil + tint"),
 * so that pairing is what this maps to (see `buildAuraRenderFields`).
 */
export type ThumbnailStyleSetting = 'fill' | 'glow';
/**
 * What the Aura drawing lights on a hold: the traced silhouette from
 * `@boardsesh/board-art-geometry`, or the placement circle.
 *
 * `'circle'` is not a fallback — it is the Modern Classic look. The renderer
 * already draws the placement circle for any hold the tracer skipped
 * (`aura/geometry.rs`), so withholding the outlines is all it takes: the veil
 * punches circles out of the wash and the glow follows them.
 */
export type HoldShapeSetting = 'silhouette' | 'circle';

export type BoardseshRenderSettings = {
  glowFalloff: GlowFalloffSetting;
  /** Overall glow reach multiplier. */
  glowReach: number;
  /** `plateau` falloff only: the share of the reach held at full alpha. */
  plateauShare: number;
  veil: VeilSetting;
  /** `custom` veil only: the wash's alpha. */
  veilOpacity: number;
  markStyle: MarkStyleSetting;
  /** `fill` / `glow-fill` only: alpha of the role-colour fill. */
  fillOpacity: number;
  /** The soft disc under the glow — the spike's rejected arm, kept as an A/B. */
  softDisc: boolean;
  /** Give a fingernail-sized foot chip a bigger glow instead of a second mark. */
  smallHoldBoost: boolean;
  /** Cover the LED pips the board art itself paints bright. */
  ledDots: boolean;
  /** Opt-in accessibility glyphs (FOOT ring, STARTING bar, HAND bar, FINISH X). */
  roleGlyphs: boolean;
  thumbnailStyle: ThumbnailStyleSetting;
  holdShape: HoldShapeSetting;
};

export const GLOW_FALLOFF_SETTINGS = ['default', 'soft', 'plateau'] as const;
export const VEIL_SETTINGS = ['auto', 'off', 'soft', 'strong', 'custom'] as const;
export const MARK_STYLE_SETTINGS = ['glow', 'glow-fill', 'fill'] as const;
export const THUMBNAIL_STYLE_SETTINGS = ['fill', 'glow'] as const;
export const HOLD_SHAPE_SETTINGS = ['silhouette', 'circle'] as const;

/** Slider ranges, exported so the settings screen and the clamps cannot drift. */
export const BOARD_RENDER_SETTING_BOUNDS = {
  glowReach: { min: 0.5, max: 2 },
  plateauShare: { min: 0.2, max: 0.7 },
  veilOpacity: { min: 0, max: 0.9 },
  fillOpacity: { min: 0.3, max: 0.9 },
} as const;

/**
 * The two fixed veil buckets, matching `VEIL_TUNING`'s soft and strong opacities
 * — a climber who overrides `auto` is choosing one of the same two washes the
 * measurement would have picked, not a third strength.
 */
export const VEIL_SETTING_OPACITY = { off: 0, soft: 0.3, strong: 0.6 } as const;

/** Peak alpha of the optional soft disc under the glow. */
export const BOARDSESH_SOFT_DISC_OPACITY = 0.3;
/** The renderer's own small-hold boost ceiling, and the value that turns it off. */
export const BOARDSESH_SMALL_HOLD_MAX_BOOST = 1.7;
export const BOARDSESH_SMALL_HOLD_NO_BOOST = 1;

/**
 * The Aura glow, as renderer tuning, spread into the config's `glow` object
 * (snake_case: the Rust `GlowTuning` fields).
 *
 * The owner's pick from PR #4972's three-way design review, tuned in the glow
 * lab against real climbs on five boards:
 *
 * - `spread_fraction` 0.91 is the reach-1.3 look shipped WITHOUT touching
 *   `reach_scale`, so the climber's Glow-reach slider keeps multiplying on
 *   top (pixel-identical to a reach_scale of 1.3 — verified RMSE 0).
 * - `merge_softness` fuses same-colour neighbours across their bisector (the
 *   dark V-notch the plain glow shows between adjacent holds).
 * - The seam pair replaces the hard colour switch between DIFFERENT-colour
 *   neighbours with a continuous, power-curved crossfade: `seam_sharpness` 3
 *   keeps the blend at a true 50/50 exactly on the bisector (a capped mix
 *   left a visible hard line there — the Grasshopper pie-slice bug) while
 *   collapsing to near-pure hold colour within a few pixels.
 * - `fringe_deepen` keeps the falloff coloured to its edge instead of greying.
 * - No spill, no rim, no gamma, no white core: the review measured spill at
 *   this reach inventing lit-looking holds, and the stylised looks lost to
 *   the drawing's own character.
 *
 * Thumbnails skip the bundle (`buildAuraRenderFields`): at 200px the
 * difference is invisible and the extra distance-field work is ~2.5× the
 * render. Every field left unnamed stays at its neutral Rust default.
 *
 * `seam_max_mix` is deliberately OMITTED: its Rust default (0.5) is
 * load-bearing — the crossfade must reach a true 50/50 on the bisector for
 * colour continuity; any lower cap re-creates the hard seam line.
 */
export const AURA_GLOW_TUNING = {
  spread_fraction: 0.91,
  merge_softness: 0.6,
  seam_blend_fraction: 0.9,
  seam_sharpness: 3.0,
  fringe_deepen: 0.4,
} as const;

export const DEFAULT_BOARDSESH_RENDER_SETTINGS: BoardseshRenderSettings = {
  glowFalloff: 'default',
  glowReach: 1,
  plateauShare: 0.4,
  veil: 'auto',
  veilOpacity: 0.6,
  markStyle: 'glow',
  fillOpacity: 0.55,
  softDisc: false,
  smallHoldBoost: true,
  ledDots: true,
  roleGlyphs: false,
  thumbnailStyle: 'fill',
  holdShape: 'silhouette',
};

/**
 * The play field the veil washes toward, per colour scheme — the mobile theme's
 * `secondaryBackground` (`packages/mobile/src/theme/colors.ts`), restated as a
 * plain hex because that module resolves to an iOS `PlatformColor` the veil
 * cannot subtract a lightness from. Pinned by a mobile test against the theme so
 * the two cannot drift.
 *
 * On the white light-mode field every board's wall is DARKER than the field, so
 * `veilOpacityFor` turns the veil off there without a special case. www and the
 * OG cards render against the dark field, which is what an app climber in the
 * default dark theme sees.
 */
export const BOARD_FIELD_COLORS = { light: '#FFFFFF', dark: '#181225' } as const;

export function boardFieldColorForScheme(colorScheme: 'light' | 'dark'): string {
  return BOARD_FIELD_COLORS[colorScheme];
}

/**
 * How hard the veil washes this board, given the climber's choice and the
 * board's own measured wall.
 *
 * `auto` with no wall row is 0, not a guess: a board the tracer skipped has no
 * reading to bucket, and washing an unmeasured wall is how a field colour ends
 * up brighter than the art it was meant to quiet.
 */
export function resolveVeilOpacity(
  settings: BoardseshRenderSettings,
  wallLightness: WallLightness | null,
  fieldColor: string,
): number {
  switch (settings.veil) {
    case 'off':
      return VEIL_SETTING_OPACITY.off;
    case 'soft':
      return VEIL_SETTING_OPACITY.soft;
    case 'strong':
      return VEIL_SETTING_OPACITY.strong;
    case 'custom':
      return settings.veilOpacity;
    case 'auto':
      return wallLightness
        ? veilOpacityFor({ wallLightness: wallLightness.mean, coverage: wallLightness.coverage, fieldColor })
        : 0;
  }
}
