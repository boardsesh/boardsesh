import { View, Pressable, StyleSheet } from 'react-native';
import { Icon } from './Icon';
import { hapticSelection } from '../lib/haptics';
import { useTheme } from '../providers/theme-provider';
import { spacing } from '../theme/tokens';

type StarRatingProps = {
  /** Current rating value. 0 or undefined means no stars selected. */
  value: number | undefined;
  /** Called when a star is tapped. Tapping the current value clears it (returns 0 or undefined). */
  onChange: (rating: number | undefined) => void;
  /** Number of stars to display. Defaults to 5. */
  maxStars?: number;
  /**
   * Glyph size in points. The tap target stays 44pt regardless, so this only
   * changes how big the star draws inside its target. Defaults to 28 — the size
   * every pre-existing caller was built around; the tick sheets pass 24.
   */
  size?: number;
  /** Value returned when the user taps the currently-selected star. Defaults to 0. */
  clearValue?: number | undefined;
  getAccessibilityLabel?: (rating: number, selected: boolean) => string;
  accessibilityHint?: string;
};

export function StarRating({
  value,
  onChange,
  maxStars = 5,
  size = 28,
  clearValue = 0,
  getAccessibilityLabel,
  accessibilityHint,
}: StarRatingProps) {
  // Both colours resolve per scheme. The old pair was scheme-static: #FFB800
  // gold and #C7C7CC (light-mode chrome grey), which made an UNSET optional
  // field the loudest object on a dark sheet at roughly 10:1.
  //
  // Empty stars sit on `secondaryLabel`, not `tertiaryLabel`. On iOS both are
  // PlatformColor alphas over the sheet's now-opaque ground, and tertiary's ~30%
  // composites to 1.73:1 light / 2.46:1 dark — under the 3:1 floor for a thin
  // outline glyph. secondaryLabel's 60% lands at 3.44:1 light / 6.14:1 dark
  // (Android's opaque fallbacks: 7.18:1 / 7.40:1). The filled amber still reads
  // clearly above it (5.02:1 light / 10.92:1 dark), so set-vs-unset survives.
  const { brandColors, systemColors } = useTheme();
  const stars = Array.from({ length: maxStars }, (_, index) => index + 1);

  return (
    <View style={styles.starRow}>
      {stars.map((starIndex) => {
        const filled = value != null && starIndex <= value;
        const selected = starIndex === value;
        return (
          <Pressable
            key={starIndex}
            onPress={() => {
              hapticSelection();
              onChange(starIndex === value ? clearValue : starIndex);
            }}
            accessibilityRole="button"
            accessibilityLabel={getAccessibilityLabel?.(starIndex, selected) ?? `${starIndex} stars`}
            accessibilityHint={accessibilityHint}
            accessibilityState={{ selected }}
            style={styles.target}
          >
            <Icon
              name={filled ? 'star.fill' : 'star'}
              size={size}
              color={filled ? brandColors.warning : systemColors.secondaryLabel}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  // Five 44pt targets plus their gaps is ~236pt — wider than the ~172pt the old
  // hitSlop version took. Rather than shrink the targets back under the floor,
  // the row wraps: in a container too narrow for one line the last star drops to
  // a second row instead of overflowing its parent. `flexShrink` is explicit
  // because React Native defaults it to 0 (the web defaults to 1), and without it
  // the row would keep its full 236pt and spill past a tight parent unwrapped.
  starRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    flexShrink: 1,
    columnGap: spacing[1],
    rowGap: spacing[1],
  },
  // A real 44pt target rather than a 28pt glyph with hitSlop 4 (~36pt, under the
  // documented floor). The gap tightens to 4 so five 44pt targets still read as
  // one rating control.
  target: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
