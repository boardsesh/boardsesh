import { memo, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { Platform, StyleSheet, useWindowDimensions, View } from 'react-native';
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
import { LiveDot, useLivePulseDriver } from '../live-sessions/LiveDot';
import { describeLiveNames, elapsedParts, type LiveCardModel } from '../live-sessions/live-session-model';
import { elapsedShort, liveBoardLine, liveCardSpokenLabel, liveNamesCopy } from '../live-sessions/live-session-copy';
import { startedAtKeyFor, useElapsedClock } from '../live-sessions/use-elapsed-clock';
import { useLiveSessionColors } from '../live-sessions/use-live-session-colors';
import { useScopedRouter as useRouter } from '../../lib/routing/scoped-navigation';
import { track } from '../../lib/analytics';
import { useIsAppBackgrounded } from '../../lib/app-visibility';
import { nowMs } from '../../lib/clock';
import { useLatestEndedWorkout } from '../../lib/ended-workout-store';
import { useSessionSummary } from '../../lib/graphql/hooks';
import { useFollowedLiveSessions } from '../../lib/graphql/hooks/use-live-sessions';
import { getCachedDateTimeFormat } from '../../lib/intl-formatter-cache';
import { useStoredUserId } from '../../hooks/use-current-user-id';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useOfflineQueryState } from '../../hooks/use-offline-query-state';
import { hapticLight } from '../../lib/haptics';
import { useQueueSessionId } from '../../providers/queue-provider';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { HomeSectionFrame } from './HomeSectionFrame';
import { lastWorkoutSummary, localDaysAgo } from './last-workout';
import { joinableLiveSessions, joinButtonName, joinButtonTitle, sessionButtonsLayout } from './session-live';

const WEEKDAY: Intl.DateTimeFormatOptions = { weekday: 'long' };
const SHORT_DATE: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
const EMPTY_CARDS: LiveCardModel[] = [];
/** The analytics `surface` for this card, and the join screen's `source`. */
const LIVE_SURFACE = 'home_session_card';

type HomeSessionSectionProps = {
  /** Home's scope for live sessions: the selected board in gym mode, null in crew mode. */
  liveBoardUuid: string | null;
  /** False until Home's scope has settled, so a cold start asks for live sessions once. */
  liveEnabled: boolean;
};

/**
 * "Session" (#7689), one card with three states:
 * - the viewer's own session is running: its timer and Open session;
 * - climbers the viewer follows are live: the first of those sessions, with
 *   Join and Start my own as two equal buttons, and one line for the rest;
 * - otherwise: the last workout this phone ran and one Start a session button.
 * Start goes to the Session tab, where building a workout, End and the stats
 * live: starting a session is how a climber builds a workout.
 *
 * The session id is local, so the card shows with no signal. The timer needs
 * the session's start time from the server and stays hidden until it loads.
 */
export const HomeSessionSection = memo(function HomeSessionSection({
  liveBoardUuid,
  liveEnabled,
}: HomeSessionSectionProps) {
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

  // Button gives its own haptic; the pressable row gives one here.
  const openSessionTab = useCallback(() => {
    router.navigate('/(tabs)/record');
  }, [router]);
  const openRunningSession = useCallback(() => {
    hapticLight();
    track(SHARED_EVENTS.HomeSectionTapped, { section: 'session', target: 'open' });
    openSessionTab();
  }, [openSessionTab]);
  // Once per focus, across the card's own states: the idle card remounts when
  // the viewer's session ends, and that must not count a second view.
  const viewedThisFocusRef = useRef(false);
  useEffect(() => {
    if (!isFocused) viewedThisFocusRef.current = false;
  }, [isFocused]);
  // Counted with the other Start invitations (Climbing now, the board sheet),
  // and with the other Home section taps. `variant` says which state offered it.
  const startSession = useCallback(
    (variant: 'home_session_card' | 'start_my_own') => {
      track(SHARED_EVENTS.StartSessionPromptTapped, { surface: LIVE_SURFACE, variant });
      track(SHARED_EVENTS.HomeSectionTapped, { section: 'session', target: 'start' });
      openSessionTab();
    },
    [openSessionTab],
  );

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
        <IdleSessionCard
          liveBoardUuid={liveBoardUuid}
          liveEnabled={liveEnabled}
          viewedThisFocusRef={viewedThisFocusRef}
          onStart={startSession}
        />
      )}
    </HomeSectionFrame>
  );
});

/**
 * No session of the viewer's own. Asks who the viewer follows is live, only
 * while Home is on screen and the app is in front, and leads with that session
 * when somebody is; otherwise the plain Start card.
 */
const IdleSessionCard = memo(function IdleSessionCard({
  liveBoardUuid,
  liveEnabled,
  viewedThisFocusRef,
  onStart,
}: HomeSessionSectionProps & {
  viewedThisFocusRef: MutableRefObject<boolean>;
  onStart: (variant: 'home_session_card' | 'start_my_own') => void;
}) {
  const router = useRouter();
  const isFocused = useIsFocused();
  const backgrounded = useIsAppBackgrounded();
  const visible = isFocused && !backgrounded;
  // The hook adds the focus gate to `enabled` and to the poll itself.
  const query = useFollowedLiveSessions(liveBoardUuid, liveEnabled && !backgrounded);
  const offline = useOfflineQueryState(query);
  const cards = query.data ?? EMPTY_CARDS;
  const sessions = useMemo(() => joinableLiveSessions(cards), [cards]);

  // "Live Sessions Shelf Viewed" once per focus with settled data, like the rail
  // this card replaces, so the rail's funnel carries on under a new surface.
  const blockedOffline = offline.isBlocked && (offline.reason === 'offline' || offline.reason === 'offline_mode');
  const shelfState: 'loaded' | 'empty' | 'error' | 'offline' | null = !liveEnabled
    ? null
    : blockedOffline
      ? 'offline'
      : offline.isBlocked
        ? 'error'
        : query.status === 'pending'
          ? null
          : sessions.length > 0
            ? 'loaded'
            : 'empty';
  const sessionCount = sessions.length;
  useEffect(() => {
    if (!isFocused || shelfState == null || viewedThisFocusRef.current) return;
    viewedThisFocusRef.current = true;
    track(SHARED_EVENTS.LiveSessionsShelfViewed, { surface: LIVE_SURFACE, count: sessionCount, state: shelfState });
  }, [isFocused, shelfState, sessionCount, viewedThisFocusRef]);

  const openLiveSession = useCallback(
    (card: LiveCardModel, target: 'join' | 'more') => {
      // Join is a Button, which gives its own haptic; a row under "+ N more" is not.
      if (target === 'more') hapticLight();
      track(SHARED_EVENTS.LiveSessionCardTapped, {
        surface: LIVE_SURFACE,
        reason: card.reasons[0] ?? null,
        viewerIsMember: card.viewerIsMember,
        participantCount: card.participantCount,
      });
      track(SHARED_EVENTS.HomeSectionTapped, { section: 'session', target });
      // Never the viewer's own session (`joinableLiveSessions` drops those), so
      // always the join preview.
      router.push({ pathname: '/join/[sessionId]', params: { sessionId: card.sessionId, source: LIVE_SURFACE } });
    },
    [router],
  );
  const handleStartOwn = useCallback(() => onStart('start_my_own'), [onStart]);
  const handleStart = useCallback(() => onStart('home_session_card'), [onStart]);

  if (sessions.length === 0) return <StartSessionCard onStart={handleStart} />;
  return <LiveSessionLead sessions={sessions} visible={visible} onOpen={openLiveSession} onStartOwn={handleStartOwn} />;
});

/**
 * The live state: who, which board, how long, what they are on, then Join and
 * Start my own at equal widths. More sessions sit behind one line under the
 * buttons, which opens them in place, so the buttons never move down the screen.
 */
const LiveSessionLead = memo(function LiveSessionLead({
  sessions,
  visible,
  onOpen,
  onStartOwn,
}: {
  sessions: readonly LiveCardModel[];
  visible: boolean;
  onOpen: (card: LiveCardModel, target: 'join' | 'more') => void;
  onStartOwn: () => void;
}) {
  const { t } = useTranslation('feed');
  const { systemColors } = useTheme();
  const colors = useLiveSessionColors();
  const { formatGrade } = useGradeFormat();
  const { userId } = useStoredUserId(true);
  const viewerUserId = userId ?? null;
  const { fontScale } = useWindowDimensions();
  const [moreOpen, setMoreOpen] = useState(false);

  const clockMs = useElapsedClock(visible, startedAtKeyFor(sessions));
  useLivePulseDriver(visible);

  const [lead, ...rest] = sessions;
  const handleJoin = useCallback(() => {
    if (lead) onOpen(lead, 'join');
  }, [lead, onOpen]);
  const toggleMore = useCallback(() => {
    hapticLight();
    setMoreOpen((open) => !open);
  }, []);
  if (!lead) return null;

  const names = liveNamesCopy(describeLiveNames(lead, viewerUserId), t);
  const elapsed = elapsedParts(lead.startedAtMs, clockMs);
  const boardLine = liveBoardLine(lead, t);
  const climbGrade = lead.currentClimbGrade
    ? (formatGrade(lead.currentClimbGrade, lead.boardType) ?? lead.currentClimbGrade)
    : null;
  const hardestGrade = lead.hardestSendGrade
    ? (formatGrade(lead.hardestSendGrade, lead.boardType) ?? lead.hardestSendGrade)
    : null;
  const climbLine = lead.currentClimbName
    ? climbGrade
      ? t('mobile.liveSessions.onClimbGrade', { climb: lead.currentClimbName, grade: climbGrade })
      : t('mobile.liveSessions.onClimb', { climb: lead.currentClimbName })
    : null;
  const joinName = joinButtonName(lead, viewerUserId);
  const startOwnTitle = t('mobile.home.sections.session.startOwn');
  // Side by side unless the text size or this locale's Start my own would wrap.
  const { stacked: stackButtons, maxLabelLength } = sessionButtonsLayout(fontScale, startOwnTitle);
  const joinTitle = joinButtonTitle(
    joinName,
    (name) => t('mobile.home.sections.session.joinName', { name }),
    t('mobile.liveSessions.actions.join'),
    maxLabelLength,
  );
  // VoiceOver keeps the name the label had to drop. Android's Compose button
  // takes its label from the title only.
  const joinSpoken =
    Platform.OS === 'ios' && joinName ? t('mobile.home.sections.session.joinName', { name: joinName }) : joinTitle;

  return (
    <Card>
      <View style={styles.startCard} testID="home-session-live">
        <View
          style={styles.liveSummary}
          accessible
          accessibilityLabel={liveCardSpokenLabel({ names, card: lead, elapsed, hardestGrade, climbGrade }, t)}
        >
          <View style={styles.liveStatus}>
            <LiveDot color={colors.live} />
            <Text variant="footnote" emphasized color={colors.live}>
              {t('mobile.liveSessions.live')}
            </Text>
            <Text variant="footnote" color={systemColors.secondaryLabel}>
              {`· ${elapsedShort(elapsed, t)}`}
            </Text>
          </View>
          <Text variant="headline" color={systemColors.label} numberOfLines={1} testID="home-session-live-names">
            {names.extra ? `${names.names} ${names.extra}` : names.names}
          </Text>
          {boardLine ? (
            <Text variant="subheadline" color={systemColors.secondaryLabel} numberOfLines={1}>
              {lead.gymName ? `${boardLine} · ${lead.gymName}` : boardLine}
            </Text>
          ) : null}
          {climbLine ? (
            <Text variant="footnote" color={systemColors.secondaryLabel} numberOfLines={1}>
              {climbLine}
            </Text>
          ) : null}
        </View>
        <View style={stackButtons ? styles.buttonsStacked : styles.buttonsRow} testID="home-session-live-buttons">
          <Button
            title={joinTitle}
            accessibilityLabel={joinSpoken}
            variant="filled"
            onPress={handleJoin}
            style={stackButtons ? undefined : styles.equalButton}
            testID="home-session-join"
          />
          <Button
            title={startOwnTitle}
            variant="outlined"
            onPress={onStartOwn}
            style={stackButtons ? undefined : styles.equalButton}
            testID="home-session-start-own"
          />
        </View>
        {rest.length > 0 ? (
          <View>
            <PressableSurface
              onPress={toggleMore}
              feedback="opacity"
              rippleColor={systemColors.label as string}
              accessibilityRole="button"
              accessibilityState={{ expanded: moreOpen }}
              style={styles.moreRow}
              testID="home-session-live-more"
            >
              <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.moreText}>
                {t('mobile.home.sections.session.moreLive', { count: rest.length })}
              </Text>
              <Icon name={moreOpen ? 'chevron.up' : 'chevron.down'} size={14} color={systemColors.tertiaryLabel} />
            </PressableSurface>
            {moreOpen
              ? rest.map((card) => (
                  <MoreLiveRow
                    key={card.sessionId}
                    card={card}
                    clockMs={clockMs}
                    viewerUserId={viewerUserId}
                    onOpen={onOpen}
                  />
                ))
              : null}
          </View>
        ) : null}
      </View>
    </Card>
  );
});

/** One more live session under the "+ N more" line: who, where, how long. Opens its join preview. */
const MoreLiveRow = memo(function MoreLiveRow({
  card,
  clockMs,
  viewerUserId,
  onOpen,
}: {
  card: LiveCardModel;
  clockMs: number;
  viewerUserId: string | null;
  onOpen: (card: LiveCardModel, target: 'join' | 'more') => void;
}) {
  const { t } = useTranslation('feed');
  const { systemColors } = useTheme();
  const names = liveNamesCopy(describeLiveNames(card, viewerUserId), t);
  const elapsed = elapsedParts(card.startedAtMs, clockMs);
  const boardLine = liveBoardLine(card, t);
  const handlePress = useCallback(() => onOpen(card, 'more'), [card, onOpen]);
  const detail = [boardLine, elapsedShort(elapsed, t)].filter((part): part is string => !!part).join(' · ');
  return (
    <PressableSurface
      onPress={handlePress}
      feedback="opacity"
      rippleColor={systemColors.label as string}
      accessibilityRole="button"
      accessibilityLabel={liveCardSpokenLabel({ names, card, elapsed, hardestGrade: null, climbGrade: null }, t)}
      accessibilityHint={t('mobile.liveSessions.a11y.hint')}
      style={styles.moreSessionRow}
      testID="home-session-live-row"
    >
      <View style={styles.moreSessionText}>
        <Text variant="body" color={systemColors.label} numberOfLines={1}>
          {names.extra ? `${names.names} ${names.extra}` : names.names}
        </Text>
        <Text variant="footnote" color={systemColors.secondaryLabel} numberOfLines={1}>
          {detail}
        </Text>
      </View>
      <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} />
    </PressableSurface>
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
  liveSummary: {
    gap: spacing[1],
  },
  liveStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
  },
  buttonsRow: {
    flexDirection: 'row',
    gap: spacing[2],
  },
  buttonsStacked: {
    gap: spacing[2],
  },
  equalButton: {
    flex: 1,
    flexBasis: 0,
  },
  moreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
    minHeight: 44,
  },
  moreText: {
    flexShrink: 1,
  },
  moreSessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    minHeight: 44,
    paddingVertical: spacing[1],
  },
  moreSessionText: {
    flex: 1,
    gap: 2,
  },
});
