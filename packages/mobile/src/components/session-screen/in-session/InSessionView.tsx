import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedScrollHandler,
  useSharedValue,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '../../Button';
import { EndSessionSheet } from '../../EndSessionSheet';
import { useTheme } from '../../../providers/theme-provider';
import { useQueue } from '../../../providers/queue-provider';
import { useSessionScreen } from '../../../providers/session-screen-provider';
import type { SessionDetailTick } from '@boardsesh/shared-schema';
import { useSessionDetail, useSessionSummary } from '../../../lib/graphql/hooks';
import { gradeSortValue } from '../../you/profile-chart-colors';
import { spacing } from '../../../theme/tokens';
import { springs } from '../../../theme/animations';
import { SessionAnalytics, type HardestSend } from './SessionAnalytics';
import { SessionLeaderboard } from './SessionLeaderboard';
import { SessionPresenceRow } from './SessionPresenceRow';

// Drag the sheet down past this fraction of the screen (or flick faster) to
// dismiss; otherwise it springs back. Mirrors the host's open/close thresholds.
const DISMISS_DISTANCE_FRACTION = 0.18;
const DISMISS_VELOCITY = 800;

type InSessionViewProps = {
  /** Host overlay offset (0 = presented). The body pull-to-dismiss drives it. */
  translateY: SharedValue<number>;
  screenHeight: number;
};

export function InSessionView({ translateY, screenHeight }: InSessionViewProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { close } = useSessionScreen();
  const { state, sessionId, liveStats, sessionUsers, driverParticipantId, participantId, endSession } = useQueue();

  // Seed the live view from the full session detail (rich grade split, flashes,
  // per-participant flashes, and the tick list we mine for the hardest climb's
  // NAME). `liveStats` (pushed over the session subscription ~2s after a tick)
  // overlays the seed so aggregates update without polling.
  const detailQuery = useSessionDetail(sessionId ?? undefined);
  const detail = detailQuery.data;

  // Only trust a live push that belongs to the CURRENT session. After a direct
  // A→B session switch the provider resets liveStats, but this guards the window
  // (and any late A push) so we never attribute the previous session's numbers
  // to this one.
  const live = liveStats && liveStats.sessionId === sessionId ? liveStats : null;

  // startedAt isn't carried by the live push, so the ticking timer reads it from
  // a single (non-polled) summary query.
  const summaryQuery = useSessionSummary(sessionId);
  const startedAt = summaryQuery.data?.startedAt ?? null;

  // A new hardest grade arriving over the live push won't carry the climb NAME
  // (the push has aggregates only). Refresh the detail so detail.ticks gains the
  // tick whose climbName we surface in the celebration card.
  const liveHardestGrade = live?.hardestGrade ?? null;
  useEffect(() => {
    if (!sessionId || !liveHardestGrade) return;
    void queryClient.invalidateQueries({ queryKey: ['sessionDetail', sessionId] });
  }, [sessionId, liveHardestGrade, queryClient]);

  // Live push takes precedence over the seed for every aggregate.
  const sends = live?.totalSends ?? detail?.totalSends ?? 0;
  const flashes = live?.totalFlashes ?? detail?.totalFlashes ?? 0;
  const gradeDistribution = live?.gradeDistribution ?? detail?.gradeDistribution ?? [];
  const participants = live?.participants ?? detail?.participants ?? [];
  const hardestGrade = live?.hardestGrade ?? detail?.hardestGrade ?? null;

  const isMultiUser = participants.length > 1;

  // Hardest send(s) to celebrate. Solo: the session's single hardest (grade from
  // the aggregate, climb name mined from the tick list). Party: each climber's
  // own hardest send, hardest first, so everyone's effort shows with their face.
  const hardestSends = useMemo<HardestSend[]>(() => {
    const sends = (detail?.ticks ?? []).filter((tick) => tick.status !== 'attempt');
    if (!isMultiUser) {
      if (!hardestGrade) return [];
      let bestName: string | null = null;
      let bestDifficulty = -Infinity;
      for (const tick of sends) {
        const difficulty = tick.difficulty ?? -Infinity;
        if (difficulty > bestDifficulty) {
          bestDifficulty = difficulty;
          bestName = tick.climbName ?? null;
        }
      }
      return [{ grade: hardestGrade, climbName: bestName }];
    }
    const bestByUser = new Map<string, SessionDetailTick>();
    for (const tick of sends) {
      const current = bestByUser.get(tick.userId);
      if (!current || (tick.difficulty ?? -Infinity) > (current.difficulty ?? -Infinity)) {
        bestByUser.set(tick.userId, tick);
      }
    }
    return [...bestByUser.entries()]
      .map(([userId, tick]) => {
        const participant = participants.find((entry) => entry.userId === userId);
        return {
          userId,
          displayName: participant?.displayName ?? null,
          avatarUrl: participant?.avatarUrl ?? null,
          grade: tick.difficultyName ?? '',
          climbName: tick.climbName,
        };
      })
      .filter((entry) => entry.grade)
      .sort((a, b) => gradeSortValue(b.grade) - gradeSortValue(a.grade));
  }, [detail?.ticks, participants, isMultiUser, hardestGrade]);

  // Our own database user id (for the "you" highlight in the leaderboard).
  // Undefined when we can't resolve it — the leaderboard handles that.
  const selfUserId = useMemo(
    () => sessionUsers.find((user) => user.id === participantId)?.userId ?? null,
    [sessionUsers, participantId],
  );

  // Swipe-down-to-dismiss from the body. Drag the sheet only when the inner
  // scroll is at the top and the pull is downward; otherwise the scroll handles
  // it (the two run simultaneously). Drives the host's translateY, and on
  // release either dismisses (close) or springs back to fully presented.
  const scrollOffset = useSharedValue(0);
  const startedAtTop = useSharedValue(true);
  const scrollHandler = useAnimatedScrollHandler((event) => {
    scrollOffset.value = event.contentOffset.y;
  });
  const scrollGesture = useMemo(() => Gesture.Native(), []);
  const dismissGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY(12)
        .onStart(() => {
          startedAtTop.value = scrollOffset.value <= 0;
        })
        .onUpdate((event) => {
          if (startedAtTop.value && event.translationY > 0) {
            translateY.value = event.translationY;
          }
        })
        .onEnd((event) => {
          if (!startedAtTop.value) return;
          if (translateY.value > screenHeight * DISMISS_DISTANCE_FRACTION || event.velocityY > DISMISS_VELOCITY) {
            runOnJS(close)();
          } else {
            translateY.value = withSpring(0, springs.gentle);
          }
        })
        .simultaneousWithExternalGesture(scrollGesture),
    [translateY, screenHeight, close, scrollOffset, startedAtTop, scrollGesture],
  );

  const [showEndSession, setShowEndSession] = useState(false);
  const [isEnding, setIsEnding] = useState(false);

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
    <GestureDetector gesture={dismissGesture}>
      <View style={styles.container}>
        <GestureDetector gesture={scrollGesture}>
          <Animated.ScrollView
            style={styles.scroll}
            contentContainerStyle={[styles.content, { paddingBottom: 100 + insets.bottom }]}
            showsVerticalScrollIndicator={false}
            onScroll={scrollHandler}
            scrollEventThrottle={16}
            // No bounce: a downward pull at the top should move the sheet (our
            // pan), not bounce the scroll view underneath it.
            bounces={false}
          >
            <SessionPresenceRow
              users={sessionUsers}
              driverParticipantId={driverParticipantId}
              selfParticipantId={participantId}
            />

            <SessionAnalytics
              sends={sends}
              flashes={flashes}
              hardestGrade={hardestGrade}
              hardestSends={hardestSends}
              startedAt={startedAt}
              gradeDistribution={gradeDistribution}
            />

            <SessionLeaderboard
              participants={participants}
              driverParticipantId={driverParticipantId}
              selfUserId={selfUserId}
            />
          </Animated.ScrollView>
        </GestureDetector>

        <View
          style={[
            styles.footer,
            { backgroundColor: systemColors.background, paddingBottom: insets.bottom + spacing[3] },
          ]}
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
          climbCount={state.queue.length}
        />
      </View>
    </GestureDetector>
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
  footer: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
  },
});
