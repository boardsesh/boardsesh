import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { WorkoutStageKind } from '@boardsesh/playlist-generator';
import { Text } from '../../Text';
import { workoutStageName } from '../../../lib/workout-run-readout';
import { useTheme } from '../../../providers/theme-provider';
import { spacing } from '../../../theme/tokens';

type WorkoutPreviewStageHeadingProps = {
  stageKind: WorkoutStageKind;
  count: number;
};

/**
 * "Pyramid · 9 climbs" over each block of a workout built from several blocks.
 * Sits above that block's section headings, so it reads one step louder.
 */
function WorkoutPreviewStageHeadingComponent({ stageKind, count }: WorkoutPreviewStageHeadingProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  return (
    <View style={styles.heading} accessibilityRole="header">
      <Text variant="subheadline" color={systemColors.label} style={styles.text}>
        {t('mobile.session.preWorkoutSectionHeading', { section: workoutStageName(stageKind, t), count })}
      </Text>
    </View>
  );
}

export const WorkoutPreviewStageHeading = memo(WorkoutPreviewStageHeadingComponent);

const styles = StyleSheet.create({
  heading: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[6],
    paddingBottom: spacing[1],
  },
  text: {
    fontWeight: '700',
  },
});
