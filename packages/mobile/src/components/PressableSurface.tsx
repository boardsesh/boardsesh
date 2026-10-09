import { useState, type ComponentProps, type Ref } from 'react';
import {
  Pressable,
  Platform,
  StyleSheet,
  type View,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useReduceMotion } from '../hooks/use-reduce-motion';
import { springs } from '../theme/animations';
import { androidRipple, opacity, material } from '../theme/tokens';
import { brandColors } from '../theme/colors';

type RNPressableProps = ComponentProps<typeof Pressable>;
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
export type PressFeedback = 'scale' | 'opacity' | 'none';
export type PressableSurfaceProps = RNPressableProps & {
  ref?: Ref<View>;
  feedback?: PressFeedback;
  scaleTo?: number;
  opacityTo?: number;
  rippleColor?: string;
  rippleBorderless?: boolean;
};
export type StaticPressableSurfaceProps = Omit<PressableSurfaceProps, 'feedback' | 'scaleTo' | 'opacityTo'>;

/** Native Pressable contract with platform feedback; persistence and haptics stay with callers. */
export function PressableSurface({
  feedback = 'scale',
  scaleTo = 0.96,
  opacityTo = 0.7,
  rippleColor,
  rippleBorderless = false,
  disabled = false,
  accessibilityRole = 'button',
  accessibilityState,
  android_ripple,
  onPressIn,
  onPressOut,
  style,
  ...props
}: PressableSurfaceProps) {
  const state = { ...accessibilityState, disabled: disabled || accessibilityState?.disabled };
  // Android's native ripple needs no Reanimated values or accessibility-motion
  // subscriber. iOS keeps its animated host even when feedback changes to none,
  // preserving active touches, refs and assistive focus across mode changes.
  if (Platform.OS === 'android') {
    return (
      <StaticPressableSurface
        {...props}
        disabled={disabled}
        accessibilityRole={accessibilityRole}
        accessibilityState={state}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        android_ripple={android_ripple}
        rippleColor={rippleColor}
        rippleBorderless={rippleBorderless}
        style={style}
      />
    );
  }
  return (
    <AnimatedFeedbackPressable
      {...props}
      disabled={disabled}
      accessibilityRole={accessibilityRole}
      accessibilityState={state}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      feedback={feedback}
      scaleTo={scaleTo}
      opacityTo={opacityTo}
      style={style}
    />
  );
}

/** A permanently native surface: opt in only when animated feedback is unnecessary. */
export function StaticPressableSurface({
  rippleColor,
  rippleBorderless = false,
  disabled = false,
  accessibilityRole = 'button',
  accessibilityState,
  android_ripple,
  style,
  ...props
}: StaticPressableSurfaceProps) {
  const state = { ...accessibilityState, disabled: disabled || accessibilityState?.disabled };
  const resolveStyle = (callerStyle: StyleProp<ViewStyle>) => {
    if (!disabled) return callerStyle;
    const callerOpacity = StyleSheet.flatten(callerStyle)?.opacity;
    return [
      callerStyle,
      {
        opacity:
          Platform.OS === 'android'
            ? material.disabledContentOpacity
            : (typeof callerOpacity === 'number' ? callerOpacity : 1) * opacity.disabled,
      },
    ];
  };
  return (
    <Pressable
      {...props}
      disabled={disabled}
      accessibilityRole={accessibilityRole}
      accessibilityState={state}
      android_ripple={
        Platform.OS === 'android'
          ? (android_ripple ?? androidRipple(rippleColor ?? brandColors.tint, rippleBorderless))
          : android_ripple
      }
      style={typeof style === 'function' ? (pressState) => resolveStyle(style(pressState)) : resolveStyle(style)}
    />
  );
}

function AnimatedFeedbackPressable({
  feedback,
  scaleTo,
  opacityTo,
  disabled,
  onPressIn,
  onPressOut,
  style,
  ...props
}: RNPressableProps & { feedback: PressFeedback; scaleTo: number; opacityTo: number }) {
  const pressed = useSharedValue(0);
  const [callbackPressed, setCallbackPressed] = useState(false);
  const reduceMotion = useReduceMotion();
  const resolvedFeedback = reduceMotion && feedback === 'scale' ? 'opacity' : feedback;
  const callerStyle = typeof style === 'function' ? style({ pressed: callbackPressed }) : style;
  const flatStyle = StyleSheet.flatten(callerStyle);
  const callerTransform = Array.isArray(flatStyle?.transform) ? flatStyle.transform : [];
  const callerOpacity = typeof flatStyle?.opacity === 'number' ? flatStyle.opacity : 1;
  const animatedStyle = useAnimatedStyle(() => {
    // Reanimated values outrank static styles regardless of array order. Keep
    // disabled dimming in this worklet, and reset both animated properties when
    // the feedback mode changes so a previous scale/opacity cannot remain stuck.
    const scale = !disabled && resolvedFeedback === 'scale' ? 1 - (1 - scaleTo) * pressed.value : 1;
    const feedbackOpacity = resolvedFeedback === 'opacity' ? 1 - (1 - opacityTo) * pressed.value : 1;
    const alpha = disabled ? opacity.disabled : feedbackOpacity;
    return { transform: [...callerTransform, { scale }], opacity: callerOpacity * alpha };
  });
  const handlePressIn = (event: GestureResponderEvent) => {
    if (typeof style === 'function') setCallbackPressed(true);
    if (resolvedFeedback !== 'none') pressed.value = reduceMotion ? 1 : withSpring(1, springs.snappy);
    onPressIn?.(event);
  };
  const handlePressOut = (event: GestureResponderEvent) => {
    if (typeof style === 'function') setCallbackPressed(false);
    if (resolvedFeedback !== 'none') pressed.value = reduceMotion ? 0 : withSpring(0, springs.snappy);
    onPressOut?.(event);
  };
  return (
    <AnimatedPressable
      {...props}
      disabled={disabled}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={[callerStyle, animatedStyle]}
    />
  );
}
