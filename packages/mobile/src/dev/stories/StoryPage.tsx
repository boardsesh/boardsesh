import { useCallback, useMemo, useRef, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '../../components/Text';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';

/**
 * An edge-to-edge scrolling page on one of the theme's grounds, for a
 * `fullscreen` story of a component that owns its own 16pt gutter (the padded
 * canvas would add a second one).
 */
export function StoryPage({ ground, children }: { ground: 'plain' | 'grouped'; children: ReactNode }) {
  const { surfaces } = useTheme();
  const insets = useSafeAreaInsets();
  const pageStyle = useMemo(() => [styles.page, { backgroundColor: surfaces[ground].page }], [surfaces, ground]);
  const contentStyle = useMemo(
    () => [styles.content, { paddingTop: insets.top + spacing[2], paddingBottom: insets.bottom + spacing[6] }],
    [insets.top, insets.bottom],
  );
  return (
    <ScrollView style={pageStyle} contentContainerStyle={contentStyle}>
      {children}
    </ScrollView>
  );
}

/** A caption above one state on a `StoryPage`, at the gutter, outside the component's own bounds. */
export function StoryPageLabel({ children }: { children: string }) {
  return (
    <View style={styles.label}>
      <Text variant="footnote" tone="secondary" style={styles.labelText}>
        {children}
      </Text>
    </View>
  );
}

/**
 * Readiness for a story that waits on several pieces of art: `onReady` fires
 * once every expected key has painted, `onError` on the first failure.
 */
export function useStoryArtReadiness(expectedKeys: readonly string[], onReady: () => void) {
  const displayed = useRef(new Set<string>());
  const reportedReady = useRef(false);
  return useCallback(
    (key: string) => {
      displayed.current.add(key);
      if (reportedReady.current || !expectedKeys.every((expected) => displayed.current.has(expected))) return;
      reportedReady.current = true;
      onReady();
    },
    [expectedKeys, onReady],
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
  },
  content: {
    gap: spacing[3],
  },
  label: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
  },
  labelText: {
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
});
