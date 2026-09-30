import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { bandColor, gradeBandFromId, gradeLabelFromId } from '../src/grades/grades';
import { formatElapsed, summarizeSession } from '../src/session/session';
import { useSession } from '../src/session/session-provider';
import { usePreferences } from '../src/settings/preferences-provider';
import { Button } from '../src/ui/Button';
import { GradeBadge } from '../src/ui/GradeBadge';
import { ReadoutStrip } from '../src/ui/StatTile';
import { Text } from '../src/ui/Text';
import { Sheet } from '../src/ui/Sheet';
import { useTheme } from '../src/ui/theme';
import { spacing } from '../src/ui/tokens';

const RESULT = { flash: 'Flash', send: 'Send', attempt: 'Attempts' } as const;

export default function SessionSummarySheet() {
  const theme = useTheme();
  const { lastSession } = useSession();
  const { gradeFormat } = usePreferences();

  if (!lastSession) {
    return (
      <Sheet title="Session done">
        <Text tone="tertiary">No finished session yet.</Text>
      </Sheet>
    );
  }

  const summary = summarizeSession(lastSession, new Date());
  const hardest = gradeLabelFromId(summary.hardestSendDifficultyId, gradeFormat);

  return (
    <Sheet title="Session done" footer={<Button title="Done" size="lg" fullWidth onPress={() => router.back()} />}>
      <Text variant="label">
        {lastSession.boardLabel} · {lastSession.angle}°
      </Text>
      <ReadoutStrip
        items={[
          { label: 'Time', value: formatElapsed(summary.durationMs), grow: 1.6 },
          { label: 'Sends', value: String(summary.sends) },
          { label: 'Flashes', value: String(summary.flashes) },
          {
            label: 'Hardest',
            value: hardest ?? '–',
            valueColor: bandColor(theme.grades, gradeBandFromId(summary.hardestSendDifficultyId)),
          },
        ]}
      />
      {lastSession.ticks.length > 0 ? (
        <View>
          {lastSession.ticks.map((tick) => (
            <View key={tick.id} style={[styles.row, { borderBottomColor: theme.border1 }]}>
              <GradeBadge
                label={gradeLabelFromId(tick.difficultyId, gradeFormat)}
                band={gradeBandFromId(tick.difficultyId)}
                variant={tick.status === 'attempt' ? 'outline' : 'solid'}
                size="sm"
              />
              <Text variant="bodyStrong" numberOfLines={1} style={styles.flex}>
                {tick.climbName}
              </Text>
              <Text variant="label" tone={tick.status === 'flash' ? 'primary' : 'tertiary'}>
                {tick.status === 'attempt' ? `${RESULT.attempt} ×${tick.attempts}` : RESULT[tick.status]}
              </Text>
            </View>
          ))}
        </View>
      ) : (
        <Text tone="tertiary">No climbs logged this time. Rest days count too.</Text>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderBottomWidth: 1 },
});
