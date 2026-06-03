import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { BoardName } from '@boardsesh/shared-schema';
import { Text } from '../../Text';
import { Button } from '../../Button';
import { ActivityIndicator } from '../../ActivityIndicator';
import { QueueItemRow, type QueueItemRowBoard } from '../../QueueItemRow';
import { EndSessionSheet } from '../../EndSessionSheet';
import { useTheme } from '../../../providers/theme-provider';
import { useQueue } from '../../../providers/queue-provider';
import { useDrawerHost } from '../../../providers/drawer-host-provider';
import { useSessionScreen } from '../../../providers/session-screen-provider';
import { useSessionSummary } from '../../../lib/graphql/hooks';
import { spacing, borderRadius } from '../../../theme/tokens';
import { SessionStatsHeader } from './SessionStatsHeader';

const SUMMARY_POLL_INTERVAL_MS = 15_000;

export function InSessionView() {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { close } = useSessionScreen();
  const { boardConfig } = useDrawerHost();
  const { state, sessionId, setCurrentClimb, removeFromQueue, endSession } = useQueue();

  const board: QueueItemRowBoard | null = boardConfig
    ? {
        boardName: boardConfig.boardName as BoardName,
        layoutId: boardConfig.layoutId,
        sizeId: boardConfig.sizeId,
        setIds: boardConfig.setIds,
        angle: boardConfig.angle,
      }
    : null;

  // Live summary: same query as the post-session view, just polled while the
  // overlay is open so the live tiles stay current as the user logs ticks.
  const summaryQuery = useSessionSummary(sessionId);
  const refetchSummary = summaryQuery.refetch;
  useEffect(() => {
    if (!sessionId) return;
    const id = setInterval(() => {
      void refetchSummary();
    }, SUMMARY_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [sessionId, refetchSummary]);

  const [showEndSession, setShowEndSession] = useState(false);
  const [isEnding, setIsEnding] = useState(false);

  const { queue, currentClimbQueueItem } = state;
  const currentUuid = currentClimbQueueItem?.uuid;

  const handlePressItem = useCallback((item: ClimbQueueItem) => setCurrentClimb(item), [setCurrentClimb]);
  const handleRemoveItem = useCallback((uuid: string) => removeFromQueue(uuid), [removeFromQueue]);

  const handleConfirmEnd = useCallback(async () => {
    setIsEnding(true);
    const summary = await endSession();
    setIsEnding(false);
    setShowEndSession(false);
    if (summary) {
      // Close the overlay before pushing the summary so the modal-presented
      // summary route lands on a stable underlying tab.
      close();
      router.push({ pathname: '/(tabs)/record/summary', params: { sessionId: summary.sessionId } });
    }
  }, [endSession, close, router]);

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: 100 + insets.bottom }]}
        showsVerticalScrollIndicator={false}
      >
        <SessionStatsHeader summary={summaryQuery.data ?? null} />

        <View style={styles.queueSection}>
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.sectionLabel}>
            {t('mobile.session.inQueueTitle')}
          </Text>
          {queue.length === 0 ? (
            <View style={[styles.emptyCard, { backgroundColor: systemColors.secondaryBackground }]}>
              <Text variant="body" color={systemColors.secondaryLabel}>
                {t('mobile.session.inQueueEmpty')}
              </Text>
            </View>
          ) : !board ? (
            // Items exist but the active board (for thumbnails) is still
            // resolving — show a spinner rather than a misleading empty state.
            <View style={[styles.emptyCard, { backgroundColor: systemColors.secondaryBackground }]}>
              <ActivityIndicator />
            </View>
          ) : (
            queue.map((item, index) => (
              <QueueItemRow
                key={item.uuid}
                item={item}
                position={index + 1}
                board={board}
                isCurrentClimb={currentUuid === item.uuid}
                onPress={handlePressItem}
                onRemove={handleRemoveItem}
              />
            ))
          )}
        </View>
      </ScrollView>

      <View
        style={[styles.footer, { backgroundColor: systemColors.background, paddingBottom: insets.bottom + spacing[3] }]}
      >
        <Button
          title={t('mobile.session.inEndSession')}
          onPress={() => setShowEndSession(true)}
          variant="outlined"
          size="large"
        />
      </View>

      <EndSessionSheet
        visible={showEndSession}
        onDismiss={() => setShowEndSession(false)}
        onConfirm={() => void handleConfirmEnd()}
        isEnding={isEnding}
        climbCount={queue.length}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    gap: spacing[5],
  },
  queueSection: {
    gap: spacing[2],
  },
  sectionLabel: {
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  emptyCard: {
    padding: spacing[4],
    borderRadius: borderRadius.lg,
    alignItems: 'center',
  },
  footer: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
  },
});
