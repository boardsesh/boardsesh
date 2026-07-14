import { StyleSheet, type ViewStyle } from 'react-native';

/**
 * The style for a native bottom sheet's single column: a plain `flex: 1` that
 * fills the detent.
 *
 * History: `@expo/ui`'s SwiftUI sheet host used to propose an UNBOUNDED height to
 * the RN content, so a `flex: 1` column sized to its CONTENT height and a pinned
 * footer landed off-screen (#3330). We worked around it by pinning the column to a
 * JS-computed estimate of the detent height — but that estimate can't match the
 * native detent across every device/OS, so on some screens it came out short and
 * the footer floated well above the sheet's real bottom (a visible dead gap under
 * the Apply button).
 *
 * As of `@expo/ui` 57.0.3 the workaround is obsolete: for a bounded sheet
 * (`enableDynamicSizing={false}` + snap points) `RNHostView` renders the RN content
 * with `.frame(maxHeight: .infinity)` — filling the detent — and reports that real
 * size back to the Yoga node (see the library's `RNHostView.swift` +
 * `BottomSheet.ios.tsx`, which wraps children in `flexGrow: 1; height: 0`). So the
 * RN root is now bounded to the true detent height, and a plain `flex: 1` column
 * fills it exactly on every device: the scroll body scrolls and the footer pins to
 * the real bottom — no per-device estimate, nothing to calibrate. Android's
 * Material sheet has always bounded the column natively; fitToContents sheets are
 * measured natively too.
 */
export const SHEET_COLUMN_STYLE: ViewStyle = StyleSheet.create({ column: { flex: 1 } }).column;
