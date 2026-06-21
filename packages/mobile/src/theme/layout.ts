/**
 * Shared layout metrics for chrome that floats over scrollable content.
 *
 * The persistent climb toolbar is rendered by variant:
 *
 *   Liquid Glass / fallback — floating glass capsule + standalone log tick
 *   Material                — docked opaque active-context bar above the tab bar
 *
 * Screens reserve it via `useBottomChromeMetrics()` so native-accessory screens
 * do not keep padding for a JS toolbar that is not mounted. Owned here (rather
 * than inside queue-control) so any screen can pad correctly without importing
 * those components' internals.
 */

/** Bottom tab bar height (excludes the safe-area inset). The Liquid Glass / native
 *  iOS tab bar value; the Material JS nav bar uses {@link MATERIAL_TAB_BAR_HEIGHT}. */
export const TAB_BAR_HEIGHT = 49;

/** M3 navigation-bar content height (excludes the safe-area inset). The Material
 *  variant's JS tab bar is taller than the iOS 49 — M3 spec is an 80dp bar that
 *  fits the active-indicator pill, icon and label with room to breathe. Only the
 *  Material variant reads this (in MaterialTabBar and the bottom-chrome metrics);
 *  Liquid Glass stays on TAB_BAR_HEIGHT. */
export const MATERIAL_TAB_BAR_HEIGHT = 80;

/**
 * One height ladder for every glass FAB / capsule / pill, so the floating chrome
 * reads as a single, deliberately-sized system rather than a pile of ad-hoc
 * diameters. Liquid Glass earns expressiveness from a single hero bump plus a
 * 4pt capsule offset — not from many sizes — so the ladder is capped and every
 * interactive tier stays at or above the 44pt touch floor.
 *
 *   hero          one defining action per floating surface (log-ascent, create)
 *   standard      default floating FAB
 *   capsule       standalone floating capsule — 4pt under its sibling FABs
 *   inlinePrimary primary action inside a sheet (PlayDrawer)
 *   inline        standard inline control + touch-target floor
 *   mini          label-only pill (angle); carries 44pt hit-slop when tappable
 *
 * Guardrail: the hero bump and the capsule offset are for STANDALONE glass
 * bodies. Anything merged inside a GlassContainer shares one height.
 */
export const glassSize = {
  hero: 56,
  standard: 48,
  capsule: 44,
  inlinePrimary: 48,
  inline: 44,
  mini: 32,
} as const;

/** Height of each floating toolbar action target. */
export const TOOLBAR_FAB_SIZE = glassSize.standard;

/** Height of the centered climb capsule — one step under the flanking FABs so it
 *  reads as context, not an action (the playful tell). See `glassSize`. */
export const TOOLBAR_CAPSULE_HEIGHT = glassSize.capsule;

/** Max width of the centered climb capsule so it never collides with the side
 *  FABs and stays Photos-style centered on wide phones. */
export const TOOLBAR_CAPSULE_MAX_WIDTH = 260;

/** Screen-edge gutter for the toolbar's side FABs. Matches ClimbTopChrome. */
export const TOOLBAR_SIDE_MARGIN = 16;

/** Gap between the toolbar's floating elements. */
export const TOOLBAR_GAP = 8;

/** Max readable width for UIKit's iOS 26 bottom accessory content. */
export const NATIVE_BOTTOM_ACCESSORY_MAX_WIDTH = 420;

/** Total horizontal screen gutter reserved around UIKit's iOS 26 bottom accessory. */
export const NATIVE_BOTTOM_ACCESSORY_SCREEN_GUTTER = 32;

/** Lift between the floating toolbar and the tab bar below it, so the islands
 *  read as floating (the old opaque queue bar sat flush against the tab bar). */
export const TOOLBAR_GAP_ABOVE_TABBAR = 10;

/** Bottom padding screens reserve (above the tab bar + safe-area inset) so the
 *  last scrollable row clears the floating toolbar. Keyed off the tallest island
 *  — the hero log-ascent tick (`glassSize.hero`) — so nothing hides under it. */
export const TOOLBAR_RESERVE = glassSize.hero + TOOLBAR_GAP_ABOVE_TABBAR;

/** Height of the Material active-context bar docked directly above the tab bar. */
export const MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT = glassSize.standard;

/** One logical px the docked Material bar tucks under the tab bar's top hairline.
 *  Because the bar now docks against the tab bar's *measured* height (not the
 *  `TAB_BAR_HEIGHT` constant), this only has to cover the hairline border / sub-pixel
 *  rounding — not absorb a constant-vs-reality mismatch — so it stays a fixed hairline
 *  instead of a hand-tuned per-device offset. */
export const TABBAR_SEAM_OVERLAP = 1;
