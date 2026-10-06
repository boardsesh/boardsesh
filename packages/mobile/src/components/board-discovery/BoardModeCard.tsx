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

/**
 * Lets a long label give up a little size before it wraps badly: at most the
 * step from footnote down to caption1 (13 → 12 on iOS, 12 → 11 on Android).
 */
const LABEL_MIN_FONT_SCALE = 0.92;

/**
 * What VoiceOver and TalkBack read for a tile. Without it the Pressable reads
 * every child, and the SF Symbol announces its own name first ("camera, Spray
 * wall", #5960).
 */
export function modeCardAccessibilityLabel(label: string, sublabel?: string): string {
  return sublabel ? `${label}, ${sublabel}` : label;
}

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
      accessibilityLabel={modeCardAccessibilityLabel(label, sublabel)}
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
      {/* Two lines, not one: with five tiles in the row, one line cut "Bluetooth",
          "Find gym" and "Spray wall" to "Bluet…", "Find…", "Spra…" (#5960). */}
      <Text
        variant="footnote"
        numberOfLines={2}
        adjustsFontSizeToFit
        minimumFontScale={LABEL_MIN_FONT_SCALE}
        style={styles.label}
      >
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
    // there were three+ of them. A square floor rather than a fixed square, so a
    // two-line label can grow the tile; the row stretches every tile to the
    // tallest one, so they stay the same height.
    flex: 1,
    minHeight: 64,
    paddingVertical: spacing[2],
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing[1],
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[1],
  },
  label: {
    fontWeight: '600',
    textAlign: 'center',
  },
});
