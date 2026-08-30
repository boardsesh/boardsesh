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
 * v7 (issue #2202) opens the Boardsesh drawing: a wash of the play field over
 * the unlit wall, a glow clipped to each lit hold's traced silhouette, and a
 * HAND blue lifted to #6980FF so it still reads once that wash lands. All three
 * ride on cache-key tokens — `mode-boardsesh`, `veil-<field>-<pct>` — that did
 * not exist before, so a Boardsesh render could never collide with a classic
 * one on its own. What forces the bump is the same thing v4 and v6 hit: the
 * cache key describes the SETTINGS a render was asked for, not the drawing that
 * came back, and the rollout ran on dev binaries whose Boardsesh path was still
 * moving. Those PNGs sit under keys the shipped renderer would happily reuse.
 * Classic pixels are unchanged and pay a one-time re-render, exactly the trade
 * v4 and v6 made, and one shared bump keeps native and Expo web on the same
 * contract.
 *
 * v9 lights the LED base plate: on a hold whose art carries a traced plate
 * boundary, the ring between that boundary and the silhouette is painted in the
 * role colour and the glow is measured off that ring rather than the whole
 * hold. Nothing about it is a setting, so the cache key — which describes the
 * settings a render was asked for, not the drawing that came back — cannot tell
 * a plated render from the pre-plate one it would happily reuse. Holds and
 * boards with no plate are byte-identical and pay a one-time re-render, the
 * same trade v4, v6 and v7 made.
 *
 * v8 is deliberately skipped: the Woods work already holds it on its own
 * branch. Two branches landing the same `= 8` line do not conflict — git merges
 * identical lines silently — so whichever merged second would have shipped new
 * pixels under a generation the first had already spent, with no red anywhere
 * to say so. Taking 9 keeps the two generations distinct without either branch
 * having to know about the other, and `renderer-version.test.ts` pins the
 * integer so the next collision is a failing test rather than a stale cache.
 *
 * Lives in its own module so both the hook (use-native-climb-render.ts) and the
 * web overlay warm-up (overlay-cache-warmup.web.ts) can read it without a
 * circular import — the hook imports the warm-up, so the warm-up must not import
 * back from the hook.
 */
export const RENDERER_VERSION = 9;

/** Cache-key prefix stamped on every overlay produced by the current renderer. */
export const currentOverlayVersionPrefix = (): string => `v${RENDERER_VERSION}_`;
