// The workout you generated, on the session screen (#5379, #6291): where you
// are in it ("4x4 · Rep 3 of 4 · Set 2 of 4") and the climb on the wall, which
// opens the player; the rest a timed block gives you, counting down, and what
// comes after it; its stages in the order you will reach them, with what each
// finished one came to (sent, tried, skipped); and "Add a block" under them. A
// session with no workout on this phone gets a one-row prompt to add one
// instead. Renders nothing outside a session.
//
// Split in two so the session screen pays nothing for it: the outer component
// reads only the session id and the run, and the queue and rest-timer
// subscriptions live in the inner one (`useWorkoutRunner`), mounted only while a
// run exists. Only the rest line re-renders per second, a leaf that reads the live
// clock for its spoken sentence; nothing above it does.

import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { WorkoutRun } from '@boardsesh/playlist-generator';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { Card } from '../../Card';
import { Icon } from '../../Icon';
import { PressableSurface } from '../../PressableSurface';
import { Text } from '../../Text';
import {
  RestTimerClock,
  restTimerClockAccessibilityLabel,
  useRestTimerDisplay,
} from '../../queue-control/RestTimerPill';
import { hapticSelection } from '../../../lib/haptics';
import { nowMs } from '../../../lib/clock';
import { armRestTimerForWorkout } from '../../../lib/rest-timer-effective';
import { useTheme } from '../../../providers/theme-provider';
import { useDrawerHost } from '../../../providers/drawer-host-provider';
import { useQueueActions, useQueueSessionId } from '../../../providers/queue-provider';
import { useDisplayGrade } from '../../../hooks/use-display-grade';
import { useWorkoutRunner } from '../../../hooks/use-workout-runner';
import { useWorkoutRun } from '../../../lib/workout-run-store';
import {
  formatWorkoutStagePositionWithGo,
  workoutStageName,
  type TranslateWorkoutStage,
} from '../../../lib/workout-run-readout';
import type {
  WorkoutClimbTally,
  WorkoutRunnerReadout,
  WorkoutRunnerRest,
  WorkoutRunnerStageReadout,
} from '../../../lib/workout-runner-readout';
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
  if (run) return <WorkoutRunCardContent sessionId={sessionId} run={run} onAddBlock={onAddBlock} />;
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

const TALLY_SEPARATOR = ' · ';
/** Between the parts of one spoken sentence, as the rest timer sheet's hero clock joins its own. */
const SPOKEN_SEPARATOR = '. ';

/** "3 sent · 1 tried · 1 skipped", leaving out what is zero. Null when nothing was sent, tried or skipped. */
function tallyLabel(tally: WorkoutClimbTally, t: TranslateWorkoutStage): string | null {
  const parts: string[] = [];
  if (tally.sent > 0) parts.push(t('mobile.workoutRunner.tallySent', { count: tally.sent }));
  if (tally.tried > 0) parts.push(t('mobile.workoutRunner.tallyTried', { count: tally.tried }));
  if (tally.skipped > 0) parts.push(t('mobile.workoutRunner.tallySkipped', { count: tally.skipped }));
  return parts.length > 0 ? parts.join(TALLY_SEPARATOR) : null;
}

/**
 * A finished stage you logged something in says what it came to; every other
 * stage says how many climbs it has, or how many are left in the current one.
 * A stage passed with nothing logged on this phone keeps its climb count: those
 * climbs may well have been logged somewhere else.
 */
function stageStatus(stage: WorkoutRunnerStageReadout, t: TranslateWorkoutStage): string {
  const tally = stage.finished && stage.logged ? tallyLabel(stage.tally, t) : null;
  if (tally !== null) return tally;
  if (stage.remainingAfterCurrent === null) return t('mobile.session.workoutStageClimbs', { count: stage.size });
  if (stage.remainingAfterCurrent === 0) return t('mobile.session.workoutStageLastClimb');
  return t('mobile.session.workoutStageToGo', { count: stage.remainingAfterCurrent });
}

function WorkoutRunCardContent({
  sessionId,
  run,
  onAddBlock,
}: {
  sessionId: string;
  run: WorkoutRun;
  onAddBlock?: () => void;
}) {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const { readout, currentItem, nextItem, resumeItem } = useWorkoutRunner(sessionId, run);

  // Every workout climb has left the queue: offer a fresh block instead.
  if (!readout) return onAddBlock ? <AddWorkoutPrompt onPress={onAddBlock} /> : null;

  const inProgress = readout.phase !== 'done';
  return (
    <Card>
      <View style={styles.headerRow}>
        <Text variant="headline" accessibilityRole="header" style={styles.headerTitle}>
          {t('mobile.session.workoutCardTitle')}
        </Text>
        {inProgress && readout.overall ? (
          <Text
            variant="subheadline"
            color={systemColors.secondaryLabel}
            numeric
            accessibilityLabel={t('mobile.workoutRunner.overallPositionAccessibilityLabel', {
              position: readout.overall.position,
              total: readout.overall.total,
            })}
            testID="workout-runner-overall"
          >
            {t('mobile.workoutRunner.overallPosition', {
              position: readout.overall.position,
              total: readout.overall.total,
            })}
          </Text>
        ) : null}
      </View>
      {inProgress ? null : <WorkoutDoneLine totals={readout.totals} />}
      {inProgress && readout.position && currentItem ? <CurrentClimbRow readout={readout} item={currentItem} /> : null}
      {inProgress && resumeItem ? <ResumeWorkoutRow readout={readout} item={resumeItem} /> : null}
      {inProgress && readout.rest?.timing ? <RestLine rest={readout.rest} nextItem={nextItem} /> : null}
      {inProgress && readout.rest && !readout.rest.armed ? (
        <TurnOnRestTimerRow sessionId={sessionId} run={run} drivesWall={readout.rest.drivesWall} />
      ) : null}
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
              {/* The name and its status share a line while they fit; a long tally
                  (German, Spanish, large text) drops under the name instead of
                  squeezing it to "4…". */}
              <View style={styles.stageText}>
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
                  style={styles.stageStatus}
                  numeric
                >
                  {status}
                </Text>
              </View>
            </View>
          );
        })}
      </View>
      {onAddBlock ? <AddBlockButton onPress={onAddBlock} /> : null}
    </Card>
  );
}

/**
 * "Workout done", with what it came to once anything was logged on this phone:
 * the totals of the blocks logged here, so a block climbed on another phone
 * never reads as skipped.
 */
function WorkoutDoneLine({ totals }: { totals: WorkoutClimbTally }) {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const loggedSomething = totals.sent + totals.tried > 0;
  const summary = loggedSomething ? tallyLabel(totals, t) : null;
  return (
    <View style={styles.doneLine} accessible testID="workout-runner-done">
      <Icon name="checkmark.circle.fill" size={20} color={brandColors.primary} />
      <View style={styles.rowText}>
        <Text variant="body" style={styles.emphasis}>
          {t('mobile.workoutRunner.done')}
        </Text>
        {summary ? (
          <Text variant="subheadline" color={systemColors.secondaryLabel} numeric>
            {summary}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * The climb on the wall, under where it sits in the workout ("4x4 · Rep 3 of 4
 * · Set 2 of 4", and "· Try 3" on a limit climb). Tap it to open the player.
 */
function CurrentClimbRow({ readout, item }: { readout: WorkoutRunnerReadout; item: ClimbQueueItem }) {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const { openPlayDrawer, boardConfig } = useDrawerHost();
  const { resolveGrade } = useDisplayGrade();
  const { position, current } = readout;
  if (!position) return null;

  const climb = item.climb;
  const grade = resolveGrade(climb, boardConfig?.boardName).label;
  const positionLabel = formatWorkoutStagePositionWithGo(position, current?.go ?? null, t);
  const name = climb.name;
  return (
    <PressableSurface
      onPress={() => {
        hapticSelection();
        // It is already the current climb, so the player opens on it without queueing it again.
        openPlayDrawer(climb, {});
      }}
      feedback="opacity"
      accessibilityRole="button"
      accessibilityLabel={
        grade
          ? t('mobile.workoutRunner.currentClimbWithGradeAccessibilityLabel', {
              position: positionLabel,
              name,
              grade,
            })
          : t('mobile.workoutRunner.currentClimbAccessibilityLabel', { position: positionLabel, name })
      }
      accessibilityHint={t('mobile.workoutRunner.currentClimbHint')}
      style={styles.climbRow}
      testID="workout-runner-current"
    >
      <View style={styles.rowText}>
        <Text variant="subheadline" color={brandColors.primary} testID="workout-runner-position">
          {positionLabel}
        </Text>
        <View style={styles.climbNameRow}>
          <Text variant="body" style={[styles.emphasis, styles.climbName]} numberOfLines={1}>
            {name}
          </Text>
          {grade ? (
            <Text variant="body" color={systemColors.secondaryLabel} numeric>
              {grade}
            </Text>
          ) : null}
        </View>
      </View>
      <Icon name="chevron.right" size={18} color={systemColors.tertiaryLabel} />
    </PressableSurface>
  );
}

/**
 * The climb on the wall is in no stage: Start ran while another climb was up,
 * or the climber wandered off the plan. One tap puts the workout climb they left
 * back on the wall (or, once something is logged on it, the first one not
 * reached yet), and stops walking any list, so Next and the rest timer follow
 * the workout again.
 */
function ResumeWorkoutRow({ readout, item }: { readout: WorkoutRunnerReadout; item: ClimbQueueItem }) {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const { setCurrentClimb } = useQueueActions();
  const started = readout.totals.sent + readout.totals.tried > 0;
  const title = started ? t('mobile.workoutRunner.backToWorkout') : t('mobile.workoutRunner.startWorkout');
  return (
    <PressableSurface
      onPress={() => {
        hapticSelection();
        setCurrentClimb(item, { playlistSuggestionSource: null });
      }}
      feedback="opacity"
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={t('mobile.workoutRunner.resumeHint', { name: item.climb.name })}
      style={styles.climbRow}
      testID="workout-runner-resume"
    >
      <Icon name="play.fill" size={18} color={brandColors.primary} />
      <View style={styles.rowText}>
        <Text variant="body" color={brandColors.primary} style={styles.emphasis}>
          {title}
        </Text>
        <Text variant="subheadline" color={systemColors.secondaryLabel} numberOfLines={1}>
          {item.climb.name}
        </Text>
      </View>
      <Icon name="chevron.right" size={18} color={systemColors.tertiaryLabel} />
    </PressableSurface>
  );
}

/** Which rest is counting down, as a word beside the clock. */
function restLabel(rest: WorkoutRunnerRest, t: TranslateWorkoutStage): string {
  if (rest.paused) return t('mobile.workoutRunner.timerPausedLabel');
  if (rest.mode === 'onTheMinute') {
    return rest.endsWorkout ? t('mobile.workoutRunner.workoutEndsLabel') : t('mobile.workoutRunner.nextBeatLabel');
  }
  return rest.closesSet ? t('mobile.workoutRunner.setRestLabel') : t('mobile.workoutRunner.restLabel');
}

/**
 * "Rest 1:42 / Then Crimp City". After a fall on a limit climb the rest leads
 * back to the same climb: "Then try again"; between two reps of a 4x4 set it
 * leads to the next rep: "Then rep 3 of 4". On a crew phone that does not hold
 * the wall, the rest moves nothing, so it says who moves the queue instead.
 *
 * A leaf: it reads the live display (`useRestTimerDisplay`) so a screen reader
 * hears one sentence ("Set rest. Rest timer, 2:58 left. Then Crimp City"),
 * with the overrun spoken as words rather than "minus zero twelve", so it
 * re-renders once a second and nothing above it does. The digits are the
 * `RestTimerClock` leaf.
 */
function RestLine({ rest, nextItem }: { rest: WorkoutRunnerRest; nextItem: ClimbQueueItem | null }) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const display = useRestTimerDisplay();
  const nextName = nextItem?.climb.name ?? null;
  const caption = rest.nextRep
    ? t('mobile.workoutRunner.thenRep', { number: rest.nextRep.number, total: rest.nextRep.total })
    : rest.staysOnClimb
      ? t('mobile.workoutRunner.thenTryAgain')
      : !rest.drivesWall
        ? t('mobile.restTimer.autoAdvanceBlocked')
        : nextName
          ? t('mobile.workoutRunner.thenNext', { name: nextName })
          : null;
  const label = restLabel(rest, t);
  const spokenParts = [label, restTimerClockAccessibilityLabel(display, t)];
  if (caption) spokenParts.push(caption);
  return (
    <View
      style={styles.restLine}
      accessible
      accessibilityRole="text"
      accessibilityLabel={spokenParts.join(SPOKEN_SEPARATOR)}
      testID="workout-runner-rest"
    >
      <View style={styles.restClockRow}>
        <Text variant="body" color={systemColors.secondaryLabel}>
          {label}
        </Text>
        <RestTimerClock variant="headline" />
      </View>
      {caption ? (
        <Text variant="subheadline" color={systemColors.secondaryLabel} numberOfLines={2}>
          {caption}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * A timed block with the rest timer off: nothing moves on its own. One tap arms
 * it on the block's own rest (`armRestTimerForWorkout`), the same arm Start makes.
 * On a crew phone that does not hold the wall the timer only times the rests,
 * and the hint says so.
 */
function TurnOnRestTimerRow({
  sessionId,
  run,
  drivesWall,
}: {
  sessionId: string;
  run: WorkoutRun;
  drivesWall: boolean;
}) {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  return (
    <PressableSurface
      onPress={() => {
        hapticSelection();
        armRestTimerForWorkout(sessionId, run, nowMs());
      }}
      feedback="opacity"
      accessibilityRole="button"
      accessibilityLabel={t('mobile.workoutRunner.turnOnAccessibilityLabel')}
      accessibilityHint={
        drivesWall ? t('mobile.workoutRunner.turnOnHint') : t('mobile.workoutRunner.turnOnPassengerHint')
      }
      style={styles.turnOnRow}
      testID="workout-runner-turn-on"
    >
      <Icon name="clock" size={18} color={systemColors.secondaryLabel} />
      <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.rowText}>
        {t('mobile.workoutRunner.timerOff')}
      </Text>
      <Text variant="subheadline" color={brandColors.primary} style={styles.emphasis}>
        {t('mobile.workoutRunner.turnOn')}
      </Text>
    </PressableSurface>
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
  stageText: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    columnGap: spacing[3],
    rowGap: 2,
  },
  stageName: {
    flexShrink: 1,
  },
  stageStatus: {
    flexShrink: 1,
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
  headerRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    columnGap: spacing[3],
  },
  headerTitle: {
    flex: 1,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  emphasis: {
    fontWeight: '600',
  },
  doneLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    marginTop: spacing[3],
  },
  climbRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    minHeight: 44,
    marginTop: spacing[3],
  },
  climbNameRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing[2],
  },
  climbName: {
    flexShrink: 1,
  },
  restLine: {
    marginTop: spacing[3],
    gap: 2,
  },
  restClockRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    columnGap: spacing[2],
  },
  turnOnRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    minHeight: 44,
    marginTop: spacing[2],
  },
});
