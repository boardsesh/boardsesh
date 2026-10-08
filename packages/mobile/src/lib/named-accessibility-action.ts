import type { AccessibilityActionEvent, AccessibilityActionInfo } from 'react-native';

/** Action name for the screen-reader route to what a long-press does. */
export const LONG_PRESS_ACTION_NAME = 'longPress';

/**
 * A single labelled screen-reader action. Used where a gesture VoiceOver and
 * TalkBack cannot perform (long-press) or a nested button the row swallows
 * needs a second route (HIG Accessibility: custom actions; HIG Gestures: every
 * gesture needs a simple alternative). The `label` is what the rotor announces.
 */
export function namedAccessibilityActions(name: string, label: string): AccessibilityActionInfo[] {
  return [{ name, label }];
}

/** `onAccessibilityAction` handler that runs `run` when the named action fires. */
export function onNamedAccessibilityAction(name: string, run: () => void) {
  return (event: AccessibilityActionEvent) => {
    if (event.nativeEvent.actionName === name) run();
  };
}
