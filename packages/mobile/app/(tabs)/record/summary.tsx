import { useEffect, useMemo, useRef } from 'react';
import { View, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming } from 'react-native-reanimated';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { SessionSummary } from '@boardsesh/shared-schema';
import { Text } from '../../../src/components/Text';
import { Button } from '../../../src/components/Button';
import { Avatar } from '../../../src/components/Avatar';
import { AvatarGroup } from '../../../src/components/you/AvatarGroup';
import { Card } from '../../../src/components/Card';
import { Icon } from '../../../src/components/Icon';
import { SectionHeader } from '../../../src/components/SectionHeader';
import { Separator } from '../../../src/components/Separator';
import { ClimbListThumbnail } from '../../../src/components/ClimbListThumbnail';
import { StatTile, GradeTile } from '../../../src/components/session/session-stat-tiles';
import { StackedBarChart } from '../../../src/components/you/YouCharts';
import { buildSessionGradeBars, gradeBadgeColor } from '../../../src/components/you/profile-chart-colors';
import { useTheme } from '../../../src/providers/theme-provider';
import { useSessionSummary } from '../../../src/lib/graphql/hooks';
import { useGradeFormat } from '../../../src/hooks/use-grade-format';
import { getBoardConfigForPlaylist } from '../../../src/lib/playlists/board-details-for-playlist';
import { formatSessionWhen } from '../../../src/lib/format-session-when';
import { SaveToAppleHealthButton } from '../../../src/components/integrations/SaveToAppleHealthButton';
import { ShareToStravaButton } from '../../../src/components/integrations/ShareToStravaButton';
import { springs, timing } from '../../../src/theme/animations';
import { hapticSuccess } from '../../../src/lib/haptics';
import {
  SESSION_STORE_REVIEW_CANDIDATE_PARAM,
  STORE_REVIEW_PROMPT_DELAY_MS,
  isSessionStoreReviewEligible,
  maybeRequestSessionStoreReview,
} from '../../../src/lib/store-review';
import { spacing } from '../../../src/theme/tokens';

type TFunc = (key: string, opts?: Record<string, unknown>) => string;

function formatDuration(minutes: number | null | undefined, t: TFunc): string {
  if (!minutes || minutes <= 0) return '';
  if (minutes < 60) return t('summary.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  const remainingMins = minutes % 60;
  if (remainingMins === 0) return t('summary.hours', { count: hours });
  return t('summary.hoursAndMinutes', { hours, mins: remainingMins });
}

/** Count-based celebratory headline. Deterministic, no historical lookup. */
function heroHeadline(isParty: boolean, totalSends: number, t: TFunc): string {
  if (isParty) return t('summary.heroCrewSession');
  if (totalSends === 0) return t('summary.heroLoggedWork');
  if (totalSends >= 5) return t('summary.heroCrushedIt');
  return t('summary.heroNiceSession');
}

export default function SessionSummaryScreen() {
  const { sessionId, reviewCandidate } = useLocalSearchParams<{ sessionId: string; reviewCandidate?: string }>();
  const { data: summary, isPending, isFetching, isError, refetch } = useSessionSummary(sessionId ?? null);
  const { t } = useTranslation('session');
  const { systemColors, brandColors: brand } = useTheme();
  const router = useRouter();
  const promptedSessionIdRef = useRef<string | null>(null);
  const reviewCandidateParam = Array.isArray(reviewCandidate) ? reviewCandidate[0] : reviewCandidate;

  useEffect(() => {
    if (!summary) return undefined;
    if (reviewCandidateParam !== SESSION_STORE_REVIEW_CANDIDATE_PARAM) return undefined;
    if (!isSessionStoreReviewEligible(summary)) return undefined;
    if (promptedSessionIdRef.current === summary.sessionId) return undefined;

    const timer = setTimeout(() => {
      promptedSessionIdRef.current = summary.sessionId;
      void maybeRequestSessionStoreReview(summary);
    }, STORE_REVIEW_PROMPT_DELAY_MS);

    return () => clearTimeout(timer);
  }, [summary, reviewCandidateParam]);

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
  // gesture, right at the post-session payoff moment.
  if (isError || !summary) {
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
          <Button title={t('summary.done')} variant="filled" onPress={() => router.back()} />
        </View>
      </View>
    );
  }

  return <SessionSummaryContent summary={summary} />;
}

/**
 * The loaded recap. Split out so the celebration animation hooks mount fresh
 * with a settled summary (no conditional hooks behind the loading/error gates).
 * Mirrors the session-detail screen — hero, hardest-send card, the shared
 * stat tiles, and the same grade chart — so the post-session payoff feels like
 * the rest of the app.
 */
function SessionSummaryContent({ summary }: { summary: SessionSummary }) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { formatGrade } = useGradeFormat();

  const participants = summary.participants;
  const isParty = participants.length > 1;
  const totalSends = summary.totalSends;
  const totalFlashes = summary.totalFlashes;
  const totalAttempts = summary.totalAttempts;
  const hasSends = totalSends > 0;

  const when = summary.endedAt ?? summary.startedAt ?? null;
  const duration = formatDuration(summary.durationMinutes, t);
  const whenLine = [when ? formatSessionWhen(when, t) : '', duration].filter(Boolean).join(' · ');

  const headline = heroHeadline(isParty, totalSends, t);
  const featuredValue = hasSends ? totalSends : totalAttempts;
  const featuredLabel = hasSends
    ? t('summary.featuredSendsLabel', { count: totalSends })
    : t('summary.featuredAttemptsLabel', { count: totalAttempts });

  const hardest = summary.hardestClimb ?? null;
  // Resolve sizeId/setIds (and boardName) from boardType + layoutId, the same
  // way the session-detail rows do. Null → no thumbnail (legacy climb / board
  // the bundled-asset path can't render), so the card falls back to grade-only.
  const thumbConfig =
    hardest?.frames && hardest.boardType ? getBoardConfigForPlaylist(hardest.boardType, hardest.layoutId) : null;

  const gradeBars = useMemo(
    () => buildSessionGradeBars(summary.gradeDistribution, formatGrade),
    [summary.gradeDistribution, formatGrade],
  );

  // Celebration: the featured number springs in, and a single success haptic
  // fires on a sending day. The tiles rise in just after. Reanimated only — no
  // confetti dependency. Mounts once (this component renders with a fixed
  // summary), so the haptic fires exactly once.
  const heroScale = useSharedValue(0.85);
  const heroOpacity = useSharedValue(0);
  const tilesOpacity = useSharedValue(0);
  const tilesTranslate = useSharedValue(12);

  useEffect(() => {
    heroOpacity.value = withTiming(1, { duration: timing.normal });
    heroScale.value = withSpring(1, springs.bouncy);
    tilesOpacity.value = withDelay(timing.fast, withTiming(1, { duration: timing.normal }));
    tilesTranslate.value = withDelay(timing.fast, withSpring(0, springs.gentle));
    if (hasSends) hapticSuccess();
  }, [hasSends, heroOpacity, heroScale, tilesOpacity, tilesTranslate]);

  const heroAnimStyle = useAnimatedStyle(() => ({
    opacity: heroOpacity.value,
    transform: [{ scale: heroScale.value }],
  }));
  const tilesAnimStyle = useAnimatedStyle(() => ({
    opacity: tilesOpacity.value,
    transform: [{ translateY: tilesTranslate.value }],
  }));

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing[6] }]}
    >
      {/* Hero — the payoff moment */}
      <View style={styles.hero}>
        {whenLine ? (
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {whenLine}
          </Text>
        ) : null}
        {isParty ? <AvatarGroup participants={participants} size={36} /> : null}
        <Text variant="title1" style={styles.headline}>
          {headline}
        </Text>
        <Animated.View style={[styles.featured, heroAnimStyle]}>
          <Text variant="largeTitle" style={styles.featuredValue}>
            {featuredValue}
          </Text>
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            {featuredLabel}
          </Text>
        </Animated.View>
      </View>

      {/* Hardest send — a real achievement card with a board thumbnail */}
      {hardest ? (
        <Card>
          <View style={styles.hardestRow}>
            {thumbConfig ? (
              <ClimbListThumbnail
                frames={hardest.frames ?? ''}
                boardName={thumbConfig.boardName}
                layoutId={thumbConfig.layoutId}
                sizeId={thumbConfig.sizeId}
                setIds={thumbConfig.setIds.join(',')}
                mirrored={hardest.isMirror ?? false}
                size={{ width: 64, height: 82 }}
              />
            ) : null}
            <View style={styles.hardestInfo}>
              <Text variant="caption1" color={systemColors.secondaryLabel}>
                {t('summary.hardestSendTitle')}
              </Text>
              <Text variant="title2" color={gradeBadgeColor(hardest.grade)} style={styles.hardestGrade}>
                {formatGrade(hardest.grade) ?? hardest.grade}
              </Text>
              <Text variant="body" numberOfLines={1}>
                {hardest.climbName}
              </Text>
            </View>
          </View>
        </Card>
      ) : !hasSends ? (
        <Card style={styles.effortCard}>
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {t('summary.effortTitle')}
          </Text>
          <Text variant="body">{t('summary.effortBody')}</Text>
        </Card>
      ) : null}

      {/* Stat tiles — same Sends · Flashes · Attempts · Hardest as the detail card */}
      <Animated.View style={[styles.tiles, tilesAnimStyle]}>
        <StatTile value={totalSends} label={t('summary.sends')} icon="tick" />
        <StatTile value={totalFlashes} label={t('summary.flashes')} icon="flash" />
        <StatTile value={totalAttempts} label={t('summary.attempts')} icon="circle" />
        {hardest ? <GradeTile grade={hardest.grade} /> : null}
      </Animated.View>

      {/* Grade distribution — the canonical chart used on the session-detail screen */}
      {gradeBars ? (
        <View style={styles.section}>
          <SectionHeader title={t('summary.gradeDistribution')} />
          <Card>
            <StackedBarChart bars={gradeBars} colorBy="grade" fitYAxisToData />
          </Card>
        </View>
      ) : null}

      {/* Crew — only meaningful with more than one climber */}
      {isParty ? (
        <View style={styles.section}>
          <SectionHeader title={t('summary.crew')} />
          {participants.map((participant, index) => (
            <View key={participant.userId}>
              <View style={styles.participantRow}>
                <Avatar uri={participant.avatarUrl} name={participant.displayName} size={36} />
                <View style={styles.participantInfo}>
                  <Text variant="body" numberOfLines={1}>
                    {participant.displayName ?? t('detail.climberFallback')}
                  </Text>
                  <Text variant="caption1" color={systemColors.secondaryLabel}>
                    {t('summary.crewStatLine', {
                      sends: participant.sends,
                      flashes: participant.flashes,
                      attempts: participant.attempts,
                    })}
                  </Text>
                </View>
              </View>
              {index < participants.length - 1 ? <Separator /> : null}
            </View>
          ))}
        </View>
      ) : null}

      {/* Goal */}
      {summary.goal ? (
        <Card style={styles.goalCard}>
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {t('summary.goal')}
          </Text>
          <Text variant="body">{summary.goal}</Text>
        </Card>
      ) : null}

      {/* External integration actions: save this session to Apple Health / share
          to Strava. Each renders only when applicable (iOS / connected account). */}
      <View style={styles.integrationActions}>
        <SaveToAppleHealthButton summary={summary} />
        <ShareToStravaButton sessionId={summary.sessionId} />
      </View>

      {/* Done button */}
      <Button title={t('summary.done')} variant="filled" onPress={() => router.back()} style={styles.doneButton} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: spacing[4],
    gap: spacing[5],
  },
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
  hero: {
    alignItems: 'center',
    gap: spacing[2],
  },
  headline: {
    textAlign: 'center',
  },
  featured: {
    alignItems: 'center',
    marginTop: spacing[1],
  },
  featuredValue: {
    fontWeight: '700',
  },
  hardestRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  hardestInfo: {
    flex: 1,
    gap: spacing[1],
  },
  hardestGrade: {
    fontWeight: '700',
  },
  effortCard: {
    gap: spacing[1],
  },
  section: {
    gap: spacing[2],
  },
  tiles: {
    flexDirection: 'row',
    gap: spacing[2],
  },
  participantRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingVertical: spacing[2],
  },
  participantInfo: {
    flex: 1,
    gap: 2,
  },
  goalCard: {
    gap: spacing[1],
  },
  integrationActions: {
    gap: spacing[3],
  },
  doneButton: {
    marginTop: spacing[2],
  },
});
