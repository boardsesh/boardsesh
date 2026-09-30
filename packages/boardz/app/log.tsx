import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import type { TickStatus } from '@boardsesh/shared-schema';
import { useBoard } from '../src/board/board-provider';
import { useClimbSequence } from '../src/climbs/climb-sequence';
import { difficultyIdFromGrade, gradeBand, gradeLabel, gradeOptions } from '../src/grades/grades';
import { usePreferences } from '../src/settings/preferences-provider';
import { useLogClimb } from '../src/ticks/use-log-climb';
import { logLine, type LogOutcome as Outcome } from '../src/ticks/log-lines';
import { useClimbTicks } from '../src/ticks/use-ticks';
import { Button } from '../src/ui/Button';
import { GradeBadge } from '../src/ui/GradeBadge';
import { Check, RotateCcw, Zap } from '../src/ui/icons';
import { SegmentedControl } from '../src/ui/SegmentedControl';
import { StarRating } from '../src/ui/StarRating';
import { Stepper } from '../src/ui/Stepper';
import { Text } from '../src/ui/Text';
import { TextField } from '../src/ui/TextField';
import { useToast, type ToastMessage } from '../src/ui/Toast';
import { Sheet } from '../src/ui/Sheet';
import { useTheme } from '../src/ui/theme';
import { spacing } from '../src/ui/tokens';

type Feel = 'soft' | 'on' | 'hard';

const MAX_TRIES = 99;

function savedToast(outcome: Outcome, tries: number): ToastMessage {
  const message = logLine(outcome);
  if (outcome === 'flash') return { tone: 'accent', title: 'Flashed!', message };
  if (outcome === 'send') return { tone: 'success', title: `Sent in ${tries}`, message };
  return { tone: 'info', title: `${tries} ${tries === 1 ? 'attempt' : 'attempts'} saved`, message };
}

/** Log the climb on screen: how it went, tries, the grade's feel, stars and a note. */
export default function LogSheet() {
  const theme = useTheme();
  const toast = useToast();
  const { uuid } = useLocalSearchParams<{ uuid: string }>();
  const { climbs } = useClimbSequence();
  const climb = climbs.find((candidate) => candidate.uuid === uuid);
  const { board } = useBoard();
  const { gradeFormat } = usePreferences();
  const logger = useLogClimb();
  const ticks = useClimbTicks(board?.boardName, climb?.uuid);

  const [picked, setPicked] = useState<Outcome | null>(null);
  const [tries, setTries] = useState(2);
  const [feel, setFeel] = useState<Feel>('on');
  const [stars, setStars] = useState(0);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!climb || !board) {
    return (
      <Sheet title="Log it">
        <Text tone="tertiary">This climb isn&apos;t open any more.</Text>
      </Sheet>
    );
  }

  if (!logger.canLog) {
    return (
      <Sheet title="Log it">
        <Text tone="secondary">Sign in to save your climbs to your Boardsesh logbook.</Text>
        <Button title="Sign in" size="lg" fullWidth onPress={() => router.replace('/login')} />
      </Sheet>
    );
  }

  // Until history loads, assume the climber has been on it: a wrongly offered
  // Flash writes a phantom flash, which is worse than no Flash for a moment.
  const hasHistory = ticks.isPending || (ticks.data ?? []).some((tick) => tick.angle === board.angle);
  const outcome: Outcome = picked === 'flash' && hasHistory ? 'send' : (picked ?? (hasHistory ? 'send' : 'flash'));
  // A send without earlier tries needs at least two goes, or it was a flash.
  const minTries = outcome === 'send' && !hasHistory ? 2 : 1;
  const attempts = outcome === 'flash' ? 1 : Math.max(tries, minTries);

  const climbDifficulty = difficultyIdFromGrade(climb.difficulty);
  const grades = gradeOptions(board.boardName, gradeFormat);
  const feltDifficulty = (): number | null => {
    if (climbDifficulty === null) return null;
    const index = grades.findIndex((grade) => grade.difficultyId === climbDifficulty);
    if (index < 0 || feel === 'on') return climbDifficulty;
    const neighbour = grades[feel === 'soft' ? index - 1 : index + 1];
    return neighbour?.difficultyId ?? climbDifficulty;
  };

  const save = async () => {
    setError(null);
    const status: TickStatus = outcome;
    const result = await logger.log(climb, {
      status,
      attempts,
      quality: stars > 0 ? stars : null,
      difficulty: outcome === 'attempt' ? null : feltDifficulty(),
      comment: note,
    });
    if (!result.ok) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(`Not saved. ${result.message}`);
      return;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.back();
    toast.show({
      ...savedToast(outcome, attempts),
      actionLabel: 'Undo',
      onAction: () => void logger.undo(result),
    });
  };

  const outcomes = [
    ...(hasHistory ? [] : [{ value: 'flash' as const, label: 'Flash', icon: Zap }]),
    { value: 'send' as const, label: 'Sent', icon: Check },
    { value: 'attempt' as const, label: 'Working it', icon: RotateCcw, grow: 1.3 },
  ];

  return (
    <Sheet title="Log it" gap={spacing.xl} avoidKeyboard>
      <View style={[styles.climbRow, { borderBottomColor: theme.border2 }]}>
        <GradeBadge label={gradeLabel(climb.difficulty, gradeFormat)} band={gradeBand(climb.difficulty)} />
        <Text variant="title3" numberOfLines={1} style={styles.flex}>
          {climb.name}
        </Text>
        <Text variant="label">{board.angle}°</Text>
      </View>

      <View style={styles.field}>
        <Text variant="label">How did it go?</Text>
        <SegmentedControl
          fullWidth
          size="lg"
          value={outcome}
          onChange={(next) => {
            setPicked(next);
            if (next === 'send' && tries < 2 && !hasHistory) setTries(2);
          }}
          options={outcomes}
        />
      </View>

      {outcome !== 'flash' ? (
        <Stepper label="Attempts" showLabel value={attempts} min={minTries} max={MAX_TRIES} onChange={setTries} />
      ) : null}

      {outcome !== 'attempt' && climbDifficulty !== null ? (
        <View style={styles.field}>
          <Text variant="label">Grade feels</Text>
          <SegmentedControl
            fullWidth
            size="lg"
            value={feel}
            onChange={setFeel}
            options={[
              { value: 'soft', label: 'Soft' },
              { value: 'on', label: 'Spot on' },
              { value: 'hard', label: 'Sandbagged', grow: 1.3 },
            ]}
          />
        </View>
      ) : null}

      {outcome !== 'attempt' ? (
        <View style={styles.qualityRow}>
          <Text>Quality</Text>
          <StarRating value={stars} max={5} size={22} onChange={setStars} />
        </View>
      ) : null}

      <TextField
        label="Notes"
        multiline
        placeholder="Beta, a victory yell, anything"
        value={note}
        onChangeText={setNote}
      />

      {error ? (
        <Text variant="small" tone="danger" accessibilityRole="alert">
          {error}
        </Text>
      ) : null}

      <Button
        title={outcome === 'attempt' ? 'Save attempts' : outcome === 'flash' ? 'Save flash' : 'Save send'}
        size="lg"
        icon={Check}
        fullWidth
        loading={logger.isLogging}
        onPress={() => void save()}
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  climbRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingBottom: 14,
    borderBottomWidth: 1,
  },
  field: { gap: spacing.sm },
  qualityRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
