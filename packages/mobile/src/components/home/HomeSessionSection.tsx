import { memo, useCallback, useMemo } from 'react';
import { View } from 'react-native';
import { useIsFocused } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { ArtRow } from '../ArtRow';
import { Icon } from '../Icon';
import { InsetGroupedList, insetGroupedRowStyles } from '../InsetGroupedList';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { SessionTimer } from '../session-screen/in-session/SessionTimer';
import { useScopedRouter as useRouter } from '../../lib/routing/scoped-navigation';
import { track } from '../../lib/analytics';
import { useIsAppBackgrounded } from '../../lib/app-visibility';
import { useSessionSummary } from '../../lib/graphql/hooks';
import { hapticLight } from '../../lib/haptics';
import { useQueueSessionId } from '../../providers/queue-provider';
import { useTheme } from '../../providers/theme-provider';
import { HomeSectionFrame } from './HomeSectionFrame';

/**
 * "Session": Start a session, or the running session's timer and Open session.
 * Both go to the Session tab, where workouts, End and the stats live.
 *
 * The session id is local, so the card shows with no signal. The timer needs
 * the session's start time from the server and stays hidden until it loads.
 */
export const HomeSessionSection = memo(function HomeSessionSection() {
  const { t } = useTranslation('feed');
  const { t: tCommon } = useTranslation('common');
  const router = useRouter();
  const { systemColors, brandColors } = useTheme();
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
  // Counted with the other Start invitations (Climbing now, the board sheet).
  const startSession = useCallback(() => {
    track(SHARED_EVENTS.StartSessionPromptTapped, { surface: 'home_session_card', variant: 'home_session_card' });
    openSessionTab();
  }, [openSessionTab]);

  const recordIcon = useMemo(() => <Icon name="record" size={24} color={brandColors.primary} />, [brandColors.primary]);
  const startTitle = t('mobile.home.sections.session.startTitle');
  const startBody = t('mobile.home.sections.session.startBody');

  return (
    <HomeSectionFrame title={tCommon('mobile.settings.homeSections.sections.session')} testID="home-section-session">
      <InsetGroupedList>
        {sessionId ? (
          <View style={insetGroupedRowStyles.row} accessible>
            <View style={insetGroupedRowStyles.leading}>{recordIcon}</View>
            <View style={insetGroupedRowStyles.text}>
              <Text variant="footnote" color={systemColors.secondaryLabel}>
                {t('mobile.home.sections.session.running')}
              </Text>
              {timerTicking ? <SessionTimer startedAt={startedAt} /> : null}
            </View>
          </View>
        ) : null}
        {sessionId ? (
          <PressableSurface
            onPress={openSessionTab}
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
        ) : (
          <ArtRow
            art={recordIcon}
            artSize="regular"
            title={startTitle}
            subtitle={startBody}
            accessory="chevron"
            onPress={startSession}
            accessibilityLabel={[startTitle, startBody].join(', ')}
            testID="home-session-start"
          />
        )}
      </InsetGroupedList>
    </HomeSectionFrame>
  );
});
