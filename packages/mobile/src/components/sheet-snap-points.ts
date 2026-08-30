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
 * A sheet whose form only fits under a pinned footer at its LAST detent (the tick
 * sheets, #4723) does NOT come through here at all on Android — `Sheet` /
 * `ModalSheet` route it into `@expo/ui`'s content-fitting path instead (see
 * `androidContentSized`), which sizes the sheet to the form and closes the
 * ~310 dp void a single near-full detent left below it (#4720).
 *
 * The added values are ignored on Android (only partial/expanded exist), and this
 * keeps the body's flex layout intact. iOS / web honour the exact detents via
 * SwiftUI / CSS, so they're returned unchanged.
 */
export function androidSafeSnapPoints(snapPoints: (string | number)[]): (string | number)[] {
  if (Platform.OS !== 'android') return snapPoints;
  if (snapPoints.length !== 1) return snapPoints;
  const only = snapPoints[0];
  const percent = typeof only === 'string' && only.trim().endsWith('%') ? parseFloat(only) : null;
  if (percent == null || percent >= ANDROID_NEAR_FULL_DETENT_PERCENT) return snapPoints;
  return [only, '100%'];
}
