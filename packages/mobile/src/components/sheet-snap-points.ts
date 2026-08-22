import { Platform } from 'react-native';

// At/above this detent a single-detent sheet is meant to be a near-full sheet, so
// Android's expanded (full) state is the right match and we leave it alone. Below
// it, full screen is wrong (a short menu shouldn't fill the screen) so we add a
// partial state.
const ANDROID_NEAR_FULL_DETENT_PERCENT = 75;

/**
 * Make a sheet's snap points safe for @expo/ui's Android bottom sheet.
 *
 * @expo/ui's Android sheet is a Material 3 `ModalBottomSheet`, which has only two
 * states — partial (~50%) and expanded — and a SINGLE snap point makes it set
 * `skipPartiallyExpanded`, so the sheet jumps straight to fully expanded (full
 * screen) and ignores the `%` value (gorhom used to honour it). For a SMALL single
 * detent that's wrong — a short action menu (e.g. `['55%']`, `['36%']`) shouldn't
 * fill the screen — so we add a second detent to give Android a partial state: the
 * sheet then opens partial (~50%) and can still be dragged to full.
 *
 * A LARGE single detent (>= 75%) is meant to be a near-full sheet, and Android's
 * expanded state is the right match, so it's left unchanged. Multi-detent sheets
 * already have a partial state, and non-% (px) detents are left as-is.
 *
 * `androidOpensExpanded` (a multi-detent sheet whose pinned footer only fits at
 * its LAST detent, e.g. the tick sheets, #4231) collapses to that single last
 * detent on Android — not "keep both detents and pick the last index at
 * present-time", which depends on an `@expo/ui` Android `expand()` call the
 * library's own `ModalBottomSheetView.kt` can silently no-op ("Expanded anchor
 * may be unreachable"). A single detent removes "partial" as a resting state
 * entirely, so the sheet can only land on Expanded. This check runs BEFORE the
 * small-single-detent padding below: without that ordering, an opted-in sheet
 * with one detent under 75% would fall into the padding branch and come back
 * out with a "partial" resting state again — exactly what the opt-in exists to
 * remove.
 *
 * The added/removed values are ignored on Android (only partial/expanded exist),
 * and this keeps the body's flex layout intact (unlike switching to fit-to-content,
 * which can collapse a scrollable body). iOS / web honour the exact detents via
 * SwiftUI / CSS, so they're returned unchanged.
 */
export function androidSafeSnapPoints(
  snapPoints: (string | number)[],
  androidOpensExpanded = false,
): (string | number)[] {
  if (Platform.OS !== 'android') return snapPoints;
  if (androidOpensExpanded) return [snapPoints[snapPoints.length - 1]];
  if (snapPoints.length !== 1) return snapPoints;
  const only = snapPoints[0];
  const percent = typeof only === 'string' && only.trim().endsWith('%') ? parseFloat(only) : null;
  if (percent == null || percent >= ANDROID_NEAR_FULL_DETENT_PERCENT) return snapPoints;
  return [only, '100%'];
}
