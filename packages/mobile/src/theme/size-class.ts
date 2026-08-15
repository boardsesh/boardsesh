/**
 * Pure size-class arbitration for the adaptive large-screen shell. No react-native
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

/**
 * An iPad whose physical screen long side is below this drops the persistent
 * "Now on the wall" panel (landscape column / portrait strip) and reaches the
 * wall through the phone-style bottom SHEET instead — the "smaller than the
 * 11-inch iPad Pro" line. This is a DEVICE-SIZE question the live width axis
 * physically can't answer: an iPad mini and an 11" Pro are both
 * Regular/Regular fullscreen, so no `UITraitCollection` separates them.
 *
 * 1194 = the 11" Pro's long side. Below it — iPad mini (1133), base iPad
 * 10.9/11" and Air 11" (1180), and legacy small iPads — the wall is sheet-only;
 * the 11" Pro (1194/1210) and every 13" (1366/1376) keep the panel. (1180 is
 * the one-line knob if you later want to keep the panel on the base 11" class.)
 */
export const WALL_PANEL_MIN_DEVICE_LONG_SIDE = 1194;

export type WidthClass = 'compact' | 'regular';

export type DeviceLayout = {
  widthClass: WidthClass;
  /** True when the width also has room for a master + detail pane side by side. */
  expanded: boolean;
};

/**
 * Resolve the size class from the app window width and whether the device is a
 * tablet-sized surface (an iPad, Android tablet, or qualifying browser screen —
 * see {@link resolveIsTablet}). Only those surfaces opt into the adaptive shell;
 * a narrow live window remains `compact`, so the rail appears only when there is
 * genuinely room for multiple columns.
 */
export function resolveDeviceLayout({ width, isTablet }: { width: number; isTablet: boolean }): DeviceLayout {
  if (!isTablet || width < REGULAR_WIDTH_BREAKPOINT) {
    return { widthClass: 'compact', expanded: false };
  }
  return { widthClass: 'regular', expanded: width >= EXPANDED_WIDTH_BREAKPOINT };
}

/**
 * Android's tablet threshold: a device whose smallest screen width is at least
 * this many dp is a tablet. This is the `sw600dp` resource qualifier Android and
 * Material 3 use to switch to tablet layouts, so we match the platform's own line.
 */
export const TABLET_MIN_SHORT_SIDE_DP = 600;

/**
 * A structural mirror of react-native's `Platform.OS` union, kept local so this
 * module stays react-native-free (it unit-tests as plain functions). `Platform.OS`
 * is assignable to it, and typing the param this way — rather than `string` —
 * catches a mistyped OS branch at the call site instead of silently never matching.
 */
export type PlatformOS = 'ios' | 'android' | 'windows' | 'macos' | 'web';

/**
 * Whether this device opts into the adaptive shell: an iPad, or an Android/web
 * screen whose smallest physical-screen width clears {@link TABLET_MIN_SHORT_SIDE_DP}. Pure (the
 * platform and the physical-screen short side are injected) so it unit-tests
 * without react-native, mirroring the width resolvers; the React wrapper reads
 * `Platform.OS` / `Dimensions.get('screen')` in `use-device-layout.ts`.
 *
 * Launch-fixed like `Platform.isPad` — the short side comes from the PHYSICAL
 * screen, not the app window (which shrinks under Split View / multi-window / DeX
 * or when a desktop browser is resized), so an eligible device stays a tablet
 * surface while the live width can still resolve `compact`. The mount decision
 * must not flip the navigator type mid-session; the live axis is `widthClass`.
 */
export function resolveIsTablet({
  platformOS,
  isPad,
  screenShortSide,
}: {
  platformOS: PlatformOS;
  isPad: boolean;
  screenShortSide: number;
}): boolean {
  const usesShortSideTabletQualifier = platformOS === 'android' || platformOS === 'web';
  return isPad || (usesShortSideTabletQualifier && screenShortSide >= TABLET_MIN_SHORT_SIDE_DP);
}

/**
 * `panel-capable` — the device is physically large enough for the persistent
 * wall panel. `sheet-only` — it isn't, so the wall falls back to the phone-style
 * bottom sheet. A launch-fixed axis, orthogonal to the live width class.
 */
export type WallDeviceClass = 'panel-capable' | 'sheet-only';

/**
 * Resolve the wall device class from the physical screen long side (see
 * {@link WALL_PANEL_MIN_DEVICE_LONG_SIDE}).
 *
 * - **Android tablets and qualifying web screens are always `panel-capable`.** The iPad points floor exists
 *   only because iPad points can't separate an iPad mini from an 11" Pro at the
 *   same size class; on Android the live width budget (`resolveWallSurface`)
 *   already decides column/strip/none, and density-bucketed dp isn't comparable to
 *   the iPad point floor anyway. So the floor is iOS-only.
 * - **iPad** keeps the launch-fixed points floor.
 * - **Phones** are always `sheet-only` — they never mount the panel.
 *
 * Pure (the long side + device flags are injected), so it unit-tests without
 * react-native like the width resolvers; the React wrapper reads
 * `Dimensions.get('screen')` in `use-device-layout.ts`.
 */
export function resolveWallDeviceClass({
  screenLongSide,
  isPad,
  isTablet,
  platformOS,
}: {
  screenLongSide: number;
  isPad: boolean;
  isTablet: boolean;
  platformOS: PlatformOS;
}): WallDeviceClass {
  if (isTablet && (platformOS === 'android' || platformOS === 'web')) return 'panel-capable';
  if (!isPad || screenLongSide < WALL_PANEL_MIN_DEVICE_LONG_SIDE) return 'sheet-only';
  return 'panel-capable';
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

/** Max detail (play) pane width when it is the only persistent trailing pane. */
export const DETAIL_PANE_MAX_WIDTH = 400;

/** The browse list must keep at least this width; below it the wall drops from a
 *  dedicated column to a compact strip atop the detail pane. */
export const WALL_COLUMN_CONTENT_FLOOR = 400;

/** The dedicated wall column keeps the trailing column fixed, then lets content
 *  and detail split the remaining width. This slightly-lower floor preserves the
 *  11" iPad landscape column while keeping portrait/narrow layouts on the strip. */
export const WALL_COLUMN_BALANCED_CONTENT_FLOOR = 390;

/**
 * Decide how the wall surface appears, from the window width and the resolved
 * size class. A dedicated column only when sidebar + fixed wall column +
 * balanced content/detail columns fit; otherwise a compact strip. Pure (the
 * sidebar width is injected) so it unit-tests without react-native.
 *
 * Worked examples (sidebar 96): 11" landscape 1194 → 399/399 content+detail
 * → `column`; 11" portrait 834 → 219/219 → `strip`; 13" portrait 1032 →
 * 318/318 → `strip`; 13" landscape 1366 → 485/485 → `column`.
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
  const balancedContentWidth = (width - sidebarWidth - WALL_COLUMN_WIDTH) / 2;
  return balancedContentWidth >= WALL_COLUMN_BALANCED_CONTENT_FLOOR ? 'column' : 'strip';
}

/**
 * The wall surface after the device-size floor is applied: a `sheet-only` device
 * never mounts the column or strip (the wall lives in the bottom sheet + the
 * "On the Wall" tab instead), so it always resolves to `none`; a `panel-capable`
 * device defers to the live width logic in {@link resolveWallSurface}. The one
 * gate the shell and the play pane both consult, so they never diverge. Pure —
 * `wallDeviceClass` and the sidebar width are injected — for unit testing.
 */
export function resolveEffectiveWallSurface({
  width,
  widthClass,
  wallDeviceClass,
  sidebarWidth,
}: {
  width: number;
  widthClass: WidthClass;
  wallDeviceClass: WallDeviceClass;
  sidebarWidth: number;
}): WallSurface {
  if (wallDeviceClass === 'sheet-only') return 'none';
  return resolveWallSurface({ width, widthClass, sidebarWidth });
}

/** Minimum width the persistent detail (play) pane needs to be useful — the floor
 *  of its standalone clamp. Below the content floor the pane is suppressed so the
 *  browse list keeps room (see {@link resolveDetailPaneSurface}). */
export const DETAIL_PANE_MIN_WIDTH = 320;

export function resolveDetailPaneWidth({
  width,
  sidebarWidth,
  wallColumnVisible,
}: {
  width: number;
  sidebarWidth: number;
  wallColumnVisible: boolean;
}): number {
  if (wallColumnVisible) {
    return Math.round((width - sidebarWidth - WALL_COLUMN_WIDTH) / 2);
  }
  return Math.round(Math.min(DETAIL_PANE_MAX_WIDTH, Math.max(DETAIL_PANE_MIN_WIDTH, width * 0.34)));
}

/**
 * How the detail (play) pane appears in the regular-width shell. `pane` is the
 * persistent right-column master-detail surface; `sheet` falls back to the
 * compact bottom-sheet PlayDrawer so the browse list keeps the full content
 * column.
 */
export type DetailPaneSurface = 'pane' | 'sheet';

/**
 * Decide whether the persistent detail pane is mounted, from the same width
 * budget `resolveWallSurface` uses — never a raw breakpoint. The pane only
 * mounts when, after the sidebar and a minimum pane width, the browse list still
 * clears `WALL_COLUMN_CONTENT_FLOOR`. The narrowest regular windows — iPad mini
 * portrait (744) and 9.7–10.2" portrait (768/810) — would otherwise squeeze the
 * list to ~iPhone-SE width beneath a persistent pane, so there it drops to a
 * sheet; 11"+ portrait (≥834 → ≥418 list) keeps the pane. Pure (sidebar width
 * injected) so it unit-tests without react-native.
 */
export function resolveDetailPaneSurface({
  width,
  widthClass,
  sidebarWidth,
}: {
  width: number;
  widthClass: WidthClass;
  sidebarWidth: number;
}): DetailPaneSurface {
  if (widthClass !== 'regular') return 'sheet';
  const contentWidth = width - sidebarWidth - DETAIL_PANE_MIN_WIDTH;
  return contentWidth >= WALL_COLUMN_CONTENT_FLOOR ? 'pane' : 'sheet';
}
