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
