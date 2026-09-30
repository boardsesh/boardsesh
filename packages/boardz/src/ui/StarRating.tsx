import { Pressable, StyleSheet, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Icon } from './Icon';
import { Star } from './icons';
import { useTheme } from './theme';

type StarRatingProps = {
  /** 0 = not rated. */
  value: number;
  max?: number;
  size?: number;
  /** Makes the stars tappable. Tapping the current rating clears it. */
  onChange?: (value: number) => void;
};

/** Boardsesh quality stars, in ink. */
export function StarRating({ value, max = 3, size = 16, onChange }: StarRatingProps) {
  const theme = useTheme();
  const stars = Array.from({ length: max }, (_, index) => index + 1);
  return (
    <View
      style={styles.row}
      accessible={!onChange}
      accessibilityLabel={onChange ? undefined : `${value} of ${max} stars`}
    >
      {stars.map((star) => {
        const on = star <= value;
        const glyph = (
          <Icon icon={Star} size={size} strokeWidth={1.5} color={on ? theme.star : theme.borderStrong} filled={on} />
        );
        return onChange ? (
          <Pressable
            key={star}
            accessibilityRole="button"
            accessibilityLabel={`${star} ${star === 1 ? 'star' : 'stars'}`}
            accessibilityState={{ selected: on }}
            onPress={() => {
              void Haptics.selectionAsync();
              onChange(star === value ? 0 : star);
            }}
            style={styles.touch}
          >
            {glyph}
          </Pressable>
        ) : (
          <View key={star}>{glyph}</View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  touch: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
