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
 * v8 (issue #2202) opens Woods, which shipped no traced geometry at all: its art
 * is an opaque photograph of the hold set, so there was no silhouette in the
 * alpha channel to find, and the Boardsesh mode drew a plain ring at every
 * placement radius with no veil. Its white ground is keyed away now, so 469 of
 * the 8x10's 485 placements and 868 of the 12x12's 894 carry a real outline, and
 * both sizes gained a `wallLightness` row (0.530 / 0.540 at ~93% coverage) that
 * turns the soft veil on wherever the veil setting is `auto`. That `auto` case
 * moves the render signature and evicts itself; the viewers who need a version
 * bump are the ones who explicitly chose veil off, soft, strong or custom, whose
 * signature is byte-identical either side of the change and whose cached PNGs
 * would keep serving rings for a Woods climb forever.
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
 * NO BUILD EVER PUBLISHED v8. The two changes were developed on separate
 * branches, and the plate branch took 9 deliberately rather than 8 so that two
 * branches landing the same `= 8` line could not merge silently — git merges
 * identical lines without a word, and whichever landed second would have shipped
 * new pixels under a generation the first had already spent. Both branches are on
 * this line now, so v9 is the first generation that carries either change and the
 * eviction it forces covers both. v8 is left in the ladder rather than reused: a
 * dev build of the Woods branch can have written v8 PNGs to a real device, the
 * sweep drops them like any other stale generation, and
 * `renderer-version.test.ts` pins the integer so the next collision is a failing
 * test rather than a stale cache.
 *
 * v10 parks the plate again. TestFlight build 5 ran the old 19-field binary,
 * which ignored the plate config entirely and drew plain silhouettes; build 6
 * carried the rebuilt artifacts and actually lit the rings, and the holds came
 * out worse for it. The renderer's default is back to no plate, so the drawing
 * is byte-identical to pre-v9 again — but v9 is exactly the generation whose
 * PNGs have the bad look baked in, sitting under keys this renderer would
 * happily reuse. Every build-6 device re-renders once.
 *
 * v11 ships Boardsesh Aura as the drawing's default glow (PR #4972): wider
 * spread, same-colour neighbours fused, the capped different-colour seam
 * crossfade, the deepened fringe. The cache key's settings signature did not
 * move — the DEFAULT moved — so every cached overlay would otherwise be
 * reused with the old flat glow baked in. One re-render per device, same as
 * every generation before it.
 *
 * v12 fixes Aura's seam: the capped crossfade left a hard colour line on the
 * bisector between different-colour neighbours (the Grasshopper pie-slice),
 * replaced by a continuous power-curved blend (`seam_sharpness`). Aura is the
 * default, so every cached v11 overlay has the hard seam baked in.
 *
 * Lives in its own module so both the hook (use-native-climb-render.ts) and the
 * web overlay warm-up (overlay-cache-warmup.web.ts) can read it without a
 * circular import — the hook imports the warm-up, so the warm-up must not import
 * back from the hook.
 */
export const RENDERER_VERSION = 12;

/** Cache-key prefix stamped on every overlay produced by the current renderer. */
export const currentOverlayVersionPrefix = (): string => `v${RENDERER_VERSION}_`;
