import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Pressable, ScrollView, StyleSheet } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQueryClient } from '@tanstack/react-query';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { FAB } from 'react-native-paper';
import type { ListRenderItemInfo } from '@shopify/flash-list';
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
import { OfflineState } from '../../../src/components/OfflineState';
import { useConnectivity } from '../../../src/lib/connectivity/use-connectivity';
import { offlineReasonFor } from '../../../src/hooks/use-offline-query-state';
import { Button } from '../../../src/components/Button';
import { SectionHeader } from '../../../src/components/SectionHeader';
import { HorizontalScrollSection } from '../../../src/components/HorizontalScrollSection';
import { PlaylistFormSheet, type PlaylistFormValues } from '../../../src/components/playlist';
import { DiscoverPlaylistCard, DiscoverSmartPlaylistCard } from '../../../src/components/playlist/DiscoverPlaylistCard';
import { PlaylistShelf } from '../../../src/components/playlist/PlaylistShelf';
import { DiscoverTopChrome } from '../../../src/components/chrome';
import { SMART_PLAYLISTS, type SmartPlaylistPresentation } from '../../../src/lib/smart-playlists';
import { useAuth } from '../../../src/providers/auth-provider';
import { useTheme } from '../../../src/providers/theme-provider';
import { useToast } from '../../../src/providers/toast-provider';
import { reportHandledError } from '../../../src/lib/error-reporting';
import { useAuthToken } from '../../../src/lib/graphql/use-auth-token';
import { useProfile } from '../../../src/lib/graphql/hooks';
import { useActiveBoard } from '../../../src/lib/graphql/use-active-board';
import { useBottomChromeMetrics } from '../../../src/hooks/use-bottom-chrome-metrics';
import { iconMap } from '../../../src/components/icon-map';
import { selectByVariant } from '../../../src/theme/variants';
import { iosSystemColors } from '../../../src/theme/ios-colors';
import { spacing } from '../../../src/theme/tokens';
import { MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT } from '../../../src/theme/layout';
import { screenshotModeLoadMore } from '../../../src/lib/screenshot-mode';

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

const NO_RECENT_PLAYLIST_CANDIDATES: Playlist[] = [];

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

function playlistKey(playlist: { uuid: string }): string {
  return playlist.uuid;
}

export default function DiscoverLibrary() {
  const { t } = useTranslation('playlists');
  const { brandColors, variant } = useTheme();
  const isMaterial = selectByVariant(variant, { material: true, liquidGlass: false });
  const bottomChrome = useBottomChromeMetrics();
  // The screen sits ABOVE the in-flow Material tab bar, so the FAB's `bottom` is
  // measured from the tab-bar top. It only needs to clear the docked queue accessory
  // bar (a root overlay that covers the screen's bottom edge when a climb is queued),
  // plus a 16dp gap. Computed directly rather than via floatingControlBottom /
  // fixedFooterBottom, which re-add the tab-bar height (built for full-screen overlays)
  // and floated the FAB ~tab-bar-height too high above the accessory bar.
  const createFabBottom = (bottomChrome.jsQueueToolbarVisible ? MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT : 0) + spacing[4];
  const insets = useSafeAreaInsets();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { data: token = null, isLoading: tokenLoading } = useAuthToken();
  const { data: profile, isLoading: profileLoading } = useProfile();
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
    hasMore: userHasMore,
    hasLoadMoreError: userLoadMoreError,
    retryLoadMore: retryLoadMoreUser,
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
    candidatePlaylists: NO_RECENT_PLAYLIST_CANDIDATES,
  });

  // Community playlists (popular + recent streams, merged).
  const {
    popular: communityPopular,
    recent: communityRecent,
    isLoading: communityLoading,
    isLoadingMore: communityLoadingMore,
    hasMore: communityHasMore,
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
    const seen = new Set<string>();
    return userPlaylists.filter((playlist) => {
      if (pinnedPlaylistUuids.has(playlist.uuid) || seen.has(playlist.uuid)) return false;
      seen.add(playlist.uuid);
      return true;
    });
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
  // Create failures surface INLINE in the sheet (its error slot), not via a root
  // toast — a toast fired while the native sheet is open renders behind it and is
  // invisible. The sheet stays open on failure so the user can fix and retry.
  const [createError, setCreateError] = useState<string | null>(null);

  const handleCreatePress = useCallback(() => {
    if (!createBoard) {
      showToast(t('bottomTabBar.selectBoardForPlaylist'), 'info');
      router.push('/boards');
      return;
    }
    setCreateError(null);
    setCreateVisible(true);
  }, [createBoard, showToast, t]);

  const handleCreateSubmit = useCallback(
    async (values: PlaylistFormValues) => {
      if (!createBoard) return;
      setCreating(true);
      setCreateError(null);
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
        reportHandledError(err, { tags: { source: 'playlist', op: 'create' } });
        // Inline, not a toast: the sheet is still open, so a root toast would be
        // hidden behind it.
        setCreateError(t('bottomTabBar.createPlaylistFailed'));
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

  const renderOwnedPlaylist = useCallback(
    ({ item: playlist, index }: ListRenderItemInfo<Playlist>) => (
      <DiscoverPlaylistCard
        uuid={playlist.uuid}
        name={playlist.name}
        climbCount={playlist.climbCount}
        color={playlist.color}
        icon={playlist.icon}
        variant="scroll"
        index={index}
        onOpen={goToPlaylist}
        isPinned={playlist.isPinnedByMe}
        onPin={togglePlaylistPin}
      />
    ),
    [goToPlaylist, togglePlaylistPin],
  );

  const renderCommunityPlaylist = useCallback(
    ({ item: playlist, index }: ListRenderItemInfo<DiscoverablePlaylist>) => (
      <DiscoverPlaylistCard
        uuid={playlist.uuid}
        name={playlist.name}
        climbCount={playlist.climbCount}
        color={playlist.color}
        icon={playlist.icon}
        variant="scroll"
        index={index}
        metaLabel={t('library.communityByline', {
          creatorName: playlist.creatorName,
          climbCount: t('detail.climbCount', { count: playlist.climbCount }),
        })}
        onOpen={goToPlaylist}
        isPinned={isAuthenticated && pinnedPlaylistUuids.has(playlist.uuid)}
        onPin={isAuthenticated ? togglePlaylistPin : undefined}
      />
    ),
    [goToPlaylist, isAuthenticated, pinnedPlaylistUuids, t, togglePlaylistPin],
  );
  const communityInvalidation = useMemo(
    () => ({ isAuthenticated, pinnedPlaylistUuids, t }),
    [isAuthenticated, pinnedPlaylistUuids, t],
  );
  const openAllPlaylists = useCallback(() => router.push('/(tabs)/discover/all'), []);

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

  // Every section here is network-only, and under `networkMode: 'offlineFirst'`
  // an offline fetch pauses rather than failing — so `showLoadError` never fires
  // and the hub renders "No playlists yet" to someone who has plenty.
  const { effectiveOffline, reason: connectivityReason } = useConnectivity();
  const hasAnyDiscoverContent =
    hasVisiblePinnedItems || userPlaylists.length > 0 || forYouSmartCards.length > 0 || communityItems.length > 0;
  const showOfflineState = effectiveOffline && !hasAnyDiscoverContent && !showSignInPrompt && !showLoadError;
  // The placard hard-coded "offline" here, so a Boardsesh outage told a climber
  // with full bars that they had no signal. One shared ladder does the mapping,
  // so this hub can never drift from the placards every other surface renders.
  const offlineStateReason = offlineReasonFor(connectivityReason);

  const handleRetryLoad = useCallback(() => {
    if (userError) refetchUser();
    if (smartCountsError) void refetchSmartCounts();
    if (communityError) refetchCommunity();
  }, [userError, smartCountsError, communityError, refetchUser, refetchSmartCounts, refetchCommunity]);

  return (
    <View style={styles.flex}>
      <ScrollView
        style={styles.flex}
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{
          paddingTop: chromeHeight,
          paddingBottom: bottomChrome.scrollBottomPadding + spacing[6],
        }}
        scrollIndicatorInsets={{ top: chromeHeight }}
        keyboardShouldPersistTaps="handled"
      >
        {/* The screen's identity, in-body under the floating chrome (the grey
            "Discover" stack header is gone). */}
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
                  <DiscoverSmartPlaylistCard
                    smartType={preset.type}
                    name={t(preset.titleI18nKey)}
                    climbCount={count}
                    color={preset.color}
                    icon={preset.icon}
                    variant="grid"
                    index={index}
                    onOpen={goToSmartPlaylist}
                    isPinned={pinnedSmartPlaylistTypeSet.has(preset.type)}
                    onPin={smartPinsHydrated ? handleToggleSmartPin : undefined}
                  />
                </View>
              ))}
              {visiblePinnedPlaylists.map((playlist, index) => (
                <View key={playlist.uuid} style={styles.gridItem}>
                  <DiscoverPlaylistCard
                    uuid={playlist.uuid}
                    name={playlist.name}
                    climbCount={playlist.climbCount}
                    color={playlist.color}
                    icon={playlist.icon}
                    variant="grid"
                    index={visiblePinnedSmartCards.length + index}
                    onOpen={goToPlaylist}
                    isPinned={playlist.isPinnedByMe}
                    onPin={togglePlaylistPin}
                  />
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {/* My Playlists — user's own playlists, excluding the pinned grid above. */}
        {isAuthenticated && (userLoading || unpinnedUserPlaylists.length > 0) ? (
          <PlaylistShelf
            title={t('library.allPlaylists.title')}
            actionLabel={userPlaylists.length > 0 ? t('library.allPlaylists.seeAll') : undefined}
            onActionPress={userPlaylists.length > 0 ? openAllPlaylists : undefined}
            loading={userLoading && unpinnedUserPlaylists.length === 0}
            isLoadingMore={userLoadingMore}
            hasMore={userHasMore || userLoadMoreError}
            onEndReached={screenshotModeLoadMore(userLoadMoreError ? retryLoadMoreUser : loadMoreUser)}
            items={unpinnedUserPlaylists}
            renderItem={renderOwnedPlaylist}
            keyExtractor={playlistKey}
          />
        ) : null}

        {/* For You — the same smart-playlist cards as web, in mobile product order. */}
        {isAuthenticated && userId && (smartCountsLoading || forYouSmartCards.length > 0) ? (
          <HorizontalScrollSection title={t('library.sections.forYou')} loading={smartCountsLoading}>
            {forYouSmartCards.map(({ preset, count }, index) => (
              <DiscoverSmartPlaylistCard
                smartType={preset.type}
                key={preset.type}
                name={t(preset.titleI18nKey)}
                climbCount={count}
                color={preset.color}
                icon={preset.icon}
                variant="scroll"
                index={index}
                onOpen={goToSmartPlaylist}
                isPinned={pinnedSmartPlaylistTypeSet.has(preset.type)}
                onPin={smartPinsHydrated ? handleToggleSmartPin : undefined}
              />
            ))}
          </HorizontalScrollSection>
        ) : null}

        {/* Community Playlists — user-made public playlists. */}
        {communityLoading || communityItems.length > 0 ? (
          <PlaylistShelf
            title={t('library.sections.community')}
            loading={communityLoading && communityItems.length === 0}
            isLoadingMore={communityLoadingMore}
            hasMore={communityHasMore}
            onEndReached={screenshotModeLoadMore(loadMoreCommunity)}
            items={communityItems}
            renderItem={renderCommunityPlaylist}
            keyExtractor={playlistKey}
            extraData={communityInvalidation}
          />
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

        {showOfflineState ? <OfflineState reason={offlineStateReason} /> : null}

        {/* Empty state: signed in, nothing anywhere, nothing loading, no error. */}
        {!showOfflineState &&
        isAuthenticated &&
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
            <View style={styles.emptyCta}>
              <Button title={t('library.empty.createCta')} icon="plus" size="large" onPress={handleCreatePress} />
            </View>
          </View>
        ) : null}

        {/* Initial spinner before any section has resolved. */}
        {!showOfflineState &&
        (authLoading || tokenLoading) &&
        !hasVisiblePinnedItems &&
        userPlaylists.length === 0 &&
        forYouSmartCards.length === 0 &&
        communityItems.length === 0 ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" />
          </View>
        ) : null}
      </ScrollView>

      <DiscoverTopChrome
        canCreate={isAuthenticated}
        onCreate={handleCreatePress}
        onOpenBoardSwitcher={() => router.push({ pathname: '/boards', params: { returnTo: '/(tabs)/discover' } })}
        onHeightChange={setChromeHeight}
      />

      {/* Material's primary create affordance is an M3 FAB — the canonical place for
          a screen's "new" action. Liquid Glass keeps the create "+" island in the
          floating chrome (via CollapsingTopChrome), so the FAB is material-only. */}
      {isMaterial && isAuthenticated ? (
        <FAB
          icon={iconMap.plus.android}
          onPress={handleCreatePress}
          accessibilityLabel={t('library.createFab.ariaLabel')}
          // Solid brand fill (the app's filled-button colour), not Paper's default
          // `primaryContainer` tonal variant — that muted tone reads as washed-out /
          // semi-transparent over the dark feed.
          color={brandColors.onPrimary as string}
          mode="elevated"
          style={[styles.createFab, { bottom: createFabBottom, backgroundColor: brandColors.primaryFill }]}
        />
      ) : null}

      <PlaylistFormSheet
        mode="create"
        visible={createVisible}
        submitting={creating}
        submitError={createError}
        onSubmit={handleCreateSubmit}
        onClose={() => {
          setCreateVisible(false);
          setCreateError(null);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  // Material create FAB: bottom-trailing, the list scrolls under it; the host sets
  // `bottom` from the variant-correct floating-control offset (clears tab bar +
  // queue accessory).
  createFab: {
    position: 'absolute',
    right: spacing[4],
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
  emptyCta: {
    marginTop: spacing[4],
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
