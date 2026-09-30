import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Text } from './Text';
import { useTheme } from './theme';
import { radius, spacing } from './tokens';

type CardProps = {
  children: ReactNode;
  /** No inner padding, for hairline rows that run edge to edge. */
  flush?: boolean;
  /** A 1.5pt ink outline. */
  selected?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** Hairlines, not shadows: a surface with a 1pt border. */
export function Card({ children, flush = false, selected = false, style }: CardProps) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.card,
        flush ? styles.flush : styles.padded,
        {
          backgroundColor: theme.bgSurface,
          borderColor: selected ? theme.fg1 : theme.border1,
          borderWidth: selected ? 1.5 : 1,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

type SectionProps = {
  /** A mono label: `BOARD`, `SESSION`. */
  title?: string;
  /** Something small on the right of the label. */
  right?: ReactNode;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
};

/** A card with a mono label over its content. */
export function Section({ title, right, children, style }: SectionProps) {
  return (
    <Card style={[styles.section, style]}>
      {title ? (
        <View style={styles.sectionHeader}>
          <Text variant="label" accessibilityRole="header">
            {title}
          </Text>
          {right}
        </View>
      ) : null}
      {children}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderCurve: 'continuous', overflow: 'hidden' },
  padded: { padding: spacing.lg },
  flush: {},
  section: { gap: 14 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 16 },
});
