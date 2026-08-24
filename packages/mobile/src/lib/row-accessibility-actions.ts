import { Platform, type AccessibilityActionInfo } from 'react-native';

// Screen-reader activation for elements whose press lives on an RNGH gesture.
// RNGH's Gesture API builds native gesture recognizers that never register with
// React Native's accessibility-action bridge (verified against
// react-native-gesture-handler@2.32.0: neither the Gesture builders nor RNGH's own
// Touchable/GenericTouchable/BaseButton set onAccessibilityTap or
// accessibilityActions), so a VoiceOver/TalkBack activate never reaches a
// Gesture.Tap(). RN core's Pressable is exempt — it rides the standard touch-
// responder chain, which the OS activates for free. Anything wrapped in a
// GestureDetector must therefore wire onAccessibilityTap + this action list
// explicitly.
//
// The `activate` entry is Android-only on purpose. On Android 'activate' is the
// only route: it maps to ACTION_CLICK in ReactAccessibilityDelegate and
// onAccessibilityTap is not implemented at all. On iOS it is both redundant and
// harmful — UIAccessibility already routes a double-tap to onAccessibilityTap,
// and every accessibilityActions entry becomes a UIAccessibilityCustomAction
// announced by its raw `name` when it carries no label, so VoiceOver would read
// out a developer-facing "activate" on every row.
const ACTIVATE_ACTIONS: readonly AccessibilityActionInfo[] =
  Platform.OS === 'android' ? ([{ name: 'activate' }] as const) : [];

// The list for an element whose only screen-reader affordance is its own press —
// undefined on iOS, where the empty list would be noise on the prop. Module-level
// so the identity is stable across rerenders.
export const ACTIVATE_ACCESSIBILITY_ACTIONS = ACTIVATE_ACTIONS.length > 0 ? ACTIVATE_ACTIONS : undefined;

// A row that also owns nested buttons has to publish each of them as a labelled
// custom action of its own: UIKit treats the row's `accessible` container as a leaf
// and VoiceOver never focuses inside it. (TalkBack does, which is why the nested
// views keep their own props too.) Variadic because a row can own more than one:
// the board card publishes activate + its ownership action + the download glyph.
// Wrap the result in a useMemo at the call site, keyed on the resolved label
// strings — never on `t`, whose identity churns.
export function rowAccessibilityActionsWith(...nestedActions: AccessibilityActionInfo[]): AccessibilityActionInfo[] {
  return [...ACTIVATE_ACTIONS, ...nestedActions];
}
