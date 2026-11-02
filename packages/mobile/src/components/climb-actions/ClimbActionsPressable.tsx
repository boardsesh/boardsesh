import { useCallback, useRef, type ReactNode } from 'react';
import { View, type AccessibilityActionEvent, type ViewProps } from 'react-native';
import { GestureDetector, useTapGesture } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import type { ClimbActionsTarget } from '../../providers/drawer-host-provider';
import { ClimbMenu, useClimbMenu } from './ClimbActionsMenu';

/** A row body with a native context menu and a bounded, independently owned tap. */
export function ClimbActionsPressable({
  target,
  onPress,
  children,
  ...viewProps
}: ViewProps & {
  target: ClimbActionsTarget | null;
  onPress: () => void;
  children: ReactNode;
}) {
  const menu = useClimbMenu(target);
  const pressRef = useRef(onPress);
  pressRef.current = onPress;
  const press = useCallback(() => pressRef.current(), []);
  const tap = useTapGesture({
    maxDuration: 400,
    maxDistance: 15,
    onActivate: () => {
      'worklet';
      runOnJS(press)();
    },
  });
  const onAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === 'activate') press();
      else menu.onAccessibilityAction(event);
    },
    [press, menu.onAccessibilityAction],
  );
  return (
    <ClimbMenu rows={menu.rows} menuKey={menu.menuKey}>
      <GestureDetector gesture={tap} touchAction="pan-y">
        <View
          {...viewProps}
          accessible
          accessibilityRole="button"
          onAccessibilityTap={press}
          accessibilityActions={[{ name: 'activate' }, ...menu.accessibilityActions]}
          onAccessibilityAction={onAccessibilityAction}
        >
          {children}
        </View>
      </GestureDetector>
    </ClimbMenu>
  );
}
