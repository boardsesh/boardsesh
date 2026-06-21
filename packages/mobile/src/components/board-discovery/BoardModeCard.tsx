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

export type ModeCardState = 'idle' | 'loading' | 'done' | 'denied' | 'unavailable';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type BoardModeCardProps = {
  icon: IconName;
  label: string;
  /** Small status line under the label (e.g. "Scanning…", "Allow location"). */
  sublabel?: string;
  state?: ModeCardState;
  onPress: () => void;
};

/**
 * Entry card for a discovery mode (Find Nearby / Bluetooth / Custom / Search).
 * Mirrors the web home's mode cards: an icon + label with per-state styling —
 * idle is tappable, loading shows a spinner, denied/unavailable dim and disable.
 */
export function BoardModeCard({ icon, label, sublabel, state = 'idle', onPress }: BoardModeCardProps) {
  const { systemColors, brandColors } = useTheme();
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  // 'done' is non-interactive (its results are already shown below) but, unlike
  // denied/unavailable, it's a success state — not dimmed.
  const nonInteractive = state === 'denied' || state === 'unavailable' || state === 'loading' || state === 'done';
  const dimmed = state === 'denied' || state === 'unavailable';
  const tint =
    state === 'denied' || state === 'unavailable'
      ? systemColors.tertiaryLabel
      : state === 'done'
        ? brandColors.success
        : brandColors.primary;

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
        dimmed ? styles.dimmed : null,
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
  dimmed: {
    opacity: 0.55,
  },
  label: {
    fontWeight: '600',
    textAlign: 'center',
  },
});
