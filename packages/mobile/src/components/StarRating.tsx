import { View, Pressable, StyleSheet } from 'react-native';
import { Icon } from './Icon';
import { hapticSelection } from '../lib/haptics';
import { iosSystemColors } from '../theme/ios-colors';
import { spacing } from '../theme/tokens';

type StarRatingProps = {
  /** Current rating value. 0 or undefined means no stars selected. */
  value: number | undefined;
  /** Called when a star is tapped. Tapping the current value clears it (returns 0 or undefined). */
  onChange: (rating: number | undefined) => void;
  /** Number of stars to display. Defaults to 5. */
  maxStars?: number;
  /** Value returned when the user taps the currently-selected star. Defaults to 0. */
  clearValue?: number | undefined;
  getAccessibilityLabel?: (rating: number, selected: boolean) => string;
  accessibilityHint?: string;
};

export function StarRating({
  value,
  onChange,
  maxStars = 5,
  clearValue = 0,
  getAccessibilityLabel,
  accessibilityHint,
}: StarRatingProps) {
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
            hitSlop={4}
          >
            <Icon
              name={filled ? 'star.fill' : 'star'}
              size={28}
              color={filled ? iosSystemColors.starGold : iosSystemColors.systemGray4}
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
    gap: spacing[2],
  },
});
