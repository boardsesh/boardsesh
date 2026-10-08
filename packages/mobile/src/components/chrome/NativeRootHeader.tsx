import { useCallback, useLayoutEffect, useRef, type ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Stack, type NativeStackNavigationOptions } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useTheme } from '../../providers/theme-provider';
import { useGlassCapability } from '../../hooks/use-glass-capability';
import { glassSize } from '../../theme/layout';

import { NativeHeaderActionContext, NativeHeaderOwnBackgroundContext } from './native-header-action-context';

/** UIKit owns title collapse, edge effects, Dynamic Type and the status-bar tap. */
export function NativeRootHeader({
  title,
  leftActions,
  leftActionsStandalone = false,
  rightActions,
  rightItems,
  centerContent,
  children,
  onHeightChange,
}: {
  title?: string;
  leftActions?: ReactNode;
  /** A single avatar draws a circle instead of UIKit's wider shared capsule. */
  leftActionsStandalone?: boolean;
  rightActions?: ReactNode;
  /** Native bar items take precedence over the custom trailing group. */
  rightItems?: NativeStackNavigationOptions['unstable_headerRightItems'];
  /** Interactive content in the compact native bar, beside the action groups. */
  centerContent?: ReactNode;
  children?: ReactNode;
  onHeightChange: (height: number) => void;
}) {
  const { systemColors } = useTheme();
  const glassCapability = useGlassCapability();
  const headerHeight = useHeaderHeight();
  const controlsHeight = useRef(0);
  const hasControls = children != null;
  useLayoutEffect(() => {
    if (!hasControls) controlsHeight.current = 0;
    onHeightChange(controlsHeight.current);
  }, [onHeightChange, hasControls]);
  const measureControls = useCallback(
    (event: LayoutChangeEvent) => {
      controlsHeight.current = event.nativeEvent.layout.height;
      onHeightChange(controlsHeight.current);
    },
    [onHeightChange],
  );
  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          // The current-climb pill replaces the root title while it is present.
          headerLargeTitle: centerContent == null,
          headerTransparent: true,
          // iOS 26 owns the scroll-edge material; don't inherit the legacy blur.
          headerBlurEffect: glassCapability ? undefined : 'systemMaterial',
          headerShadowVisible: false,
          headerLargeTitleShadowVisible: false,
          // Route layouts own the title even while a root modal is focused.
          ...(title === undefined ? {} : { title }),
          headerTitle:
            centerContent != null
              ? () => (
                  <NativeHeaderActionContext.Provider value={true}>
                    <View pointerEvents="box-none" style={styles.centerContent}>
                      {centerContent}
                    </View>
                  </NativeHeaderActionContext.Provider>
                )
              : undefined,
          headerTitleStyle: { color: systemColors.label },
          headerLargeTitleStyle: { color: systemColors.label },
          headerLeft:
            leftActions && !leftActionsStandalone
              ? () => (
                  <NativeHeaderActionContext.Provider value={true}>{leftActions}</NativeHeaderActionContext.Provider>
                )
              : undefined,
          unstable_headerLeftItems:
            leftActions && leftActionsStandalone
              ? () => [
                  {
                    type: 'custom',
                    hidesSharedBackground: true,
                    element: (
                      <NativeHeaderActionContext.Provider value={true}>
                        <NativeHeaderOwnBackgroundContext.Provider value={true}>
                          {leftActions}
                        </NativeHeaderOwnBackgroundContext.Provider>
                      </NativeHeaderActionContext.Provider>
                    ),
                  },
                ]
              : undefined,
          headerRight: rightActions
            ? () => <NativeHeaderActionContext.Provider value={true}>{rightActions}</NativeHeaderActionContext.Provider>
            : undefined,
          unstable_headerRightItems: rightItems,
        }}
      />
      {hasControls ? (
        <View
          onLayout={measureControls}
          style={[styles.controls, { top: headerHeight, backgroundColor: systemColors.background }]}
        >
          {children}
        </View>
      ) : null}
    </>
  );
}
const styles = StyleSheet.create({
  controls: { position: 'absolute', left: 0, right: 0, zIndex: 20 },
  centerContent: {
    height: glassSize.inline,
    maxWidth: '100%',
    minWidth: 0,
    flexShrink: 1,
    alignItems: 'stretch',
    justifyContent: 'center',
  },
});
