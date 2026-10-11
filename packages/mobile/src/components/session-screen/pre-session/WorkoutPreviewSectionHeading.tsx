import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../../Text';
import { useTheme } from '../../../providers/theme-provider';
import { spacing } from '../../../theme/tokens';
import type { PreviewSection } from './workout-preview-sections';

// Literal `t()` calls per section so the i18n key analyser sees every key.
function sectionLabel(section: PreviewSection, t: (key: string) => string): string {
  switch (section) {
    case 'warmUp':
      return t('mobile.session.preWorkoutSectionWarmUp');
    case 'increasing':
      return t('mobile.session.preWorkoutSectionIncreasing');
    case 'peak':
      return t('mobile.session.preWorkoutSectionPeak');
    case 'decreasing':
      return t('mobile.session.preWorkoutSectionDecreasing');
    case 'main':
      return t('mobile.session.preWorkoutSectionMain');
  }
}

type WorkoutPreviewSectionHeadingProps = {
  section: PreviewSection;
  count: number;
};

/** "Warm-up · 4 climbs" between groups of preview rows. */
function WorkoutPreviewSectionHeadingComponent({ section, count }: WorkoutPreviewSectionHeadingProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  return (
    <View style={styles.heading} accessibilityRole="header">
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.text}>
        {t('mobile.session.preWorkoutSectionHeading', { section: sectionLabel(section, t), count })}
      </Text>
    </View>
  );
}

export const WorkoutPreviewSectionHeading = memo(WorkoutPreviewSectionHeadingComponent);

const styles = StyleSheet.create({
  heading: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[4],
    paddingBottom: spacing[2],
  },
  text: {
    fontWeight: '600',
  },
});
