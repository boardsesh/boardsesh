import { View, Platform, StyleSheet } from 'react-native';
import { Text } from '../Text';
import { spacing } from '../../theme/tokens';

/**
 * Sticky-style section label for the grouped sessions feed (Today / This week /
 * Earlier). Mirrors `SectionHeader`'s uppercase iOS treatment but with the
 * card-aligned horizontal inset the feed uses.
 */
export function FeedSectionLabel({ label }: { label: string }) {
  const displayLabel = Platform.OS === 'ios' ? label.toUpperCase() : label;
  return (
    <View style={styles.container}>
      <Text variant="footnote" style={styles.text}>
        {displayLabel}
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
  text: {
    opacity: 0.6,
    letterSpacing: 0.5,
    fontWeight: '600',
  },
});
