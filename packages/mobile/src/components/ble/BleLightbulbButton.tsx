import { useEffect } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { Icon } from '../Icon';
import { hapticLight, hapticMedium } from '../../lib/haptics';
import { useTheme } from '../../providers/theme-provider';
import { timing } from '../../theme/animations';
import { getBleLightbulbAccessibilityHint, getBleLightbulbVisualState } from './ble-lightbulb-button-state';

type BleLightbulbButtonProps = {
  isConnected: boolean;
  isScanning: boolean;
  onPress: () => void;
  /**
   * Secondary action on long-press. Wired to disconnect, since a tap now
   * re-lights the wall (when connected) or reconnects (when disconnected)
   * rather than toggling the connection.
   */
  onLongPress?: () => void;
  accessibilityLabel: string;
  /**
   * Whether the control reads as "selected" to assistive tech. Defaults to
   * `isConnected`. Pass the local-BLE connection state when `isConnected` is an
   * OR'd visual (e.g. the bulb is lit because a peer holds the wall) so
   * VoiceOver reflects what tapping does, not just the filled look.
   */
  accessibilitySelected?: boolean;
  scanningAccessibilityHint?: string;
  /** Hint describing the long-press action (e.g. "Hold to disconnect"). */
  longPressAccessibilityHint?: string;
  haptic?: 'light' | 'medium' | 'none';
  size?: number;
  /**
   * Width/height of the pressable container in pixels. Defaults to 44 (iOS HIG
   * minimum tap target). Used to render a larger 56-pt variant inside the play
   * drawer's primary action row.
   */
  containerSize?: number;
};

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export function BleLightbulbButton({
  isConnected,
  isScanning,
  onPress,
  onLongPress,
  accessibilityLabel,
  accessibilitySelected,
  scanningAccessibilityHint,
  longPressAccessibilityHint,
  haptic = 'light',
  size = 24,
  containerSize = 44,
}: BleLightbulbButtonProps) {
  const { systemColors, brandColors } = useTheme();
  const pulseOpacity = useSharedValue(1);

  useEffect(() => {
    if (isScanning) {
      pulseOpacity.value = withRepeat(withTiming(0.35, { duration: timing.slow }), -1, true);
    } else {
      cancelAnimation(pulseOpacity);
      pulseOpacity.value = withTiming(1, { duration: timing.fast });
    }
  }, [isScanning, pulseOpacity]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: pulseOpacity.value,
  }));

  const handlePress = () => {
    if (haptic === 'light') {
      hapticLight();
    } else if (haptic === 'medium') {
      hapticMedium();
    }
    onPress();
  };

  const handleLongPress = onLongPress
    ? () => {
        // A medium tap confirms the (heavier) disconnect action regardless of
        // the configured tap haptic.
        hapticMedium();
        onLongPress();
      }
    : undefined;

  const visualState = getBleLightbulbVisualState({
    isConnected,
    connectedColor: brandColors.warning,
    disconnectedColor: systemColors.secondaryLabel,
  });

  return (
    <AnimatedPressable
      onPress={handlePress}
      onLongPress={handleLongPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={getBleLightbulbAccessibilityHint(
        isScanning,
        scanningAccessibilityHint,
        longPressAccessibilityHint,
      )}
      accessibilityState={{ selected: accessibilitySelected ?? isConnected }}
      hitSlop={8}
      style={({ pressed }) => [
        styles.container,
        { width: containerSize, height: containerSize, borderRadius: containerSize / 2 },
        animatedStyle,
        isConnected && {
          backgroundColor: visualState.backgroundColor,
          shadowColor: visualState.shadowColor,
        },
        isConnected && styles.connected,
        pressed && styles.pressed,
      ]}
    >
      <Icon name={visualState.iconName} size={size} color={visualState.iconColor} />
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  connected: {
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 2,
  },
  pressed: {
    opacity: 0.6,
    transform: [{ scale: 0.92 }],
  },
});
