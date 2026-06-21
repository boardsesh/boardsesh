import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type BottomSheet from '@gorhom/bottom-sheet';
import type { SessionFeedItem, SessionFeedTickHighlight, SocialEntityType, UserBoard } from '@boardsesh/shared-schema';
import { betaLinkIdentity, isBetaVideoUrl, isInstagramUrl, isTikTokUrl } from '@boardsesh/shared-schema';
import { Text } from '../../../src/components/Text';
import { Icon } from '../../../src/components/Icon';
import type { IconName } from '../../../src/components/icon-map';
import { Card } from '../../../src/components/Card';
import { Button } from '../../../src/components/Button';
import { SessionFeedCard } from '../../../src/components/you/SessionFeedCard';
import { CommentSheet } from '../../../src/components/you/CommentSheet';
import { HomeTopChrome, TOP_ISLAND_BAND } from '../../../src/components/feed/HomeTopChrome';
import { type AppMenuAction } from '../../../src/components/AppMenu';
import {
  useBulkVoteSummaries,
  useRecentBetaLinks,
  useSessionGroupedFeed,
  type RecentBetaVideo,
} from '../../../src/lib/graphql/hooks';
import { useHomeBoard } from '../../../src/lib/graphql/hooks/use-home-board';
import { useAuth } from '../../../src/providers/auth-provider';
import { useTheme } from '../../../src/providers/theme-provider';
import { useToast } from '../../../src/providers/toast-provider';
import { useDrawerHost } from '../../../src/providers/drawer-host-provider';
import { useBottomChromeMetrics } from '../../../src/hooks/use-bottom-chrome-metrics';
import { dedupeSessionsById } from '../../../src/lib/feed-time-buckets';
import { deriveFeedScopeInput, type FeedMode } from '../../../src/lib/feed/feed-scope';
import { openClimbInPlayDrawer } from '../../../src/lib/open-climb-in-play-drawer';
import { openValidatedUrl } from '../../../src/lib/open-external-link';
import { hapticLight } from '../../../src/lib/haptics';
import { navigateToSessionFeedItem } from '../../../src/lib/session-feed-navigation';
import { iosSystemColors } from '../../../src/theme/ios-colors';
import { borderRadius, spacing } from '../../../src/theme/tokens';
import { BETA_CARD_HEIGHT, BETA_CARD_WIDTH } from '../../../src/components/play-drawer/BetaVideoCard';

const RECENT_BETA_LIMIT = 20;
const SHELF_GAP = spacing[3];
const BETA_SKELETON_KEYS = ['beta-skeleton-1', 'beta-skeleton-2', 'beta-skeleton-3'];
const INITIAL_FEED_SKELETON_KEYS = ['home-feed-skeleton-1', 'home-feed-skeleton-2', 'home-feed-skeleton-3'];
const NEXT_PAGE_FEED_SKELETON_KEYS = ['home-feed-footer-skeleton-1', 'home-feed-footer-skeleton-2'];

type CommentTarget = {
  entityId: string;
  entityType: SocialEntityType;
};

type VoteSummary = {
  upvotes: number;
  userVote: number | null;
};

function detectPlatform(url: string): { name: 'instagram' | 'tiktok'; icon: IconName } | null {
  if (isInstagramUrl(url)) return { name: 'instagram', icon: 'instagram' };
  if (isTikTokUrl(url)) return { name: 'tiktok', icon: 'tiktok' };
  return null;
}

export default function HomeTab() {
  const { t } = useTranslation('feed');
  const { t: tCommon } = useTranslation('common');
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const { systemColors, brandColors } = useTheme();
  const { openPlayDrawer } = useDrawerHost();
  const bottomChrome = useBottomChromeMetrics();
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlashListRef<SessionFeedItem>>(null);
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
  // The beta shelf rescopes to the selected board's type + layout ("Fresh beta
  // on this board"); with no board it stays global ("Fresh beta"). Layout
  // matters — a Kilter Original beta is useless on a Kilter Homewall.
  const betaBoardType = selectedBoard?.boardType ?? null;
  const betaLayoutId = selectedBoard?.layoutId ?? null;

  // Hold both queries until home-board inference settles, so a cold start never
  // fires the unscoped global feed first (initial state is gym + no board) and
  // then refetches the scoped/crew query — that double-fetch flickered the feed.
  const scopeReady = !isResolvingHomeBoard;
  const betaVideos = useRecentBetaLinks(RECENT_BETA_LIMIT, betaBoardType, betaLayoutId, scopeReady);
  const feed = useSessionGroupedFeed(feedInput, isAuthenticated && scopeReady);

  const sessions = useMemo(
    () => dedupeSessionsById(feed.data?.pages.flatMap((page) => page.sessionGroupedFeed.sessions) ?? []),
    [feed.data],
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
  const summaryMap = useMemo(() => {
    const map = new Map<string, VoteSummary>();
    for (const summary of sessionVoteSummaries.data ?? []) {
      map.set(`session:${summary.entityId}`, { upvotes: summary.upvotes, userVote: summary.userVote });
    }
    for (const summary of tickVoteSummaries.data ?? []) {
      map.set(`tick:${summary.entityId}`, { upvotes: summary.upvotes, userVote: summary.userVote });
    }
    return map;
  }, [sessionVoteSummaries.data, tickVoteSummaries.data]);

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

  const handleEndReached = useCallback(() => {
    if (feed.hasNextPage && !feed.isFetchingNextPage) void feed.fetchNextPage();
  }, [feed]);

  const handleRefresh = useCallback(() => {
    void betaVideos.refetch();
    void sessionVoteSummaries.refetch();
    void tickVoteSummaries.refetch();
    if (isAuthenticated) void feed.refetch();
  }, [betaVideos, feed, isAuthenticated, sessionVoteSummaries, tickVoteSummaries]);

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

  const renderItem = useCallback(
    ({ item }: { item: SessionFeedItem }) => (
      <SessionFeedCard
        session={item}
        voteSummary={summaryMap.get(`${item.socialEntityType}:${item.socialEntityId}`)}
        onOpenComments={handleOpenComments}
        onPress={handleSessionPress}
        onOpenClimb={handleOpenClimb}
      />
    ),
    [handleOpenComments, handleSessionPress, handleOpenClimb, summaryMap],
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

  const handleBetaOpenClimb = useCallback(
    (video: RecentBetaVideo) => {
      if (!video.betaLink.climb_uuid || !video.boardType || video.betaLink.angle == null) return;
      openClimbInPlayDrawer(
        {
          kind: 'ref',
          climbUuid: video.betaLink.climb_uuid,
          boardType: video.boardType,
          layoutId: video.layoutId,
          angle: video.betaLink.angle,
        },
        { openPlayDrawer, router },
      );
    },
    [openPlayDrawer, router],
  );

  const betaHeading = betaBoardType ? t('mobile.home.betaTitleBoard') : t('mobile.home.betaTitle');
  const sessionsHeading = mode === 'gym' ? t('mobile.home.sessionsTitle') : t('mobile.home.feedTitle');

  const header = useMemo(
    () => (
      <View style={styles.header}>
        <RecentBetaShelf
          heading={betaHeading}
          videos={betaVideos.data ?? []}
          isLoading={betaVideos.isLoading}
          isError={betaVideos.isError}
          onRetry={() => void betaVideos.refetch()}
          onOpenClimb={handleBetaOpenClimb}
        />
        <Text variant="title3" style={styles.feedHeading}>
          {sessionsHeading}
        </Text>
      </View>
    ),
    [
      betaHeading,
      betaVideos.data,
      betaVideos.isError,
      betaVideos.isLoading,
      betaVideos.refetch,
      handleBetaOpenClimb,
      sessionsHeading,
    ],
  );

  if (!isAuthenticated) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
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
        data={sessions}
        extraData={summaryMap}
        renderItem={renderItem}
        keyExtractor={(item) => item.sessionId}
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
          <RefreshControl
            refreshing={betaVideos.isRefetching || feed.isRefetching}
            onRefresh={handleRefresh}
            tintColor={brandColors.primary}
          />
        }
        ListEmptyComponent={
          feed.isLoading || !scopeReady ? (
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
          ) : mode === 'gym' && selectedBoard != null ? (
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
          )
        }
        ListFooterComponent={
          feed.isFetchingNextPage ? <ActivitySkeletonList skeletonKeys={NEXT_PAGE_FEED_SKELETON_KEYS} /> : null
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

function RecentBetaShelf({
  heading,
  videos,
  isLoading,
  isError,
  onRetry,
  onOpenClimb,
}: {
  heading: string;
  videos: RecentBetaVideo[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onOpenClimb: (video: RecentBetaVideo) => void;
}) {
  const { t } = useTranslation('feed');
  const { t: tCommon } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();

  return (
    <View style={styles.shelfSection}>
      <View style={styles.sectionHeaderRow}>
        <Text variant="title3">{heading}</Text>
      </View>
      {isLoading ? (
        <FlatList
          horizontal
          data={BETA_SKELETON_KEYS}
          renderItem={({ item }) => <View key={item} style={styles.betaSkeleton} />}
          keyExtractor={(item) => item}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.shelfContent}
          ItemSeparatorComponent={BetaShelfSeparator}
          scrollEnabled={false}
        />
      ) : isError ? (
        <View style={[styles.shelfState, { borderColor: systemColors.separator }]}>
          <Icon name="error" size={20} color={iosSystemColors.systemRed} />
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.shelfStateText}>
            {t('mobile.home.betaError')}
          </Text>
          <Pressable
            onPress={onRetry}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.inlineRetry,
              { borderColor: brandColors.primary },
              pressed && { backgroundColor: `${brandColors.primary}1A` },
            ]}
          >
            <Text variant="footnote" color={brandColors.primary}>
              {tCommon('actions.retry')}
            </Text>
          </Pressable>
        </View>
      ) : videos.length === 0 ? (
        <View style={[styles.shelfState, { borderColor: systemColors.separator }]}>
          <Icon name="video" size={20} color={systemColors.tertiaryLabel} />
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            {t('mobile.home.betaEmpty')}
          </Text>
        </View>
      ) : (
        <FlatList
          horizontal
          data={videos}
          renderItem={({ item }) => <RecentBetaCard video={item} onOpenClimb={onOpenClimb} />}
          keyExtractor={(video) => betaLinkIdentity(video.betaLink.link)}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.shelfContent}
          ItemSeparatorComponent={BetaShelfSeparator}
          snapToInterval={BETA_CARD_WIDTH + SHELF_GAP}
          decelerationRate="fast"
          snapToAlignment="start"
          initialNumToRender={5}
          maxToRenderPerBatch={5}
          windowSize={3}
          removeClippedSubviews
          getItemLayout={(_data, index) => ({
            length: BETA_CARD_WIDTH + SHELF_GAP,
            offset: (BETA_CARD_WIDTH + SHELF_GAP) * index,
            index,
          })}
        />
      )}
    </View>
  );
}

function BetaShelfSeparator() {
  return <View style={styles.shelfSeparator} />;
}

function RecentBetaCard({
  video,
  onOpenClimb,
}: {
  video: RecentBetaVideo;
  onOpenClimb: (video: RecentBetaVideo) => void;
}) {
  const { t } = useTranslation('feed');
  const { showToast } = useToast();
  const [imageFailed, setImageFailed] = useState(false);
  const platform = detectPlatform(video.betaLink.link);
  const username = video.betaLink.foreign_username?.trim();

  const handleOpenVideo = useCallback(async () => {
    hapticLight();
    const opened = await openValidatedUrl(video.betaLink.link, isBetaVideoUrl);
    if (!opened) {
      showToast(t('mobile.home.betaOpenError'), 'error');
    }
  }, [showToast, t, video.betaLink.link]);

  return (
    <View style={styles.betaCard}>
      <Pressable
        onPress={handleOpenVideo}
        accessibilityRole="link"
        accessibilityLabel={t('mobile.home.betaCardLabel')}
        style={({ pressed }) => [styles.betaVideoSurface, pressed && styles.pressed]}
      >
        {video.betaLink.thumbnail && !imageFailed ? (
          <Image
            source={{ uri: video.betaLink.thumbnail }}
            style={styles.betaThumbnail}
            contentFit="cover"
            transition={150}
            recyclingKey={video.betaLink.thumbnail}
            onError={() => setImageFailed(true)}
            accessibilityIgnoresInvertColors
          />
        ) : (
          <View style={[styles.betaThumbnail, styles.thumbnailFallback]}>
            <Icon name="video" size={28} color={iosSystemColors.systemGray} />
          </View>
        )}

        {platform ? (
          <View style={styles.platformBadge}>
            <Icon name={platform.icon} size={12} color={iosSystemColors.white} />
          </View>
        ) : null}
      </Pressable>

      <View style={styles.betaCardFooter}>
        <Pressable
          onPress={() => onOpenClimb(video)}
          accessibilityRole="button"
          style={({ pressed }) => [styles.climbPill, pressed && styles.climbPillPressed]}
          hitSlop={6}
        >
          <Text variant="caption1" color={iosSystemColors.white} numberOfLines={1}>
            {video.climbName ?? t('mobile.home.unknownClimb')}
          </Text>
        </Pressable>
        {username ? (
          <Text variant="caption2" color={iosSystemColors.white} numberOfLines={1} style={styles.usernameText}>
            @{username}
          </Text>
        ) : null}
      </View>
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
  shelfSection: {
    paddingBottom: spacing[5],
  },
  sectionHeaderRow: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
  },
  shelfContent: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[1],
  },
  shelfSeparator: {
    width: SHELF_GAP,
  },
  betaCard: {
    width: BETA_CARD_WIDTH,
    height: BETA_CARD_HEIGHT,
    borderRadius: borderRadius.md,
    overflow: 'hidden',
    backgroundColor: `${iosSystemColors.systemGray}1F`,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: iosSystemColors.separator,
  },
  betaSkeleton: {
    width: BETA_CARD_WIDTH,
    height: BETA_CARD_HEIGHT,
    borderRadius: borderRadius.md,
    backgroundColor: `${iosSystemColors.systemGray}26`,
  },
  pressed: {
    opacity: 0.85,
    transform: [{ scale: 0.97 }],
  },
  betaVideoSurface: {
    width: '100%',
    height: '100%',
  },
  betaThumbnail: {
    width: '100%',
    height: '100%',
  },
  thumbnailFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  platformBadge: {
    position: 'absolute',
    top: spacing[1],
    left: spacing[1],
    width: 22,
    height: 22,
    borderRadius: borderRadius.full,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  betaCardFooter: {
    position: 'absolute',
    bottom: spacing[1],
    left: spacing[1],
    right: spacing[1],
    gap: spacing[1],
  },
  climbPill: {
    alignSelf: 'flex-start',
    maxWidth: BETA_CARD_WIDTH - spacing[2] * 2,
    paddingHorizontal: spacing[2],
    paddingVertical: 3,
    borderRadius: borderRadius.full,
    backgroundColor: 'rgba(0,0,0,0.62)',
  },
  climbPillPressed: {
    backgroundColor: 'rgba(0,0,0,0.8)',
  },
  usernameText: {
    paddingHorizontal: spacing[1],
    textShadowColor: 'rgba(0,0,0,0.75)',
    textShadowRadius: 3,
  },
  shelfState: {
    marginHorizontal: spacing[4],
    minHeight: 72,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: borderRadius.md,
    padding: spacing[3],
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  shelfStateText: {
    flex: 1,
  },
  inlineRetry: {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
    borderRadius: borderRadius.full,
    borderWidth: StyleSheet.hairlineWidth,
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
  activityHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  activityHeaderText: {
    flex: 1,
  },
  activityBody: {
    flexDirection: 'row',
    gap: spacing[3],
    paddingTop: spacing[3],
  },
  activityThumbnailFallback: {
    width: 76,
    height: 96,
    borderRadius: borderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activityDetails: {
    flex: 1,
    gap: spacing[2],
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing[1],
  },
  metaChip: {
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
    borderRadius: borderRadius.full,
  },
  quote: {
    paddingTop: spacing[1],
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
