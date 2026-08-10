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
  /** Glyph size in points. The tap target stays 44pt regardless. */
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
  size = 24,
  clearValue = 0,
  getAccessibilityLabel,
  accessibilityHint,
}: StarRatingProps) {
  // Both colours resolve per scheme. The old pair was scheme-static: #FFB800
  // gold and #C7C7CC (light-mode chrome grey), which made an UNSET optional
  // field the loudest object on a dark sheet at roughly 10:1. Empty stars now
  // sit on tertiaryLabel — deliberately quieter than the row label beside them.
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
              color={filled ? brandColors.warning : systemColors.tertiaryLabel}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  starRow: {
    flexDirection: 'row',
    gap: spacing[1],
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
