// Typed helpers for reading expo-router's focused-route segments.
//
// `useSegments()` returns a route-typed tuple (e.g. `['(tabs)', 'climbs']`).
// Casting it to `string[]` to probe an index silently discards that typing and
// would let a wrong index slip through if the route tree changes. These helpers
// instead accept the segments as a `readonly string[]` — the tuple widens to it
// safely — and centralise the "which surface am I on" checks so callers never
// index raw segment positions.

type Segments = readonly string[];

const TABS_GROUP = '(tabs)';
const CLIMBS_TAB = 'climbs';
const PLAYER_ROUTE = 'play';
// The replayable walkthrough. Like the player, a transparentModal with an opaque
// backing (docs/mobile-sheets-vs-routes.md rule 2), so where it IS over the live
// tabs the tab bar never leaves while it is up.
const ONBOARDING_ROUTE = 'onboarding';

/** True when the focused route lives inside the bottom-tab navigator. */
export function isTabsRoute(segments: Segments): boolean {
  return segments[0] === TABS_GROUP;
}

/**
 * True when the native bottom tab CHROME (the tab bar) is present and STABLE — on any
 * route inside the tabs (including pushed sub-routes, which keep the tab bar), OR under
 * the player route (`/play`) or the walkthrough (`/onboarding`).
 *
 * Both are `transparentModal`s (app/_layout.tsx): the tabs screen stays LIVE behind
 * them, so UIKit never snapshots the presenting view controller. That lets the tab-bar
 * metrics stay put across their open/close instead of churning. The walkthrough joined
 * the player when it stopped being a `fullScreenModal` (#5654): unmounting the
 * accessory under a transparent cover would detach it while the bar is still up, which
 * is the #5055 failure below.
 *
 * The walkthrough's clause is now deliberately WIDER than the truth. Since Settings
 * became a root destination, its replay rows push `/onboarding` over `/settings` —
 * a root push that already covered the bar — so on that path this predicate drives a
 * full `setBottomAccessory:` / `setBottomAccessory:nil` pair against a tab bar nobody
 * can see: attached when the walkthrough opens over Settings, detached again when
 * "Customize" pops back to Settings. (Leaving via `dismissTo('/(tabs)/climbs')` pops
 * both root screens in one action, so the host never detaches there, and the
 * walkthrough has no other exit — its gesture is off and each step swallows Android
 * back.) The tab-bar height reserved meanwhile goes unread, since the walkthrough's
 * steps consume no bottom chrome.
 *
 * That churn is the cheap side of the trade, and it happens entirely under cover:
 * #5055 is a detach while the bar is ON SCREEN, which none of these transitions is.
 * Narrowing the clause would buy the expensive side — the route is still reachable by
 * deep link straight over the live tabs, and there the host WOULD detach with the bar
 * up, which is #5055 exactly. Segments alone cannot tell the two entries apart, and
 * this predicate is not worth making navigation-state-aware to save a hidden remount.
 *
 * Drives the tab-bar height/padding in `useBottomChromeMetrics`, and — through
 * `isAccessoryHostRoute`, which is this predicate under another name — the native
 * bottom-accessory host mount. Where the bar is up, the host is mounted; the two
 * cannot drift apart without re-breaking #5055.
 */
export function isTabsChromeRoute(segments: Segments): boolean {
  return segments[0] === TABS_GROUP || segments[0] === PLAYER_ROUTE || segments[0] === ONBOARDING_ROUTE;
}

/** True when the focused route is the Climbs tab (or one of its sub-routes). */
export function isClimbsTabRoute(segments: Segments): boolean {
  return segments[0] === TABS_GROUP && segments[1] === CLIMBS_TAB;
}

/**
 * True only on a tab's own top-level page — its index (`/(tabs)/home`,
 * `/(tabs)/climbs`, …), never a pushed sub-route inside that tab (session detail,
 * settings, climb filters, the climb redirector). A tab index is the only route
 * that's ≤ 2 segments deep under `(tabs)` (`['(tabs)']` or `['(tabs)', '<tab>']`);
 * every sub-route is `['(tabs)', '<tab>', …]` (≥ 3). The current-climb accessory
 * bar shows only on these top-level tab surfaces.
 */
export function isTopLevelTabRoute(segments: Segments): boolean {
  return segments[0] === TABS_GROUP && segments.length <= 2;
}

/**
 * True when the full-screen now-playing player route (`/play`) is focused.
 *
 * The player is a self-contained surface with its own queue UI. On iOS the native
 * bottom accessory is deliberately kept mounted under the transparent player (see
 * `isAccessoryHostRoute`) and stays occluded behind it, so nothing doubles and the
 * tab-bar height doesn't churn.
 */
export function isPlayerRoute(segments: Segments): boolean {
  return segments[0] === PLAYER_ROUTE;
}

/**
 * True on the surfaces where the current-climb bar is SHOWN to the climber: a
 * top-level tab page, OR under the player (`/play`). Pushed tab sub-routes and root
 * pushes/modals are not — the bar is hidden there (#3253).
 *
 * This is a presentation gate, not a mount gate. It drives the JS `PersistentQueueBar`
 * (Android / iOS < 26) and the bottom-chrome reserve that goes with it — surfaces with
 * no UIKit layout coupling, where hiding costs nothing. The native
 * `NativeTabs.BottomAccessory` HOST is gated by `isAccessoryHostRoute` instead, which
 * is deliberately wider; see its docblock for why the two must not be merged.
 */
export function isAccessorySurfaceRoute(segments: Segments): boolean {
  return isTopLevelTabRoute(segments) || isPlayerRoute(segments);
}

/**
 * True where the native `NativeTabs.BottomAccessory` HOST must stay MOUNTED. Identical
 * to `isTabsChromeRoute` by construction, and that identity is the point.
 *
 * The accessory lives INSIDE the iOS 26 tab bar, so attaching or detaching it while the
 * bar is on screen re-lays-out the bar. A detach runs
 * `[_controller setBottomAccessory:nil animated:YES]` with nothing invalidating
 * `-[UITabBar layoutSubviews]`, which owns the frame of the docked `role="search"`
 * Climbs item — leaving it drawn wrong and hit-testing to nowhere until the process
 * restarts (#5055). The same mechanism was device-observed on the player route in
 * `126538345` ("unmounting the accessory instead churned the native tab-bar height and
 * shoved the docked Climbs search field"), and cured the same way: keep it mounted.
 *
 * So the host mounts exactly when the bar is up, and unmounts only when the whole tab
 * view controller leaves (root pushes/modals) — where the accessory co-detaches with the
 * bar, which is the case `d12aa606a` device-verified as safe.
 *
 * NOT interchangeable with `isAccessorySurfaceRoute`: that one is narrower and keeps the
 * bar hidden on sub-routes for the JS bar. Narrowing THIS one back to it reintroduces
 * #5055.
 *
 * Why a separate name rather than calling `isTabsChromeRoute` at the call sites: the two
 * answer different questions that happen to have the same answer. "Is the tab bar on
 * screen?" is a fact about chrome; "must the accessory host stay mounted?" is a
 * constraint about UIKit layout, and it is the one that carries the #5055 reasoning. A
 * call site spelled `isTabsChromeRoute` reads like an incidental coupling someone may
 * tighten; spelled `isAccessoryHostRoute` it reads as the contract it is, and leads
 * whoever follows it here. The identity is asserted by a table-driven test in
 * `__tests__/route-segments.test.ts`, so the alias cannot silently drift into a lie.
 */
export function isAccessoryHostRoute(segments: Segments): boolean {
  return isTabsChromeRoute(segments);
}

/**
 * The focused tab's route segment (e.g. `'climbs'`), or `null` when the focused
 * route is not inside the tab navigator. Segment 0 is the `(tabs)` group, so the
 * tab name is segment 1. Used by the iPad sidebar to highlight the active row
 * without indexing the route-typed tuple directly.
 */
export function tabsActiveSegment(segments: Segments): string | null {
  return isTabsRoute(segments) ? (segments[1] ?? null) : null;
}
