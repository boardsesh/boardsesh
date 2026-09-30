import type { ReactElement, ReactNode } from 'react';
import { ScrollView, StyleSheet, View, type RefreshControlProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from './theme';
import { GUTTER, spacing } from './tokens';

type ScreenProps = {
  /** A PageHeader or TopBar, scrolled with the page. */
  header?: ReactNode;
  children: ReactNode;
  refreshControl?: ReactElement<RefreshControlProps>;
};

/**
 * A scrolling page on the app background, with gutters and 12pt between blocks.
 * It starts below the status bar, so scrolled content never runs under the clock.
 */
export function Screen({ header, children, refreshControl }: ScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.root, { paddingTop: insets.top, backgroundColor: theme.bgApp }]}>
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="never"
        keyboardShouldPersistTaps="handled"
        refreshControl={refreshControl}
      >
        {header}
        <View style={styles.body}>{children}</View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingBottom: spacing.xxxl },
  body: { paddingHorizontal: GUTTER, gap: spacing.md },
});
