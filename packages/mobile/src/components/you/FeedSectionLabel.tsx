import { View, StyleSheet } from 'react-native';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { applySectionCaption } from '../../theme/variants/variant-tokens';
import { spacing } from '../../theme/tokens';

/**
 * Sticky-style section label for the grouped sessions feed (Today / This week /
 * Earlier). Mirrors `SectionHeader`'s variant-keyed caption treatment (Liquid
 * Glass uppercases + dims + tracks; Material keeps sentence case) but with the
 * card-aligned horizontal inset the feed uses.
 */
export function FeedSectionLabel({ label }: { label: string }) {
  const { sectionCaption } = useTheme();
  const caption = applySectionCaption(label, sectionCaption);
  return (
    <View style={styles.container}>
      <Text variant="footnote" style={[styles.text, caption.style]}>
        {caption.text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[5],
    paddingBottom: spacing[1],
  },
  // Opacity + letter-spacing come from `caption.style` per variant.
  text: {
    fontWeight: '600',
  },
});
