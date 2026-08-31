/**
 * How far (in placement radii, centre-to-centre) an unlit hold can sit from a
 * lit one and still catch the renderer's light spill (`glow.spill_boost`), so
 * config builders know which unlit silhouettes to attach.
 *
 * One constant, shared by every config builder (the mobile native path and the
 * shared/WASM path), because the JS pre-filter and the Rust glow reach must
 * agree: a builder with a smaller bound than the renderer's actual reach would
 * silently clip the spill. The bound itself: reach tops out around 2.4r past a
 * silhouette that itself extends ~2r, so 5r covers every reachable neighbour
 * with margin.
 */
export const SPILL_NEIGHBOUR_RADII = 5;
