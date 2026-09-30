import { useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useKeepAwake } from 'expo-keep-awake';
import * as Haptics from 'expo-haptics';
import { BoardView } from '../src/board/BoardView';
import { HoldLegend } from '../src/board/HoldLegend';
import { useBoard } from '../src/board/board-provider';
import { useBluetooth } from '../src/ble/bluetooth-provider';
import { climbSubtitle } from '../src/climbs/ClimbRow';
import { gradeBand, gradeLabel } from '../src/grades/grades';
import { useNow } from '../src/hooks/use-now';
import { formatElapsed, summarizeSession } from '../src/session/session';
import { useSession } from '../src/session/session-provider';
import { usePreferences } from '../src/settings/preferences-provider';
import { sendStatus } from '../src/ticks/tick-input';
import { useLogClimb } from '../src/ticks/use-log-climb';
import { useClimbTicks } from '../src/ticks/use-ticks';
import { msRemaining, summarizeRunner, workoutSteps } from '../src/workout/engine';
import { formatCountdown } from '../src/workout/format';
import { useWorkoutCues } from '../src/workout/use-workout-cues';
import { useWorkout } from '../src/workout/workout-provider';
import { Button } from '../src/ui/Button';
import { GradeBadge } from '../src/ui/GradeBadge';
import { Bluetooth, Check, LayoutGrid, SkipForward } from '../src/ui/icons';
import { ReadoutStrip } from '../src/ui/StatTile';
import { Text } from '../src/ui/Text';
import { TopBar } from '../src/ui/TopBar';
import { useTheme } from '../src/ui/theme';
import { GUTTER, spacing } from '../src/ui/tokens';

// Taps closer together than this are one tap. With no rest between climbs, a
// double tap on Sent would otherwise log the next climb as sent too.
const TAP_GUARD_MS = 700;

const pad = (value: number) => String(value).padStart(2, '0');

export default function WorkoutRunScreen() {
  useKeepAwake();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { workout, dispatch, end } = useWorkout();
  const { board } = useBoard();
  const bluetooth = useBluetooth();
  const logger = useLogClimb();
  const { session } = useSession();
  const { gradeFormat } = usePreferences();
  const [notice, setNotice] = useState<string | null>(null);
  const lastTapAt = useRef(0);

  const runner = workout?.runner ?? null;
  const timing = workout?.timing ?? null;
  const running = runner !== null && runner.phase.kind !== 'done';
  const isFree = workout !== null && timing === null;
  const now = useNow(250, running || isFree);

  const steps = workout && timing ? workoutSteps({ timing, climbCount: workout.climbs.length }) : [];
  const phase = runner?.phase ?? null;
  const stepIndex =
    phase?.kind === 'climbing' ? phase.stepIndex : phase?.kind === 'resting' ? phase.nextStepIndex : null;
  const step = stepIndex === null ? undefined : steps[stepIndex];
  const climb = step && workout ? workout.climbs[step.climbIndex] : undefined;
  const msLeft = runner ? msRemaining(runner, now.getTime()) : null;
  const climbTicks = useClimbTicks(board?.boardName, climb?.uuid);

  // Free climbing: count down to the goal, if there is one.
  const freeElapsedMs = workout ? now.getTime() - workout.startedAt : 0;
  const freeGoalMs = workout?.goalMinutes ? workout.goalMinutes * 60_000 : null;
  const freeGoalReached = freeGoalMs !== null && freeElapsedMs >= freeGoalMs;

  // The runner's clock: moves the workout on when a rest or interval runs out.
  useEffect(() => {
    if (running) dispatch({ type: 'tick', at: now.getTime() });
  }, [now, running]);

  // Light the climb being climbed, or the next one during a rest so it can be studied.
  useEffect(() => {
    if (climb) void bluetooth.showClimb(climb.frames);
  }, [climb?.uuid, bluetooth.status]);

  const phaseKey = isFree
    ? freeGoalReached
      ? 'free-goal'
      : 'free'
    : phase === null || phase.kind === 'done'
      ? 'done'
      : phase.kind === 'resting'
        ? `rest:${phase.nextStepIndex}:${phase.endsAt}`
        : `climb:${phase.stepIndex}`;
  const secondsLeft = isFree
    ? freeGoalMs === null || freeGoalReached
      ? null
      : Math.ceil((freeGoalMs - freeElapsedMs) / 1000)
    : msLeft === null
      ? null
      : Math.ceil(msLeft / 1000);
  useWorkoutCues({ secondsLeft, phaseKey, isClimbing: isFree ? freeGoalReached : phase?.kind === 'climbing' });

  if (!workout) {
    return (
      <View style={[styles.flex, { backgroundColor: theme.bgApp }]}>
        <TopBar />
        <View style={styles.center}>
          <Text variant="title3">No workout running.</Text>
          <Button title="Pick a workout" variant="secondary" onPress={() => router.replace('/workout')} />
        </View>
      </View>
    );
  }

  const finish = () => {
    end();
    if (router.canGoBack()) router.back();
    else router.replace('/workout');
  };

  const confirmEnd = () =>
    Alert.alert('End this workout?', 'Climbs you logged stay in your logbook.', [
      { text: 'Keep going', style: 'cancel' },
      {
        text: 'End workout',
        style: 'destructive',
        onPress: () => (isFree ? finish() : dispatch({ type: 'finish', at: Date.now() })),
      },
    ]);

  const handle = async (type: 'sent' | 'fell' | 'moveOn') => {
    if (!climb || !board) return;
    const tappedAt = Date.now();
    if (tappedAt - lastTapAt.current < TAP_GUARD_MS) return;
    lastTapAt.current = tappedAt;
    const hadHistory = climbTicks.isPending || (climbTicks.data ?? []).some((tick) => tick.angle === board.angle);
    void Haptics.selectionAsync();
    const log = dispatch({ type, at: tappedAt });
    if (!log) return;
    if (!logger.canLog) {
      setNotice('Sign in to save workout climbs to your logbook.');
      return;
    }
    const loggedClimb = workout.climbs[steps[log.stepIndex].climbIndex];
    const status = log.outcome === 'sent' ? sendStatus(hadHistory, log.attempts) : 'attempt';
    const result = await logger.log(loggedClimb, {
      status,
      attempts: log.attempts,
      quality: null,
      difficulty: null,
      comment: '',
    });
    setNotice(result.ok ? null : `Not saved to your logbook: ${result.message}`);
  };

  const endButton =
    phase?.kind === 'done' ? null : <Button title="End" variant="ghost" size="sm" onPress={confirmEnd} />;
  const actionBarStyle = [
    styles.actions,
    { borderTopColor: theme.border2, backgroundColor: theme.bgApp, paddingBottom: spacing.md + insets.bottom },
  ];

  // Free climbing: a clock and a way to the climbs.
  if (isFree) {
    const sessionSummary = session ? summarizeSession(session, now) : null;
    return (
      <View style={[styles.flex, { backgroundColor: theme.bgApp }]}>
        <TopBar label={workout.title} right={endButton} />
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.clockBlock}>
            <Text variant="label">
              {freeGoalMs === null
                ? 'Climbing for'
                : freeGoalReached
                  ? 'Goal reached'
                  : `Goal · ${workout.goalMinutes} min`}
            </Text>
            <Text variant="readout" monospacedDigits accessibilityRole="timer" style={styles.bigClock}>
              {formatElapsed(freeElapsedMs)}
            </Text>
          </View>
          {sessionSummary ? (
            <ReadoutStrip
              items={[
                { label: 'Sends', value: String(sessionSummary.sends) },
                { label: 'Flashes', value: String(sessionSummary.flashes) },
                { label: 'Tries', value: String(sessionSummary.attempts) },
              ]}
            />
          ) : null}
        </ScrollView>
        <View style={actionBarStyle}>
          <View style={styles.actionRow}>
            <Button title="Finish" variant="secondary" size="lg" style={styles.flex} onPress={finish} />
            <Button
              title="Browse climbs"
              size="lg"
              icon={LayoutGrid}
              style={styles.flex}
              onPress={() => router.navigate('/session')}
            />
          </View>
        </View>
      </View>
    );
  }

  if (!runner || !timing || phase === null) return null;

  // Done: how it went.
  if (phase.kind === 'done') {
    const summary = summarizeRunner(runner);
    return (
      <View style={[styles.flex, { backgroundColor: theme.bgApp }]}>
        <TopBar label={workout.title} />
        <ScrollView contentContainerStyle={styles.content}>
          <Text variant="title1">Workout done</Text>
          <ReadoutStrip
            items={[
              { label: 'Sent', value: String(summary.sent) },
              { label: 'Tried', value: String(summary.attempted) },
              { label: 'Skipped', value: String(summary.skipped) },
              { label: 'Time', value: formatElapsed((runner.finishedAt ?? now.getTime()) - runner.startedAt) },
            ]}
          />
          <Text tone="tertiary">
            {logger.canLog
              ? 'Every climb you logged is in your Boardsesh logbook. Your session keeps running until you end it on Home.'
              : 'Sign in next time to save workout climbs to your logbook.'}
          </Text>
        </ScrollView>
        <View style={actionBarStyle}>
          <Button title="Finish" size="lg" fullWidth onPress={finish} />
        </View>
      </View>
    );
  }

  const isResting = phase.kind === 'resting';
  const round = step?.round ?? 1;
  const rounds = timing.kind === 'rounds' ? timing.rounds : 1;
  const progress = stepIndex === null ? 0 : stepIndex / steps.length;
  const retries = timing.kind === 'rest' || timing.kind === 'limit';
  const position = [
    `Climb ${pad((stepIndex ?? 0) + 1)} / ${pad(steps.length)}`,
    rounds > 1 ? `Round ${round} / ${rounds}` : null,
    runner.attemptsOnStep > 0 ? `Try ${runner.attemptsOnStep + 1}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <View style={[styles.flex, { backgroundColor: theme.bgApp }]}>
      <TopBar label={workout.title} right={endButton} />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.progressBlock}>
          <Text variant="label">{position}</Text>
          <View style={[styles.progressTrack, { backgroundColor: theme.border2 }]}>
            <View style={[styles.progressFill, { width: `${progress * 100}%`, backgroundColor: theme.fg1 }]} />
          </View>
        </View>

        {isResting ? (
          <View style={styles.clockBlock}>
            <Text variant="label">{phase.getReady ? 'Get ready' : 'Rest'}</Text>
            <Text variant="readout" monospacedDigits accessibilityRole="timer" style={styles.bigClock}>
              {formatCountdown(msLeft ?? 0)}
            </Text>
          </View>
        ) : null}

        {climb ? (
          <View style={styles.titleRow}>
            <View style={styles.titleCopy}>
              {isResting ? <Text variant="label">Next</Text> : null}
              <Text variant={isResting ? 'title2' : 'title1'} numberOfLines={2}>
                {climb.name}
              </Text>
              <Text variant="small" tone="tertiary" numberOfLines={1}>
                {climbSubtitle(climb)}
              </Text>
            </View>
            <View style={styles.titleAside}>
              <GradeBadge
                label={gradeLabel(climb.difficulty, gradeFormat)}
                band={gradeBand(climb.difficulty)}
                variant="display"
                size={isResting ? 'md' : 'lg'}
              />
              {!isResting && msLeft !== null ? (
                <Text variant="value" monospacedDigits accessibilityRole="timer">
                  {formatCountdown(msLeft)}
                </Text>
              ) : null}
            </View>
          </View>
        ) : null}

        {climb && board ? (
          <>
            <BoardView board={board} frames={climb.frames} maxHeight={windowHeight * (isResting ? 0.32 : 0.46)} />
            <HoldLegend board={board} frames={climb.frames} />
          </>
        ) : null}

        {bluetooth.status !== 'connected' ? (
          <Button
            title="Connect board to light each climb"
            variant="ghost"
            size="sm"
            icon={Bluetooth}
            onPress={() => router.push('/connect')}
          />
        ) : null}

        {notice ? (
          <Text variant="small" tone="danger" accessibilityRole="alert">
            {notice}
          </Text>
        ) : null}
      </ScrollView>

      <View style={actionBarStyle}>
        {isResting ? (
          <Button
            title={phase.getReady ? 'Start now' : 'Skip rest'}
            variant="secondary"
            size="lg"
            icon={SkipForward}
            fullWidth
            onPress={() => dispatch({ type: 'skipRest', at: Date.now() })}
          />
        ) : phase.logged ? (
          <View style={styles.actionRow}>
            <Text variant="small" tone="tertiary" style={styles.flex}>
              Logged. Next climb in {formatCountdown(msLeft ?? 0)}.
            </Text>
            <Button title="Go now" variant="ghost" size="sm" onPress={() => void handle('moveOn')} />
          </View>
        ) : (
          <>
            <View style={styles.actionRow}>
              <Button
                title={retries ? 'Fell · rest' : 'Fell'}
                variant="secondary"
                size="lg"
                style={styles.flex}
                onPress={() => void handle('fell')}
              />
              <Button title="Sent" size="lg" icon={Check} style={styles.flex} onPress={() => void handle('sent')} />
            </View>
            <Button
              title={runner.attemptsOnStep > 0 ? 'Move on to the next climb' : 'Skip this climb'}
              variant="ghost"
              size="sm"
              onPress={() => void handle('moveOn')}
            />
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, padding: spacing.xxl },
  content: { paddingHorizontal: GUTTER, paddingBottom: spacing.xl, gap: spacing.lg },
  progressBlock: { gap: spacing.sm },
  progressTrack: { height: 2, borderRadius: 1, overflow: 'hidden' },
  progressFill: { height: '100%' },
  clockBlock: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm },
  bigClock: { fontSize: 88, lineHeight: 96, letterSpacing: -6 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: spacing.lg },
  titleCopy: { flex: 1, minWidth: 0, gap: 6 },
  titleAside: { alignItems: 'flex-end', gap: spacing.xs },
  actions: {
    gap: spacing.sm,
    paddingTop: spacing.md,
    paddingHorizontal: spacing.lg,
    borderTopWidth: 1,
    alignItems: 'center',
  },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, alignSelf: 'stretch' },
});
