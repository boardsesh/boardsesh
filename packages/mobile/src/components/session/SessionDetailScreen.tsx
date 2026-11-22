import { formatTickAbsoluteTime } from '@boardsesh/profile-stats';
import type { SessionDetailTick, SessionFeedParticipant, SocialEntityType } from '@boardsesh/shared-schema';
import type { BottomSheet } from '../sheet-presentation';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { WEB_BASE_URL } from '../../lib/env';
import { getSoleBoardType } from '../../lib/grade-label';
import { useBulkVoteSummaries, useProfile, useSessionDetail } from '../../lib/graphql/hooks';
import { useTickListActivation } from '../../lib/playlists/use-tick-list-activation';
import { canEditSessionDetail, isDailySessionId } from '../../lib/session-edit-permissions';
import { spacing } from '../../theme/tokens';
import { buildSessionRecapOgImageUrl } from '../../lib/share-prewarm';
import { useVariantValue } from '../../theme/variants';
import { SectionHeader } from '../SectionHeader';
import { ShareIconButton } from '../ShareIconButton';
import { CommentSheet } from '../you/CommentSheet';
import { SessionAnalyticsSection } from './SessionAnalyticsSection';
import { SessionBetaCarousel } from './SessionBetaCarousel';
import { SessionClimbsListItem } from './SessionClimbsListItem';
import { SessionDetailView } from './SessionDetailView';
import { SessionEditSheet } from './SessionEditSheet';
import { SessionLeaderboard } from './SessionLeaderboard';
import { SessionNotesCard, SessionSummaryCard } from './SessionSummaryCard';
import { useSessionWorkoutView } from './workout/use-session-workout-view';
import { buildWorkoutClimbRows, type WorkoutClimbsRow, type WorkoutClimbsRows } from './workout/workout-climb-rows';

const EMPTY_TICKS: SessionDetailTick[] = [];

/** A session without a workout: one row per tick, in the order the server lists them. */
function plainTickRows(ticks: SessionDetailTick[]): WorkoutClimbsRows {
  return { rows: ticks.map((tick) => ({ type: 'tick', key: tick.uuid, tick })), orderedTicks: ticks };
}

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
  const navigation = useNavigation();
  const bottomChrome = useBottomChromeMetrics();
  // Session detail is a pushed route without queue/accessory chrome. Use the
  // floating-control metric so the final row clears whichever tab bar is actually
  // rendered: UIKit's raw inset for NativeTabs, or the explicit JS bar height.
  const paddingBottom = bottomChrome.floatingControlBottom + spacing[6];

  const { data: session, isPending } = useSessionDetail(sessionId);
  // The workout this session was climbed to, if any (#6903): the Climbs list
  // then groups by block. The viewer's own when they ran one, else the session
  // owner's (`chooseSessionWorkout`).
  const workout = useSessionWorkoutView(sessionId, 'session', session?.ownerUserId ?? null)?.workout;
  const ticks = session?.ticks ?? EMPTY_TICKS;
  const climbRows = useMemo(
    () => (workout ? buildWorkoutClimbRows(ticks, workout) : plainTickRows(ticks)),
    [ticks, workout],
  );
  // A daily group is a synthesised feed key with no session row, so votes and
  // comments on it as a 'session' would be rejected (#5290). They live on the feed card.
  const isDaily = isDailySessionId(sessionId) || session?.sessionType === 'daily_highlight';
  const { data: voteSummaries } = useBulkVoteSummaries(
    'session',
    sessionId && !isDaily ? [sessionId] : [],
    !!sessionId && !isDaily,
  );
  // `.at(0)`, not `[0]`: the list is empty until the chunk resolves, and `.at`
  // is the indexed read typed `VoteSummary | undefined` without
  // `noUncheckedIndexedAccess`.
  const sessionVoteSummary = voteSummaries.at(0);
  const { data: profile } = useProfile();

  // Only the creator of a real session can rename it / edit the recap (the server
  // enforces this too; gating the affordance keeps the rejection from surfacing).
  const canEdit = canEditSessionDetail(session, profile?.id);

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

  // A tick opens playing from this session's ticks, in the order listed: every
  // tick is loaded, so the track is the whole session (issue #6665).
  const handleTickPress = useTickListActivation<SessionDetailTick>({
    sourceId: `session:${sessionId ?? ''}`,
    label: t('playView.track.sessionClimbs'),
    rows: climbRows.orderedTicks,
  });

  // Stable per-row factory so the memoized rows keep their identity across
  // re-renders — a fresh inline arrow would force FlashList to re-evaluate
  // every visible item each pass.
  const renderItem = useCallback(
    ({ item }: { item: WorkoutClimbsRow }) => (
      <SessionClimbsListItem
        row={item}
        isMultiUser={isMultiUser}
        participantById={participantById}
        onPress={handleTickPress}
      />
    ),
    [isMultiUser, participantById, handleTickPress],
  );

  // UIKit's header follows the loaded session name/date. Material's app bar names
  // the screen instead: the summary card right under it already leads with the name.
  const headerTitle = useVariantValue({ liquidGlass: title, material: '' }) || t('mobileDetail.title');
  const canShare = !!session && !isPending;
  useEffect(() => {
    navigation.setOptions({
      headerShown: true,
      title: headerTitle,
      headerRight: canShare
        ? () => (
            <ShareIconButton
              appearance="nativeHeader"
              url={`${WEB_BASE_URL}/session/${encodeURIComponent(sessionId)}`}
              message={t('detail.shareText')}
              accessibilityLabel={t('detail.share')}
              copiedMessage={t('detail.shareSuccess')}
              errorMessage={t('detail.shareError')}
              prewarmOgImageUrl={isDaily ? undefined : (buildSessionRecapOgImageUrl(sessionId) ?? undefined)}
            />
          )
        : undefined,
    });
  }, [navigation, headerTitle, canShare, sessionId, isDaily, t]);

  if (isPending || !session)
    return (
      <SessionDetailView
        loading={isPending}
        found={!!session}
        rows={climbRows.rows}
        renderItem={renderItem}
        paddingBottom={paddingBottom}
      />
    );

  const header = (
    <View>
      <SessionSummaryCard
        session={session}
        title={title}
        titleIsDate={!session.sessionName}
        onOpenComments={isDaily ? undefined : handleOpenSessionComments}
        voteSummary={sessionVoteSummary}
        onEditSession={canEdit ? openEdit : undefined}
      />

      <SessionAnalyticsSection
        gradeDistribution={session.gradeDistribution}
        boardName={getSoleBoardType(session.boardTypes)}
      />

      <SessionNotesCard session={session} />

      <SessionBetaCarousel ticks={session.ticks} participantById={participantById} isMultiUser={isMultiUser} />

      <SessionLeaderboard participants={session.participants} ticks={session.ticks} />

      <SectionHeader title={t('detail.climbsCount', { count: session.ticks.length })} />
    </View>
  );

  return (
    <SessionDetailView
      loading={false}
      found
      rows={climbRows.rows}
      renderItem={renderItem}
      header={header}
      paddingBottom={paddingBottom}
      overlays={
        <>
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
        </>
      }
    />
  );
}
