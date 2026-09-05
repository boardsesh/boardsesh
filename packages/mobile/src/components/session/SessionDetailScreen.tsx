import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { useTranslation } from 'react-i18next';
import type { BottomSheet } from '@expo/ui/community/bottom-sheet';
import type { SessionDetailTick, SessionFeedParticipant, SocialEntityType } from '@boardsesh/shared-schema';
import { formatTickAbsoluteTime } from '@boardsesh/profile-stats';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { ActivityIndicator } from '../ActivityIndicator';
import { SectionHeader } from '../SectionHeader';
import { CommentSheet } from '../you/CommentSheet';
import { SessionSummaryCard } from './SessionSummaryCard';
import { SessionEditSheet } from './SessionEditSheet';
import { SessionAnalyticsSection } from './SessionAnalyticsSection';
import { SessionBetaCarousel } from './SessionBetaCarousel';
import { SessionLeaderboard } from './SessionLeaderboard';
import { SessionTickRow } from './SessionTickRow';
import { useSessionDetail, useBulkVoteSummaries, useProfile } from '../../lib/graphql/hooks';
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
 * the tab stack and keeps the tab bar on screen, rather than a root push that
 * slides it away. Pushed routes are intentionally not accessory surfaces, so the
 * Liquid Glass BottomAccessory unmounts here.
 */
export default function SessionDetailScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const navigation = useNavigation();
  const router = useRouter();
  const { openPlayDrawer } = useDrawerHost();
  const bottomChrome = useBottomChromeMetrics();
  // Session detail is a pushed route without queue/accessory chrome. Use the
  // floating-control metric so the final row clears whichever tab bar is actually
  // rendered: UIKit's raw inset for NativeTabs, or the explicit JS bar height.
  const paddingBottom = bottomChrome.floatingControlBottom + spacing[6];

  const { data: session, isPending } = useSessionDetail(sessionId);
  const { data: voteSummaries } = useBulkVoteSummaries('session', sessionId ? [sessionId] : [], !!sessionId);
  // `.at(0)`, not `[0]`: the list is empty until the chunk resolves, and `.at`
  // is the indexed read typed `VoteSummary | undefined` without
  // `noUncheckedIndexedAccess`.
  const sessionVoteSummary = voteSummaries.at(0);
  const { data: profile } = useProfile();

  // Only the session's creator can rename it / edit the recap (the server enforces
  // this too; gating the affordance keeps non-owners from hitting a rejection).
  const canEdit = !!session?.ownerUserId && !!profile?.id && session.ownerUserId === profile.id;

  const commentSheetRef = useRef<BottomSheet | null>(null);
  const [commentTarget, setCommentTarget] = useState<{ entityId: string; entityType: SocialEntityType } | null>(null);
  const [editVisible, setEditVisible] = useState(false);
  const openEdit = useCallback(() => setEditVisible(true), []);
  const closeEdit = useCallback(() => setEditVisible(false), []);

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
        onEditSession={canEdit ? openEdit : undefined}
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

      {canEdit ? (
        <SessionEditSheet
          visible={editVisible}
          sessionId={session.sessionId}
          currentName={session.sessionName ?? null}
          currentNotes={session.notes ?? null}
          onClose={closeEdit}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing[3], paddingHorizontal: spacing[8] },
  notFound: { textAlign: 'center' },
});
