import { useMemo } from 'react';
import { Platform, StyleSheet, useWindowDimensions, type ViewStyle } from 'react-native';

// Grabber + top-padding chrome above the sheet's content column. `@expo/ui`'s
// `BottomSheet.ios` adds `paddingTop: 16` above the content and draws the native
// drag indicator in that band, so the usable column is the detent minus roughly
// this. Errs a touch SHORT on purpose — a few spare points below a pinned footer
// beat a clipped one (#3330). Tunable on-device.
const SHEET_TOP_CHROME_PT = 16;

const fillStyle = StyleSheet.create({ fill: { flex: 1 } }).fill;

type SheetColumnStyleOptions = {
  /** fitToContents sheets (no snap points) let the native side measure content
   * height, so the column must stay flex — never a fixed height. */
  enableDynamicSizing?: boolean;
  /** The detent the sheet is resting at (from the native `onChange` index). Drives
   * the height when a sheet has multiple `%` detents. */
  activeIndex?: number;
};

/**
 * The style for a native bottom sheet's single column.
 *
 * On iOS the `@expo/ui` SwiftUI sheet host proposes an UNBOUNDED height to the RN
 * content, so a `flex: 1` column sizes to its CONTENT height — anything past the
 * content (the empty part of the detent) leaves the pinned footer floating well
 * above the sheet's real bottom (#3330). So on iOS we pin the column to the current
 * detent's height, computed JS-side.
 *
 * A `%`/fraction snap point maps to a SwiftUI `.fraction(f)` detent, and
 * `.fraction` measures against the height of the sheet's CONTAINING VIEW — the full
 * window — not the safe-area-inset height. So the detent is `f × windowHeight`; the
 * column is that minus `SHEET_TOP_CHROME_PT` for the grabber band. (A px snap point
 * is the literal sheet height.) An earlier version subtracted the top safe-area
 * inset before the multiply, which made the column ~80pt short on notched devices
 * and floated the footer.
 *
 * Android's Material sheet bounds the column natively, and fitToContents sheets are
 * measured natively too, so both keep `flex: 1`.
 */
export function useSheetColumnStyle(
  snapPoints: (string | number)[] | undefined,
  { enableDynamicSizing = false, activeIndex = 0 }: SheetColumnStyleOptions = {},
): ViewStyle {
  const { height: windowHeight } = useWindowDimensions();
  return useMemo<ViewStyle>(() => {
    if (Platform.OS !== 'ios' || enableDynamicSizing || !snapPoints || snapPoints.length === 0) {
      return fillStyle;
    }
    const index = Math.min(Math.max(activeIndex, 0), snapPoints.length - 1);
    const height = detentColumnHeight(snapPoints[index], windowHeight);
    return height == null ? fillStyle : { height };
  }, [snapPoints, enableDynamicSizing, activeIndex, windowHeight]);
}

function detentColumnHeight(snapPoint: string | number, windowHeight: number): number | null {
  if (typeof snapPoint === 'number') {
    return Math.round(snapPoint) - SHEET_TOP_CHROME_PT;
  }
  const trimmed = snapPoint.trim();
  if (!trimmed.endsWith('%')) return null;
  const fraction = parseFloat(trimmed) / 100;
  if (!Number.isFinite(fraction)) return null;
  return Math.round(windowHeight * fraction) - SHEET_TOP_CHROME_PT;
}
