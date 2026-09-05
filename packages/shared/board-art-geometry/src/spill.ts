// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Boardsesh

/**
 * How far (in placement radii) an unlit hold can sit from a lit one and still
 * catch the renderer's light spill (`glow.spill_boost`), so config builders
 * know which unlit silhouettes to attach.
 *
 * One constant and one predicate, shared by every config builder (the mobile
 * native path and the shared/WASM path), because the JS pre-filter and the
 * Rust glow reach must agree: a builder with a smaller bound than the
 * renderer's actual reach would silently clip the spill. The bound itself:
 * reach tops out around 2.4r past a silhouette that itself extends ~2r, so 5r
 * covers every reachable neighbour with margin.
 */
export const SPILL_NEIGHBOUR_RADII = 5;

type HoldPlacement = { cx: number; cy: number; r: number };

/**
 * Can `unlitHold` catch `litHold`'s spill? An axis-aligned box test, not
 * Euclidean — it over-includes diagonal neighbours by up to √2×, which only
 * costs a few never-brightened polygons in the config; the renderer's own
 * distance field is what decides where light actually lands. The range scales
 * with the LIT hold's radius (the glow reach is proportional to it), maxed
 * with the unlit hold's own so a large neighbour's far edge still counts on
 * mixed-size boards.
 */
export function isWithinSpillRange(litHold: HoldPlacement, unlitHold: HoldPlacement): boolean {
  const range = SPILL_NEIGHBOUR_RADII * Math.max(litHold.r, unlitHold.r);
  return Math.abs(litHold.cx - unlitHold.cx) <= range && Math.abs(litHold.cy - unlitHold.cy) <= range;
}
