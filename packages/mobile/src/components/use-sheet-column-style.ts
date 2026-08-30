import { useMemo } from 'react';
import { Platform, StyleSheet, useWindowDimensions, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// The wrapper's drag-indicator padding plus a little slack. The bound errs SHORT
// on purpose — a few spare points below a pinned footer beat a clipped footer
// (see #3330). Kept here as the single source of truth for every sheet's iOS
// column bound.
export const SHEET_TOP_CHROME_PT = 20;

// The gap an iOS 26 large-sheet card leaves BELOW the top safe area. SwiftUI's
// `.fraction(f)` detent measures against the sheet's own maximum (`.large`)
// height, which on iOS 26 starts a card-inset (Liquid-Glass/grabber chrome)
// below the top safe area — not at `windowHeight − topInset`. Omitting it made
// the `%` estimate run LONG on short screens (iPhone 13 mini / iOS 26.1),
// pushing the pinned footer off the bottom. Folded into the base before the
// fraction so the correction scales with the detent. Calibrated for the grabber
// card presentation every sheet in this app uses (the default
// `BottomSheetModal`). Applied only on iOS 26+ (`Platform.Version >= 26`), where
// that chrome exists; pre-26 iOS has no such card gap, so the correction is `0`
// there — otherwise the column comes out ~8–14 pt short. A non-card
// `.pageSheet`/`.formSheet` has no such gap and would just be bounded a touch
// short — safe, since erring short beats a clipped footer. Tunable on-device.
export const SHEET_TOP_GAP_PT = 24;

const fillStyle = StyleSheet.create({ fill: { flex: 1 } }).fill;

type SheetColumnStyleOptions = {
  /** fitToContents sheets (no snap points) let the native side measure content
   * height, so the JS column must stay flex — never a fixed height. */
  enableDynamicSizing?: boolean;
  /** The detent the sheet is currently resting at (from the native `onChange`
   * index). Drives the height when a sheet has multiple `%` detents. */
  activeIndex?: number;
  /** The sheet is on `@expo/ui`'s Android content-fitting path (see
   * `androidContentSized` on `Sheet` / `ModalSheet`). The column then carries a
   * `maxHeight` — not `flex: 1`, which collapses to nothing under a `matchContents`
   * host — so the sheet sizes to the form yet a keyboard-up long note still
   * scrolls under the pinned footer instead of clipping (#4720). */
  contentSizedOnAndroid?: boolean;
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
 * Android's Material sheet bounds the column natively, so it keeps `flex: 1` —
 * EXCEPT on the content-fitting path (`contentSizedOnAndroid`), where the native
 * `RNHostView` forces the Compose node to the RN child's measured height: a
 * `flex: 1` child there resolves to zero, so the column instead takes a
 * `maxHeight` of `window − topInset − chrome` and lets its body shrink-and-scroll
 * into that ceiling.
 */
export function useSheetColumnStyle(
  snapPoints: (string | number)[] | undefined,
  { enableDynamicSizing = false, activeIndex = 0, contentSizedOnAndroid = false }: SheetColumnStyleOptions = {},
): ViewStyle {
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  return useMemo<ViewStyle>(() => {
    if (Platform.OS === 'android') {
      return contentSizedOnAndroid
        ? { maxHeight: Math.round(windowHeight - insets.top - SHEET_TOP_CHROME_PT) }
        : fillStyle;
    }
    if (Platform.OS !== 'ios' || enableDynamicSizing || !snapPoints || snapPoints.length === 0) {
      return fillStyle;
    }
    const index = Math.min(Math.max(activeIndex, 0), snapPoints.length - 1);
    // Reached only on iOS (early return above), so `Platform.Version` is the iOS
    // version string (e.g. "26.1"). The card gap exists only from iOS 26.
    const topGapPt = parseInt(String(Platform.Version), 10) >= 26 ? SHEET_TOP_GAP_PT : 0;
    const height = detentColumnHeight(snapPoints[index], windowHeight, insets.top, topGapPt);
    return height == null ? fillStyle : { height };
  }, [snapPoints, enableDynamicSizing, activeIndex, windowHeight, insets.top, contentSizedOnAndroid]);
}

function detentColumnHeight(
  snapPoint: string | number,
  windowHeight: number,
  topInset: number,
  topGapPt: number,
): number | null {
  if (typeof snapPoint === 'number') {
    return Math.round(snapPoint) - SHEET_TOP_CHROME_PT;
  }
  const trimmed = snapPoint.trim();
  if (!trimmed.endsWith('%')) return null;
  const fraction = parseFloat(trimmed) / 100;
  if (!Number.isFinite(fraction)) return null;
  return Math.round((windowHeight - topInset - topGapPt) * fraction) - SHEET_TOP_CHROME_PT;
}
