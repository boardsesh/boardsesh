// "Set by your workout" (#5380, #6231): what the rest timer sheet and the Record
// tab's arm row show in place of the rest length, cadence and auto-advance
// controls while a timed workout block paces the timer. Those controls edit the
// climber's own settings, which a stage overrides, so showing them would offer
// switches that change nothing until the block is over.

import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { stageRestSeconds } from '@boardsesh/playlist-generator';
import { Text } from '../Text';
import { SectionHeader } from '../SectionHeader';
import { TICK_GUTTER } from '../tick/tick-sheet-metrics';
import { useTheme } from '../../providers/theme-provider';
import { useSessionTimerDriver } from '../../hooks/use-session-timer-driver';
import { workoutStageName, type TranslateWorkoutStage } from '../../lib/workout-run-readout';
import type { RestTimerStagePacing } from '../../lib/rest-timer-pacing';
import { spacing } from '../../theme/tokens';
import { formatRestLength } from './rest-length.logic';

type RestTimerWorkoutPacingRowProps = {
  stage: RestTimerStagePacing;
  /** `false` cancels a caller-owned card gutter, like the controls it stands in for. */
  inset?: boolean;
};

export function RestTimerWorkoutPacingRow({ stage, inset = true }: RestTimerWorkoutPacingRowProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  // A passenger's phone never moves the shared wall, stage or not: say so
  // rather than promise an advance the scheduler will refuse.
  const { blockedReason: driverBlockedReason } = useSessionTimerDriver();

  const stageName = workoutStageName(stage.kind, t, stage.isCoolDown === true);
  const summary = pacingSummary(stage, stageName, t);

  const advance =
    driverBlockedReason !== null
      ? t('mobile.restTimer.autoAdvanceBlocked')
      : stage.reps !== undefined
        ? t('mobile.restTimer.workoutPacingAdvanceSet')
        : stage.advanceOn === 'send'
          ? t('mobile.restTimer.workoutPacingAdvanceSend')
          : stage.advanceOn === 'tick'
            ? t('mobile.restTimer.workoutPacingAdvanceTick')
            : t('mobile.restTimer.workoutPacingAdvanceBeat');

  return (
    <View style={inset ? null : styles.cardBleed}>
      <SectionHeader title={t('mobile.restTimer.workoutPacingTitle')} />
      <View style={styles.content}>
        <Text variant="body" color={systemColors.label}>
          {summary}
        </Text>
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {advance}
        </Text>
      </View>
    </View>
  );
}

/**
 * "4x4 · 4 reps a set, 3:00 between sets" (with the rest between reps when
 * there is one), "Limit Bouldering · 3:00 rest after each climb", or "On the
 * Minute · A new climb every 1:00".
 */
function pacingSummary(stage: RestTimerStagePacing, stageName: string, t: TranslateWorkoutStage): string {
  const { stagePacing } = stage;
  if (stagePacing.mode === 'onTheMinute') {
    return t('mobile.restTimer.workoutPacingInterval', {
      stage: stageName,
      interval: formatRestLength(stageRestSeconds(stagePacing, false)),
    });
  }
  if (stagePacing.sets !== undefined) {
    const reps = stagePacing.sets.repsPerSet;
    const setRest = formatRestLength(stageRestSeconds(stagePacing, true));
    const repRestSeconds = stageRestSeconds(stagePacing, false);
    return repRestSeconds > 0
      ? t('mobile.restTimer.workoutPacingSetsWithRepRest', {
          stage: stageName,
          reps,
          repRest: formatRestLength(repRestSeconds),
          setRest,
        })
      : t('mobile.restTimer.workoutPacingSets', { stage: stageName, reps, setRest });
  }
  return t('mobile.restTimer.workoutPacingRest', {
    stage: stageName,
    rest: formatRestLength(stageRestSeconds(stagePacing, false)),
  });
}

const styles = StyleSheet.create({
  // Cancels a caller-owned card gutter; the content re-applies TICK_GUTTER.
  cardBleed: {
    marginHorizontal: -spacing[4],
  },
  content: {
    paddingHorizontal: TICK_GUTTER,
    gap: spacing[1],
  },
});
