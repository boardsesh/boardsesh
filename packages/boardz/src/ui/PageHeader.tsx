import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from './Text';
import { GUTTER, spacing } from './tokens';

type PageHeaderProps = {
  /** The big title, or a custom node like the wordmark. */
  title: ReactNode;
  /** The mono meta row: `MOONBOARD 2024 · 40°`. Without one the title leads. */
  meta?: string | null;
  /** A mono figure beside the title, like a climb count. */
  count?: string | null;
  /** Something live beside the title instead, like a session clock. */
  aside?: ReactNode;
  /** On the meta row's right, or beside the title without one: the connection pill, a settings button. */
  right?: ReactNode;
};

/**
 * A tab's big-title header: mono meta row, then a 38pt title with a mono count.
 * The page it tops starts below the status bar (see `Screen`).
 */
export function PageHeader({ title, meta, count, aside, right }: PageHeaderProps) {
  const titleNode =
    typeof title === 'string' ? (
      <Text variant="display" accessibilityRole="header" numberOfLines={1} style={styles.title}>
        {title}
      </Text>
    ) : (
      title
    );
  const beside =
    aside ??
    (count ? (
      <Text variant="mono" tone="tertiary" style={styles.count}>
        {count}
      </Text>
    ) : null);

  if (meta == null) {
    return (
      <View style={styles.header}>
        <View style={[styles.titleRow, styles.titleRowLeading]}>
          {titleNode}
          {right ?? beside}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.header}>
      <View style={styles.metaRow}>
        <Text variant="label" numberOfLines={1} style={styles.meta}>
          {meta}
        </Text>
        {right}
      </View>
      <View style={styles.titleRow}>
        {titleNode}
        {beside}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: GUTTER, paddingTop: spacing.sm, paddingBottom: 14, gap: 10 },
  metaRow: {
    minHeight: 44,
    marginBottom: -spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  meta: { flexShrink: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: spacing.md },
  // A title that leads the page sits level with what's beside it.
  titleRowLeading: { alignItems: 'center', minHeight: 56 },
  title: { flexShrink: 1 },
  count: { fontSize: 12 },
});
