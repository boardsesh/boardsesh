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
  /** A warm-up after the last block, headed "Cool-down". */
  isCoolDown?: boolean;
  /** Set when the stage's rows repeat (a 4x4): how many rounds the queue runs them. */
  rounds?: number;
};

/**
 * "Pyramid · 9 climbs" over each block of a workout built from several blocks,
 * or "4x4 · 4 climbs × 4 rounds" over a block whose rows repeat. Sits above that
 * block's section headings, so it reads one step louder.
 */
function WorkoutPreviewStageHeadingComponent({
  stageKind,
  count,
  isCoolDown = false,
  rounds,
}: WorkoutPreviewStageHeadingProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const section = workoutStageName(stageKind, t, isCoolDown);
  return (
    <View style={styles.heading} accessibilityRole="header">
      <Text variant="subheadline" color={systemColors.label} style={styles.text}>
        {rounds === undefined
          ? t('mobile.session.preWorkoutSectionHeading', { section, count })
          : t('mobile.session.preWorkoutStageRoundsHeading', { section, count, rounds })}
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
