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
 * detent on Android instead. This is deliberately NOT "keep both detents and pick
 * the last index at present-time": `skipPartiallyExpanded` on a single detent
 * removes "partial" as a valid resting state entirely, so the native sheet can
 * only land on Expanded (or Hidden) — no imperative re-snap needed. With two
 * detents, opening expanded instead relies on `@expo/ui`'s Android
 * `ModalBottomSheetView.kt` calling `sheetState.expand()` in a `LaunchedEffect`
 * that the library itself wraps in a swallowed `catch` ("Expanded anchor may be
 * unreachable; never crash the view") — a real, silent-failure race that can
 * leave the sheet resting at partial with the footer off-screen even with the
 * right detent index requested. Collapsing to one detent sidesteps that path
 * altogether, the same way any other near-full single-detent sheet in this
 * codebase already does.
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
  if (androidOpensExpanded && snapPoints.length > 1) return [snapPoints[snapPoints.length - 1]];
  if (snapPoints.length !== 1) return snapPoints;
  const only = snapPoints[0];
  const percent = typeof only === 'string' && only.trim().endsWith('%') ? parseFloat(only) : null;
  if (percent == null || percent >= ANDROID_NEAR_FULL_DETENT_PERCENT) return snapPoints;
  return [only, '100%'];
}
