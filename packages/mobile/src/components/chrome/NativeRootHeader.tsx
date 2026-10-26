import { useCallback, useLayoutEffect, useRef, type ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Stack, type NativeStackNavigationOptions } from 'expo-router';
import { useFrameSize, useHeaderHeight } from 'expo-router/react-navigation';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../providers/theme-provider';
import { useFloatingHeaderControls } from '../../hooks/use-floating-header-controls';
import { useGlassCapability } from '../../hooks/use-glass-capability';
import { HorizontalSafeAreaApplied, useHorizontalSafeArea } from '../../hooks/use-horizontal-safe-area';
import type { ScrollEdgeBackdrop } from '../../hooks/use-scroll-edge-backdrop';
import { glassSize } from '../../theme/layout';

import {
  NativeHeaderActionContext,
  NativeHeaderOwnBackgroundContext,
  NativeTitleMaxWidthContext,
} from './native-header-action-context';
import { nativeItemsTitleMaxWidth, nativeTitleMaxWidth, type NativeBarSide } from './native-title-bound';
import { HIDDEN_HEADER_TITLE_STYLE } from './hidden-header-title';

/** UIKit owns title collapse, edge effects, Dynamic Type and the status-bar tap. */
export function NativeRootHeader({
  title,
  leftActions,
  leftActionsStandalone = false,
  rightActions,
  leftItems,
  rightItems,
  centerContent,
  centerActionWidths,
  centerItemSides,
  titleHidden = false,
  children,
  opaqueControls = false,
  onHeightChange,
}: {
  title?: string;
  leftActions?: ReactNode;
  /** A single avatar draws a circle instead of UIKit's wider shared capsule. */
  leftActionsStandalone?: boolean;
  rightActions?: ReactNode;
  /**
   * Native leading bar items (`root-bar-items.ts`). When set they replace
   * `leftActions`: iPhone Duo moves native items onto its side rail.
   */
  leftItems?: NativeStackNavigationOptions['unstable_headerLeftItems'];
  /** Native bar items take precedence over the custom trailing group. */
  rightItems?: NativeStackNavigationOptions['unstable_headerRightItems'];
  /** Interactive content in the compact native bar, beside the action groups. */
  centerContent?: ReactNode;
  /** Content widths of the native action groups flanking the custom title. */
  centerActionWidths?: { leading: number; trailing: number };
  /**
   * What the native bar items on each side hold, for `leftItems`/`rightItems`:
   * they take UIKit's measured widths, not the custom 38pt slots. Takes
   * precedence over `centerActionWidths`.
   */
  centerItemSides?: { leading: NativeBarSide; trailing: NativeBarSide };
  /**
   * Draw no title, large or inline, for a screen whose tab already names it
   * (Climbs). `centerContent` still shows when present.
   */
  titleHidden?: boolean;
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
  const centerMaxWidth = centerItemSides
    ? nativeItemsTitleMaxWidth(frameWidth, insets, centerItemSides)
    : centerActionWidths
      ? nativeTitleMaxWidth(frameWidth, insets, centerActionWidths)
      : undefined;
  // Stable renderer identity across re-renders that change neither input: one
  // fewer header option that changes on every render of the screen (#6619).
  const hasCenterContent = centerContent != null;
  const renderCenterContent = useCallback(
    () => (
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
    ),
    [centerContent, centerMaxWidth],
  );
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
          headerLargeTitle: !hasCenterContent && !titleHidden,
          headerTransparent: true,
          // iOS 26 owns the scroll-edge material; don't inherit the legacy blur.
          headerBlurEffect: glassCapability ? undefined : 'systemMaterial',
          headerShadowVisible: false,
          headerLargeTitleShadowVisible: false,
          // Route layouts own the title even while a root modal is focused.
          ...(title === undefined ? {} : { title }),
          headerTitle: hasCenterContent ? renderCenterContent : undefined,
          headerTitleStyle: titleHidden ? HIDDEN_HEADER_TITLE_STYLE : { color: systemColors.label },
          headerLargeTitleStyle: { color: systemColors.label },
          headerLeft:
            leftActions && !leftItems && !leftActionsStandalone
              ? () => (
                  <NativeHeaderActionContext.Provider value={true}>{leftActions}</NativeHeaderActionContext.Provider>
                )
              : undefined,
          unstable_headerLeftItems:
            leftItems ??
            (leftActions && leftActionsStandalone
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
              : undefined),
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
  // Clear of iPhone Duo's side status bar and tab rail; 0 on a portrait iPhone.
  const { left, right } = useHorizontalSafeArea();
  return (
    <View
      testID="header-controls"
      // Controls and their gaps own touches rather than opening a row underneath.
      pointerEvents="auto"
      style={[
        styles.controls,
        { top: headerHeight, left, right },
        floating ? null : { backgroundColor: systemColors.background },
      ]}
    >
      <View pointerEvents="box-none" onLayout={onLayout}>
        {/* The frame above is already inset; a nested ReadableColumn must not pad again. */}
        <HorizontalSafeAreaApplied>{children}</HorizontalSafeAreaApplied>
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
