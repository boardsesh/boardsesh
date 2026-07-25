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
 * stale v3 PNGs must not be reused. v5 (issue #3885) adds dark-mode-only marker
 * colors (displayColorDark) — MoonBoard's hand ring is a different hex in dark
 * mode, so a v4 PNG cached in one scheme would be wrong in the other.
 *
 * Lives in its own module so both the hook (use-native-climb-render.ts) and the
 * web overlay warm-up (overlay-cache-warmup.web.ts) can read it without a
 * circular import — the hook imports the warm-up, so the warm-up must not import
 * back from the hook.
 */
export const RENDERER_VERSION = 5;

/** Cache-key prefix stamped on every overlay produced by the current renderer. */
export const currentOverlayVersionPrefix = (): string => `v${RENDERER_VERSION}_`;
