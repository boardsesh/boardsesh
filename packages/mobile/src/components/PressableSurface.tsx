import { type ReactNode } from 'react';
import {
  Pressable,
  Platform,
  type AccessibilityActionEvent,
  type AccessibilityActionInfo,
  type AccessibilityRole,
  type AccessibilityState,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { springs } from '../theme/animations';
import { androidRipple } from '../theme/tokens';
import { brandColors as staticBrandColors } from '../theme/colors';
import { useOptionalTheme } from '../providers/theme-provider';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * iOS press feedback. `scale` shrinks the target (buttons, cards), `opacity`
 * dims it (list rows), `none` disables motion (the ripple still fires on
 * Android). Android always uses a Material ripple regardless of this value.
 */
export type PressFeedback = 'scale' | 'opacity' | 'none';

type PressableSurfaceProps = {
  children: ReactNode;
  onPress?: (event: GestureResponderEvent) => void;
  onPressIn?: (event: GestureResponderEvent) => void;
  onPressOut?: (event: GestureResponderEvent) => void;
  onLongPress?: (event: GestureResponderEvent) => void;
  onLayout?: (event: LayoutChangeEvent) => void;
  disabled?: boolean;
  /** iOS feedback style (default 'scale'). Android uses a ripple either way. */
  feedback?: PressFeedback;
  /** Pressed scale target for 'scale' feedback (default 0.96). */
  scaleTo?: number;
  /** Pressed opacity target for 'opacity' feedback (default 0.7). */
  opacityTo?: number;
  /** Android ripple base colour, composited at the M3 pressed state-layer opacity. */
  rippleColor?: string;
  /** Borderless ripple for circular targets (tab items, icon buttons). */
  rippleBorderless?: boolean;
  hitSlop?: number;
  accessibilityRole?: AccessibilityRole;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityState?: AccessibilityState;
  /** Custom assistive-tech actions (e.g. a long-press equivalent VoiceOver / Switch Control can reach). */
  accessibilityActions?: ReadonlyArray<AccessibilityActionInfo>;
  onAccessibilityAction?: (event: AccessibilityActionEvent) => void;
  style?: StyleProp<ViewStyle>;
};

/**
 * One touch-feedback primitive behind a single API: a native Material ripple on
 * Android, the app's reanimated scale/opacity spring on iOS. Replaces the
 * hand-rolled AnimatedPressable found in Button/ListRow/Card/SegmentedControl
 * and the tab-bar items so Android gets idiomatic ripple feedback without
 * touching the iOS look. Haptics stay with the caller (this primitive is purely
 * visual feedback).
 */
export function PressableSurface({
  children,
  onPress,
  onPressIn,
  onPressOut,
  onLongPress,
  onLayout,
  disabled = false,
  feedback = 'scale',
  scaleTo = 0.96,
  opacityTo = 0.7,
  rippleColor,
  rippleBorderless = false,
  hitSlop,
  accessibilityRole = 'button',
  accessibilityLabel,
  accessibilityHint,
  accessibilityState,
  accessibilityActions,
  onAccessibilityAction,
  style,
}: PressableSurfaceProps) {
  const theme = useOptionalTheme();
  const defaultRippleColor = theme?.brandColors.tint ?? staticBrandColors.tint;
  // `pressed` is 0 at rest, 1 while held. Resolved into a scale or opacity in
  // the worklet so the same shared value drives either feedback mode.
  const pressed = useSharedValue(0);

  const animatedStyle = useAnimatedStyle(() => {
    if (feedback === 'scale') {
      return { transform: [{ scale: 1 - (1 - scaleTo) * pressed.value }] };
    }
    if (feedback === 'opacity') {
      return { opacity: 1 - (1 - opacityTo) * pressed.value };
    }
    return {};
  });

  const handlePressIn = (event: GestureResponderEvent) => {
    if (feedback !== 'none') {
      pressed.value = withSpring(1, springs.snappy);
    }
    onPressIn?.(event);
  };

  const handlePressOut = (event: GestureResponderEvent) => {
    if (feedback !== 'none') {
      pressed.value = withSpring(0, springs.snappy);
    }
    onPressOut?.(event);
  };

  // Android: native ripple, no transform/opacity worklet (ripple + a reanimated
  // transform on the same node clip awkwardly). The ripple is the platform-
  // correct press feedback, so it fires regardless of `feedback` (which only
  // governs the iOS motion) — a tab item with feedback="none" still ripples.
  if (Platform.OS === 'android') {
    return (
      <Pressable
        onPress={onPress}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        onLongPress={onLongPress}
        onLayout={onLayout}
        disabled={disabled}
        android_ripple={androidRipple(rippleColor ?? defaultRippleColor, rippleBorderless)}
        hitSlop={hitSlop}
        accessibilityRole={accessibilityRole}
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        accessibilityState={accessibilityState}
        accessibilityActions={accessibilityActions}
        onAccessibilityAction={onAccessibilityAction}
        style={style}
      >
        {children}
      </Pressable>
    );
  }

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onLongPress={onLongPress}
      onLayout={onLayout}
      disabled={disabled}
      hitSlop={hitSlop}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={accessibilityState}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      style={[animatedStyle, style]}
    >
      {children}
    </AnimatedPressable>
  );
}
