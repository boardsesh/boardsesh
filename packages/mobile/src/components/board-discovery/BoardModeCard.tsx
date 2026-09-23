import { Pressable, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { hapticLight } from '../../lib/haptics';
import { springs } from '../../theme/animations';
import { spacing, borderRadius } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { ActivityIndicator } from '../ActivityIndicator';
import type { IconName } from '../icon-map';

// No disabled state: a denied or failed location used to dim the Find nearby
// tile and make it untappable, a dead end with no way to Settings. The picker
// now keeps it tappable and says what happened underneath it (#5654).
export type ModeCardState = 'idle' | 'loading' | 'done';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type BoardModeCardProps = {
  icon: IconName;
  label: string;
  /** Small status line under the label (e.g. "Showing nearby", "Allow location"). */
  sublabel?: string;
  state?: ModeCardState;
  onPress: () => void;
};

/**
 * Entry card for a discovery mode (Find Nearby / Bluetooth / Custom / Search).
 * Mirrors the web home's mode cards: an icon + label with per-state styling —
 * idle is tappable, loading shows a spinner, done shows a tick.
 */
export function BoardModeCard({ icon, label, sublabel, state = 'idle', onPress }: BoardModeCardProps) {
  const { systemColors, brandColors } = useTheme();
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  // 'done' is non-interactive: its results are already shown below.
  const nonInteractive = state === 'loading' || state === 'done';
  const tint = state === 'done' ? brandColors.success : brandColors.primary;

  return (
    <AnimatedPressable
      onPress={() => {
        if (nonInteractive) return;
        hapticLight();
        onPress();
      }}
      onPressIn={() => {
        if (!nonInteractive) scale.value = withSpring(0.97, springs.snappy);
      }}
      onPressOut={() => {
        if (!nonInteractive) scale.value = withSpring(1, springs.snappy);
      }}
      accessibilityRole="button"
      accessibilityState={{ disabled: nonInteractive }}
      style={[
        animatedStyle,
        styles.card,
        { backgroundColor: systemColors.secondaryBackground, borderColor: systemColors.separator },
      ]}
    >
      {state === 'loading' ? (
        <ActivityIndicator size="small" />
      ) : (
        <Icon name={state === 'done' ? 'tick' : icon} size={28} color={tint} />
      )}
      <Text variant="footnote" numberOfLines={1} style={styles.label}>
        {label}
      </Text>
      {sublabel ? (
        <Text variant="caption2" color={systemColors.secondaryLabel} numberOfLines={1}>
          {sublabel}
        </Text>
      ) : null}
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  card: {
    // flex: 1 so the mode cards split the row evenly instead of a fixed width
    // each — fixed-width cards + gaps + padding overflowed narrow iPhones once
    // there were three+ of them. aspectRatio keeps them square as they shrink.
    flex: 1,
    aspectRatio: 1,
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing[2],
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[1],
  },
  label: {
    fontWeight: '600',
    textAlign: 'center',
  },
});
