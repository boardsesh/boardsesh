// The workout you generated, on the session screen (#5379): its stages in the
// order you will reach them, which one you are on, and how many climbs are left
// in it. Renders nothing unless this session has a workout on this phone.
//
// Split in two so the session screen pays nothing for it: the outer component
// reads only the session id and the run, and the queue subscription lives in the
// inner one, mounted only while a run exists.

import { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { WorkoutRun } from '@boardsesh/playlist-generator';
import { Card } from '../../Card';
import { Text } from '../../Text';
import { useTheme } from '../../../providers/theme-provider';
import { useQueueData, useQueueSessionId } from '../../../providers/queue-provider';
import { useWorkoutRun } from '../../../lib/workout-run-store';
import {
  describeWorkoutRun,
  workoutStageName,
  type TranslateWorkoutStage,
  type WorkoutStageReadout,
} from '../../../lib/workout-run-readout';
import { spacing } from '../../../theme/tokens';

const STAGE_MARKER_SIZE = 10;

export const WorkoutRunCard = memo(function WorkoutRunCard() {
  const { sessionId } = useQueueSessionId();
  const run = useWorkoutRun(sessionId);
  return run ? <WorkoutRunCardContent run={run} /> : null;
});

function stageStatus(stage: WorkoutStageReadout, t: TranslateWorkoutStage): string {
  if (stage.remainingAfterCurrent === null) return t('mobile.session.workoutStageClimbs', { count: stage.size });
  if (stage.remainingAfterCurrent === 0) return t('mobile.session.workoutStageLastClimb');
  return t('mobile.session.workoutStageToGo', { count: stage.remainingAfterCurrent });
}

function WorkoutRunCardContent({ run }: { run: WorkoutRun }) {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const { queue, currentClimbQueueItem } = useQueueData();
  const queueUuids = useMemo(() => queue.map((item) => item.uuid), [queue]);
  const currentUuid = currentClimbQueueItem?.uuid ?? null;
  const readout = useMemo(() => describeWorkoutRun(run, queueUuids, currentUuid), [run, queueUuids, currentUuid]);

  if (!readout) return null;

  return (
    <Card>
      <Text variant="headline" accessibilityRole="header">
        {t('mobile.session.workoutCardTitle')}
      </Text>
      <View style={styles.stageList}>
        {readout.stages.map((stage) => {
          const name = workoutStageName(stage.kind, t);
          const status = stageStatus(stage, t);
          return (
            <View
              key={stage.id}
              style={styles.stageRow}
              accessible
              accessibilityLabel={
                stage.isCurrent
                  ? t('mobile.session.workoutStageCurrentAccessibilityLabel', { stage: name, status })
                  : t('mobile.session.workoutStageAccessibilityLabel', { stage: name, status })
              }
              testID={stage.isCurrent ? 'workout-stage-current' : 'workout-stage'}
            >
              <View
                style={[
                  styles.marker,
                  stage.isCurrent
                    ? { backgroundColor: brandColors.primaryFill, borderColor: brandColors.primaryFill }
                    : { borderColor: systemColors.tertiaryLabel },
                ]}
              />
              <Text
                variant="body"
                color={stage.isCurrent ? systemColors.label : systemColors.secondaryLabel}
                style={[styles.stageName, stage.isCurrent ? styles.currentStageName : null]}
                numberOfLines={1}
              >
                {name}
              </Text>
              <Text
                variant="subheadline"
                color={stage.isCurrent ? brandColors.primary : systemColors.secondaryLabel}
                numeric
              >
                {status}
              </Text>
            </View>
          );
        })}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  stageList: {
    marginTop: spacing[3],
    gap: spacing[3],
  },
  stageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  marker: {
    width: STAGE_MARKER_SIZE,
    height: STAGE_MARKER_SIZE,
    borderRadius: STAGE_MARKER_SIZE / 2,
    borderWidth: 2,
  },
  stageName: {
    flex: 1,
  },
  currentStageName: {
    fontWeight: '600',
  },
});
