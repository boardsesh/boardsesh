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
export const ACTIVATE_ACCESSIBILITY_ACTIONS: readonly AccessibilityActionInfo[] =
  Platform.OS === 'android' ? ([{ name: 'activate' }] as const) : [];

// A button nested inside a row's `accessible` container only ever needs the plain
// activate, so on iOS it gets no action list at all — UIKit treats the container
// as a leaf and never focuses inside it anyway, which is why every such row also
// has to publish its nested affordance as a labelled custom action of its own.
// (TalkBack does still focus the nested view, which is why these props stay wired.)
// Module-level so the identity is stable across rerenders.
export const NESTED_BUTTON_ACCESSIBILITY_ACTIONS =
  ACTIVATE_ACCESSIBILITY_ACTIONS.length > 0 ? ACTIVATE_ACCESSIBILITY_ACTIONS : undefined;
