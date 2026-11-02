import { useEffect, useRef } from 'react';
import { View, StyleSheet, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Text } from '../../../src/components/Text';
import { Button } from '../../../src/components/Button';
import { Icon } from '../../../src/components/Icon';
import { SessionSummaryContent } from '../../../src/components/session/SessionSummaryContent';
import { useSessionWorkoutView } from '../../../src/components/session/workout/use-session-workout-view';
import { useTheme } from '../../../src/providers/theme-provider';
import { useHeaderActions } from '../../../src/hooks/use-header-actions';
import { useSessionSummary } from '../../../src/lib/graphql/hooks';
import { STORE_REVIEW_PROMPT_DELAY_MS, maybeRequestSessionStoreReview } from '../../../src/lib/store-review';
import { usePostSessionPrompt } from '../../../src/lib/offline-nudges/use-post-session-prompt';
import { spacing } from '../../../src/theme/tokens';

export default function SessionSummaryScreen() {
  const { sessionId, reviewCandidate } = useLocalSearchParams<{ sessionId: string; reviewCandidate?: string }>();
  const { data: summary, isPending, isFetching, isError, refetch } = useSessionSummary(sessionId ?? null);
  // The workout this session was climbed to, if any (#6903). Undefined until the
  // workout data lands, so the recap reads as a plain session.
  const workoutState = useSessionWorkoutView(sessionId);
  const { t } = useTranslation('session');
  const { systemColors, brandColors: brand } = useTheme();
  const router = useRouter();
  // The X closes the modal from the header in every state, loading and error
  // included, so the post-session screen never traps the climber. A close, not
  // a trailing Done: the summary is read-only, there is nothing to commit.
  useHeaderActions({ leading: { kind: 'close', onPress: () => router.back() } });
  const promptedSessionIdRef = useRef<string | null>(null);
  const reviewCandidateParam = Array.isArray(reviewCandidate) ? reviewCandidate[0] : reviewCandidate;

  // One decision for the whole screen: the store review, the offline-download
  // offer, or neither. Resolving it once is what keeps the offline prompt alive
  // on the ≥3-send sessions where the review is merely on cooldown — see
  // usePostSessionPrompt.
  const postSessionPrompt = usePostSessionPrompt(summary, reviewCandidateParam);

  useEffect(() => {
    if (!summary) return undefined;
    if (postSessionPrompt !== 'review') return undefined;
    if (promptedSessionIdRef.current === summary.sessionId) return undefined;

    const timer = setTimeout(() => {
      promptedSessionIdRef.current = summary.sessionId;
      void maybeRequestSessionStoreReview(summary);
    }, STORE_REVIEW_PROMPT_DELAY_MS);

    return () => clearTimeout(timer);
  }, [summary, postSessionPrompt]);

  // Still loading: query hasn't settled yet (first fetch in flight or refetching
  // after a retry). isPending covers the disabled (no sessionId) case too.
  if ((isPending || isFetching) && !summary) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={brand.primary} />
      </View>
    );
  }

  // Settled but unusable: the query errored or resolved to no summary. Without
  // this branch the screen would spin forever with no way out but the back
  // gesture, right at the post-session payoff moment. A failed background
  // refetch keeps the summary already on screen.
  if (!summary) {
    return (
      <View style={[styles.centered, styles.errorContent]}>
        <Icon name="warning" size={40} color={systemColors.secondaryLabel} />
        <Text variant="title3" style={styles.errorTitle}>
          {t('summary.loadErrorTitle')}
        </Text>
        <Text variant="body" color={systemColors.secondaryLabel} style={styles.errorMessage}>
          {t('summary.loadErrorMessage')}
        </Text>
        <View style={styles.errorActions}>
          <Button title={t('summary.retry')} variant="text" onPress={() => void refetch()} />
        </View>
      </View>
    );
  }

  return (
    <SessionSummaryContent
      summary={summary}
      storeReviewWillPrompt={postSessionPrompt !== 'offline'}
      workout={workoutState?.workout}
      pendingTicks={workoutState?.pendingTicks}
      offline={workoutState?.offline}
    />
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorContent: {
    paddingHorizontal: spacing[6],
    gap: spacing[3],
  },
  errorTitle: {
    textAlign: 'center',
  },
  errorMessage: {
    textAlign: 'center',
  },
  errorActions: {
    marginTop: spacing[2],
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
});
