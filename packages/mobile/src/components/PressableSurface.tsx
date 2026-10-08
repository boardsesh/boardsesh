import { useState, type ComponentProps, type Ref } from 'react';
import { Pressable, Platform, StyleSheet, type View, type GestureResponderEvent } from 'react-native';
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
  const state = { ...accessibilityState, disabled: disabled || accessibilityState?.disabled };
  const disabledStyle = disabled
    ? { opacity: Platform.OS === 'android' ? material.disabledContentOpacity : opacity.disabled }
    : undefined;
  if (Platform.OS === 'android') {
    return (
      <Pressable
        {...props}
        disabled={disabled}
        accessibilityRole={accessibilityRole}
        accessibilityState={state}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        android_ripple={android_ripple ?? androidRipple(rippleColor ?? brandColors.tint, rippleBorderless)}
        style={
          typeof style === 'function' ? (pressState) => [style(pressState), disabledStyle] : [style, disabledStyle]
        }
      />
    );
  }
  return (
    <AnimatedPressable
      {...props}
      disabled={disabled}
      accessibilityRole={accessibilityRole}
      accessibilityState={state}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={[callerStyle, animatedStyle, disabledStyle]}
    />
  );
}
