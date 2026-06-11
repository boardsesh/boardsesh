import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Animated, { useAnimatedRef, useAnimatedScrollHandler, useSharedValue } from 'react-native-reanimated';
import { useQueryClient } from '@tanstack/react-query';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import {
  useDiscoverPlaylists,
  useUserPlaylists,
  usePinnedPlaylists,
  useSmartPlaylistCounts,
  usePlaylistMutations,
} from '@boardsesh/playlists-react';
import type { DiscoverablePlaylist, Playlist, SmartPlaylistType } from '@boardsesh/graphql/operations/playlists';
import { Text } from '../../../src/components/Text';
import { Icon } from '../../../src/components/Icon';
import { ActivityIndicator } from '../../../src/components/ActivityIndicator';
import { SectionHeader } from '../../../src/components/SectionHeader';
import {
  PlaylistCard,
  PlaylistScrollSection,
  PlaylistFormSheet,
  type PlaylistFormValues,
} from '../../../src/components/playlist';
import { DiscoverTopChrome } from '../../../src/components/chrome';
import { SMART_PLAYLISTS, type SmartPlaylistPresentation } from '../../../src/lib/smart-playlists';
import { useAuth } from '../../../src/providers/auth-provider';
import { useTheme } from '../../../src/providers/theme-provider';
import { useToast } from '../../../src/providers/toast-provider';
import { useAuthToken } from '../../../src/lib/graphql/use-auth-token';
import { useProfile } from '../../../src/lib/graphql/hooks';
import { useActiveBoard } from '../../../src/lib/graphql/use-active-board';
import { useBottomChromeMetrics } from '../../../src/hooks/use-bottom-chrome-metrics';
import { iosSystemColors } from '../../../src/theme/ios-colors';
import { spacing } from '../../../src/theme/tokens';

const FOR_YOU_SMART_PLAYLIST_TYPES: SmartPlaylistType[] = [
  'LIKED_CLIMBS',
  'FIVE_STARS',
  'PROJECTS',
  'MOST_REPEATED',
  'RECOMMENDED_CROWD_FAVORITES',
  'RECOMMENDED_HIDDEN_GEMS',
  'RECOMMENDED_AT_LEVEL',
  'RECOMMENDED_FRESH',
];

const PINNED_SMART_PLAYLISTS_STORAGE_PREFIX = 'boardsesh_pinned_smart_playlists_v1';

function isForYouSmartPlaylistType(value: unknown): value is SmartPlaylistType {
  return typeof value === 'string' && FOR_YOU_SMART_PLAYLIST_TYPES.includes(value as SmartPlaylistType);
}

function parsePinnedSmartPlaylistTypes(raw: string | null): SmartPlaylistType[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<SmartPlaylistType>();
    const pinnedTypes: SmartPlaylistType[] = [];
    for (const maybeType of parsed) {
      if (!isForYouSmartPlaylistType(maybeType) || seen.has(maybeType)) continue;
      seen.add(maybeType);
      pinnedTypes.push(maybeType);
    }
    return pinnedTypes;
  } catch {
    return [];
  }
}

function pinnedSmartPlaylistsStorageKey(userId: string): string {
  return `${PINNED_SMART_PLAYLISTS_STORAGE_PREFIX}_${userId}`;
}

export default function DiscoverLibrary() {
  const { t } = useTranslation('playlists');
  const { brandColors } = useTheme();
  const bottomChrome = useBottomChromeMetrics();
  const insets = useSafeAreaInsets();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { data: token = null, isLoading: tokenLoading } = useAuthToken();
  const { data: profile, isLoading: profileLoading } = useProfile({ enabled: isAuthenticated });
  const { data: activeBoard, isLoading: activeBoardLoading } = useActiveBoard();
  const queryClient = useQueryClient();

  const userId = profile?.id ?? null;
  const effectiveToken = isAuthenticated ? token : null;

  // The board pill in the top chrome is the default filter: every section scopes
  // to the active board's boardType + layoutId (the shared hooks reset on
  // change). With no active board yet, sections stay unscoped so a signed-out or
  // not-yet-onboarded user still sees community playlists.
  const filterBoardType = activeBoard?.boardType;
  const filterLayoutId = activeBoard?.layoutId;

  // Measured top-chrome height so the scroll content clears the floating islands
  // (seeded to the safe-area top + a row, like the Climbs list).
  const [chromeHeight, setChromeHeight] = useState(() => insets.top + 56);

  // Scroll offset drives the in-body "Discover" title collapsing into the chrome;
  // tapping the collapsed title capsule scrolls back to the top.
  const listRef = useAnimatedRef<Animated.ScrollView>();
  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((event) => {
    scrollY.value = event.contentOffset.y;
  });
  const handleScrollToTop = useCallback(() => {
    listRef.current?.scrollTo({ y: 0, animated: true });
  }, [listRef]);

  const {
    data: smartCounts,
    isLoading: smartCountsLoading,
    isError: smartCountsError,
    refetch: refetchSmartCounts,
  } = useSmartPlaylistCounts({
    token: effectiveToken,
    tokenLoading,
    isAuthenticated,
  });

  // Owned playlists (paginated). Feeds the "See all" affordance and receives
  // refreshes after creates/pin changes.
  const {
    playlists: userPlaylists,
    isLoading: userLoading,
    isLoadingMore: userLoadingMore,
    hasError: userError,
    loadMore: loadMoreUser,
    refetch: refetchUser,
  } = useUserPlaylists({
    token: effectiveToken,
    boardType: filterBoardType,
    layoutId: filterLayoutId,
    pageSize: 20,
  });

  const { pinned: pinnedPlaylists, refetch: refetchPinned } = usePinnedPlaylists({
    token: effectiveToken,
    boardType: filterBoardType,
    layoutId: filterLayoutId,
    candidatePlaylists: [],
  });

  // Community playlists (popular + recent streams, merged).
  const {
    popular: communityPopular,
    recent: communityRecent,
    isLoading: communityLoading,
    isLoadingMore: communityLoadingMore,
    hasError: communityError,
    loadMore: loadMoreCommunity,
    refetch: refetchCommunity,
  } = useDiscoverPlaylists({
    boardType: filterBoardType,
    layoutId: filterLayoutId,
    pageSize: 10,
    generatedRecommendation: false,
    enabled: !activeBoardLoading,
  });

  // Merge community popular + recent, de-duped and excluding the current user's own.
  const communityItems = useMemo(() => {
    const merged: DiscoverablePlaylist[] = [];
    const seen = new Set<string>();
    for (const playlist of [...communityPopular, ...communityRecent]) {
      if (seen.has(playlist.uuid)) continue;
      if (userId && playlist.creatorId === userId) continue;
      seen.add(playlist.uuid);
      merged.push(playlist);
    }
    return merged;
  }, [communityPopular, communityRecent, userId]);

  const smartCountsByType = useMemo(
    () => new Map((smartCounts ?? []).map((smartCount) => [smartCount.type, smartCount.count])),
    [smartCounts],
  );

  const [pinnedSmartPlaylistTypes, setPinnedSmartPlaylistTypes] = useState<SmartPlaylistType[]>([]);
  const [smartPinsHydrated, setSmartPinsHydrated] = useState(false);
  const pinnedSmartPlaylistTypesRef = useRef<SmartPlaylistType[]>([]);
  const smartPinsTouchedRef = useRef(false);

  useEffect(() => {
    smartPinsTouchedRef.current = false;
    setSmartPinsHydrated(false);
    if (!userId) {
      pinnedSmartPlaylistTypesRef.current = [];
      setPinnedSmartPlaylistTypes([]);
      setSmartPinsHydrated(true);
      return;
    }

    let cancelled = false;
    AsyncStorage.getItem(pinnedSmartPlaylistsStorageKey(userId))
      .then((raw) => {
        if (cancelled || smartPinsTouchedRef.current) return;
        const loadedPinnedTypes = parsePinnedSmartPlaylistTypes(raw);
        pinnedSmartPlaylistTypesRef.current = loadedPinnedTypes;
        setPinnedSmartPlaylistTypes(loadedPinnedTypes);
        setSmartPinsHydrated(true);
      })
      .catch(() => {
        if (cancelled || smartPinsTouchedRef.current) return;
        pinnedSmartPlaylistTypesRef.current = [];
        setPinnedSmartPlaylistTypes([]);
        setSmartPinsHydrated(true);
      });

    return () => {
      cancelled = true;
    };
  }, [userId]);

  const persistPinnedSmartPlaylistTypes = useCallback(
    (nextPinnedTypes: SmartPlaylistType[]) => {
      if (!userId) return;
      void AsyncStorage.setItem(pinnedSmartPlaylistsStorageKey(userId), JSON.stringify(nextPinnedTypes)).catch(() => {
        // Non-critical preference write; keep the in-memory pin state usable.
      });
    },
    [userId],
  );

  const handleToggleSmartPin = useCallback(
    (smartPlaylistType: SmartPlaylistType) => {
      if (!smartPinsHydrated) return;
      smartPinsTouchedRef.current = true;
      const previousPinnedTypes = pinnedSmartPlaylistTypesRef.current;
      const nextPinnedTypes = previousPinnedTypes.includes(smartPlaylistType)
        ? previousPinnedTypes.filter((pinnedType) => pinnedType !== smartPlaylistType)
        : [smartPlaylistType, ...previousPinnedTypes.filter((pinnedType) => pinnedType !== smartPlaylistType)];
      pinnedSmartPlaylistTypesRef.current = nextPinnedTypes;
      setPinnedSmartPlaylistTypes(nextPinnedTypes);
      persistPinnedSmartPlaylistTypes(nextPinnedTypes);
    },
    [persistPinnedSmartPlaylistTypes, smartPinsHydrated],
  );

  const forYouSmartCards = useMemo(() => {
    if (!userId || smartCounts == null) return [];
    return FOR_YOU_SMART_PLAYLIST_TYPES.map((smartPlaylistType) => {
      if (pinnedSmartPlaylistTypes.includes(smartPlaylistType)) return null;
      const preset = SMART_PLAYLISTS.find((smartPlaylist) => smartPlaylist.type === smartPlaylistType);
      if (!preset) return null;
      return { preset, count: smartCountsByType.get(smartPlaylistType) ?? 0 };
    }).filter((entry): entry is { preset: (typeof SMART_PLAYLISTS)[number]; count: number } => entry !== null);
  }, [pinnedSmartPlaylistTypes, smartCounts, smartCountsByType, userId]);

  const pinnedSmartPlaylistTypeSet = useMemo(() => new Set(pinnedSmartPlaylistTypes), [pinnedSmartPlaylistTypes]);

  const pinnedSmartCards = useMemo(() => {
    if (!userId || smartCounts == null) return [];
    return pinnedSmartPlaylistTypes
      .map((smartPlaylistType) => {
        const preset = SMART_PLAYLISTS.find((smartPlaylist) => smartPlaylist.type === smartPlaylistType);
        if (!preset) return null;
        return { preset, count: smartCountsByType.get(smartPlaylistType) ?? 0 };
      })
      .filter((entry): entry is { preset: SmartPlaylistPresentation; count: number } => entry !== null);
  }, [pinnedSmartPlaylistTypes, smartCounts, smartCountsByType, userId]);

  const pinnedPlaylistUuids = useMemo(
    () => new Set(pinnedPlaylists.map((playlist) => playlist.uuid)),
    [pinnedPlaylists],
  );
  const visiblePinnedSmartLimit =
    pinnedSmartCards.length > 0 && pinnedPlaylists.length > 0 ? 8 - Math.min(pinnedPlaylists.length, 4) : 8;
  const visiblePinnedSmartCards = useMemo(
    () => pinnedSmartCards.slice(0, visiblePinnedSmartLimit),
    [pinnedSmartCards, visiblePinnedSmartLimit],
  );
  const visiblePinnedPlaylists = useMemo(
    () => pinnedPlaylists.slice(0, Math.max(8 - visiblePinnedSmartCards.length, 0)),
    [pinnedPlaylists, visiblePinnedSmartCards.length],
  );
  const hasVisiblePinnedItems = visiblePinnedSmartCards.length + visiblePinnedPlaylists.length > 0;

  const unpinnedUserPlaylists = useMemo(() => {
    return userPlaylists.filter((playlist) => !pinnedPlaylistUuids.has(playlist.uuid));
  }, [pinnedPlaylistUuids, userPlaylists]);

  const goToPlaylist = useCallback((uuid: string) => {
    router.push(`/(tabs)/discover/${uuid}`);
  }, []);

  const goToSmartPlaylist = useCallback((smartPlaylistType: SmartPlaylistType) => {
    router.push(`/(tabs)/discover/smart/${smartPlaylistType}`);
  }, []);

  const { showToast } = useToast();
  const { createPlaylist, pinPlaylist, unpinPlaylist } = usePlaylistMutations();

  // Create flow — needs a board (boardType + layoutId). Use the active board (the
  // pill's selection); with none, guide the user to pick one first (mirrors web's
  // "select a board").
  const createBoard = useMemo(
    () => (activeBoard ? { boardType: activeBoard.boardType, layoutId: activeBoard.layoutId } : null),
    [activeBoard],
  );

  const [createVisible, setCreateVisible] = useState(false);
  const [creating, setCreating] = useState(false);

  const handleCreatePress = useCallback(() => {
    if (!createBoard) {
      showToast(t('bottomTabBar.selectBoardForPlaylist'), 'info');
      router.push('/boards');
      return;
    }
    setCreateVisible(true);
  }, [createBoard, showToast, t]);

  const handleCreateSubmit = useCallback(
    async (values: PlaylistFormValues) => {
      if (!createBoard) return;
      setCreating(true);
      try {
        const created = await createPlaylist({
          boardType: createBoard.boardType,
          layoutId: createBoard.layoutId,
          name: values.name,
          description: values.description,
          color: values.color,
          icon: values.icon,
        });
        setCreateVisible(false);
        showToast(t('bottomTabBar.createdPlaylistToast', { name: created.name }), 'success');
        // refetchUser() only refreshes useUserPlaylists' own useState store
        // (the Discover/all shelves). The Add-to-Playlist picker reads the
        // react-query ['userPlaylists'] cache instead, which that refetch never
        // touches — and the mobile QueryProvider wires no focus/online refetch,
        // so the new playlist would stay missing from the picker for the rest
        // of the session. Prepend it directly so it shows up immediately.
        queryClient.setQueryData<Playlist[]>(['userPlaylists'], (prev) => (prev ? [created, ...prev] : [created]));
        refetchUser();
        router.push(`/(tabs)/discover/${created.uuid}`);
      } catch (err) {
        console.error('Failed to create playlist:', err);
        showToast(t('bottomTabBar.createPlaylistFailed'), 'error');
      } finally {
        setCreating(false);
      }
    },
    [createBoard, createPlaylist, queryClient, showToast, t, refetchUser],
  );

  const togglePlaylistPin = useCallback(
    async (playlistUuid: string, isPinned: boolean) => {
      try {
        if (isPinned) await unpinPlaylist(playlistUuid);
        else await pinPlaylist(playlistUuid);
        refetchUser();
        refetchPinned();
      } catch {
        showToast(t(isPinned ? 'library.pin.unpinFailed' : 'library.pin.pinFailed'), 'error');
      }
    },
    [pinPlaylist, refetchPinned, refetchUser, showToast, t, unpinPlaylist],
  );

  // Pin / unpin straight from a playlist card. The shared-hook arrays aren't
  // ours to mutate optimistically, so refetch both lists once the mutation lands
  // and let the pinned ordering + icon re-derive.
  const handleToggleCardPin = useCallback(
    (playlist: Playlist) => {
      void togglePlaylistPin(playlist.uuid, playlist.isPinnedByMe);
    },
    [togglePlaylistPin],
  );

  const handleToggleDiscoverPin = useCallback(
    (playlistUuid: string) => {
      void togglePlaylistPin(playlistUuid, pinnedPlaylistUuids.has(playlistUuid));
    },
    [pinnedPlaylistUuids, togglePlaylistPin],
  );

  // Refresh owned + pinned when returning to the tab (e.g. after editing,
  // deleting, or pinning from a detail screen). Skip the first focus so we don't
  // double-fetch what the hooks already load on mount. The ref is instance-local
  // — React recreates it (back to false) on any remount, so a fresh mount
  // correctly skips its own first focus; it deliberately isn't reset within a
  // mount (every later focus should refetch).
  const hasFocusedRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!hasFocusedRef.current) {
        hasFocusedRef.current = true;
        return;
      }
      refetchUser();
      refetchPinned();
    }, [refetchUser, refetchPinned]),
  );

  const showSignInPrompt = !isAuthenticated && !authLoading;

  // The first-page fetch of one (or both) sections failed and the hub is empty
  // — show a retry rather than the "no playlists yet" empty state, which would
  // mislead a user who actually has playlists into thinking they have none.
  const showLoadError =
    (userError || smartCountsError || communityError) &&
    userPlaylists.length === 0 &&
    !hasVisiblePinnedItems &&
    forYouSmartCards.length === 0 &&
    communityItems.length === 0 &&
    !userLoading;

  const handleRetryLoad = useCallback(() => {
    if (userError) refetchUser();
    if (smartCountsError) void refetchSmartCounts();
    if (communityError) refetchCommunity();
  }, [userError, smartCountsError, communityError, refetchUser, refetchSmartCounts, refetchCommunity]);

  return (
    <View style={styles.flex}>
      <Animated.ScrollView
        ref={listRef}
        style={styles.flex}
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{
          paddingTop: chromeHeight,
          paddingBottom: bottomChrome.scrollBottomPadding + spacing[6],
        }}
        scrollIndicatorInsets={{ top: chromeHeight }}
        keyboardShouldPersistTaps="handled"
        onScroll={onScroll}
        scrollEventThrottle={16}
      >
        {/* The screen's identity, in-body under the floating chrome (the grey
            "Discover" stack header is gone). Collapses into a header capsule as it
            scrolls up behind the glass. */}
        <Text variant="largeTitle" style={styles.screenTitle}>
          {t('bottomTabBar.discover')}
        </Text>

        {showSignInPrompt ? (
          <Pressable style={styles.signInBanner} onPress={() => router.push('/auth/login')} accessibilityRole="button">
            <Icon name="person" size={26} color={iosSystemColors.systemGray} />
            <View style={styles.signInText}>
              <Text variant="subheadline" style={styles.signInTitle}>
                {t('library.signInBanner.title')}
              </Text>
              <Text variant="caption1" style={styles.signInDescription}>
                {t('library.signInBanner.description')}
              </Text>
            </View>
            <Text variant="subheadline" color={brandColors.primary} style={styles.signInCta}>
              {t('library.signInBanner.cta')}
            </Text>
          </Pressable>
        ) : null}

        {/* Pinned — dense grid capped at four rows of two. */}
        {isAuthenticated && hasVisiblePinnedItems ? (
          <View style={styles.section}>
            <SectionHeader title={t('library.sections.pinned')} />
            <View style={styles.grid}>
              {visiblePinnedSmartCards.map(({ preset, count }, index) => (
                <View key={preset.type} style={styles.gridItem}>
                  <PlaylistCard
                    name={t(preset.titleI18nKey)}
                    climbCount={count}
                    color={preset.color}
                    icon={preset.icon}
                    variant="grid"
                    index={index}
                    onPress={() => goToSmartPlaylist(preset.type)}
                    isPinned={pinnedSmartPlaylistTypeSet.has(preset.type)}
                    onTogglePin={smartPinsHydrated ? () => handleToggleSmartPin(preset.type) : undefined}
                  />
                </View>
              ))}
              {visiblePinnedPlaylists.map((playlist, index) => (
                <View key={playlist.uuid} style={styles.gridItem}>
                  <PlaylistCard
                    name={playlist.name}
                    climbCount={playlist.climbCount}
                    color={playlist.color}
                    icon={playlist.icon}
                    variant="grid"
                    index={visiblePinnedSmartCards.length + index}
                    onPress={() => goToPlaylist(playlist.uuid)}
                    isPinned={playlist.isPinnedByMe}
                    onTogglePin={() => handleToggleCardPin(playlist)}
                  />
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {/* My Playlists — user's own playlists, excluding the pinned grid above. */}
        {isAuthenticated && (userLoading || unpinnedUserPlaylists.length > 0) ? (
          <PlaylistScrollSection
            title={t('library.allPlaylists.title')}
            actionLabel={userPlaylists.length > 0 ? t('library.allPlaylists.seeAll') : undefined}
            onActionPress={userPlaylists.length > 0 ? () => router.push('/(tabs)/discover/all') : undefined}
            loading={userLoading && unpinnedUserPlaylists.length === 0}
            isLoadingMore={userLoadingMore}
            onEndReached={loadMoreUser}
          >
            {unpinnedUserPlaylists.map((playlist, index) => (
              <PlaylistCard
                key={playlist.uuid}
                name={playlist.name}
                climbCount={playlist.climbCount}
                color={playlist.color}
                icon={playlist.icon}
                variant="scroll"
                index={index}
                onPress={() => goToPlaylist(playlist.uuid)}
                isPinned={playlist.isPinnedByMe}
                onTogglePin={() => handleToggleCardPin(playlist)}
              />
            ))}
          </PlaylistScrollSection>
        ) : null}

        {/* For You — the same smart-playlist cards as web, in mobile product order. */}
        {isAuthenticated && userId && (smartCountsLoading || forYouSmartCards.length > 0) ? (
          <PlaylistScrollSection title={t('library.sections.forYou')} loading={smartCountsLoading}>
            {forYouSmartCards.map(({ preset, count }, index) => (
              <PlaylistCard
                key={preset.type}
                name={t(preset.titleI18nKey)}
                climbCount={count}
                color={preset.color}
                icon={preset.icon}
                variant="scroll"
                index={index}
                onPress={() => goToSmartPlaylist(preset.type)}
                isPinned={pinnedSmartPlaylistTypeSet.has(preset.type)}
                onTogglePin={smartPinsHydrated ? () => handleToggleSmartPin(preset.type) : undefined}
              />
            ))}
          </PlaylistScrollSection>
        ) : null}

        {/* Community Playlists — user-made public playlists. */}
        {communityLoading || communityItems.length > 0 ? (
          <PlaylistScrollSection
            title={t('library.sections.community')}
            loading={communityLoading && communityItems.length === 0}
            isLoadingMore={communityLoadingMore}
            onEndReached={loadMoreCommunity}
          >
            {communityItems.map((playlist, index) => (
              <PlaylistCard
                key={playlist.uuid}
                name={playlist.name}
                climbCount={playlist.climbCount}
                color={playlist.color}
                icon={playlist.icon}
                variant="scroll"
                metaLabel={t('library.communityByline', {
                  creatorName: playlist.creatorName,
                  climbCount: t('detail.climbCount', { count: playlist.climbCount }),
                })}
                index={index}
                onPress={() => goToPlaylist(playlist.uuid)}
                isPinned={isAuthenticated && pinnedPlaylistUuids.has(playlist.uuid)}
                onTogglePin={isAuthenticated ? () => handleToggleDiscoverPin(playlist.uuid) : undefined}
              />
            ))}
          </PlaylistScrollSection>
        ) : null}

        {/* Load error: a section's first page failed and the hub is empty.
            Offer a retry instead of falsely claiming the library is empty. */}
        {showLoadError ? (
          <View style={styles.emptyContainer}>
            <Icon name="error" size={48} color={iosSystemColors.systemGray4} />
            <Text variant="headline" style={styles.emptyTitle}>
              {t('library.errors.loadTitle')}
            </Text>
            <Text variant="subheadline" style={styles.emptySubtitle}>
              {t('library.errors.loadDescription')}
            </Text>
            <Pressable
              onPress={handleRetryLoad}
              accessibilityRole="button"
              accessibilityLabel={t('library.errors.tryAgain')}
              hitSlop={8}
            >
              <Text variant="subheadline" color={brandColors.primary} style={styles.retryCta}>
                {t('library.errors.tryAgain')}
              </Text>
            </Pressable>
          </View>
        ) : null}

        {/* Empty state: signed in, nothing anywhere, nothing loading, no error. */}
        {isAuthenticated &&
        !userLoading &&
        !smartCountsLoading &&
        !communityLoading &&
        !profileLoading &&
        !showLoadError &&
        !hasVisiblePinnedItems &&
        userPlaylists.length === 0 &&
        forYouSmartCards.length === 0 &&
        communityItems.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Icon name="playlist" size={48} color={iosSystemColors.systemGray4} />
            <Text variant="headline" style={styles.emptyTitle}>
              {t('library.empty.title')}
            </Text>
            <Text variant="subheadline" style={styles.emptySubtitle}>
              {t('library.empty.description')}
            </Text>
          </View>
        ) : null}

        {/* Initial spinner before any section has resolved. */}
        {(authLoading || tokenLoading) &&
        !hasVisiblePinnedItems &&
        userPlaylists.length === 0 &&
        forYouSmartCards.length === 0 &&
        communityItems.length === 0 ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" />
          </View>
        ) : null}
      </Animated.ScrollView>

      <DiscoverTopChrome
        canCreate={isAuthenticated}
        onCreate={handleCreatePress}
        onOpenBoardSwitcher={() => router.push({ pathname: '/boards', params: { returnTo: '/(tabs)/discover' } })}
        onHeightChange={setChromeHeight}
        scrollY={scrollY}
        onPressTitle={handleScrollToTop}
      />

      <PlaylistFormSheet
        mode="create"
        visible={createVisible}
        submitting={creating}
        onSubmit={handleCreateSubmit}
        onClose={() => setCreateVisible(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  screenTitle: {
    paddingHorizontal: spacing[4],
    paddingTop: 0,
    paddingBottom: spacing[2],
  },
  section: {
    marginTop: spacing[2],
    marginBottom: spacing[2],
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: spacing[4],
    rowGap: spacing[4],
  },
  gridItem: {
    width: '50%',
    paddingRight: spacing[3],
  },
  signInBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    marginHorizontal: spacing[4],
    marginTop: spacing[3],
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[4],
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: iosSystemColors.separator,
  },
  signInText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  signInTitle: {
    fontWeight: '600',
  },
  signInDescription: {
    opacity: 0.6,
  },
  signInCta: {
    fontWeight: '600',
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: spacing[10] * 2,
    paddingHorizontal: 32,
    gap: 8,
  },
  emptyTitle: {
    marginTop: 12,
    opacity: 0.6,
  },
  emptySubtitle: {
    opacity: 0.4,
    textAlign: 'center',
  },
  retryCta: {
    marginTop: spacing[3],
    fontWeight: '600',
  },
  loadingContainer: {
    paddingTop: spacing[10] * 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
