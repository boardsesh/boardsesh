import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { useTranslation } from 'react-i18next';
import type BottomSheet from '@gorhom/bottom-sheet';
import type { SessionDetailTick, SessionFeedParticipant, SocialEntityType } from '@boardsesh/shared-schema';
import { formatTickAbsoluteTime } from '@boardsesh/profile-stats';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { ActivityIndicator } from '../ActivityIndicator';
import { SectionHeader } from '../SectionHeader';
import { CommentSheet } from '../you/CommentSheet';
import { SessionSummaryCard } from './SessionSummaryCard';
import { SessionAnalyticsSection } from './SessionAnalyticsSection';
import { SessionBetaCarousel } from './SessionBetaCarousel';
import { SessionLeaderboard } from './SessionLeaderboard';
import { SessionTickRow } from './SessionTickRow';
import { useSessionDetail, useBulkVoteSummaries } from '../../lib/graphql/hooks';
import { openClimbInPlayDrawer } from '../../lib/open-climb-in-play-drawer';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

// Hoisted so FlashList gets a stable reference across renders.
const keyExtractor = (tick: SessionDetailTick) => tick.uuid;

/**
 * Session detail — hero + stats + ticks list. Mounted from a per-tab route
 * (`home/session/[sessionId]`, `profile/session/[sessionId]`) so it pushes inside
 * the tab stack and keeps the native tab bar + Liquid Glass bottom accessory on
 * screen (matching the playlist detail view), rather than a root push that slides
 * the tab bar away.
 */
export default function SessionDetailScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const navigation = useNavigation();
  const router = useRouter();
  const { openPlayDrawer } = useDrawerHost();
  const bottomChrome = useBottomChromeMetrics();
  // floatingControlBottom (not scrollBottomPadding) reserves the iOS-26 native
  // accessory — the now-playing bar — so the last sends clear it instead of
  // hiding behind it.
  const paddingBottom = bottomChrome.floatingControlBottom + spacing[6];

  const { data: session, isPending } = useSessionDetail(sessionId);
  const { data: voteSummaries } = useBulkVoteSummaries('session', sessionId ? [sessionId] : [], !!sessionId);
  const sessionVoteSummary = voteSummaries?.[0];

  const commentSheetRef = useRef<BottomSheet | null>(null);
  const [commentTarget, setCommentTarget] = useState<{ entityId: string; entityType: SocialEntityType } | null>(null);

  // Session name, falling back to a generated "<date>" label when unnamed.
  const title = useMemo(() => {
    if (!session) return '';
    if (session.sessionName) return session.sessionName;
    return formatTickAbsoluteTime(session.lastTickAt, 'MMM D, YYYY');
  }, [session]);

  const isMultiUser = (session?.participants.length ?? 0) > 1;
  const participantById = useMemo(() => {
    const map = new Map<string, SessionFeedParticipant>();
    for (const participant of session?.participants ?? []) map.set(participant.userId, participant);
    return map;
  }, [session]);

  const openComments = useCallback((entityId: string, entityType: SocialEntityType) => {
    setCommentTarget({ entityId, entityType });
    commentSheetRef.current?.snapToIndex(0);
  }, []);

  const handleOpenSessionComments = useCallback((id: string) => openComments(id, 'session'), [openComments]);

  const handleTickPress = useCallback(
    (tick: SessionDetailTick) => openClimbInPlayDrawer({ kind: 'tick', tick }, { openPlayDrawer, router }),
    [openPlayDrawer, router],
  );

  // Stable per-row factory so the memoized `SessionTickRow`s keep their identity
  // across re-renders — a fresh inline arrow would force FlashList to re-evaluate
  // every visible item each pass.
  const renderItem = useCallback(
    ({ item }: { item: SessionDetailTick }) => (
      <SessionTickRow
        tick={item}
        isMultiUser={isMultiUser}
        participant={participantById.get(item.userId)}
        onPress={handleTickPress}
      />
    ),
    [isMultiUser, participantById, handleTickPress],
  );

  // Header title follows the loaded session name/date.
  useEffect(() => {
    navigation.setOptions({
      headerShown: true,
      title: title || t('mobileDetail.title'),
    });
  }, [navigation, title, t]);

  if (isPending) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (!session) {
    return (
      <View style={styles.centered}>
        <Icon name="history" size={48} color={systemColors.tertiaryLabel} />
        <Text variant="headline" color={systemColors.secondaryLabel} style={styles.notFound}>
          {t('mobileDetail.notFound')}
        </Text>
      </View>
    );
  }

  const header = (
    <View>
      <SessionSummaryCard
        session={session}
        title={title}
        titleIsDate={!session.sessionName}
        onOpenComments={handleOpenSessionComments}
        voteSummary={sessionVoteSummary}
      />

      <SessionAnalyticsSection gradeDistribution={session.gradeDistribution} />

      <SessionBetaCarousel ticks={session.ticks} participantById={participantById} isMultiUser={isMultiUser} />

      <SessionLeaderboard participants={session.participants} ticks={session.ticks} />

      <SectionHeader title={t('detail.climbsCount', { count: session.ticks.length })} />
    </View>
  );

  return (
    <View style={[styles.flex, { backgroundColor: systemColors.groupedBackground }]}>
      <FlashList
        data={session.ticks}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        ListHeaderComponent={header}
        // The stack header is transparent + blurred on iOS, so let the list
        // inset its content below it (and the status bar) rather than draw under.
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom }}
      />

      <CommentSheet
        sheetRef={commentSheetRef}
        entityId={commentTarget?.entityId ?? null}
        entityType={commentTarget?.entityType ?? 'session'}
        onClose={() => setCommentTarget(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing[3], paddingHorizontal: spacing[8] },
  notFound: { textAlign: 'center' },
});
