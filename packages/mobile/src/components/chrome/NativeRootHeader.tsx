import { useCallback, useLayoutEffect, useRef, type ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Stack, type NativeStackNavigationOptions } from 'expo-router';
import { useFrameSize, useHeaderHeight } from 'expo-router/react-navigation';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../providers/theme-provider';
import { useFloatingHeaderControls } from '../../hooks/use-floating-header-controls';
import { useGlassCapability } from '../../hooks/use-glass-capability';
import type { ScrollEdgeBackdrop } from '../../hooks/use-scroll-edge-backdrop';
import { glassSize } from '../../theme/layout';

import {
  NativeHeaderActionContext,
  NativeHeaderOwnBackgroundContext,
  NativeTitleMaxWidthContext,
} from './native-header-action-context';
import { nativeTitleMaxWidth } from './native-title-bound';

/** UIKit owns title collapse, edge effects, Dynamic Type and the status-bar tap. */
export function NativeRootHeader({
  title,
  leftActions,
  leftActionsStandalone = false,
  rightActions,
  rightItems,
  centerContent,
  centerActionWidths,
  children,
  opaqueControls = false,
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
  /** Content widths of the native action groups flanking the custom title. */
  centerActionWidths?: { leading: number; trailing: number };
  /** Supplementary controls pinned under the bar; see `HeaderControls`. */
  children?: ReactNode;
  /**
   * Keep the painted band behind `children` even where they could float. For a
   * block that carries bare text, which a blur alone does not keep readable.
   */
  opaqueControls?: boolean;
  /**
   * @deprecated Ignored by the native header; retained for existing callers.
   * Native glass controls draw their individual
   * surfaces without a continuous backdrop or a list-scroll subscription.
   */
  scrollEdge?: ScrollEdgeBackdrop;
  /** Reports the height of `children` alone: the list pads its top by it. */
  onHeightChange: (height: number) => void;
}) {
  const { systemColors } = useTheme();
  const glassCapability = useGlassCapability();
  const headerHeight = useHeaderHeight();
  // The navigation stack's measured frame, including a tablet's local pane.
  // UIKit adds space around shared bar-item backgrounds that Yoga does not see.
  const frameWidth = useFrameSize((frame) => frame.width);
  const insets = useSafeAreaInsets();
  // The title view gets the free space between the two groups (see nativeTitleMaxWidth).
  const centerMaxWidth = centerActionWidths ? nativeTitleMaxWidth(frameWidth, insets, centerActionWidths) : undefined;
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
                    <NativeTitleMaxWidthContext.Provider value={centerMaxWidth}>
                      <View
                        pointerEvents="box-none"
                        style={[styles.centerContent, centerMaxWidth == null ? null : { maxWidth: centerMaxWidth }]}
                      >
                        {centerContent}
                      </View>
                    </NativeTitleMaxWidthContext.Provider>
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
        <HeaderControls headerHeight={headerHeight} opaque={opaqueControls} onLayout={measureControls}>
          {children}
        </HeaderControls>
      ) : null}
    </>
  );
}

/**
 * The controls pinned under the bar: filter chips, a segmented control.
 *
 * On iOS 26 glass they float. Each native control owns its glass surface, with no
 * continuous blur behind the row. UIKit owns the navigation bar's material and
 * status area above this block.
 *
 * Everywhere else the block paints the scene background, as it always has: before
 * iOS 26, with Reduce Transparency or Increase Contrast on, and when the caller
 * opts out.
 *
 * A component of its own so the accessibility reads behind
 * `useFloatingHeaderControls` only run on a screen that has controls.
 */
function HeaderControls({
  headerHeight,
  opaque,
  onLayout,
  children,
}: {
  headerHeight: number;
  opaque: boolean;
  onLayout: (event: LayoutChangeEvent) => void;
  children: ReactNode;
}) {
  const { systemColors } = useTheme();
  const canFloat = useFloatingHeaderControls();
  const floating = canFloat && !opaque;
  return (
    <View
      testID="header-controls"
      // Controls and their gaps own touches rather than opening a row underneath.
      pointerEvents="auto"
      style={[styles.controls, { top: headerHeight }, floating ? null : { backgroundColor: systemColors.background }]}
    >
      <View pointerEvents="box-none" onLayout={onLayout}>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  controls: { position: 'absolute', left: 0, right: 0, zIndex: 20 },
  centerContent: {
    // The same slot as the action groups beside it (`NATIVE_ACTION_SIZE`).
    height: glassSize.bar,
    maxWidth: '100%',
    minWidth: 0,
    flexShrink: 1,
    alignItems: 'stretch',
    justifyContent: 'center',
  },
});
