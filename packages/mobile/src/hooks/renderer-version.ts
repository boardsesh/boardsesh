/**
 * Version tag for the native/web overlay render + cache contract.
 *
 * Bump when the overlay output or cache-key shape changes. v2 marked the switch
 * from composited PNGs (backgrounds baked in) to overlay-only PNGs (transparent
 * background, holds only). v3 marks marker shape, brush, and size override
 * support, and drops any wrong custom-marker PNGs written by overlay-only dev
 * binaries during rollout. v4 (issue #2202) switches hold colors to each role's
 * calibrated displayColor and boosts Grasshopper's default stroke width — both
 * change the rendered pixels for a config that otherwise hashes the same, so
 * stale v3 PNGs must not be reused. v5 invalidates any v4 native
 * PNG that may have been truncated before publication became atomic. This
 * version is shared by native and Expo web, so the web Cache API intentionally
 * performs the same one-time v4 flush. The accompanying native-module changes
 * move Expo's fingerprint, keeping the v5 JS contract isolated to binaries that
 * contain the atomic writer. v6 (issue #4495) drops every overlay the stale web
 * WASM artifact drew: it ignored stroke_width_multiplier, so a Grasshopper
 * overlay cached under the DEFAULT signature — and any overlay cached under a
 * `brush-N` one — came out at the wrong thickness under a key the rebuilt
 * artifact would happily reuse. The cache key carries the render signature, not
 * the board's stroke default, so nothing short of a version bump evicts those.
 * Shared with native like the v4 flush was: native overlays that were already
 * correct pay a one-time re-render, which is the same trade v4 made.
 *
 * Lives in its own module so both the hook (use-native-climb-render.ts) and the
 * web overlay warm-up (overlay-cache-warmup.web.ts) can read it without a
 * circular import — the hook imports the warm-up, so the warm-up must not import
 * back from the hook.
 */
export const RENDERER_VERSION = 6;

/** Cache-key prefix stamped on every overlay produced by the current renderer. */
export const currentOverlayVersionPrefix = (): string => `v${RENDERER_VERSION}_`;
