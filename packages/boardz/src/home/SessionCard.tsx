import { Alert, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { bandColor, gradeBandFromId, gradeLabelFromId } from '../grades/grades';
import { useNow } from '../hooks/use-now';
import { formatElapsed, summarizeSession } from '../session/session';
import { useSession } from '../session/session-provider';
import { usePreferences } from '../settings/preferences-provider';
import { Button } from '../ui/Button';
import { Section } from '../ui/Card';
import { Play } from '../ui/icons';
import { LedDot } from '../ui/LedDot';
import { ReadoutStrip } from '../ui/StatTile';
import { Text } from '../ui/Text';
import { LED, useTheme } from '../ui/theme';
import { spacing } from '../ui/tokens';

/** Start a session, or follow the one that's running. */
export function SessionCard({ canStart }: { canStart: boolean }) {
  const theme = useTheme();
  const { session, start, end } = useSession();
  const { gradeFormat } = usePreferences();
  const now = useNow(1000, session !== null);

  if (!session) {
    return (
      <Section title="Session">
        <Text variant="title3">Ready to climb?</Text>
        <Text variant="small" tone="tertiary">
          A session times your climbing and counts your sends. Every climb you log goes to your logbook.
        </Text>
        <Button
          title="Start session"
          size="lg"
          icon={Play}
          fullWidth
          disabled={!canStart}
          onPress={() => {
            start();
            router.navigate('/session');
          }}
        />
      </Section>
    );
  }

  const summary = summarizeSession(session, now);
  const hardest = gradeLabelFromId(summary.hardestSendDifficultyId, gradeFormat);

  const confirmEnd = () =>
    Alert.alert('End this session?', 'Your logged climbs stay in your logbook.', [
      { text: 'Keep climbing', style: 'cancel' },
      {
        text: 'End session',
        style: 'destructive',
        onPress: () => {
          end();
          router.push('/session-summary');
        },
      },
    ]);

  return (
    <Section
      title="Session"
      right={
        <View style={styles.live}>
          <LedDot color={LED.green} pulse />
          <Text variant="label" tone="secondary">
            Live
          </Text>
        </View>
      }
    >
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
      <View style={styles.actions}>
        <Button title="Open session" size="lg" style={styles.flex} onPress={() => router.navigate('/session')} />
        <Button title="End" variant="danger" size="lg" onPress={confirmEnd} />
      </View>
    </Section>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  live: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  actions: { flexDirection: 'row', gap: spacing.sm },
});
