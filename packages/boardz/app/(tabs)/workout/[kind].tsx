import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Climb } from '@boardsesh/shared-schema';
import { getGradesForBoard } from '@boardsesh/board-config';
import { describeRequestError } from '../../../src/api/graphql-client';
import { useAuth } from '../../../src/auth/auth-provider';
import { toSearchConfig } from '../../../src/board/active-board';
import { useBoard } from '../../../src/board/board-provider';
import { climbQuality } from '../../../src/climbs/ClimbRow';
import { useClimbSequence } from '../../../src/climbs/climb-sequence';
import { gradeBand, gradeLabel, gradeOptions, type GradeOption } from '../../../src/grades/grades';
import { useSession } from '../../../src/session/session-provider';
import { usePreferences } from '../../../src/settings/preferences-provider';
import { WORKOUTS, type WorkoutKind } from '../../../src/workout/catalog';
import { fetchGradePools } from '../../../src/workout/fetch-pools';
import { formatSeconds, formatSecondsShort } from '../../../src/workout/format';
import { pickClimbs, swapClimb, type PlannedClimb } from '../../../src/workout/pick-climbs';
import {
  defaultConfig,
  estimateMinutes,
  plannedGrades,
  usesField,
  workoutTiming,
  workoutTitle,
  type WorkoutConfig,
} from '../../../src/workout/workout-config';
import { useWorkout } from '../../../src/workout/workout-provider';
import { Button } from '../../../src/ui/Button';
import { Card, Section } from '../../../src/ui/Card';
import { GradeBadge } from '../../../src/ui/GradeBadge';
import { IconButton } from '../../../src/ui/IconButton';
import { Play, RefreshCw, Shuffle } from '../../../src/ui/icons';
import { SegmentedControl } from '../../../src/ui/SegmentedControl';
import { Stepper } from '../../../src/ui/Stepper';
import { Switch } from '../../../src/ui/Switch';
import { Text } from '../../../src/ui/Text';
import { TopBar } from '../../../src/ui/TopBar';
import { useTheme } from '../../../src/ui/theme';
import { GUTTER, spacing } from '../../../src/ui/tokens';

type NumericField =
  | 'climbs'
  | 'steps'
  | 'climbsPerStep'
  | 'spread'
  | 'restSeconds'
  | 'intervalSeconds'
  | 'rounds'
  | 'restBetweenClimbsSeconds'
  | 'restBetweenRoundsSeconds';

const NUMERIC_FIELDS: NumericField[] = [
  'climbs',
  'steps',
  'climbsPerStep',
  'spread',
  'intervalSeconds',
  'rounds',
  'restSeconds',
  'restBetweenClimbsSeconds',
  'restBetweenRoundsSeconds',
];

type FieldSpec = {
  label: string;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  spoken?: (value: number) => string;
};

/** Durations show as mono figures and are spoken in words. */
const DURATION = { format: formatSecondsShort, spoken: formatSeconds };

function numericSpec(kind: WorkoutKind, field: NumericField): FieldSpec {
  switch (field) {
    case 'climbs':
      return kind === 'limitBouldering'
        ? { label: 'Problems', min: 1, max: 8, step: 1, format: String }
        : { label: 'Climbs', min: 1, max: 40, step: 1, format: String };
    case 'steps':
      return { label: kind === 'pyramid' ? 'Steps up and down' : 'Steps up', min: 2, max: 9, step: 1, format: String };
    case 'climbsPerStep':
      return { label: 'Climbs per step', min: 1, max: 4, step: 1, format: String };
    case 'spread':
      return { label: 'Grade spread', min: 0, max: 3, step: 1, format: (value) => (value === 0 ? '0' : `±${value}`) };
    case 'restSeconds':
      return kind === 'limitBouldering'
        ? { label: 'Rest after each go', min: 60, max: 600, step: 30, ...DURATION }
        : { label: 'Rest after each climb', min: 0, max: 600, step: 15, ...DURATION };
    case 'intervalSeconds':
      return { label: 'Time per climb', min: 30, max: 240, step: 15, ...DURATION };
    case 'rounds':
      return { label: 'Rounds', min: 1, max: 8, step: 1, format: String };
    case 'restBetweenClimbsSeconds':
      return { label: 'Rest between climbs', min: 0, max: 120, step: 15, ...DURATION };
    case 'restBetweenRoundsSeconds':
      return { label: 'Rest between rounds', min: 60, max: 600, step: 30, ...DURATION };
  }
}

function gradeFieldLabel(kind: WorkoutKind): string {
  switch (kind) {
    case 'pyramid':
    case 'ladder':
      return 'Top grade';
    case 'warmUp':
      return 'Warm up for';
    case 'volume':
      return 'Around';
    default:
      return 'Grade';
  }
}

// 6B (V4) when there is nothing better to go on.
const FALLBACK_GRADE = 18;

function initialGrade(grades: GradeOption[], remembered: number | null): number {
  const available = new Set(grades.map((grade) => grade.difficultyId));
  if (remembered !== null && available.has(remembered)) return remembered;
  if (available.has(FALLBACK_GRADE)) return FALLBACK_GRADE;
  return grades[Math.floor(grades.length / 2)]?.difficultyId ?? FALLBACK_GRADE;
}

type Preview = { planned: PlannedClimb[]; missing: number; pools: Map<number, Climb[]> };

export default function WorkoutSetupScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ kind: string }>();
  const definition = WORKOUTS.find((workout) => workout.kind === params.kind);
  const { board } = useBoard();
  const { status } = useAuth();
  const { gradeFormat, workoutGrade, update } = usePreferences();
  const workoutContext = useWorkout();
  const session = useSession();
  const { setClimbs } = useClimbSequence();
  const grades = board ? gradeOptions(board.boardName, gradeFormat) : [];

  const [config, setConfig] = useState<WorkoutConfig | null>(() =>
    definition ? defaultConfig(definition.kind, initialGrade(grades, workoutGrade)) : null,
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [shuffleCount, setShuffleCount] = useState(0);

  // Rebuild the preview whenever a setting changes, after a short pause so
  // stepping through values doesn't fire a search for each one.
  const buildKey = JSON.stringify([config, board ? toSearchConfig(board) : null, status, shuffleCount]);
  useEffect(() => {
    if (!board || !config || config.kind === 'freeClimbing') return;
    let cancelled = false;
    setBuilding(true);
    setBuildError(null);
    const timer = setTimeout(() => {
      const planned = plannedGrades(config, getGradesForBoard(board.boardName));
      fetchGradePools(board, planned, { unsentOnly: config.freshClimbsOnly && status === 'signedIn' })
        .then((pools) => {
          if (!cancelled) setPreview({ ...pickClimbs(planned, pools), pools });
        })
        .catch((error: unknown) => {
          if (!cancelled) setBuildError(describeRequestError(error));
        })
        .finally(() => {
          if (!cancelled) setBuilding(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [buildKey]);

  if (!definition || !config) {
    return (
      <View style={[styles.flex, { backgroundColor: theme.bgApp }]}>
        <TopBar />
        <View style={styles.center}>
          <Text tone="tertiary">This workout doesn&apos;t exist.</Text>
        </View>
      </View>
    );
  }

  const change = (changes: Partial<WorkoutConfig>) => setConfig({ ...config, ...changes });
  const gradeIndex = Math.max(
    0,
    grades.findIndex((grade) => grade.difficultyId === config.targetGrade),
  );
  const targetLabel = grades[gradeIndex]?.label ?? '';
  const isFree = config.kind === 'freeClimbing';
  const planned = preview?.planned ?? [];
  const canStart = board !== null && (isFree || (planned.length > 0 && !building));

  const start = () => {
    const begin = () => {
      workoutContext.start({
        kind: config.kind,
        title: workoutTitle(config, targetLabel),
        climbs: planned.map((entry) => entry.climb),
        timing: workoutTiming(config),
        goalMinutes: isFree ? config.goalMinutes : null,
      });
      session.start();
      if (!isFree) update({ workoutGrade: config.targetGrade });
      router.push('/workout-run');
    };
    if (workoutContext.workout) {
      Alert.alert('Replace your workout?', `${workoutContext.workout.title} is still in progress.`, [
        { text: 'Keep it', style: 'cancel' },
        { text: 'Start new', style: 'destructive', onPress: begin },
      ]);
    } else {
      begin();
    }
  };

  const openPreviewClimb = (index: number) => {
    setClimbs(planned.map((entry) => entry.climb));
    router.push({ pathname: '/climb/[uuid]', params: { uuid: planned[index].climb.uuid } });
  };

  const numericFields = NUMERIC_FIELDS.filter((field) => usesField(config.kind, field));
  const climbCount =
    config.kind === 'fourByFour'
      ? `${planned.length} climbs × ${config.rounds} rounds`
      : `${planned.length} ${planned.length === 1 ? 'climb' : 'climbs'}`;
  const summary = preview ? `${climbCount} · about ${estimateMinutes(config, planned.length)} min` : null;

  return (
    <View style={[styles.flex, { backgroundColor: theme.bgApp }]}>
      <TopBar label={`Workout · ${definition.name}`} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.titleBlock}>
          <Text variant="title1">{definition.name}</Text>
          <Text variant="small" tone="tertiary">
            {definition.summary}
          </Text>
        </View>

        {!board ? (
          <Section>
            <Text>Set up your board first, so Boardz can pick climbs that are on it.</Text>
            <Button title="Set up board" onPress={() => router.push('/board-setup')} />
          </Section>
        ) : (
          <>
            <Section title="Settings">
              {!isFree ? (
                <Stepper
                  label={gradeFieldLabel(config.kind)}
                  showLabel
                  value={gradeIndex}
                  min={0}
                  max={Math.max(0, grades.length - 1)}
                  format={(index) => grades[index]?.label ?? ''}
                  onChange={(index) => change({ targetGrade: grades[index].difficultyId })}
                />
              ) : null}
              {numericFields.map((field) => {
                const spec = numericSpec(config.kind, field);
                return (
                  <Stepper
                    key={field}
                    label={spec.label}
                    showLabel
                    value={config[field]}
                    min={spec.min}
                    max={spec.max}
                    step={spec.step}
                    format={spec.format}
                    spokenFormat={spec.spoken}
                    onChange={(value) => change({ [field]: value })}
                  />
                );
              })}
              {usesField(config.kind, 'warmUpLength') ? (
                <View style={styles.field}>
                  <Text variant="label">Length</Text>
                  <SegmentedControl
                    fullWidth
                    size="lg"
                    value={config.warmUpLength}
                    onChange={(warmUpLength) => change({ warmUpLength })}
                    options={[
                      { value: 'standard', label: 'Short · 4' },
                      { value: 'extended', label: 'Long · 12' },
                    ]}
                  />
                </View>
              ) : null}
              {isFree ? (
                <Stepper
                  label="Goal"
                  showLabel
                  value={config.goalMinutes ?? 0}
                  min={0}
                  max={240}
                  step={15}
                  format={(minutes) => (minutes === 0 ? 'Open' : `${minutes}m`)}
                  onChange={(minutes) => change({ goalMinutes: minutes === 0 ? null : minutes })}
                />
              ) : null}
              {usesField(config.kind, 'warmUp') ? (
                <Switch
                  label="Warm up first"
                  description="Four easier climbs before the main set"
                  value={config.warmUp}
                  onValueChange={(warmUp) => change({ warmUp })}
                />
              ) : null}
              {usesField(config.kind, 'freshClimbsOnly') ? (
                <Switch
                  label="Climbs I haven't sent"
                  description={
                    status === 'signedIn' ? 'Tops up with sent ones if a grade runs short' : 'Sign in to use this'
                  }
                  value={config.freshClimbsOnly && status === 'signedIn'}
                  disabled={status !== 'signedIn'}
                  onValueChange={(freshClimbsOnly) => change({ freshClimbsOnly })}
                />
              ) : null}
            </Section>

            {isFree ? (
              <Text variant="small" tone="tertiary" style={styles.note}>
                A clock runs while you pick climbs yourself from the Session tab.
              </Text>
            ) : (
              <View style={styles.previewBlock}>
                <View style={styles.previewHeader}>
                  <View style={styles.flex}>
                    <Text variant="label">Your climbs</Text>
                    {summary ? (
                      <Text variant="mono" tone="secondary" style={styles.summary}>
                        {summary}
                      </Text>
                    ) : null}
                  </View>
                  <Button
                    title="Shuffle"
                    variant="ghost"
                    size="sm"
                    icon={Shuffle}
                    disabled={building}
                    onPress={() => setShuffleCount(shuffleCount + 1)}
                  />
                </View>
                {preview && preview.missing > 0 ? (
                  <Text variant="small" tone="tertiary">
                    {preview.missing} left out: not enough climbs at that grade on your board.
                  </Text>
                ) : null}
                {buildError ? (
                  <Section>
                    <Text tone="danger">{buildError}</Text>
                    <Button title="Try again" variant="secondary" onPress={() => setShuffleCount(shuffleCount + 1)} />
                  </Section>
                ) : null}
                {preview ? (
                  <Card flush style={building ? styles.stale : undefined}>
                    {planned.map((entry, index) => {
                      const quality = climbQuality(entry.climb);
                      return (
                        <View
                          key={`${index}-${entry.climb.uuid}`}
                          style={[
                            styles.previewRow,
                            index < planned.length - 1 && { borderBottomWidth: 1, borderBottomColor: theme.border1 },
                          ]}
                        >
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Climb ${index + 1}: ${entry.climb.name}`}
                            accessibilityHint="Shows the climb"
                            onPress={() => openPreviewClimb(index)}
                            style={styles.previewMain}
                          >
                            <Text variant="mono" tone="tertiary" style={styles.index}>
                              {String(index + 1).padStart(2, '0')}
                            </Text>
                            <View style={styles.previewCopy}>
                              <Text variant="bodyStrong" numberOfLines={1}>
                                {entry.climb.name}
                              </Text>
                              <View style={styles.meta}>
                                <Text variant="mono" tone="tertiary">
                                  {entry.climb.ascensionist_count.toLocaleString()}
                                </Text>
                                {quality ? (
                                  <Text variant="mono" tone="tertiary">
                                    ★{quality}
                                  </Text>
                                ) : null}
                              </View>
                            </View>
                            <GradeBadge
                              label={gradeLabel(entry.climb.difficulty, gradeFormat)}
                              band={gradeBand(entry.climb.difficulty)}
                              benchmark={entry.climb.benchmark_difficulty != null}
                              fixedWidth
                            />
                          </Pressable>
                          <IconButton
                            icon={RefreshCw}
                            label={`Swap ${entry.climb.name} for another climb at this grade`}
                            size="sm"
                            onPress={() =>
                              setPreview({ ...preview, planned: swapClimb(planned, index, preview.pools) })
                            }
                          />
                        </View>
                      );
                    })}
                  </Card>
                ) : building ? (
                  <ActivityIndicator style={styles.loading} />
                ) : null}
              </View>
            )}
          </>
        )}
      </ScrollView>
      {board ? (
        <View
          style={[
            styles.actions,
            { borderTopColor: theme.border2, backgroundColor: theme.bgApp, paddingBottom: spacing.md + insets.bottom },
          ]}
        >
          <Button title="Start workout" size="lg" icon={Play} fullWidth disabled={!canStart} onPress={start} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: GUTTER, paddingBottom: spacing.xxl, gap: spacing.md },
  titleBlock: { gap: spacing.sm, paddingBottom: spacing.xs },
  field: { gap: spacing.sm },
  note: { paddingHorizontal: spacing.xxs },
  previewBlock: { gap: spacing.sm, marginTop: spacing.xs },
  previewHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingLeft: spacing.xxs },
  summary: { marginTop: spacing.xs },
  stale: { opacity: 0.5 },
  previewRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingRight: spacing.sm },
  previewMain: {
    flex: 1,
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingLeft: spacing.lg,
  },
  index: { width: 22 },
  previewCopy: { flex: 1, minWidth: 0, gap: 4 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  loading: { paddingVertical: spacing.xl },
  actions: { paddingTop: spacing.md, paddingHorizontal: spacing.lg, borderTopWidth: 1 },
});
