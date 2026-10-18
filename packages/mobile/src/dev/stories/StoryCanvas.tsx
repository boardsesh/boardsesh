import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '../../components/Text';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';

/**
 * One labelled state inside a story, so a single screenshot can show every
 * state of a component side by side. The label is plain caption text above the
 * sample, outside the component's own bounds.
 */
export function StoryVariant({ label, children }: { label: string; children: ReactNode }) {
  const { systemColors } = useTheme();
  return (
    <View style={styles.variant}>
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.variantLabel}>
        {label}
      </Text>
      {children}
    </View>
  );
}

/**
 * A stand-in for the surface a component normally sits on (a drawer, a header),
 * so its colours are judged against the right background.
 */
export function StorySurface({ children, padded = true }: { children: ReactNode; padded?: boolean }) {
  const { systemColors } = useTheme();
  return (
    <View
      style={[
        styles.surface,
        padded && styles.surfacePadded,
        { backgroundColor: systemColors.secondaryBackground, borderColor: systemColors.separator },
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  variant: {
    gap: spacing[2],
  },
  variantLabel: {
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  surface: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  surfacePadded: {
    padding: spacing[4],
  },
});
