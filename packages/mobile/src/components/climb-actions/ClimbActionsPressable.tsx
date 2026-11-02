import { useCallback, useMemo, useRef, type ReactNode } from 'react';
import { type AccessibilityActionEvent, type ViewProps } from 'react-native';
import { GestureDetector, useTapGesture } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import type { ClimbActionsTarget } from '../../providers/drawer-host-provider';
import { useReduceMotion } from '../../hooks/use-reduce-motion';
import { ACTIVATE_ACCESSIBILITY_ACTIONS } from '../../lib/row-accessibility-actions';
import { springs } from '../../theme/animations';
import { ClimbMenu, useClimbMenu } from './ClimbActionsMenu';

// The dim a card takes while a finger is on it: PressableSurface's opacity feedback.
const PRESSED_OPACITY = 0.7;

/** A row body with a native context menu and a bounded, independently owned tap. */
export function ClimbActionsPressable({
  target,
  onPress,
  children,
  style,
  ...viewProps
}: ViewProps & {
  target: ClimbActionsTarget | null;
  onPress: () => void;
  children: ReactNode;
}) {
  const menu = useClimbMenu(target);
  const reduceMotion = useReduceMotion();
  const pressRef = useRef(onPress);
  pressRef.current = onPress;
  const press = useCallback(() => pressRef.current(), []);
  // The tap owns the press, so it also owns the press feedback a Pressable
  // would have drawn: dim on touch-down, back on release or cancel.
  const pressed = useSharedValue(0);
  const tap = useTapGesture({
    maxDuration: 400,
    maxDistance: 15,
    onBegin: () => {
      'worklet';
      pressed.value = reduceMotion ? 1 : withSpring(1, springs.snappy);
    },
    onActivate: () => {
      'worklet';
      runOnJS(press)();
    },
    onFinalize: () => {
      'worklet';
      pressed.value = reduceMotion ? 0 : withSpring(0, springs.snappy);
    },
  });
  const pressedStyle = useAnimatedStyle(() => ({ opacity: 1 - (1 - PRESSED_OPACITY) * pressed.value }));
  const onAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === 'activate') press();
      else menu.onAccessibilityAction(event);
    },
    [press, menu.onAccessibilityAction],
  );
  // `activate` only where TalkBack needs it: on iOS a double-tap already reaches
  // onAccessibilityTap, and a bare `activate` entry would be read out as a
  // custom action (lib/row-accessibility-actions).
  const accessibilityActions = useMemo(
    () => [...(ACTIVATE_ACCESSIBILITY_ACTIONS ?? []), ...menu.accessibilityActions],
    [menu.accessibilityActions],
  );
  return (
    <ClimbMenu rows={menu.rows} menuKey={menu.menuKey}>
      <GestureDetector gesture={tap} touchAction="pan-y">
        <Animated.View
          {...viewProps}
          style={[style, pressedStyle]}
          accessible
          accessibilityRole="button"
          onAccessibilityTap={press}
          accessibilityActions={accessibilityActions}
          onAccessibilityAction={onAccessibilityAction}
        >
          {children}
        </Animated.View>
      </GestureDetector>
    </ClimbMenu>
  );
}
