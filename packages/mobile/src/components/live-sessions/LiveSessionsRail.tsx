// Home's "Climbing now" rail. Self-subscribing on purpose: Home's list header
// is a `useMemo` whose deps must not include this query's data, or every poll
// would rebuild the FlashList header. The screen passes the scope and a stable
// invite callback; everything that changes on a poll stays in here.

import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { FlatList, Pressable, StyleSheet, useWindowDimensions, View, type ListRenderItemInfo } from 'react-native';
import { useIsFocused, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { Text } from '../Text';
import { SectionDisclosureChevron } from '../SectionDisclosureChevron';
import { track } from '../../lib/analytics';
import { hapticLight } from '../../lib/haptics';
import { nowDate } from '../../lib/clock';
import { useIsAppBackgrounded } from '../../lib/app-visibility';
import { useLiveSessionsCollapse } from '../../lib/live-sessions-collapse';
import { useBluetoothConnectedStatus } from '../../lib/ble/bluetooth-status-store';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { useFollowedLiveSessions } from '../../lib/graphql/hooks/use-live-sessions';
import { useProfile } from '../../lib/graphql/hooks';
import { usePublicProfile } from '../../lib/graphql/hooks/use-social';
import { useOfflineQueryState } from '../../hooks/use-offline-query-state';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useQueueSessionId } from '../../providers/queue-provider';
import { spacing } from '../../theme/tokens';
import { LiveSessionCard } from './LiveSessionCard';
import { FindClimbersTile } from './FindClimbersTile';
import { StartSessionRow, StartSessionTile, type StartPromptVariant } from './StartSessionTile';
import { LiveRailErrorRow, LiveRailOfflineRow, LiveRailSkeleton } from './LiveRailStates';
import { useLivePulseDriver } from './LiveDot';
import { useMinuteTick } from './use-minute-tick';
import { useLiveSessionColors } from './use-live-session-colors';
import {
  LIVE_TILE_GAP,
  LIVE_TILE_WIDTH,
  liveTileLayout,
  planLiveRail,
  type LiveCardModel,
  type RailEntry,
} from './live-session-model';
import {
  isStartPromptCollapsed,
  localDayKey,
  recordStartPromptImpression,
  resetStartPromptImpressions,
  useStartPromptImpressions,
} from './start-prompt-quiet-days';

const EMPTY_CARDS: LiveCardModel[] = [];
const TILE_STEP = LIVE_TILE_WIDTH + LIVE_TILE_GAP;

export type LiveRailState = 'loaded' | 'empty' | 'error' | 'offline';

const keyExtractor = (entry: RailEntry) => entry.key;
const getItemLayout = (_data: ArrayLike<RailEntry> | null | undefined, index: number) => ({
  length: TILE_STEP,
  offset: TILE_STEP * index,
  index,
});

function RailSeparator() {
  return <View style={styles.separator} />;
}

type LiveSessionsRailProps = {
  /** The Home-selected board, in gym mode only; null in crew mode. */
  boardUuid: string | null;
  /** False until Home's scope has settled, so a cold start fetches once. */
  enabled: boolean;
  /** Opens the invite sheet for the viewer's own solo session. */
  onInvite: (sessionId: string) => void;
};

export const LiveSessionsRail = memo(function LiveSessionsRail({
  boardUuid,
  enabled,
  onInvite,
}: LiveSessionsRailProps) {
  const { t } = useTranslation('feed');
  const router = useRouter();
  const isFocused = useIsFocused();
  const backgrounded = useIsAppBackgrounded();
  const colors = useLiveSessionColors();
  const { fontScale } = useWindowDimensions();
  const layout = useMemo(() => liveTileLayout(fontScale), [fontScale]);
  const { formatGrade } = useGradeFormat();

  const { expanded, toggle, loaded } = useLiveSessionsCollapse();
  // A folded rail costs no request; the header still renders, so it can unfold.
  const query = useFollowedLiveSessions(boardUuid, enabled && loaded && expanded);
  const offline = useOfflineQueryState(query);
  const cards = query.data ?? EMPTY_CARDS;
  const { refetch } = query;
  const handleRetry = useCallback(() => {
    void refetch();
  }, [refetch]);

  const { sessionId: queueSessionId } = useQueueSessionId();
  const queueSessionIdRef = useRef(queueSessionId);
  queueSessionIdRef.current = queueSessionId;

  const { data: profile } = useProfile();
  const viewerUserId = profile?.id ?? null;
  const bleConnected = useBluetoothConnectedStatus();
  const { data: activeBoard } = useActiveBoard();
  const activeBoardName = activeBoard?.name ?? null;

  // Follow count only matters when the rail has nobody the viewer follows on
  // it; a card listed for FOLLOWING_USER already proves they follow someone.
  const followsSomeoneLive = cards.some((card) => card.reasons.includes('FOLLOWING_USER'));
  const publicProfile = usePublicProfile(viewerUserId ?? undefined, query.isSuccess && !followsSomeoneLive);
  const followsNobody = !followsSomeoneLive && publicProfile.data?.followingCount === 0;

  const impressions = useStartPromptImpressions();
  const startCollapsed = impressions.loaded && isStartPromptCollapsed(impressions.days, localDayKey(nowDate()));

  const plan = useMemo(
    () => planLiveRail({ cards, viewerInSession: queueSessionId != null, followsNobody, startCollapsed }),
    [cards, queueSessionId, followsNobody, startCollapsed],
  );

  const blockedOffline = offline.isBlocked && (offline.reason === 'offline' || offline.reason === 'offline_mode');
  // Our server being down is not "no signal": it gets the retryable error row.
  const blockedError = offline.isBlocked && !blockedOffline;
  const isPending = !blockedError && !blockedOffline && (query.status === 'pending' || !impressions.loaded);
  const railState: LiveRailState | null =
    !loaded || !expanded
      ? null
      : blockedOffline
        ? 'offline'
        : blockedError
          ? 'error'
          : isPending
            ? null
            : cards.length === 0
              ? 'empty'
              : 'loaded';

  const hasLiveCards = cards.length > 0;
  const visible = isFocused && !backgrounded && loaded && expanded;
  const nowMinute = useMinuteTick(visible && hasLiveCards);
  useLivePulseDriver(visible && hasLiveCards);

  // Quiet-days resets: somebody went live, or the climber connected to a board.
  useEffect(() => {
    if (hasLiveCards) resetStartPromptImpressions();
  }, [hasLiveCards]);
  useEffect(() => {
    if (bleConnected) resetStartPromptImpressions();
  }, [bleConnected]);

  // Once per focus, with settled data.
  const viewedThisFocusRef = useRef(false);
  useEffect(() => {
    if (!isFocused) viewedThisFocusRef.current = false;
  }, [isFocused]);
  const cardCount = cards.length;
  const showsStartTile = plan.showsStartTile;
  useEffect(() => {
    if (!isFocused || railState == null || viewedThisFocusRef.current) return;
    viewedThisFocusRef.current = true;
    track(SHARED_EVENTS.LiveSessionsShelfViewed, { surface: 'home_rail', count: cardCount, state: railState });
    if (showsStartTile && railState !== 'offline') recordStartPromptImpression(localDayKey(nowDate()));
  }, [isFocused, railState, cardCount, showsStartTile]);

  const handleCardPress = useCallback(
    (card: LiveCardModel) => {
      hapticLight();
      track(SHARED_EVENTS.LiveSessionCardTapped, {
        surface: 'home_rail',
        reason: card.reasons[0] ?? null,
        viewerIsMember: card.viewerIsMember,
        participantCount: card.participantCount,
      });
      // The session this phone is in lives on the Record tab. A roster the
      // backend says we are on but this phone is not (another device) goes
      // through the join preview, which knows how to rejoin.
      if (card.viewerIsMember && card.sessionId === queueSessionIdRef.current) {
        router.navigate('/(tabs)/record');
        return;
      }
      router.push({ pathname: '/join/[sessionId]', params: { sessionId: card.sessionId, source: 'home_rail' } });
    },
    [router],
  );

  const startPrompt = useCallback(
    (variant: StartPromptVariant | 'compact') => {
      hapticLight();
      resetStartPromptImpressions();
      track(SHARED_EVENTS.StartSessionPromptTapped, { surface: 'home_rail', variant });
      router.navigate('/(tabs)/record');
    },
    [router],
  );
  const handleStartCompactPress = useCallback(() => startPrompt('compact'), [startPrompt]);

  const handleFindPress = useCallback(() => {
    hapticLight();
    router.push('/users/search');
  }, [router]);

  const startVariant: StartPromptVariant = bleConnected && activeBoardName ? 'ble_connected' : 'default';
  const viewerName = profile?.displayName ?? null;
  const viewerAvatarUrl = profile?.avatarUrl ?? null;
  const { height: tileHeight, stacked } = layout;

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<RailEntry>) => {
      switch (item.kind) {
        case 'session':
          return (
            <LiveSessionCard
              card={item.card}
              nowMinute={nowMinute}
              viewerUserId={viewerUserId}
              height={tileHeight}
              stacked={stacked}
              formatGrade={formatGrade}
              onPress={handleCardPress}
              onInvite={onInvite}
            />
          );
        case 'start':
          return (
            <StartSessionTile
              variant={startVariant}
              boardName={activeBoardName}
              viewerName={viewerName}
              viewerAvatarUrl={viewerAvatarUrl}
              height={tileHeight}
              onPress={startPrompt}
            />
          );
        case 'find':
          return <FindClimbersTile height={tileHeight} onPress={handleFindPress} />;
      }
    },
    [
      nowMinute,
      viewerUserId,
      tileHeight,
      stacked,
      formatGrade,
      handleCardPress,
      onInvite,
      startVariant,
      activeBoardName,
      viewerName,
      viewerAvatarUrl,
      startPrompt,
      handleFindPress,
    ],
  );

  const title = t('mobile.liveSessions.title');
  const liveCount = railState === 'loaded' && cards.length >= 2 ? cards.length : 0;

  const railList =
    plan.entries.length > 0 ? (
      <FlatList
        horizontal
        data={plan.entries}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        getItemLayout={getItemLayout}
        ItemSeparatorComponent={RailSeparator}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.railContent}
        snapToInterval={TILE_STEP}
        decelerationRate="fast"
        snapToAlignment="start"
        initialNumToRender={3}
        maxToRenderPerBatch={3}
        windowSize={3}
      />
    ) : null;

  return (
    <View style={styles.section} testID="live-sessions-rail">
      {/* The whole heading row is one tap target (25pt + padding + hit slop ≥ 44pt). */}
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded }}
        hitSlop={8}
        style={styles.headerRow}
      >
        <Text variant="title3">{title}</Text>
        <SectionDisclosureChevron expanded={expanded} size={18} />
        <View style={styles.headerSpacer} />
        {liveCount > 0 ? (
          <Text variant="footnote" color={colors.live} style={styles.liveCount}>
            {t('mobile.liveSessions.liveCount', { count: liveCount })}
          </Text>
        ) : null}
      </Pressable>
      {/* Nothing until the stored collapse state lands: rendering the default
          and then correcting it is the cold-start flash this avoids. */}
      {!loaded || !expanded ? null : blockedOffline ? (
        <LiveRailOfflineRow />
      ) : isPending ? (
        <LiveRailSkeleton height={tileHeight} />
      ) : (
        <View style={styles.body}>
          {blockedError ? <LiveRailErrorRow onRetry={handleRetry} /> : null}
          {railList}
          {plan.compactStart ? <StartSessionRow onPress={handleStartCompactPress} /> : null}
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  section: {
    paddingBottom: spacing[5],
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
  },
  headerSpacer: { flex: 1 },
  liveCount: { fontWeight: '600' },
  body: {
    gap: spacing[3],
  },
  railContent: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[1],
  },
  separator: {
    width: LIVE_TILE_GAP,
  },
});
