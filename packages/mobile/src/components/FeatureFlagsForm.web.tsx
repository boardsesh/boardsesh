// FeatureFlagsForm — web implementation (react-native-web + react-native-paper).
// The tester-only Feature Flags screen, rendered from the same plain view-model the
// native files consume. Structurally follows FeatureFlagsForm.android.tsx: a
// scrolling list of Material cards, each a flag's label + description + an
// override control (Default / On / Off for a boolean flag, Default + each
// variant for a multivariate one) + the precomputed "Live default… Effective…"
// caption, then the "Reset all overrides" button.
//
// Each row builds its own SegmentedControl options from `row.options` (set by
// FeatureFlagsForm.logic.ts) so the segments can't drift across platforms.
// All copy is tester-only English (i18n-ignore), matching the native files.

import { ScrollView, StyleSheet, View } from 'react-native';
import { Surface, Text } from 'react-native-paper';
import { useTheme } from '../providers/theme-provider';
import { spacing } from '../theme/tokens';
import { Button } from './Button';
import { SegmentedControl } from './SegmentedControl';
import type { FeatureFlagsFormProps } from './FeatureFlagsForm.types';

export function FeatureFlagsForm({ rows, onSelect, onReset, canReset, noticeText, title }: FeatureFlagsFormProps) {
  const { systemColors } = useTheme();
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      {/* i18n-ignore-next-line — tester-only screen */}
      <Text variant="titleLarge">{title}</Text>
      <Text variant="bodySmall" style={{ color: systemColors.secondaryLabel as string }}>
        {noticeText}
      </Text>

      {rows.map((row) => (
        <Surface key={row.key} style={styles.card} elevation={1}>
          <Text variant="bodyLarge">{row.label}</Text>
          <Text variant="bodySmall" style={[styles.muted, { color: systemColors.secondaryLabel as string }]}>
            {row.description}
          </Text>
          <View style={styles.control}>
            <SegmentedControl
              options={[...row.options]}
              selectedKey={row.choice}
              onSelect={(choice) => onSelect(row.key, choice)}
              accessibilityLabel={row.label}
            />
          </View>
          <Text variant="labelSmall" style={[styles.muted, { color: systemColors.secondaryLabel as string }]}>
            {row.effectiveLabel}
          </Text>
        </Surface>
      ))}

      {/* i18n-ignore-next-line — tester-only screen */}
      <Button title="Reset all overrides" onPress={onReset} disabled={!canReset} style={styles.fullWidth} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  content: {
    padding: spacing[4],
    paddingBottom: spacing[10],
    gap: spacing[3],
  },
  card: {
    borderRadius: 12,
    padding: spacing[4],
    gap: spacing[2],
  },
  control: {
    marginVertical: spacing[1],
  },
  muted: {
    opacity: 0.7,
  },
  fullWidth: {
    alignSelf: 'stretch',
  },
});
