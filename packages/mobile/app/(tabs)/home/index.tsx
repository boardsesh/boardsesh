import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';
import { FlashList, type FlashListRef, type ListRenderItemInfo } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { BottomSheet } from '@expo/ui/community/bottom-sheet';
import type {
  CrewFeedItem,
  SessionFeedItem,
  SessionFeedTickHighlight,
  SocialEntityType,
  UserBoard,
} from '@boardsesh/shared-schema';
import { Text } from '../../../src/components/Text';
import { Icon } from '../../../src/components/Icon';
import { Card } from '../../../src/components/Card';
import { Button } from '../../../src/components/Button';
import { SessionFeedCard } from '../../../src/components/you/SessionFeedCard';
import { NewClimbFeedCard } from '../../../src/components/feed/NewClimbFeedCard';
import { useCrewFeed } from '../../../src/lib/graphql/hooks/use-crew-feed';
import { CommentSheet } from '../../../src/components/you/CommentSheet';
import { HomeTopChrome, TOP_ISLAND_BAND } from '../../../src/components/feed/HomeTopChrome';
import { type AppMenuAction } from '../../../src/components/AppMenu';
import { useBulkVoteSummaries, useSessionGroupedFeed } from '../../../src/lib/graphql/hooks';
import { FOLLOWED_LIVE_SESSIONS_QUERY_KEY } from '../../../src/lib/graphql/query-keys';
import { useHomeBoard } from '../../../src/lib/graphql/hooks/use-home-board';
import { useAuth } from '../../../src/providers/auth-provider';
import { useTheme } from '../../../src/providers/theme-provider';
import { useDrawerHost } from '../../../src/providers/drawer-host-provider';
import { useBottomChromeMetrics } from '../../../src/hooks/use-bottom-chrome-metrics';
import { useOfflineQueryState } from '../../../src/hooks/use-offline-query-state';
import { OfflineState } from '../../../src/components/OfflineState';
import { dedupeSessionsById } from '../../../src/lib/feed-time-buckets';
import { deriveFeedScopeInput, type FeedMode } from '../../../src/lib/feed/feed-scope';
import { createFeedPageGate, requiresCrewPageTap } from '../../../src/lib/feed/crew-page-state';
import { buildVoteSummaryMap, voteSummaryKey, type VoteSummary } from '../../../src/lib/feed/vote-summary-map';
import { openClimbInPlayDrawer } from '../../../src/lib/open-climb-in-play-drawer';
import { hapticLight } from '../../../src/lib/haptics';
import { navigateToSessionFeedItem } from '../../../src/lib/session-feed-navigation';
import { iosSystemColors } from '../../../src/theme/ios-colors';
import { borderRadius, spacing } from '../../../src/theme/tokens';
import { LiveSessionsRail } from '../../../src/components/live-sessions/LiveSessionsRail';
import { InviteSheet } from '../../../src/components/session-screen/InviteSheet';

import { HomeStartupCommit } from '../../../src/lib/profiling/HomeStartupCommit';
import { STARTUP_PROFILING_ENABLED } from '../../../src/lib/profiling/startup-profile';
import { homeEmptyStartupOutcome } from '../../../src/lib/profiling/startup-collector';

const INITIAL_FEED_SKELETON_KEYS = ['home-feed-skeleton-1', 'home-feed-skeleton-2', 'home-feed-skeleton-3'];
const NEXT_PAGE_FEED_SKELETON_KEYS = ['home-feed-footer-skeleton-1', 'home-feed-footer-skeleton-2'];

type CommentTarget = {
  entityId: string;
  entityType: SocialEntityType;
};

// Hoisted so the FlashList `keyExtractor` prop keeps a stable identity across
// renders (perf playbook rule 3) instead of a fresh inline arrow each pass.
const keyExtractor = (item: CrewFeedItem) => item.id;
const getItemType = (item: CrewFeedItem) => item.__typename;

export default function HomeTab() {
  const { t } = useTranslation('feed');
  const { t: tCommon } = useTranslation('common');
  const router = useRouter();
  const queryClient = useQueryClient();
  const { isAuthenticated } = useAuth();
  const { systemColors, brandColors } = useTheme();
  const { openPlayDrawer } = useDrawerHost();
  const bottomChrome = useBottomChromeMetrics();
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlashListRef<CrewFeedItem>>(null);
  const commentSheetRef = useRef<BottomSheet | null>(null);
  const [commentTarget, setCommentTarget] = useState<CommentTarget | null>(null);
  // Measured top-chrome height so the feed clears the chrome (seeded to the floating
  // band's height — exact for Liquid Glass, corrected by the Material app bar's
  // onLayout on the next frame).
  const [chromeHeight, setChromeHeight] = useState(() => insets.top + TOP_ISLAND_BAND);

  // Feed scope. `mode` chooses the view — `crew` (people you follow) is the
  // default; `gym` is everyone on the selected board. `selectedBoard` is the
  // gym/board both views filter to (`null` = unscoped: crew across all boards,
  // or the "Everyone" global feed). It defaults to the inferred home board once
  // it resolves; the view stays on `crew`.
  const { board: homeBoard, isResolving: isResolvingHomeBoard, boards: ownedBoards } = useHomeBoard();
  // Screenshot builds open on the global "Everyone" feed (gym + no board) — a
  // livelier hero shot than the test user's own crew. Inlined so it dead-strips
  // in normal builds, where the default stays `crew`.
  const [mode, setMode] = useState<FeedMode>(process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' ? 'gym' : 'crew');
  const [selectedBoard, setSelectedBoard] = useState<UserBoard | null>(null);
  // Once home-board inference settles, point the crew/gym filter at the home
  // board. The view stays on `crew`; with no home board it's the unfiltered crew.
  const hasDefaultedScope = useRef(false);
  useEffect(() => {
    if (hasDefaultedScope.current || isResolvingHomeBoard) return;
    hasDefaultedScope.current = true;
    // Screenshot mode stays on the global "Everyone" feed, so don't scope the
    // gym view to the home board (that would turn it into one board's feed).
    if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') return;
    if (homeBoard) setSelectedBoard(homeBoard);
  }, [homeBoard, isResolvingHomeBoard]);

  const feedInput = useMemo(() => deriveFeedScopeInput(mode, selectedBoard?.uuid ?? null), [mode, selectedBoard]);
  // "Climbing now" adds the selected board's sessions only when the climber is
  // looking at that board (gym mode); crew mode is people only.
  const liveBoardUuid = mode === 'gym' ? (selectedBoard?.uuid ?? null) : null;

  // Hold both queries until home-board inference settles, so a cold start never
  // fires the unscoped global feed first (initial state is gym + no board) and
  // then refetches the scoped/crew query — that double-fetch flickered the feed.
  const scopeReady = !isResolvingHomeBoard;
  const sessionFeed = useSessionGroupedFeed(feedInput, isAuthenticated && scopeReady && mode === 'gym');
  const crewFeed = useCrewFeed(isAuthenticated && scopeReady && mode === 'crew');
  const feed = mode === 'crew' ? crewFeed : sessionFeed;
  // A visibility recheck can remove every candidate from one page. Advancing
  // that cursor needs an explicit tap, not an automatic drain of sparse pages.
  const lastCrewPage = crewFeed.data?.pages.at(-1)?.crewFeed;
  const requiresManualPage = mode === 'crew' && requiresCrewPageTap(lastCrewPage);
  const pageGateRef = useRef(createFeedPageGate());
  const pageSource = mode === 'crew' ? 'crew' : `gym:${selectedBoard?.uuid ?? 'everyone'}`;
  // The feed is network-only and `networkMode: 'offlineFirst'` pauses an offline
  // fetch instead of failing it, so neither `isLoading` nor `isError` ever
  // resolves — the skeleton list would sit there for good.
  const feedOffline = useOfflineQueryState(feed);

  const feedItems = useMemo<CrewFeedItem[]>(() => {
    if (mode === 'crew') {
      const items = crewFeed.data?.pages.flatMap((page) => page.crewFeed.items) ?? [];
      return [...new Map(items.map((item) => [item.id, item])).values()];
    }
    return dedupeSessionsById(sessionFeed.data?.pages.flatMap((page) => page.sessionGroupedFeed.sessions) ?? []).map(
      (session) => ({
        __typename: 'CrewSessionItem',
        id: `session:${session.sessionId}`,
        occurredAt: session.lastTickAt,
        session,
      }),
    );
  }, [mode, crewFeed.data, sessionFeed.data]);
  const sessions = useMemo(
    () => feedItems.flatMap((item) => (item.__typename === 'CrewSessionItem' ? [item.session] : [])),
    [feedItems],
  );

  const sessionEntityIds = useMemo(
    () => sessions.filter((session) => session.socialEntityType === 'session').map((session) => session.socialEntityId),
    [sessions],
  );
  const tickEntityIds = useMemo(
    () => sessions.filter((session) => session.socialEntityType === 'tick').map((session) => session.socialEntityId),
    [sessions],
  );
  const sessionVoteSummaries = useBulkVoteSummaries(
    'session',
    sessionEntityIds,
    isAuthenticated && sessionEntityIds.length > 0,
  );
  const tickVoteSummaries = useBulkVoteSummaries('tick', tickEntityIds, isAuthenticated && tickEntityIds.length > 0);
  // Rebuild the vote map on each summary change, but reuse the prior value object
  // for any unchanged entity (see buildVoteSummaryMap). The `Map` reference still
  // changes each rebuild — that's what drives FlashList `extraData` — while the
  // stable inner objects let each `React.memo`'d card bail unless its vote moved.
  // `summaryMapRef` holds the last committed map so the rebuild can diff against
  // it; `renderItem` also reads it so it never has to depend on `summaryMap`.
  const summaryMapRef = useRef<Map<string, VoteSummary>>(new Map());
  const summaryMap = useMemo(
    () =>
      buildVoteSummaryMap(summaryMapRef.current, [
        ...(sessionVoteSummaries.data ?? []).map((summary) => ({
          entityType: 'session' as const,
          entityId: summary.entityId,
          upvotes: summary.upvotes,
          userVote: summary.userVote,
        })),
        ...(tickVoteSummaries.data ?? []).map((summary) => ({
          entityType: 'tick' as const,
          entityId: summary.entityId,
          upvotes: summary.upvotes,
          userVote: summary.userVote,
        })),
      ]),
    [sessionVoteSummaries.data, tickVoteSummaries.data],
  );
  // Point the ref at the freshly-built map before `renderItem` reads it below, so
  // the stable `renderItem` always closes over the current vote data.
  summaryMapRef.current = summaryMap;

  const handleOpenComments = useCallback((entityId: string, entityType: SocialEntityType) => {
    setCommentTarget({ entityId, entityType });
    commentSheetRef.current?.snapToIndex(0);
  }, []);

  const handleOpenSearch = useCallback(() => {
    router.push('/users/search');
  }, [router]);

  const handleSessionPress = useCallback(
    (session: SessionFeedItem) => navigateToSessionFeedItem(router, session, '/home/session/[sessionId]'),
    [router],
  );

  const handleOpenClimb = useCallback(
    (tick: SessionFeedTickHighlight) => openClimbInPlayDrawer({ kind: 'tick', tick }, { openPlayDrawer, router }),
    [openPlayDrawer, router],
  );

  const loadNextPage = useCallback(() => {
    if (!feed.hasNextPage || feed.isFetchingNextPage || !pageGateRef.current.claim(pageSource)) return;
    // Promise cleanup still runs after unmount. A remount owns a fresh ref, so
    // this completion can only release the old instance's gate.
    void feed.fetchNextPage().finally(() => {
      pageGateRef.current.release(pageSource);
    });
  }, [feed.hasNextPage, feed.isFetchingNextPage, feed.fetchNextPage, pageSource]);
  const handleEndReached = useCallback(() => {
    if (!requiresManualPage) loadNextPage();
  }, [requiresManualPage, loadNextPage]);

  const handleRefresh = useCallback(() => {
    // The rail subscribes to its own query, so the screen refreshes it by key.
    void queryClient.invalidateQueries({ queryKey: FOLLOWED_LIVE_SESSIONS_QUERY_KEY });
    void sessionVoteSummaries.refetch();
    void tickVoteSummaries.refetch();
    if (isAuthenticated) void feed.refetch();
  }, [queryClient, feed, isAuthenticated, sessionVoteSummaries, tickVoteSummaries]);

  // The invite sheet for the viewer's own solo session on the rail. Mounted on
  // the first request and kept mounted; opening waits one frame so the native
  // sheet has committed before the coordinator presents it.
  const [inviteSessionId, setInviteSessionId] = useState<string | null>(null);
  const [inviteRequest, setInviteRequest] = useState(0);
  const [inviteOpen, setInviteOpen] = useState(false);
  const handleOpenInvite = useCallback((sessionId: string) => {
    setInviteSessionId(sessionId);
    setInviteRequest((request) => request + 1);
  }, []);
  useEffect(() => {
    if (inviteRequest === 0) return;
    const frame = requestAnimationFrame(() => setInviteOpen(true));
    return () => cancelAnimationFrame(frame);
  }, [inviteRequest]);
  const handleDismissInvite = useCallback(() => setInviteOpen(false), []);

  const handleSelectCrew = useCallback(() => {
    hapticLight();
    setMode('crew');
  }, []);

  const handleSelectBoard = useCallback((board: UserBoard) => {
    hapticLight();
    setSelectedBoard(board);
    setMode('gym');
  }, []);

  const handleSelectEveryone = useCallback(() => {
    hapticLight();
    setSelectedBoard(null);
    setMode('gym');
  }, []);

  const handleFindGym = useCallback(() => {
    router.push('/gyms');
  }, [router]);

  const handleBrowseEveryone = useCallback(() => {
    setSelectedBoard(null);
    setMode('gym');
  }, []);

  // Read the map through `summaryMapRef` (not `summaryMap`) so this stays
  // referentially stable across vote/page updates — `extraData={summaryMap}` is
  // the single signal that re-invokes it. A churning `renderItem` would force
  // FlashList to re-render regardless of `extraData` (perf playbook rule 3).
  const renderItem = useCallback(
    ({ item, target }: ListRenderItemInfo<CrewFeedItem>) => (
      <>
        {STARTUP_PROFILING_ENABLED && target === 'Cell' ? <HomeStartupCommit outcome="content" /> : null}
        {item.__typename === 'CrewClimbItem' ? (
          <NewClimbFeedCard climb={item.climb} />
        ) : (
          <SessionFeedCard
            session={item.session}
            voteSummary={summaryMapRef.current.get(
              voteSummaryKey(item.session.socialEntityType, item.session.socialEntityId),
            )}
            onOpenComments={handleOpenComments}
            onPress={handleSessionPress}
            onOpenClimb={handleOpenClimb}
          />
        )}
      </>
    ),
    [handleOpenComments, handleSessionPress, handleOpenClimb],
  );

  // The scope menu: "My crew" (default), the home gym/board, any other owned
  // boards, "Everyone", and "Find a gym". The active scope carries a checkmark
  // and doubles as the large title. `onSelectIndex` runs the tapped item.
  const scopeMenu = useMemo(() => {
    const items: { action: AppMenuAction; run: () => void }[] = [
      {
        action: { label: t('mobile.home.scope.myCrew'), systemIcon: 'person.2.fill', selected: mode === 'crew' },
        run: handleSelectCrew,
      },
    ];
    if (homeBoard) {
      items.push({
        action: {
          label: homeBoard.gymName ?? homeBoard.name,
          systemIcon: 'building.2.fill',
          selected: mode === 'gym' && selectedBoard?.uuid === homeBoard.uuid,
        },
        run: () => handleSelectBoard(homeBoard),
      });
    }
    for (const board of ownedBoards) {
      if (homeBoard && board.uuid === homeBoard.uuid) continue;
      items.push({
        action: {
          label: board.gymName ?? board.name,
          systemIcon: 'building.2.fill',
          selected: mode === 'gym' && selectedBoard?.uuid === board.uuid,
        },
        run: () => handleSelectBoard(board),
      });
    }
    items.push({
      action: {
        label: t('mobile.home.scope.everyone'),
        systemIcon: 'globe',
        selected: mode === 'gym' && selectedBoard == null,
      },
      run: handleSelectEveryone,
    });
    items.push({
      action: { label: t('mobile.home.scope.findGym'), systemIcon: 'mappin.and.ellipse' },
      run: handleFindGym,
    });

    const title =
      mode === 'crew'
        ? t('mobile.home.scope.myCrew')
        : selectedBoard == null
          ? t('mobile.home.scope.everyone')
          : (selectedBoard.gymName ?? selectedBoard.name);

    return {
      title,
      actions: items.map((item) => item.action),
      onSelectIndex: (index: number) => items[index]?.run(),
    };
  }, [
    t,
    mode,
    homeBoard,
    ownedBoards,
    selectedBoard,
    handleSelectCrew,
    handleSelectBoard,
    handleSelectEveryone,
    handleFindGym,
  ]);

  const sessionsHeading = mode === 'gym' ? t('mobile.home.sessionsTitle') : t('mobile.home.feedTitle');

  // No query data in these deps: the rail polls on its own, and a dep that
  // changed on every poll would rebuild the FlashList header each minute.
  const header = useMemo(
    () => (
      <View style={styles.header}>
        <LiveSessionsRail boardUuid={liveBoardUuid} enabled={scopeReady} onInvite={handleOpenInvite} />
        <Text variant="title3" style={styles.feedHeading}>
          {sessionsHeading}
        </Text>
      </View>
    ),
    [liveBoardUuid, scopeReady, handleOpenInvite, sessionsHeading],
  );

  if (!isAuthenticated) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        {STARTUP_PROFILING_ENABLED ? <HomeStartupCommit outcome="empty" /> : null}
        <Icon name="people" size={48} color={systemColors.tertiaryLabel} />
        <Text variant="headline" style={styles.emptyTitle}>
          {t('mobile.home.signInTitle')}
        </Text>
        <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.emptyBody}>
          {t('mobile.home.signInBody')}
        </Text>
        <View style={styles.emptyCta}>
          <Button title={tCommon('userDrawer.signIn')} onPress={() => router.push('/auth/login')} />
        </View>
      </View>
    );
  }

  return (
    <View testID="home-screen" style={[styles.flex, { backgroundColor: systemColors.background }]}>
      <FlashList
        ref={listRef}
        data={feedItems}
        getItemType={getItemType}
        extraData={summaryMap}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        // The floating glass header owns the top inset on every platform (the
        // iOS-only `automatic` behaviour left an Android gap), so pad manually.
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{
          paddingTop: chromeHeight,
          paddingBottom: bottomChrome.scrollBottomPadding + spacing[5],
        }}
        scrollIndicatorInsets={{ top: chromeHeight }}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.5}
        ListHeaderComponent={header}
        refreshControl={
          <RefreshControl refreshing={feed.isRefetching} onRefresh={handleRefresh} tintColor={brandColors.primary} />
        }
        ListEmptyComponent={
          <>
            {STARTUP_PROFILING_ENABLED ? (
              <HomeStartupCommit
                outcome={homeEmptyStartupOutcome({
                  authenticated: isAuthenticated,
                  blockedReason: feedOffline.isBlocked ? feedOffline.reason : null,
                  loading: feed.isLoading,
                  scopeReady,
                  error: feed.isError,
                })}
              />
            ) : null}
            {feedOffline.isBlocked && feedOffline.reason ? (
              <OfflineState reason={feedOffline.reason} onRetry={handleRefresh} />
            ) : feed.isLoading || !scopeReady ? (
              <ActivitySkeletonList skeletonKeys={INITIAL_FEED_SKELETON_KEYS} />
            ) : feed.isError ? (
              <View style={styles.feedState}>
                <Icon name="error" size={32} color={iosSystemColors.systemRed} />
                <Text variant="headline" style={styles.emptyTitle}>
                  {t('errors.loadActivity')}
                </Text>
                <View style={styles.emptyCta}>
                  <Button title={tCommon('actions.retry')} onPress={() => void feed.refetch()} />
                </View>
              </View>
            ) : requiresManualPage ? null : mode === 'gym' && selectedBoard != null ? (
              <View style={styles.feedState}>
                <Icon name="boards" size={48} color={systemColors.tertiaryLabel} />
                <Text variant="headline" style={styles.emptyTitle}>
                  {t('mobile.home.boardEmptyTitle', { board: selectedBoard.gymName ?? selectedBoard.name })}
                </Text>
                <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.emptyBody}>
                  {t('mobile.home.boardEmptyBody')}
                </Text>
                <View style={styles.emptyCta}>
                  <Button title={t('mobile.home.boardEmptyCta')} onPress={handleBrowseEveryone} />
                </View>
              </View>
            ) : mode === 'crew' ? (
              <View style={styles.feedState}>
                <Icon name="people" size={48} color={systemColors.tertiaryLabel} />
                <Text variant="headline" style={styles.emptyTitle}>
                  {t('mobile.home.emptyTitle')}
                </Text>
                <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.emptyBody}>
                  {t('mobile.home.emptyBody')}
                </Text>
              </View>
            ) : (
              <View style={styles.feedState}>
                <Icon name="people" size={48} color={systemColors.tertiaryLabel} />
                <Text variant="headline" style={styles.emptyTitle}>
                  {t('emptyStates.noRecentActivity')}
                </Text>
              </View>
            )}
          </>
        }
        ListFooterComponent={
          feed.isFetchingNextPage ? (
            <ActivitySkeletonList skeletonKeys={NEXT_PAGE_FEED_SKELETON_KEYS} />
          ) : requiresManualPage ? (
            <Button title={t('crewLoadMore')} onPress={loadNextPage} />
          ) : null
        }
      />
      <HomeTopChrome
        scopeTitle={scopeMenu.title}
        scopeActions={scopeMenu.actions}
        onSelectScopeIndex={scopeMenu.onSelectIndex}
        onOpenSearch={handleOpenSearch}
        searchAccessibilityLabel={t('mobile.home.searchAction')}
        scopeAccessibilityHint={t('mobile.home.scope.hint')}
        onHeightChange={setChromeHeight}
      />
      <CommentSheet
        sheetRef={commentSheetRef}
        entityId={commentTarget?.entityId ?? null}
        entityType={commentTarget?.entityType ?? 'tick'}
        onClose={() => setCommentTarget(null)}
      />
      {inviteSessionId ? (
        <InviteSheet visible={inviteOpen} onDismiss={handleDismissInvite} sessionId={inviteSessionId} />
      ) : null}
    </View>
  );
}

function ActivitySkeletonList({ skeletonKeys }: { skeletonKeys: string[] }) {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {skeletonKeys.map((skeletonKey) => (
        <ActivityCardSkeleton key={skeletonKey} />
      ))}
    </View>
  );
}

function ActivityCardSkeleton() {
  const { systemColors } = useTheme();
  const blockStyle = { backgroundColor: systemColors.fill };

  return (
    <View style={styles.cardOuter}>
      <Card>
        <View style={styles.skeletonHeader}>
          <View style={[styles.skeletonAvatar, blockStyle]} />
          <View style={styles.skeletonHeaderText}>
            <View style={[styles.skeletonTitleLine, blockStyle]} />
            <View style={[styles.skeletonSmallLine, blockStyle]} />
          </View>
        </View>

        <View style={styles.skeletonBody}>
          <View style={[styles.skeletonThumbnail, blockStyle]} />
          <View style={styles.skeletonDetails}>
            <View style={[styles.skeletonClimbName, blockStyle]} />
            <View style={[styles.skeletonMetaLine, blockStyle]} />
            <View style={[styles.skeletonCommentLine, blockStyle]} />
            <View style={[styles.skeletonCommentShortLine, blockStyle]} />
          </View>
        </View>

        <View style={[styles.skeletonSocialRow, { borderTopColor: systemColors.separator }]}>
          <View style={[styles.skeletonSocialPill, blockStyle]} />
          <View style={[styles.skeletonSocialPill, blockStyle]} />
        </View>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[8],
    gap: spacing[2],
  },
  header: {
    // A small gap below the floating header band (the list already insets by the
    // band via contentContainerStyle).
    paddingTop: spacing[2],
  },
  feedHeading: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
  },
  cardOuter: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  skeletonHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  skeletonAvatar: {
    width: 40,
    height: 40,
    borderRadius: borderRadius.full,
    opacity: 0.5,
  },
  skeletonHeaderText: {
    flex: 1,
    gap: spacing[2],
  },
  skeletonTitleLine: {
    width: '44%',
    height: 18,
    borderRadius: borderRadius.full,
    opacity: 0.55,
  },
  skeletonSmallLine: {
    width: '34%',
    height: 12,
    borderRadius: borderRadius.full,
    opacity: 0.4,
  },
  skeletonBody: {
    flexDirection: 'row',
    gap: spacing[3],
    paddingTop: spacing[3],
  },
  skeletonThumbnail: {
    width: 76,
    height: 96,
    borderRadius: borderRadius.md,
    opacity: 0.55,
  },
  skeletonDetails: {
    flex: 1,
    gap: spacing[2],
  },
  skeletonClimbName: {
    width: '74%',
    height: 20,
    borderRadius: borderRadius.full,
    opacity: 0.55,
  },
  skeletonMetaLine: {
    width: '64%',
    height: 14,
    borderRadius: borderRadius.full,
    opacity: 0.4,
  },
  skeletonCommentLine: {
    width: '92%',
    height: 12,
    borderRadius: borderRadius.full,
    opacity: 0.35,
  },
  skeletonCommentShortLine: {
    width: '58%',
    height: 12,
    borderRadius: borderRadius.full,
    opacity: 0.32,
  },
  skeletonSocialRow: {
    flexDirection: 'row',
    gap: spacing[2],
    marginTop: spacing[3],
    paddingTop: spacing[2],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  skeletonSocialPill: {
    width: 52,
    height: 28,
    borderRadius: borderRadius.full,
    opacity: 0.42,
  },
  feedState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: spacing[12],
    paddingHorizontal: spacing[8],
    gap: spacing[2],
  },
  emptyTitle: {
    marginTop: spacing[3],
    textAlign: 'center',
  },
  emptyBody: {
    textAlign: 'center',
  },
  emptyCta: {
    marginTop: spacing[4],
  },
});
