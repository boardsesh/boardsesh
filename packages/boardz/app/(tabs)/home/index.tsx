import { ActivityIndicator, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '../../../src/auth/auth-provider';
import { useConnectionState } from '../../../src/ble/use-connection-state';
import { useBoard } from '../../../src/board/board-provider';
import { BoardCard } from '../../../src/home/BoardCard';
import { ListsSection } from '../../../src/home/ListsSection';
import { SessionCard } from '../../../src/home/SessionCard';
import { Button } from '../../../src/ui/Button';
import { Section } from '../../../src/ui/Card';
import { ConnectionPill } from '../../../src/ui/ConnectionPill';
import { PageHeader } from '../../../src/ui/PageHeader';
import { Screen } from '../../../src/ui/Screen';
import { Text } from '../../../src/ui/Text';
import { Wordmark } from '../../../src/ui/Wordmark';
import { spacing } from '../../../src/ui/tokens';

export default function HomeScreen() {
  const { status } = useAuth();
  const { board, isLoading } = useBoard();
  const connection = useConnectionState();

  return (
    <Screen
      header={
        // The board card below names the board, so the wordmark leads.
        <PageHeader
          title={<Wordmark />}
          right={board ? <ConnectionPill state={connection} onPress={() => router.push('/connect')} /> : null}
        />
      }
    >
      {isLoading ? (
        <ActivityIndicator style={styles.loading} />
      ) : board ? (
        <BoardCard board={board} />
      ) : (
        <Section title="Board">
          <Text variant="title3">Set up your board</Text>
          <Text variant="small" tone="tertiary">
            Tell Boardz which MoonBoard, Tension or Kilter you climb on, so it shows climbs that fit your wall and can
            light them up.
          </Text>
          <Button title="Set up board" size="lg" fullWidth onPress={() => router.push('/board-setup')} />
        </Section>
      )}

      <SessionCard canStart={board !== null} />

      <ListsSection />

      {status === 'signedOut' ? (
        <Section title="Account">
          <Text variant="title3">Sign in to log your climbs</Text>
          <Text variant="small" tone="tertiary">
            Boardz saves every send to your Boardsesh account, so your logbook stays in one place.
          </Text>
          <Button title="Sign in" variant="secondary" fullWidth onPress={() => router.push('/login')} />
        </Section>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  loading: { paddingVertical: spacing.xl },
});
