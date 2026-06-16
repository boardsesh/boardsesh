/**
 * Pure size-class arbitration for the adaptive iPad shell. No react-native
 * imports, so it unit-tests as plain functions (mirrors the pure
 * `bottom-chrome-metrics.ts` pattern). The React wrapper that feeds it window
 * dimensions lives in `hooks/use-device-layout.ts`.
 *
 * - `compact` — every iPhone, plus an iPad whose window is too narrow for a
 *   sidebar + content (Slide Over, a ⅓/½/⅔ Split View). Compact renders the
 *   existing phone UI verbatim, so no phase can regress the phone.
 * - `regular` — an iPad window wide enough for the left sidebar + at least one
 *   content pane.
 * - `expanded` — additionally wide enough for a master + detail pane side by
 *   side (the Climbs two-pane browser, Phase 3). A flag on top of `regular`.
 */

/** Below this width an iPad falls back to the compact phone UI. */
export const REGULAR_WIDTH_BREAKPOINT = 700;

/** At/above this width a regular layout also fits a master + detail pane. */
export const EXPANDED_WIDTH_BREAKPOINT = 1024;

export type WidthClass = 'compact' | 'regular';

export type DeviceLayout = {
  widthClass: WidthClass;
  /** True when the width also has room for a master + detail pane side by side. */
  expanded: boolean;
};

/**
 * Resolve the size class from the app window width and whether the device is an
 * iPad. Only iPad opts into the adaptive shell — every iPhone stays `compact`
 * regardless of width — and an iPad in a narrow split is `compact` too, so the
 * sidebar appears only when there is genuinely room for two columns.
 */
export function resolveDeviceLayout({ width, isPad }: { width: number; isPad: boolean }): DeviceLayout {
  if (!isPad || width < REGULAR_WIDTH_BREAKPOINT) {
    return { widthClass: 'compact', expanded: false };
  }
  return { widthClass: 'regular', expanded: width >= EXPANDED_WIDTH_BREAKPOINT };
}

/**
 * The live-wall surface in the regular-width shell. `column` is a dedicated
 * "Now on the wall" column on the trailing edge (landscape, where there's room);
 * `strip` is a slim header docked atop the detail pane (portrait/narrow, where a
 * 4th column would crush the browse list); `none` is compact width, which renders
 * the phone UI and carries its own wall chrome.
 */
export type WallSurface = 'none' | 'strip' | 'column';

/** Width of the dedicated wall column when it is shown. */
export const WALL_COLUMN_WIDTH = 300;

/** Detail (play) pane width when a wall column shares the shell row — narrowed
 *  from the standalone clamp so the browse list keeps room. */
export const DETAIL_PANE_WIDTH_WITH_WALL = 320;

/** The browse list must keep at least this width; below it the wall drops from a
 *  dedicated column to a compact strip atop the detail pane. */
export const WALL_COLUMN_CONTENT_FLOOR = 400;

/**
 * Decide how the wall surface appears, from the window width and the resolved
 * size class. A dedicated column only when sidebar + content list (≥ floor) +
 * detail pane + wall column all fit; otherwise a compact strip. Pure (the
 * sidebar width is injected) so it unit-tests without react-native.
 *
 * Worked examples (sidebar 96): 11" landscape 1194 → 478 content → `column`;
 * 11" portrait 834 → 118 → `strip`; 13" portrait 1032 → 316 → `strip`;
 * 13" landscape 1366 → 650 → `column`.
 */
export function resolveWallSurface({
  width,
  widthClass,
  sidebarWidth,
}: {
  width: number;
  widthClass: WidthClass;
  sidebarWidth: number;
}): WallSurface {
  if (widthClass !== 'regular') return 'none';
  const contentWidth = width - sidebarWidth - DETAIL_PANE_WIDTH_WITH_WALL - WALL_COLUMN_WIDTH;
  return contentWidth >= WALL_COLUMN_CONTENT_FLOOR ? 'column' : 'strip';
}
