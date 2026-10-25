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
  /** Set on a 4x4: how many reps each of its climbs (one per set) takes. */
  repsPerSet?: number;
};

/**
 * "Pyramid · 9 climbs" over each block of a workout built from several blocks,
 * or "4x4 · 4 reps × 4 sets" over a 4x4, whose rows are each done for every
 * rep. Sits above that block's section headings, so it reads one step louder.
 */
function WorkoutPreviewStageHeadingComponent({
  stageKind,
  count,
  isCoolDown = false,
  repsPerSet,
}: WorkoutPreviewStageHeadingProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const section = workoutStageName(stageKind, t, isCoolDown);
  return (
    <View style={styles.heading} accessibilityRole="header">
      <Text variant="subheadline" color={systemColors.label} style={styles.text}>
        {repsPerSet === undefined
          ? t('mobile.session.preWorkoutSectionHeading', { section, count })
          : t('mobile.session.preWorkoutStageSetsHeading', { section, reps: repsPerSet, count })}
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
