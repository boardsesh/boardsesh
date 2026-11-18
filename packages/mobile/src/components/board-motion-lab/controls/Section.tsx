import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '../../Text';
import { spacing } from '../../../theme/tokens';

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text variant="footnote" tone="secondary" emphasized style={styles.title}>
        {title.toUpperCase()}
      </Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing[2], paddingTop: spacing[4] },
  title: { paddingHorizontal: spacing[1] },
});
