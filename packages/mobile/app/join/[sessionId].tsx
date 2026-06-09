import { useCallback, useMemo, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { parseBoardPath, formatBoardDisplayName } from '@boardsesh/board-config';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../../src/lib/analytics';
import { Text } from '../../src/components/Text';
import { Button } from '../../src/components/Button';
import { Card } from '../../src/components/Card';
import { Avatar } from '../../src/components/Avatar';
import { ActivityIndicator } from '../../src/components/ActivityIndicator';
import { Icon } from '../../src/components/Icon';
import { useTheme } from '../../src/providers/theme-provider';
import { useAuth } from '../../src/providers/auth-provider';
import { useQueue } from '../../src/providers/queue-provider';
import { useToast } from '../../src/providers/toast-provider';
import { useSessionPreview, useMyBoards, useCreateBoard } from '../../src/lib/graphql/hooks';
import { resolveBoardForSession } from '../../src/lib/board-path-to-user-board';
import { spacing, borderRadius } from '../../src/theme/tokens';

/** Human board label for the confirmation card, e.g. "Kilter · 40°". */
function boardLabelFromPath(boardPath: string): string {
  const parsed = parseBoardPath(boardPath);
  if (!parsed) return boardPath;
  const name = formatBoardDisplayName(parsed.boardName);
  return parsed.angle != null ? `${name} · ${parsed.angle}°` : name;
}

export default function JoinSessionScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const { showToast } = useToast();

  const { sessionId: activeSessionId, joinSession, clearSession } = useQueue();

  const preview = useSessionPreview(sessionId);
  const myBoards = useMyBoards(undefined, { enabled: isAuthenticated });
  const createBoard = useCreateBoard();

  const [isJoining, setIsJoining] = useState(false);

  const session = preview.data;
  const hostName = useMemo(
    () => session?.users.find((sessionUser) => sessionUser.isLeader)?.username ?? t('mobileJoin.hostFallback'),
    [session, t],
  );

  const performJoin = useCallback(async () => {
    if (!session) return;
    setIsJoining(true);
    try {
      // Make sure the user's boards have loaded before resolving. On a cold
      // deep-link open the preview can resolve before myBoards; an empty list
      // makes resolveBoardForSession create a board the user already owns, which
      // the backend rejects ("You already have a board with this configuration")
      // and surfaces as a generic join error. Awaiting the boards lets the
      // owned-board reuse path run instead.
      let ownedBoards = myBoards.data?.boards;
      if (!ownedBoards) {
        ownedBoards = (await myBoards.refetch()).data?.boards ?? [];
      }
      const userBoard = await resolveBoardForSession(session.boardPath, {
        ownedBoards,
        createBoard: (input) => createBoard.mutateAsync(input),
      });
      await joinSession(session.id, { boardPath: session.boardPath, userBoard });
      // Web fires `Session Joined` on a genuine new-session entry (board-session-
      // bridge). The mobile equivalent is a successful deep-link join — the
      // queue provider only emits Session Started/Ended, never Joined. Mirror
      // web's props (session_id, board_name, layout_id), derived from the path.
      // Web only emits this from a fully-resolved board context, so skip the
      // event when the path doesn't parse rather than sending null board props
      // (they'd never group with web's events).
      const parsedBoard = parseBoardPath(session.boardPath);
      if (parsedBoard) {
        track(SHARED_EVENTS.SessionJoined, {
          session_id: session.id,
          board_name: parsedBoard.boardName,
          layout_id: parsedBoard.layoutId,
        });
      }
      // Land on the Record tab so the user drops straight into the joined session.
      router.replace('/(tabs)/record');
    } catch (error) {
      if (__DEV__) console.warn('[join] failed to join session', error);
      showToast(t('mobileJoin.joinError'), 'error');
      setIsJoining(false);
    }
  }, [session, myBoards, createBoard, joinSession, router, showToast, t]);

  const handleJoinPress = useCallback(() => {
    if (!session) return;
    // Already in a different session — confirm the switch before clearing it.
    if (activeSessionId && activeSessionId !== session.id) {
      Alert.alert(t('mobileJoin.switchTitle'), t('mobileJoin.switchBody'), [
        { text: t('mobileJoin.cancel'), style: 'cancel' },
        {
          text: t('mobileJoin.join'),
          style: 'destructive',
          onPress: () => {
            void (async () => {
              await clearSession();
              await performJoin();
            })();
          },
        },
      ]);
      return;
    }
    void performJoin();
  }, [session, activeSessionId, clearSession, performJoin, t]);

  const containerStyle = [styles.container, { backgroundColor: systemColors.background, paddingTop: insets.top }];

  // Not signed in — surface a sign-in CTA (the auth gate also handles this; this
  // is defense in depth so the modal never shows a dead confirmation card).
  if (!isAuthenticated) {
    return (
      <View style={containerStyle}>
        <View style={styles.centered}>
          <Icon name="person" size={40} color={systemColors.secondaryLabel} />
          <Text variant="title3" style={styles.centeredTitle}>
            {t('mobileJoin.signInToJoin')}
          </Text>
          <Button
            title={t('mobileJoin.signInToJoin')}
            variant="filled"
            size="large"
            onPress={() => router.replace('/auth/login')}
          />
        </View>
      </View>
    );
  }

  // Loading the preview.
  if (preview.isLoading) {
    return (
      <View style={containerStyle}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" />
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            {t('mobileJoin.loading')}
          </Text>
        </View>
      </View>
    );
  }

  // Errored — offer a retry.
  if (preview.isError) {
    return (
      <View style={containerStyle}>
        <View style={styles.centered}>
          <Icon name="warning" size={40} color={brandColors.warning} />
          <Text variant="title3" style={styles.centeredTitle}>
            {t('mobileJoin.error')}
          </Text>
          <Button title={t('mobileJoin.retry')} variant="filled" size="large" onPress={() => void preview.refetch()} />
          <Button title={t('mobileJoin.cancel')} variant="text" onPress={() => router.back()} />
        </View>
      </View>
    );
  }

  // Not found (session query resolved to null).
  if (!session) {
    return (
      <View style={containerStyle}>
        <View style={styles.centered}>
          <Icon name="search" size={40} color={systemColors.secondaryLabel} />
          <Text variant="title3" style={styles.centeredTitle}>
            {t('mobileJoin.notFound')}
          </Text>
          <Button title={t('mobileJoin.cancel')} variant="filled" size="large" onPress={() => router.back()} />
        </View>
      </View>
    );
  }

  // Ended.
  if (session.endedAt != null) {
    return (
      <View style={containerStyle}>
        <View style={styles.centered}>
          <Icon name="clock" size={40} color={systemColors.secondaryLabel} />
          <Text variant="title3" style={styles.centeredTitle}>
            {t('mobileJoin.ended')}
          </Text>
          <Button title={t('mobileJoin.cancel')} variant="filled" size="large" onPress={() => router.back()} />
        </View>
      </View>
    );
  }

  // Loaded + active — confirmation card.
  return (
    <View style={[containerStyle, styles.confirmContainer]}>
      <Card style={styles.card}>
        <Text variant="title2" style={styles.cardTitle}>
          {t('mobileJoin.confirmTitle', { host: hostName })}
        </Text>
        <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.boardLabel}>
          {t('mobileJoin.boardLabel', { board: boardLabelFromPath(session.boardPath), count: session.users.length })}
        </Text>

        <View style={styles.avatarRow}>
          {session.users.slice(0, 6).map((sessionUser) => (
            <Avatar key={sessionUser.id} uri={sessionUser.avatarUrl} name={sessionUser.username} size={40} />
          ))}
        </View>

        <View style={styles.buttonColumn}>
          <Button
            title={t('mobileJoin.join')}
            variant="filled"
            size="large"
            loading={isJoining}
            disabled={isJoining}
            onPress={handleJoinPress}
          />
          <Button
            title={t('mobileJoin.cancel')}
            variant="text"
            size="large"
            disabled={isJoining}
            onPress={() => router.back()}
          />
        </View>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  confirmContainer: {
    justifyContent: 'center',
    padding: spacing[4],
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[4],
    padding: spacing[6],
  },
  centeredTitle: {
    textAlign: 'center',
  },
  card: {
    padding: spacing[5],
    borderRadius: borderRadius.xl,
    gap: spacing[3],
  },
  cardTitle: {
    textAlign: 'center',
  },
  boardLabel: {
    textAlign: 'center',
  },
  avatarRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing[2],
    marginVertical: spacing[2],
  },
  buttonColumn: {
    gap: spacing[2],
    marginTop: spacing[2],
  },
});
