import { SMART_PLAYLIST_COUNTS_QUERY_KEY } from '@boardsesh/playlists-react';
import type {
  CrewFeedItem,
  SessionFeedItem,
  SessionFeedTickHighlight,
  SocialEntityType,
  UserBoard,
} from '@boardsesh/shared-schema';
import type { BottomSheet } from '@expo/ui/community/bottom-sheet';
import { type FlashListRef, type ListRenderItemInfo } from '@shopify/flash-list';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { type AppMenuAction } from '../../../src/components/AppMenu';
import { AppStorePrompt } from '../../../src/components/AppStorePrompt';
import { HomeTopChrome, TOP_ISLAND_BAND } from '../../../src/components/feed/HomeTopChrome';
import { NewClimbFeedCard } from '../../../src/components/feed/NewClimbFeedCard';
import { HomeCustomizeSheet } from '../../../src/components/home/HomeCustomizeSheet';
import { HomeHeaderView } from '../../../src/components/home/HomeHeaderView';
import { HomeSections } from '../../../src/components/home/HomeSections';
import { HomeSupportCard } from '../../../src/components/home/HomeSupportCard';
import { HomeView } from '../../../src/components/home/HomeView';
import { InviteSheet } from '../../../src/components/session-screen/InviteSheet';
import { useSessionWorkoutHeadlines } from '../../../src/components/session/workout/use-session-workout-view';
import { CommentSheet } from '../../../src/components/you/CommentSheet';
import { SessionFeedCard } from '../../../src/components/you/SessionFeedCard';
import { useBottomChromeMetrics } from '../../../src/hooks/use-bottom-chrome-metrics';
import { useHideOnScroll } from '../../../src/hooks/use-hide-on-scroll';
import { useMountedOnFirstOpen } from '../../../src/hooks/use-mounted-on-first-open';
import { useNativeRootHeader } from '../../../src/hooks/use-native-root-header';
import { useOfflineQueryState } from '../../../src/hooks/use-offline-query-state';
import { useScrollEdgeBackdrop } from '../../../src/hooks/use-scroll-edge-backdrop';
import { dedupeSessionsById } from '../../../src/lib/feed-time-buckets';
import { createFeedPageGate, requiresCrewPageTap } from '../../../src/lib/feed/crew-page-state';
import { deriveFeedScopeInput, type FeedMode } from '../../../src/lib/feed/feed-scope';
import { buildVoteSummaryMap, voteSummaryKey, type VoteSummary } from '../../../src/lib/feed/vote-summary-map';
import { useBulkVoteSummaries, useSessionGroupedFeed } from '../../../src/lib/graphql/hooks';
import { useCrewFeed } from '../../../src/lib/graphql/hooks/use-crew-feed';
import { useHomeBoard } from '../../../src/lib/graphql/hooks/use-home-board';
import {
  FOLLOWED_LIVE_SESSIONS_QUERY_KEY,
  RECENT_BETA_LINKS_QUERY_KEY,
  SESSION_SUMMARY_QUERY_KEY,
} from '../../../src/lib/graphql/query-keys';
import { hapticLight } from '../../../src/lib/haptics';
import { useHomeSectionLayout, visibleTopHomeSections } from '../../../src/lib/home-sections';
import { useTickListActivation } from '../../../src/lib/playlists/use-tick-list-activation';
import { useScopedRouter as useRouter } from '../../../src/lib/routing/scoped-navigation';
import { navigateToSessionFeedItem } from '../../../src/lib/session-feed-navigation';
import { useAuth } from '../../../src/providers/auth-provider';

import { useHasBeenFocused } from '../../../src/hooks/use-has-been-focused';
import { HomeStartupCommit } from '../../../src/lib/profiling/HomeStartupCommit';
import { homeEmptyStartupOutcome } from '../../../src/lib/profiling/startup-collector';
import { STARTUP_PROFILING_ENABLED } from '../../../src/lib/profiling/startup-profile';

type CommentTarget = {
  entityId: string;
  entityType: SocialEntityType;
};

// Hoisted so the FlashList `keyExtractor` prop keeps a stable identity across
// renders (perf playbook rule 3) instead of a fresh inline arrow each pass.
const NO_FEED_ITEMS: CrewFeedItem[] = [];
// A session card shows one climb, so it plays from a list of just that one.
const NO_TICKS: SessionFeedTickHighlight[] = [];
const NO_SESSION_ID_PAGES: readonly (readonly string[])[] = [];

export default function HomeTab() {
  const nativeRootHeader = useNativeRootHeader();
  const { t } = useTranslation('feed');
  const { t: tCommon } = useTranslation('common');
  const { t: tSession } = useTranslation('session');
  const router = useRouter();
  const queryClient = useQueryClient();
  const { isAuthenticated } = useAuth();
  const bottomChrome = useBottomChromeMetrics();
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlashListRef<CrewFeedItem>>(null);
  const commentSheetRef = useRef<BottomSheet | null>(null);
  const [commentTarget, setCommentTarget] = useState<CommentTarget | null>(null);
  // UIKit owns its title inset. Other variants measure the floating chrome.
  const [chromeHeight, setChromeHeight] = useState(() => (nativeRootHeader ? 0 : insets.top + TOP_ISLAND_BAND));
  // Tells the Material app bar when the feed has scrolled under it. `list` stays
  // undefined, and the feed listener-free, until a bar attaches.
  const scrollEdge = useScrollEdgeBackdrop();
  // The Android nav bar hides as the feed scrolls down (`useHideOnScroll`).
  const handleScroll = useHideOnScroll(scrollEdge.list?.listProps.onScroll);

  // Which sections the climber shows, and in what order (Customize Home). Read
  // synchronously, so a hidden section never mounts and its queries never start.
  // The default is today's Home: Climbing now, then the feed.
  const sectionLayout = useHomeSectionLayout();
  const feedVisible = sectionLayout.visible.feed;
  const climbingNowVisible = sectionLayout.visible.climbingNow;
  // The scope menu picks whose sessions the feed and Climbing now show; without
  // either there is nothing for it to scope.
  const scopeVisible = feedVisible || climbingNowVisible;
  const topSectionIds = useMemo(() => visibleTopHomeSections(sectionLayout), [sectionLayout]);
  const homeEmpty = topSectionIds.length === 0 && !feedVisible;
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const mountCustomizeSheet = useMountedOnFirstOpen(customizeOpen);
  const handleOpenCustomize = useCallback(() => setCustomizeOpen(true), []);
  const handleCloseCustomize = useCallback(() => setCustomizeOpen(false), []);

  // Feed scope. `mode` chooses the view — `crew` (people you follow) is the
  // default; `gym` is everyone on the selected board. `selectedBoard` is the
  // gym/board both views filter to (`null` = unscoped: crew across all boards,
  // or the "Everyone" global feed). It defaults to the inferred home board once
  // it resolves; the view stays on `crew`.
  const { board: homeBoard, isResolving: isResolvingHomeBoard, boards: ownedBoards } = useHomeBoard();
  const [mode, setMode] = useState<FeedMode>('crew');
  const [selectedBoard, setSelectedBoard] = useState<UserBoard | null>(null);
  // Once home-board inference settles, point the crew/gym filter at the home
  // board. The view stays on `crew`; with no home board it's the unfiltered crew.
  // During render, not in an effect: React re-renders with the board before it
  // commits, so nothing that waits on `scopeReady` (Fresh beta, the feeds) ever
  // asks once for every board and again for this one.
  // Until the climber picks a scope from the menu, the scope follows the home
  // board: a Change board from Your board's card moves Fresh beta, the gym feed
  // and Climbing now with it. A board or Everyone picked from the menu stays.
  // `undefined` until inference first settles.
  const [scopedHomeBoardUuid, setScopedHomeBoardUuid] = useState<string | null | undefined>(undefined);
  const [hasChosenScope, setHasChosenScope] = useState(false);
  const homeBoardUuid = homeBoard?.uuid ?? null;
  if (!isResolvingHomeBoard && scopedHomeBoardUuid !== homeBoardUuid) {
    setScopedHomeBoardUuid(homeBoardUuid);
    if (!hasChosenScope) setSelectedBoard(homeBoard);
  }
  const hasDefaultedScope = scopedHomeBoardUuid !== undefined;

  const feedInput = useMemo(() => deriveFeedScopeInput(mode, selectedBoard?.uuid ?? null), [mode, selectedBoard]);
  // "Climbing now" adds the selected board's sessions only when the climber is
  // looking at that board (gym mode); crew mode is people only.
  const liveBoardUuid = mode === 'gym' ? (selectedBoard?.uuid ?? null) : null;

  // Hold both queries until home-board inference settles, so a cold start never
  // fires the unscoped global feed first (initial state is gym + no board) and
  // then refetches the scoped/crew query — that double-fetch flickered the feed.
  // NativeTabs mounts every tab at launch, so the feeds also wait for Home's
  // first focus (see useHasBeenFocused); a launch on Climbs no longer pays them.
  const hasBeenFocused = useHasBeenFocused();
  const scopeReady = hasDefaultedScope && !isResolvingHomeBoard && hasBeenFocused;
  const feedEnabled = isAuthenticated && scopeReady && feedVisible;
  const sessionFeed = useSessionGroupedFeed(feedInput, feedEnabled && mode === 'gym');
  const crewFeed = useCrewFeed(feedEnabled && mode === 'crew');
  const feed = mode === 'crew' ? crewFeed : sessionFeed;
  // A visibility recheck can remove every candidate from one page. Advancing
  // that cursor needs an explicit tap, not an automatic drain of sparse pages.
  const lastCrewPage = crewFeed.data?.pages.at(-1)?.crewFeed;
  const requiresManualPage = feedVisible && mode === 'crew' && requiresCrewPageTap(lastCrewPage);
  const pageGateRef = useRef(createFeedPageGate());
  const pageSource = mode === 'crew' ? 'crew' : `gym:${selectedBoard?.uuid ?? 'everyone'}`;
  // The feed is network-only and `networkMode: 'offlineFirst'` pauses an offline
  // fetch instead of failing it, so neither `isLoading` nor `isError` ever
  // resolves — the skeleton list would sit there for good.
  const feedOffline = useOfflineQueryState(feed);

  const feedItems = useMemo<CrewFeedItem[]>(() => {
    // A hidden feed shows nothing, even with pages still cached from before.
    if (!feedVisible) return NO_FEED_ITEMS;
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
  }, [feedVisible, mode, crewFeed.data, sessionFeed.data]);
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

  // Each session card's workout line (#6903): one headline request per loaded
  // feed page. Read through a ref like the vote map, so `renderItem` stays
  // stable; `listExtraData` below re-invokes it when a line arrives.
  const sessionIdPages = useMemo(() => {
    if (!feedVisible) return NO_SESSION_ID_PAGES;
    if (mode === 'crew') {
      return (
        crewFeed.data?.pages.map((page) =>
          page.crewFeed.items.flatMap((item) =>
            item.__typename === 'CrewSessionItem' ? [item.session.sessionId] : [],
          ),
        ) ?? NO_SESSION_ID_PAGES
      );
    }
    return (
      sessionFeed.data?.pages.map((page) => page.sessionGroupedFeed.sessions.map((session) => session.sessionId)) ??
      NO_SESSION_ID_PAGES
    );
  }, [feedVisible, mode, crewFeed.data, sessionFeed.data]);
  const workoutHeadlines = useSessionWorkoutHeadlines(sessionIdPages);
  const workoutHeadlinesRef = useRef(workoutHeadlines);
  workoutHeadlinesRef.current = workoutHeadlines;
  const listExtraData = useMemo(() => ({ summaryMap, workoutHeadlines }), [summaryMap, workoutHeadlines]);

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

  // A session card's hardest send opens like a row of any list (issue #6665):
  // driving the wall (a swipe, Put on board or Always drive the wall) decides
  // whether it goes up, and it plays from a one-climb list of its own.
  const handleOpenClimb = useTickListActivation<SessionFeedTickHighlight>({
    sourceId: 'home-session-cards',
    label: tSession('playView.track.hardestSend'),
    rows: NO_TICKS,
  });

  const loadNextPage = useCallback(() => {
    // A disabled query still pages on request, so a hidden feed must not ask.
    if (!feedVisible || !feed.hasNextPage || feed.isFetchingNextPage || !pageGateRef.current.claim(pageSource)) {
      return;
    }
    // Promise cleanup still runs after unmount. A remount owns a fresh ref, so
    // this completion can only release the old instance's gate.
    void feed.fetchNextPage().finally(() => {
      pageGateRef.current.release(pageSource);
    });
  }, [feedVisible, feed.hasNextPage, feed.isFetchingNextPage, feed.fetchNextPage, pageSource]);
  const handleEndReached = useCallback(() => {
    if (!requiresManualPage) loadNextPage();
  }, [requiresManualPage, loadNextPage]);

  const sessionCardVisible = sectionLayout.visible.session;
  const playlistsVisible = sectionLayout.visible.playlists;
  const betaVisible = sectionLayout.visible.beta;
  // The spinner follows the feed's refetch while the feed shows, as it always
  // has. Without the feed it follows the sections' own refetches.
  const [sectionsRefreshing, setSectionsRefreshing] = useState(false);
  // Which pull is the latest, so an earlier one settling can't drop the spinner
  // while a later one is still out.
  const latestRefreshRef = useRef(0);
  const handleRefresh = useCallback(() => {
    // Only what is on screen. Each section subscribes to its own query, so the
    // screen refreshes it by key; Your board reads the phone and has nothing to fetch.
    const sectionRefetches: Promise<void>[] = [];
    if (climbingNowVisible) {
      sectionRefetches.push(queryClient.invalidateQueries({ queryKey: FOLLOWED_LIVE_SESSIONS_QUERY_KEY }));
    }
    if (sessionCardVisible)
      sectionRefetches.push(queryClient.invalidateQueries({ queryKey: [SESSION_SUMMARY_QUERY_KEY] }));
    if (playlistsVisible) {
      sectionRefetches.push(queryClient.invalidateQueries({ queryKey: [SMART_PLAYLIST_COUNTS_QUERY_KEY] }));
    }
    if (betaVisible) sectionRefetches.push(queryClient.invalidateQueries({ queryKey: [RECENT_BETA_LINKS_QUERY_KEY] }));
    if (sectionRefetches.length > 0) {
      latestRefreshRef.current += 1;
      const refresh = latestRefreshRef.current;
      setSectionsRefreshing(true);
      void Promise.allSettled(sectionRefetches).then(() => {
        if (latestRefreshRef.current === refresh) setSectionsRefreshing(false);
      });
    }
    if (!feedVisible) return;
    void sessionVoteSummaries.refetch();
    void tickVoteSummaries.refetch();
    if (isAuthenticated) void feed.refetch();
  }, [
    queryClient,
    climbingNowVisible,
    sessionCardVisible,
    playlistsVisible,
    betaVisible,
    feedVisible,
    feed,
    isAuthenticated,
    sessionVoteSummaries,
    tickVoteSummaries,
  ]);

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
    setHasChosenScope(true);
    setSelectedBoard(board);
    setMode('gym');
  }, []);

  const handleSelectEveryone = useCallback(() => {
    hapticLight();
    setHasChosenScope(true);
    setSelectedBoard(null);
    setMode('gym');
  }, []);

  const handleFindGym = useCallback(() => {
    router.push('/gyms');
  }, [router]);

  const handleBrowseEveryone = useCallback(() => {
    setHasChosenScope(true);
    setSelectedBoard(null);
    setMode('gym');
  }, []);

  // Read the map through `summaryMapRef` (not `summaryMap`) so this stays
  // referentially stable across vote/page updates — `extraData={listExtraData}` is
  // the single signal that re-invokes it. A churning `renderItem` would force
  // FlashList to re-render regardless of `extraData` (perf playbook rule 3).
  const renderItem = useCallback(
    ({ item, target }: ListRenderItemInfo<CrewFeedItem>) => (
      <View testID={target === 'Cell' ? 'home-feed-item' : undefined} collapsable={false}>
        {STARTUP_PROFILING_ENABLED && target === 'Cell' ? <HomeStartupCommit outcome="content" /> : null}
        {item.__typename === 'CrewClimbItem' || item.__typename === 'CrewClimbGroupItem' ? (
          <NewClimbFeedCard item={item} />
        ) : (
          <SessionFeedCard
            session={item.session}
            voteSummary={summaryMapRef.current.get(
              voteSummaryKey(item.session.socialEntityType, item.session.socialEntityId),
            )}
            onOpenComments={handleOpenComments}
            onPress={handleSessionPress}
            onOpenClimb={handleOpenClimb}
            workoutHeadline={workoutHeadlinesRef.current.get(item.session.sessionId)}
          />
        )}
      </View>
    ),
    [handleOpenComments, handleSessionPress, handleOpenClimb],
  );

  // The scope menu: "My crew" (default), the home gym/board, any other owned
  // boards, "Everyone", and "Find a gym". The active scope carries a checkmark
  // and doubles as the large title. `onSelectIndex` runs the tapped item.
  const scopeMenu = useMemo(() => {
    // Nothing to scope: the chrome shows a plain "Home" title instead of the menu.
    if (!scopeVisible) {
      return { title: tCommon('mobile.nav.home'), actions: [], onSelectIndex: () => {} };
    }
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
    tCommon,
    scopeVisible,
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

  // No query data in these deps: every section subscribes to its own data, and a
  // dep that changed on every poll would rebuild the FlashList header each minute.
  // The layout changes only when the climber edits it.
  const header = useMemo(
    () => (
      <HomeHeaderView
        scope={
          nativeRootHeader && scopeVisible
            ? {
                title: scopeMenu.title,
                actions: scopeMenu.actions,
                onSelectIndex: scopeMenu.onSelectIndex,
                accessibilityHint: t('mobile.home.scope.hint'),
              }
            : undefined
        }
        notices={
          <>
            <HomeSupportCard />
            <AppStorePrompt surface="home" />
          </>
        }
        sections={
          <HomeSections
            sectionIds={topSectionIds}
            cardsReady={hasBeenFocused}
            liveBoardUuid={liveBoardUuid}
            liveEnabled={scopeReady}
            betaBoardType={selectedBoard?.boardType ?? null}
            betaLayoutId={selectedBoard?.layoutId ?? null}
            onInvite={handleOpenInvite}
          />
        }
        showCustomize={!homeEmpty}
        onCustomize={handleOpenCustomize}
        heading={feedVisible ? sessionsHeading : undefined}
      />
    ),
    [
      nativeRootHeader,
      scopeVisible,
      scopeMenu,
      t,
      topSectionIds,
      hasBeenFocused,
      liveBoardUuid,
      scopeReady,
      selectedBoard,
      handleOpenInvite,
      homeEmpty,
      handleOpenCustomize,
      feedVisible,
      sessionsHeading,
    ],
  );

  return (
    <HomeView
      isAuthenticated={isAuthenticated}
      feedItems={feedItems}
      renderItem={renderItem}
      listRef={listRef}
      listExtraData={listExtraData}
      nativeRootHeader={nativeRootHeader}
      chromeHeight={chromeHeight}
      bottomInset={bottomChrome.scrollBottomPadding}
      scrollEdge={scrollEdge.list}
      handleScroll={handleScroll}
      handleEndReached={handleEndReached}
      handleRefresh={handleRefresh}
      handleOpenCustomize={handleOpenCustomize}
      handleBrowseEveryone={handleBrowseEveryone}
      loadNextPage={loadNextPage}
      onSignIn={() => router.push('/auth/login')}
      header={header}
      chrome={
        <HomeTopChrome
          showScopeMenu={scopeVisible}
          scopeTitle={scopeMenu.title}
          scopeActions={scopeMenu.actions}
          onSelectScopeIndex={scopeMenu.onSelectIndex}
          onOpenSearch={handleOpenSearch}
          searchAccessibilityLabel={t('mobile.home.searchAction')}
          scopeAccessibilityHint={t('mobile.home.scope.hint')}
          onHeightChange={setChromeHeight}
          scrollEdge={scrollEdge.backdrop}
        />
      }
      overlays={
        <>
          <CommentSheet
            sheetRef={commentSheetRef}
            entityId={commentTarget?.entityId ?? null}
            entityType={commentTarget?.entityType ?? 'tick'}
            onClose={() => setCommentTarget(null)}
          />
          {inviteSessionId ? (
            <InviteSheet visible={inviteOpen} onDismiss={handleDismissInvite} sessionId={inviteSessionId} />
          ) : null}
          {mountCustomizeSheet ? <HomeCustomizeSheet visible={customizeOpen} onClose={handleCloseCustomize} /> : null}
        </>
      }
      feedVisible={feedVisible}
      homeEmpty={homeEmpty}
      sectionsRefreshing={sectionsRefreshing}
      scopeReady={scopeReady}
      requiresManualPage={requiresManualPage}
      mode={mode}
      selectedBoard={selectedBoard}
      feedOffline={feedOffline}
      feed={feed}
      emptyMarker={
        STARTUP_PROFILING_ENABLED ? (
          <HomeStartupCommit
            outcome={
              !feedVisible
                ? homeEmpty
                  ? 'empty'
                  : 'content'
                : homeEmptyStartupOutcome({
                    authenticated: isAuthenticated,
                    blockedReason: feedOffline.isBlocked ? feedOffline.reason : null,
                    loading: feed.isLoading,
                    scopeReady,
                    error: feed.isError,
                  })
            }
          />
        ) : undefined
      }
    />
  );
}
