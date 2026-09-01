import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';

const DOT_SIZE = 6;

/**
 * How many cards a rail holds, and which one you are on.
 *
 * Earns its place only where the cards are big enough to hide each other: a hero
 * rail shows about one card where a thumbnail rail showed two and a bit, so
 * "there are more of these" stops being something the composition says for free.
 * On a step with no exit, a climber who believes there are two options picks from
 * two.
 *
 * **Colour changes, size never does** — the same discipline the card borders keep,
 * so the row cannot reflow as you swipe.
 *
 * Not interactive: a 6pt target is a fake affordance. Hidden from assistive tech,
 * which gets the position from each card's own `accessibilityValue` instead.
 */
export function RailIndexDots({ count, activeIndex }: { count: number; activeIndex: number }) {
  const { brandColors, systemColors } = useTheme();

  if (count < 2) return null;

  return (
    <View
      style={styles.row}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
    >
      {Array.from({ length: count }, (_, index) => (
        <View
          key={index}
          style={[
            styles.dot,
            { backgroundColor: index === activeIndex ? brandColors.primary : systemColors.separator },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: DOT_SIZE,
    paddingBottom: spacing[3],
  },
  dot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: borderRadius.full,
  },
});
