import { useCallback, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useUserPlaylists } from '@boardsesh/playlists-react';
import type { Playlist } from '@boardsesh/graphql/operations/playlists';
import { Text } from '../../../src/components/Text';
import { Icon } from '../../../src/components/Icon';
import { ActivityIndicator } from '../../../src/components/ActivityIndicator';
import { PlaylistListRow, PlaylistListRowSeparator } from '../../../src/components/playlist';
import { useAuth } from '../../../src/providers/auth-provider';
import { useTheme } from '../../../src/providers/theme-provider';
import { useAuthToken } from '../../../src/lib/graphql/use-auth-token';
import { useActiveBoard } from '../../../src/lib/graphql/use-active-board';
import { useBottomChromeMetrics } from '../../../src/hooks/use-bottom-chrome-metrics';
import { useDrainAllPages } from '../../../src/hooks/use-drain-all-pages';
import { sortAndFilterPlaylists } from '../../../src/lib/sort-filter-playlists';
import { iosSystemColors } from '../../../src/theme/ios-colors';
import { spacing } from '../../../src/theme/tokens';

/**
 * "My Playlists" — the full, vertical, alphabetical list of the signed-in user's
 * own playlists with a title filter. The horizontal "Jump Back In" shelf on
 * Discover surfaces a few by recency; this expands it so a categorized library
 * (move type, projects at an angle) is easy to scan and search. Auto-generated /
 * smart playlists never appear here — they come from separate queries, so
 * `useUserPlaylists` already returns owned playlists only.
 */
export default function AllPlaylistsScreen() {
  const { t } = useTranslation('playlists');
  const { systemColors, brandColors } = useTheme();
  const bottomChrome = useBottomChromeMetrics();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { data: token = null } = useAuthToken();
  const { data: activeBoard } = useActiveBoard();

  const effectiveToken = isAuthenticated ? token : null;

  // Scope to the active board (matching the Discover hub's board filter), so this
  // screen is the full version of the "Jump Back In" shelf it expands.
  const { playlists, isLoading, isLoadingMore, hasMore, hasError, hasLoadMoreError, loadMore, retryLoadMore, refetch } =
    useUserPlaylists({
      token: effectiveToken,
      boardType: activeBoard?.boardType,
      layoutId: activeBoard?.layoutId,
      pageSize: 50,
    });

  // Drain every page so the alphabetical sort + title filter see the whole
  // library, not just the first page.
  useDrainAllPages({ hasMore, isLoading, isLoadingMore, loadMore });

  // Refresh on return so an edit/delete made on a pushed detail screen lands here
  // (this list uses its own useState store, not the react-query cache the picker
  // reads). Skip the first focus so we don't double-fetch the mount load. Mirrors
  // the Discover hub's focus refetch. useDrainAllPages re-drains after refetch.
  const hasFocusedRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!hasFocusedRef.current) {
        hasFocusedRef.current = true;
        return;
      }
      refetch();
    }, [refetch]),
  );

  const [query, setQuery] = useState('');

  const filtered = useMemo(() => sortAndFilterPlaylists(playlists, query), [playlists, query]);

  const goToPlaylist = useCallback((uuid: string) => {
    router.push(`/(tabs)/discover/${uuid}`);
  }, []);

  // No `filtered.length` dependency: the row reports its own uuid to a single
  // stable handler, and the hairline lives in `ItemSeparatorComponent`. So
  // `renderItem` stays referentially stable across page appends and the memoised
  // rows don't re-render while the library drains.
  const renderItem = useCallback(
    ({ item, index }: { item: Playlist; index: number }) => (
      <PlaylistListRow
        uuid={item.uuid}
        name={item.name}
        climbCount={item.climbCount}
        color={item.color}
        icon={item.icon}
        index={index}
        onPressUuid={goToPlaylist}
      />
    ),
    [goToPlaylist],
  );

  // Signed-out (reachable only via deep link — the entry points are gated on auth).
  if (!isAuthenticated && !authLoading) {
    return (
      <View style={[styles.flex, styles.centered, { backgroundColor: systemColors.background }]}>
        <Icon name="person" size={48} color={iosSystemColors.systemGray4} />
        <Text variant="headline" style={styles.stateTitle}>
          {t('library.signInBanner.title')}
        </Text>
        <Pressable onPress={() => router.push('/auth/login')} accessibilityRole="button" hitSlop={8}>
          <Text variant="subheadline" color={brandColors.primary} style={styles.stateCta}>
            {t('library.signInBanner.cta')}
          </Text>
        </Pressable>
      </View>
    );
  }

  // The first page failed and nothing is on screen — offer a retry rather than
  // falling through to the "no playlists yet" empty state. A retry flips
  // isLoading back on, so the spinner branch below takes over while it's inflight.
  if (hasError && !isLoading && playlists.length === 0) {
    return (
      <View style={[styles.flex, styles.centered, { backgroundColor: systemColors.background }]}>
        <Icon name="error" size={48} color={iosSystemColors.systemGray4} />
        <Text variant="headline" style={styles.stateTitle}>
          {t('library.errors.loadTitle')}
        </Text>
        <Text variant="subheadline" style={styles.stateSubtitle}>
          {t('library.errors.loadDescription')}
        </Text>
        <Pressable
          onPress={refetch}
          accessibilityRole="button"
          accessibilityLabel={t('library.errors.tryAgain')}
          hitSlop={8}
        >
          <Text variant="subheadline" color={brandColors.primary} style={styles.stateCta}>
            {t('library.errors.tryAgain')}
          </Text>
        </Pressable>
      </View>
    );
  }

  const showInitialSpinner = isLoading && playlists.length === 0;
  const showDrainingFooter = isLoadingMore;

  return (
    <View style={[styles.flex, { backgroundColor: systemColors.background }]}>
      <View style={styles.searchWrap}>
        <View style={[styles.searchField, { backgroundColor: systemColors.fill }]}>
          <Icon name="search" size={18} color={systemColors.secondaryLabel} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t('library.allPlaylists.searchPlaceholder')}
            placeholderTextColor={iosSystemColors.systemGray}
            style={[styles.searchInput, { color: systemColors.label }]}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            accessibilityLabel={t('library.allPlaylists.searchPlaceholder')}
          />
          {query.length > 0 ? (
            <Pressable
              onPress={() => setQuery('')}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('library.allPlaylists.clearSearch')}
            >
              <Icon name="close" size={16} color={systemColors.secondaryLabel} />
            </Pressable>
          ) : null}
        </View>
      </View>

      {showInitialSpinner ? (
        <View style={[styles.flex, styles.centered]}>
          <ActivityIndicator size="large" />
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.uuid}
          renderItem={renderItem}
          ItemSeparatorComponent={PlaylistListRowSeparator}
          contentContainerStyle={{ paddingBottom: bottomChrome.scrollBottomPadding + spacing[6] }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          ListEmptyComponent={
            <View style={[styles.centered, styles.emptyBlock]}>
              <Icon name="playlist" size={48} color={iosSystemColors.systemGray4} />
              <Text variant="headline" style={styles.stateTitle}>
                {playlists.length === 0
                  ? t('library.empty.title')
                  : t('library.allPlaylists.noResults', { query: query.trim() })}
              </Text>
              {playlists.length === 0 ? (
                <Text variant="subheadline" style={styles.stateSubtitle}>
                  {t('library.empty.description')}
                </Text>
              ) : null}
            </View>
          }
          ListFooterComponent={
            hasLoadMoreError ? (
              <Pressable
                style={styles.footer}
                onPress={retryLoadMore}
                accessibilityRole="button"
                accessibilityLabel={`${t('library.allPlaylists.loadMoreError')} ${t('library.errors.tryAgain')}`}
              >
                <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.footerError}>
                  {t('library.allPlaylists.loadMoreError')}
                </Text>
                <Text variant="subheadline" color={brandColors.primary} style={styles.footerRetry}>
                  {t('library.errors.tryAgain')}
                </Text>
              </Pressable>
            ) : showDrainingFooter ? (
              <View style={styles.footer}>
                <ActivityIndicator size="small" />
              </View>
            ) : null
          }
        />
      )}
    </View>
  );
}

// Drops the empty / no-results block below the search bar toward the optical
// centre (spacing[16] + spacing[4] = 80).
const STATE_BLOCK_TOP_INSET = spacing[16] + spacing[4];

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchWrap: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    paddingBottom: spacing[2],
  },
  searchField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    height: 40,
    borderRadius: 10,
    paddingHorizontal: spacing[3],
  },
  searchInput: {
    flex: 1,
    fontSize: 17,
    paddingVertical: 0,
  },
  emptyBlock: {
    paddingTop: STATE_BLOCK_TOP_INSET,
    paddingHorizontal: spacing[8],
    gap: spacing[2],
  },
  stateTitle: {
    marginTop: spacing[3],
    opacity: 0.6,
    textAlign: 'center',
  },
  stateSubtitle: {
    opacity: 0.4,
    textAlign: 'center',
  },
  stateCta: {
    marginTop: spacing[3],
    fontWeight: '600',
  },
  footer: {
    paddingVertical: spacing[4],
    alignItems: 'center',
  },
  footerError: {
    textAlign: 'center',
  },
  footerRetry: {
    marginTop: spacing[1],
    fontWeight: '600',
  },
});
