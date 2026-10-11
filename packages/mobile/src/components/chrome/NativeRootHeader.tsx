import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Stack, type NativeStackNavigationOptions } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useTheme } from '../../providers/theme-provider';
import { useFloatingHeaderControls } from '../../hooks/use-floating-header-controls';
import { useGlassCapability } from '../../hooks/use-glass-capability';
import { useReduceMotion } from '../../hooks/use-reduce-motion';
import { timing } from '../../theme/animations';
import { glassSize } from '../../theme/layout';
import { ProgressiveBlur } from '../ProgressiveBlur';

import { NativeHeaderActionContext, NativeHeaderOwnBackgroundContext } from './native-header-action-context';

/**
 * The blur behind floating controls. These numbers are the whole look, so tune
 * them here and nowhere else.
 */
export const CONTROLS_BACKDROP = {
  /** Stacked thin-material layers: each one frosts the list behind more heavily. */
  layers: 1,
  /** Points over which the blur fades out along the block's bottom edge. */
  fadeLength: 24,
  /**
   * Scene-background wash over the blur, 0 to 1: how far the list behind fades
   * toward the page colour. Thin material alone frosts grey over a black page
   * and reads as a band; at half strength the rows still show passing under the
   * controls and the region stays close to the page. Tuned on a simulator in
   * dark mode.
   */
  washOpacity: 0.5,
  /** Milliseconds the blur takes to fade in or out as rows pass under the block. */
  fadeDuration: timing.fast,
} as const;

/** UIKit owns title collapse, edge effects, Dynamic Type and the status-bar tap. */
export function NativeRootHeader({
  title,
  leftActions,
  leftActionsStandalone = false,
  rightActions,
  rightItems,
  centerContent,
  children,
  opaqueControls = false,
  scrolledUnder,
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
  /** Supplementary controls pinned under the bar; see `HeaderControls`. */
  children?: ReactNode;
  /**
   * Keep the painted band behind `children` even where they could float. For a
   * block that carries bare text, which a blur alone does not keep readable.
   */
  opaqueControls?: boolean;
  /**
   * Whether the list is scrolled under `children` (`useScrollEdgeBackdrop`). The
   * blur behind floating controls shows only then; at rest there is nothing but
   * the page behind them. Leave it out and the blur is always on: a screen that
   * forgets the wiring gets a frost at rest, which is plain to see and harmless,
   * where the other default would put bare controls over rows mid-scroll.
   */
  scrolledUnder?: boolean;
  /** Reports the height of `children` alone: the list pads its top by it. */
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
        <HeaderControls
          headerHeight={headerHeight}
          opaque={opaqueControls}
          backdropVisible={scrolledUnder ?? true}
          onLayout={measureControls}
        >
          {children}
        </HeaderControls>
      ) : null}
    </>
  );
}

/**
 * The controls pinned under the bar: filter chips, a segmented control.
 *
 * On iOS 26 glass they float. The list scrolls behind them and one blur, from the
 * top of the screen to the bottom of this block, keeps them readable: HIG Layout
 * asks for a scroll edge effect under controls, not a painted colour. Like the
 * system's, it is there only while rows are behind the controls. The blur is a
 * material, never a glass panel, because the controls on it are glass already
 * (HIG Materials: no glass on glass).
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
  backdropVisible,
  onLayout,
  children,
}: {
  headerHeight: number;
  opaque: boolean;
  backdropVisible: boolean;
  onLayout: (event: LayoutChangeEvent) => void;
  children: ReactNode;
}) {
  const { systemColors } = useTheme();
  const canFloat = useFloatingHeaderControls();
  const floating = canFloat && !opaque;
  return (
    <View
      onLayout={onLayout}
      // NOT box-none, floating or not: a row the blur has smeared must not take a
      // tap through the gaps between the controls.
      pointerEvents="auto"
      style={[styles.controls, { top: headerHeight }, floating ? null : { backgroundColor: systemColors.background }]}
    >
      {floating ? <ControlsBackdrop headerHeight={headerHeight} visible={backdropVisible} /> : null}
      {children}
    </View>
  );
}

/**
 * The blur behind floating controls, faded in while rows are under them.
 *
 * Absolutely positioned, so the block's measured height (the number the list pads
 * by) is the controls alone. It reaches up past the block's own top to the top of
 * the screen, under the native bar, and down past its bottom by the fade's
 * length: the blur holds full strength behind every control and fades out over
 * the rows just below, so a translucent control (the segmented control) never
 * has sharp text showing through its lower half. It stays mounted while hidden:
 * a view at zero opacity is not drawn, and the fade in has nothing to build.
 */
function ControlsBackdrop({ headerHeight, visible }: { headerHeight: number; visible: boolean }) {
  const reduceMotion = useReduceMotion();
  const opacity = useSharedValue(visible ? 1 : 0);
  useEffect(() => {
    const target = visible ? 1 : 0;
    opacity.value = reduceMotion ? target : withTiming(target, { duration: CONTROLS_BACKDROP.fadeDuration });
  }, [visible, reduceMotion, opacity]);
  const fade = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.backdrop, { top: -headerHeight, bottom: -CONTROLS_BACKDROP.fadeLength }, fade]}
    >
      <ProgressiveBlur
        style={StyleSheet.absoluteFill}
        layers={CONTROLS_BACKDROP.layers}
        fadeLength={CONTROLS_BACKDROP.fadeLength}
        washOpacity={CONTROLS_BACKDROP.washOpacity}
        scrim={false}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  controls: { position: 'absolute', left: 0, right: 0, zIndex: 20 },
  backdrop: { position: 'absolute', left: 0, right: 0 },
  centerContent: {
    height: glassSize.inline,
    maxWidth: '100%',
    minWidth: 0,
    flexShrink: 1,
    alignItems: 'stretch',
    justifyContent: 'center',
  },
});
