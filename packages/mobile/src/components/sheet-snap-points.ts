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
 * The added value is ignored on Android (only partial/expanded exist), and this
 * keeps the body's flex layout intact (unlike switching to fit-to-content, which
 * can collapse a scrollable body). iOS / web honour the exact detents via SwiftUI
 * / CSS, so they're returned unchanged.
 */
export function androidSafeSnapPoints(snapPoints: (string | number)[]): (string | number)[] {
  if (Platform.OS !== 'android' || snapPoints.length !== 1) return snapPoints;
  const only = snapPoints[0];
  const percent = typeof only === 'string' && only.trim().endsWith('%') ? parseFloat(only) : null;
  if (percent == null || percent >= ANDROID_NEAR_FULL_DETENT_PERCENT) return snapPoints;
  return [only, '100%'];
}

/**
 * The index a sheet should present at. Android's `@expo/ui` sheet ignores the
 * requested `%` fraction on its "partial" state (see `androidSafeSnapPoints`
 * above), so a sheet tuned for iOS's real first detent (e.g. a pinned footer
 * sized to fit under `65%`/`80%` content) can strand that footer below
 * Android's fixed ~50% partial fold (#4231). An opted-in sheet presents at
 * its LAST detent (expanded) on Android instead of the first. No effect with
 * a single detent, or on iOS/web.
 */
export function androidInitialPresentIndex(
  effectiveSnapPoints: (string | number)[],
  androidOpensExpanded: boolean,
): number {
  return Platform.OS === 'android' && androidOpensExpanded && effectiveSnapPoints.length > 1
    ? effectiveSnapPoints.length - 1
    : 0;
}
