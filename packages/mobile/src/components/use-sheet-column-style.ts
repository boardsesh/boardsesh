import { useMemo } from 'react';
import { Platform, StyleSheet, useWindowDimensions, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// The wrapper's drag-indicator padding plus a little slack. The bound errs SHORT
// on purpose — a few spare points below a pinned footer beat a clipped footer
// (see #3330). Kept here as the single source of truth for every sheet's iOS
// column bound.
export const SHEET_TOP_CHROME_PT = 20;

// The gap an iOS large-sheet card leaves BELOW the top safe area. SwiftUI's
// `.fraction(f)` detent measures against the sheet's own maximum (`.large`)
// height, which starts a card-inset (and, on iOS 26, Liquid-Glass/grabber
// chrome) below the top safe area — not at `windowHeight − topInset`. Omitting
// it made the `%` estimate run LONG on short screens (iPhone 13 mini / iOS
// 26.1), pushing the pinned footer off the bottom. Folded into the base before
// the fraction so the correction scales with the detent. Tunable on-device.
export const SHEET_TOP_GAP_PT = 24;

const fillStyle = StyleSheet.create({ fill: { flex: 1 } }).fill;

type SheetColumnStyleOptions = {
  /** fitToContents sheets (no snap points) let the native side measure content
   * height, so the JS column must stay flex — never a fixed height. */
  enableDynamicSizing?: boolean;
  /** The detent the sheet is currently resting at (from the native `onChange`
   * index). Drives the height when a sheet has multiple `%` detents. */
  activeIndex?: number;
};

/**
 * The style for a native bottom sheet's single flex column.
 *
 * On iOS the `@expo/ui` SwiftUI sheet host can propose an UNBOUNDED height to the
 * RN content, so a `flex: 1` column sizes to its CONTENT height instead of the
 * detent — anything past the detent (a pinned footer) then lands off-screen
 * (#3330, device-verified). So on iOS we pin the column to the current detent's
 * height, computed JS-side: a `%`/fraction detent resolves against the sheet's
 * maximum height (the window minus the top safe area, where SwiftUI's `.fraction`
 * detents measure from, less the `SHEET_TOP_GAP_PT` card gap); a px detent is
 * the literal sheet height. The `SHEET_TOP_CHROME_PT` margin covers the
 * drag-indicator chrome, erring short.
 *
 * Android's Material sheet bounds the column natively, and fitToContents sheets
 * are measured natively too, so both keep `flex: 1`.
 */
export function useSheetColumnStyle(
  snapPoints: (string | number)[] | undefined,
  { enableDynamicSizing = false, activeIndex = 0 }: SheetColumnStyleOptions = {},
): ViewStyle {
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  return useMemo<ViewStyle>(() => {
    if (Platform.OS !== 'ios' || enableDynamicSizing || !snapPoints || snapPoints.length === 0) {
      return fillStyle;
    }
    const index = Math.min(Math.max(activeIndex, 0), snapPoints.length - 1);
    const height = detentColumnHeight(snapPoints[index], windowHeight, insets.top);
    return height == null ? fillStyle : { height };
  }, [snapPoints, enableDynamicSizing, activeIndex, windowHeight, insets.top]);
}

function detentColumnHeight(snapPoint: string | number, windowHeight: number, topInset: number): number | null {
  if (typeof snapPoint === 'number') {
    return Math.round(snapPoint) - SHEET_TOP_CHROME_PT;
  }
  const trimmed = snapPoint.trim();
  if (!trimmed.endsWith('%')) return null;
  const fraction = parseFloat(trimmed) / 100;
  if (!Number.isFinite(fraction)) return null;
  return Math.round((windowHeight - topInset - SHEET_TOP_GAP_PT) * fraction) - SHEET_TOP_CHROME_PT;
}
