import type { AccessibilityActionEvent, AccessibilityActionInfo } from 'react-native';

/** Action name for the screen-reader route to what a long-press does. */
export const LONG_PRESS_ACTION_NAME = 'longPress';

/** One labelled screen-reader action and what it runs. */
export type NamedAccessibilityAction = {
  name: string;
  /** What the rotor (VoiceOver) or the actions menu (TalkBack) announces. */
  label: string;
  run: () => void;
};

/**
 * Labelled screen-reader actions. Used where a gesture VoiceOver and TalkBack
 * cannot perform (long-press, a swipe on a button) or a nested button the row
 * swallows needs a second route (HIG Accessibility: custom actions; HIG
 * Gestures: every gesture needs a simple alternative). The `label` is what the
 * rotor announces.
 *
 * Takes one `(name, label)` pair, or a list of actions for a control with
 * several (the wall button's board controls and Light every climb).
 */
export function namedAccessibilityActions(name: string, label: string): AccessibilityActionInfo[];
export function namedAccessibilityActions(actions: readonly NamedAccessibilityAction[]): AccessibilityActionInfo[];
export function namedAccessibilityActions(
  nameOrActions: string | readonly NamedAccessibilityAction[],
  label?: string,
): AccessibilityActionInfo[] {
  if (typeof nameOrActions === 'string') return [{ name: nameOrActions, label: label ?? nameOrActions }];
  return nameOrActions.map(({ name, label: actionLabel }) => ({ name, label: actionLabel }));
}

/**
 * `onAccessibilityAction` handler that runs `run` when the named action fires,
 * or for a list, runs whichever action fired.
 */
export function onNamedAccessibilityAction(name: string, run: () => void): (event: AccessibilityActionEvent) => void;
export function onNamedAccessibilityAction(
  actions: readonly NamedAccessibilityAction[],
): (event: AccessibilityActionEvent) => void;
export function onNamedAccessibilityAction(
  nameOrActions: string | readonly NamedAccessibilityAction[],
  run?: () => void,
): (event: AccessibilityActionEvent) => void {
  return (event: AccessibilityActionEvent) => {
    const fired = event.nativeEvent.actionName;
    if (typeof nameOrActions === 'string') {
      if (fired === nameOrActions) run?.();
      return;
    }
    nameOrActions.find((action) => action.name === fired)?.run();
  };
}
