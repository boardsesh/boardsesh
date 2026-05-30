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
import { hapticLight } from '../../lib/haptics';
import { useTheme } from '../../providers/theme-provider';
import { timing } from '../../theme/animations';

type BleLightbulbButtonProps = {
  isConnected: boolean;
  isScanning: boolean;
  onPress: () => void;
  accessibilityLabel: string;
  size?: number;
};

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export function BleLightbulbButton({
  isConnected,
  isScanning,
  onPress,
  accessibilityLabel,
  size = 24,
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
    hapticLight();
    onPress();
  };

  const iconName = isConnected ? 'lightbulb.fill' : 'lightbulb';
  const iconColor = isConnected ? brandColors.warning : (systemColors.secondaryLabel as string);

  return (
    <AnimatedPressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: isConnected, busy: isScanning }}
      hitSlop={8}
      style={({ pressed }) => [
        styles.container,
        isConnected && {
          backgroundColor: `${brandColors.warning}24`,
          shadowColor: brandColors.warning,
        },
        isConnected && styles.connected,
        pressed && styles.pressed,
        animatedStyle,
      ]}
    >
      <Icon name={iconName} size={size} color={iconColor} />
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  container: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
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
