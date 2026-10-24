// The workout you generated, on the session screen (#5379): its stages in the
// order you will reach them, which one you are on, and how many climbs are left
// in it, with "Add a block" under them. A session with no workout on this phone
// gets a one-row prompt to add one instead. Renders nothing outside a session.
//
// Split in two so the session screen pays nothing for it: the outer component
// reads only the session id and the run, and the queue subscription lives in the
// inner one, mounted only while a run exists.

import { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { WorkoutRun } from '@boardsesh/playlist-generator';
import { Card } from '../../Card';
import { Icon } from '../../Icon';
import { PressableSurface } from '../../PressableSurface';
import { Text } from '../../Text';
import { hapticSelection } from '../../../lib/haptics';
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

type WorkoutRunCardProps = {
  /** Opens "Add a block". Without it the card only reads out the run. */
  onAddBlock?: () => void;
};

export const WorkoutRunCard = memo(function WorkoutRunCard({ onAddBlock }: WorkoutRunCardProps) {
  const { sessionId } = useQueueSessionId();
  const run = useWorkoutRun(sessionId);
  if (sessionId === null) return null;
  if (run) return <WorkoutRunCardContent run={run} onAddBlock={onAddBlock} />;
  return onAddBlock ? <AddWorkoutPrompt onPress={onAddBlock} /> : null;
});

/** One quiet row for a session with no workout: tap it to add the first block. */
function AddWorkoutPrompt({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  // Card gives the tap its own haptic.
  return (
    <Card
      onPress={onPress}
      accessibilityLabel={t('mobile.session.addWorkoutPromptTitle')}
      accessibilityHint={t('mobile.session.addWorkoutPromptSubtitle')}
    >
      <View style={styles.promptRow} testID="workout-add-prompt">
        <Icon name="add" size={22} color={brandColors.primary} />
        <View style={styles.promptText}>
          <Text variant="body" color={brandColors.primary} style={styles.promptTitle}>
            {t('mobile.session.addWorkoutPromptTitle')}
          </Text>
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {t('mobile.session.addWorkoutPromptSubtitle')}
          </Text>
        </View>
        <Icon name="chevron.right" size={18} color={systemColors.tertiaryLabel} />
      </View>
    </Card>
  );
}

function stageStatus(stage: WorkoutStageReadout, t: TranslateWorkoutStage): string {
  if (stage.remainingAfterCurrent === null) return t('mobile.session.workoutStageClimbs', { count: stage.size });
  if (stage.remainingAfterCurrent === 0) return t('mobile.session.workoutStageLastClimb');
  return t('mobile.session.workoutStageToGo', { count: stage.remainingAfterCurrent });
}

function WorkoutRunCardContent({ run, onAddBlock }: { run: WorkoutRun; onAddBlock?: () => void }) {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const { queue, currentClimbQueueItem } = useQueueData();
  const queueUuids = useMemo(() => queue.map((item) => item.uuid), [queue]);
  const currentUuid = currentClimbQueueItem?.uuid ?? null;
  const readout = useMemo(() => describeWorkoutRun(run, queueUuids, currentUuid), [run, queueUuids, currentUuid]);

  // Every workout climb has left the queue: offer a fresh block instead.
  if (!readout) return onAddBlock ? <AddWorkoutPrompt onPress={onAddBlock} /> : null;

  return (
    <Card>
      <Text variant="headline" accessibilityRole="header">
        {t('mobile.session.workoutCardTitle')}
      </Text>
      <View style={styles.stageList}>
        {readout.stages.map((stage) => {
          const name = workoutStageName(stage.kind, t, stage.isCoolDown);
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
      {onAddBlock ? <AddBlockButton onPress={onAddBlock} /> : null}
    </Card>
  );
}

function AddBlockButton({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation('session');
  const { brandColors } = useTheme();
  return (
    <PressableSurface
      onPress={() => {
        hapticSelection();
        onPress();
      }}
      feedback="opacity"
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={t('mobile.session.preGeneratorAddBlock')}
      accessibilityHint={t('mobile.session.preGeneratorAddBlockHint')}
      style={styles.addButton}
      testID="workout-add-block"
    >
      <Icon name="add" size={18} color={brandColors.primary} />
      <Text variant="subheadline" color={brandColors.primary} style={styles.addText}>
        {t('mobile.session.preGeneratorAddBlock')}
      </Text>
    </PressableSurface>
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
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing[2],
    minHeight: 44,
    marginTop: spacing[2],
  },
  addText: {
    fontWeight: '600',
  },
  promptRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  promptText: {
    flex: 1,
    gap: 2,
  },
  promptTitle: {
    fontWeight: '600',
  },
});
