import { memo } from 'react';
import { StyleSheet } from 'react-native';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { applySectionCaption } from '../../theme/variants/variant-tokens';
import { sectionHeaderText } from '../section-header-text';
import { spacing } from '../../theme/tokens';

// The two text rows every gym list draws: a section title and a one-line
// notice. Shared by the gym map's panel (`GymListPanel`) and the add-a-board
// gym step (`GymStep`). Each reads its own colours, so a list's `renderItem`
// deps stay free of theme values.

/** A section title: footnote semibold on Liquid Glass, titleSmall on Material, as SectionHeader. */
export const GymListSectionHeader = memo(function GymListSectionHeader({ label }: { label: string }) {
  const { systemColors, m3, variant, sectionCaption } = useTheme();
  const caption = applySectionCaption(label, sectionCaption);
  const headerText = sectionHeaderText(variant, {
    secondaryLabel: systemColors.secondaryLabel,
    onSurfaceVariant: m3.onSurfaceVariant,
  });
  return (
    <Text
      variant={headerText.textVariant}
      color={headerText.color}
      style={[styles.sectionLabel, caption.style, { fontWeight: headerText.fontWeight }]}
    >
      {caption.text}
    </Text>
  );
});

/** A centred notice in place of rows: nothing found, offline, a failed lookup. */
export const GymListEmptyRow = memo(function GymListEmptyRow({ label }: { label: string }) {
  const { systemColors } = useTheme();
  return (
    <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.empty}>
      {label}
    </Text>
  );
});

const styles = StyleSheet.create({
  sectionLabel: {
    marginBottom: spacing[1],
    marginTop: spacing[2],
  },
  empty: {
    marginTop: spacing[4],
    textAlign: 'center',
  },
});
