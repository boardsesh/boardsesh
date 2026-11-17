import { memo, useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useIsFocused } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { workoutMainBlocksText } from '@boardsesh/workout-summary';
import { Button } from '../Button';
import { Card } from '../Card';
import { Icon } from '../Icon';
import { InsetGroupedList, insetGroupedRowStyles } from '../InsetGroupedList';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { SessionTimer } from '../session-screen/in-session/SessionTimer';
import { useScopedRouter as useRouter } from '../../lib/routing/scoped-navigation';
import { track } from '../../lib/analytics';
import { useIsAppBackgrounded } from '../../lib/app-visibility';
import { nowMs } from '../../lib/clock';
import { useLatestEndedWorkout } from '../../lib/ended-workout-store';
import { useSessionSummary } from '../../lib/graphql/hooks';
import { getCachedDateTimeFormat } from '../../lib/intl-formatter-cache';
import { useStoredUserId } from '../../hooks/use-current-user-id';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { hapticLight } from '../../lib/haptics';
import { useQueueSessionId } from '../../providers/queue-provider';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { HomeSectionFrame } from './HomeSectionFrame';
import { lastWorkoutSummary, localDaysAgo } from './last-workout';

const WEEKDAY: Intl.DateTimeFormatOptions = { weekday: 'long' };
const SHORT_DATE: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };

/**
 * "Session": the last workout this phone ran and one Start a session button
 * (#7689), or the running session's timer and Open session. Both go to the
 * Session tab, where building a workout, End and the stats live: starting a
 * session is how a climber builds a workout, so the card has no second button.
 *
 * The session id is local, so the card shows with no signal. The timer needs
 * the session's start time from the server and stays hidden until it loads.
 */
export const HomeSessionSection = memo(function HomeSessionSection() {
  const { t } = useTranslation('feed');
  const { t: tCommon } = useTranslation('common');
  const router = useRouter();
  const { systemColors } = useTheme();
  const { sessionId } = useQueueSessionId();
  // The Session tab's own query key, so the two share one cached answer.
  const summaryQuery = useSessionSummary(sessionId);
  const startedAt = summaryQuery.data?.startedAt ?? null;
  // The timer ticks only while Home is on screen.
  const isFocused = useIsFocused();
  const backgrounded = useIsAppBackgrounded();
  const timerTicking = isFocused && !backgrounded;

  const openSessionTab = useCallback(() => {
    hapticLight();
    router.navigate('/(tabs)/record');
  }, [router]);
  const openRunningSession = useCallback(() => {
    track(SHARED_EVENTS.HomeSectionTapped, { section: 'session', target: 'open' });
    openSessionTab();
  }, [openSessionTab]);
  // Counted with the other Start invitations (Climbing now, the board sheet),
  // and with the other Home section taps.
  const startSession = useCallback(() => {
    track(SHARED_EVENTS.StartSessionPromptTapped, { surface: 'home_session_card', variant: 'home_session_card' });
    track(SHARED_EVENTS.HomeSectionTapped, { section: 'session', target: 'start' });
    openSessionTab();
  }, [openSessionTab]);

  const recordIcon = useMemo(() => <Icon name="record" size={24} color={systemColors.accent} />, [systemColors.accent]);

  return (
    <HomeSectionFrame title={tCommon('mobile.settings.homeSections.sections.session')} testID="home-section-session">
      {sessionId ? (
        <InsetGroupedList>
          <View style={insetGroupedRowStyles.row} accessible>
            <View style={insetGroupedRowStyles.leading}>{recordIcon}</View>
            <View style={insetGroupedRowStyles.text}>
              <Text variant="footnote" color={systemColors.secondaryLabel}>
                {t('mobile.home.sections.session.running')}
              </Text>
              {timerTicking ? <SessionTimer startedAt={startedAt} /> : null}
            </View>
          </View>
          <PressableSurface
            onPress={openRunningSession}
            feedback="opacity"
            rippleColor={systemColors.label as string}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.home.sections.session.open')}
            style={insetGroupedRowStyles.row}
            testID="home-session-open"
          >
            <View style={insetGroupedRowStyles.leading}>
              <Icon name="play.circle" size={20} color={systemColors.secondaryLabel} />
            </View>
            <Text variant="body" color={systemColors.label} style={insetGroupedRowStyles.text}>
              {t('mobile.home.sections.session.open')}
            </Text>
            <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} />
          </PressableSurface>
        </InsetGroupedList>
      ) : (
        <StartSessionCard onStart={startSession} />
      )}
    </HomeSectionFrame>
  );
});

/**
 * No session running: the last workout this phone ran, when there is one, then
 * Start a session. Without a workout it says what starting offers instead.
 */
const StartSessionCard = memo(function StartSessionCard({ onStart }: { onStart: () => void }) {
  const { t, i18n } = useTranslation('feed');
  const { t: tSession } = useTranslation('session');
  const { systemColors } = useTheme();
  const { formatGradeByDifficultyId } = useGradeFormat();
  const { userId } = useStoredUserId(true);
  const recap = useLatestEndedWorkout(userId);
  const summary = useMemo(
    () => (recap ? lastWorkoutSummary(recap, formatGradeByDifficultyId) : null),
    [recap, formatGradeByDifficultyId],
  );

  const locale = i18n.language;
  let whenLabel: string | null = null;
  let detail: string | null = null;
  if (summary) {
    const daysAgo = localDaysAgo(summary.endedAtMs, nowMs());
    const ended = new Date(summary.endedAtMs);
    whenLabel =
      daysAgo <= 0
        ? t('mobile.home.sections.session.lastWorkoutToday')
        : daysAgo === 1
          ? t('mobile.home.sections.session.lastWorkoutYesterday')
          : t('mobile.home.sections.session.lastWorkoutOn', {
              day: getCachedDateTimeFormat(locale, daysAgo < 7 ? WEEKDAY : SHORT_DATE).format(ended),
            });
    detail =
      [
        workoutMainBlocksText(summary.headline, tSession),
        summary.sends > 0 ? t('mobile.home.sections.session.lastWorkoutSends', { count: summary.sends }) : null,
      ]
        .filter((part): part is string => !!part)
        .join(' · ') || null;
  }

  return (
    <Card>
      <View style={styles.startCard}>
        {summary ? (
          <View style={styles.lastWorkout} accessible testID="home-session-last-workout">
            <Text variant="footnote" color={systemColors.secondaryLabel}>
              {whenLabel}
            </Text>
            {detail ? (
              <Text variant="body" color={systemColors.label}>
                {detail}
              </Text>
            ) : null}
          </View>
        ) : (
          <Text variant="body" color={systemColors.secondaryLabel}>
            {t('mobile.home.sections.session.startBody')}
          </Text>
        )}
        <Button
          title={t('mobile.home.sections.session.startTitle')}
          variant="filled"
          icon="record"
          onPress={onStart}
          testID="home-session-start"
        />
      </View>
    </Card>
  );
});

const styles = StyleSheet.create({
  startCard: {
    gap: spacing[3],
  },
  lastWorkout: {
    gap: spacing[1],
  },
});
