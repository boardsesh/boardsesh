import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, TextInput, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FlashList } from '@shopify/flash-list';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import type { AscentFeedItem } from '@boardsesh/graphql/operations';
import { Text } from '../src/components/Text';
import { Button } from '../src/components/Button';
import { Icon } from '../src/components/Icon';
import { ActivityIndicator } from '../src/components/ActivityIndicator';
import { LogbookRow } from '../src/components/you/LogbookRow';
import { useTheme } from '../src/providers/theme-provider';
import { useAuth } from '../src/providers/auth-provider';
import { useToast } from '../src/providers/toast-provider';
import { useProfile, useUserAscentsFeed, useAttachBetaLink, useBetaLinkPreview } from '../src/lib/graphql/hooks';
import { partitionAscentsForShare } from '../src/lib/match-ascents-to-caption';
import { extractGraphqlMessage } from '../src/lib/graphql/extract-error-message';
import { spacing, borderRadius } from '../src/theme/tokens';
import { iosSystemColors } from '../src/theme/ios-colors';

// Keep the ascents query from refiring on every keystroke; commit the search
// term after a short pause.
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Modal opened by the share target (ShareTargetProvider) after a beta video link
 * is shared into Boardsesh from Instagram / TikTok. Lists the user's recent
 * ascents (with a name search over their logged climbs) and attaches the shared
 * link to the climb they pick, via the existing attachBetaLink mutation. The link
 * arrives as a route param so this screen is decoupled from the native module.
 */
export default function ShareBetaScreen() {
  const { link } = useLocalSearchParams<{ link: string }>();
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const { showToast } = useToast();
  const { data: profile } = useProfile({ enabled: isAuthenticated });
  const attach = useAttachBetaLink();

  // Best-effort: fetch the reel's thumbnail + caption so we can preview the post
  // and auto-match the climb. Never blocks the manual picker.
  const preview = useBetaLinkPreview(link);
  const caption = preview.data?.caption ?? null;
  const thumbnail = preview.data?.thumbnail ?? null;

  const [searchText, setSearchText] = useState('');
  const [committedQuery, setCommittedQuery] = useState('');
  useEffect(() => {
    const handle = setTimeout(() => setCommittedQuery(searchText.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchText]);

  // Nothing to attach (shouldn't happen — the provider validates first); just
  // dismiss rather than show a dead screen.
  useEffect(() => {
    if (!link) router.back();
  }, [link, router]);

  // statusMode 'both' so projects/attempts show too (people post beta of climbs
  // they're still working). climbName filters the user's *logged* climbs when
  // searching; the row shape is identical either way.
  const feedInput = useMemo(
    () =>
      committedQuery ? ({ statusMode: 'both', climbName: committedQuery } as const) : ({ statusMode: 'both' } as const),
    [committedQuery],
  );
  const feed = useUserAscentsFeed(profile?.id, feedInput);
  // Memoized so the identity is stable while the query data is unchanged —
  // keeps the caption→suggestion partition below from recomputing every render.
  const items = useMemo(() => feed.data?.pages.flatMap((page) => page.userAscentsFeed.items) ?? [], [feed.data]);

  const handleEndReached = useCallback(() => {
    if (feed.hasNextPage && !feed.isFetchingNextPage) void feed.fetchNextPage();
  }, [feed]);

  const handleAttach = useCallback(
    (ascent: AscentFeedItem) => {
      if (!link || attach.isPending) return;
      attach.mutate(
        { boardType: ascent.boardType, climbUuid: ascent.climbUuid, link, angle: ascent.angle },
        {
          onSuccess: () => {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            showToast(t('mobile.betaVideos.attachSuccess'), 'success');
            router.back();
          },
          onError: (error: unknown) => {
            // Surface the backend message verbatim — it carries the useful
            // guidance ("post isn't available", "already attached to <climb>",
            // "temporarily blocking us"). Keep the modal open so the user can
            // pick a different climb or retry.
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
            showToast(extractGraphqlMessage(error) ?? t('mobile.betaVideos.attachError'), 'error');
          },
        },
      );
    },
    [attach, link, router, showToast, t],
  );

  const renderItem = useCallback(
    ({ item }: { item: AscentFeedItem }) => <LogbookRow ascent={item} onPress={handleAttach} />,
    [handleAttach],
  );

  // Auto-match the climb from the reel caption, partitioning the list into a
  // "Suggested" group + the rest. Memoized (matcher is pure) so typing/preview
  // state changes don't re-normalize every climb name. Hidden while searching.
  const isSearching = committedQuery.length > 0;
  const { suggestions, listData } = useMemo(
    () => partitionAscentsForShare(caption, items, isSearching),
    [caption, items, isSearching],
  );
  const showSuggestions = suggestions.length > 0;

  const containerStyle = [styles.container, { backgroundColor: systemColors.background, paddingTop: insets.top }];

  // Defense in depth — the provider stashes shares until login, so this is rare.
  if (!isAuthenticated) {
    return (
      <View style={containerStyle}>
        <View style={styles.centered}>
          <Icon name="person" size={40} color={systemColors.secondaryLabel} />
          <Text variant="title3" style={styles.centeredText}>
            {t('mobile.betaVideos.shareSignIn')}
          </Text>
          <Button
            title={t('mobile.betaVideos.shareSignInButton')}
            variant="filled"
            size="large"
            onPress={() => router.replace('/auth/login')}
          />
        </View>
      </View>
    );
  }

  return (
    <View style={containerStyle}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.betaVideos.shareClose')}
          hitSlop={spacing[2]}
          style={styles.closeButton}
        >
          <Icon name="close" size={22} color={systemColors.secondaryLabel} />
        </Pressable>
        <Text variant="headline">{t('mobile.betaVideos.shareTargetTitle')}</Text>
        <View style={styles.closeButton} />
      </View>

      <View style={[styles.linkCard, { backgroundColor: systemColors.secondaryBackground }]}>
        {thumbnail ? (
          <Image
            source={{ uri: thumbnail }}
            style={styles.thumb}
            contentFit="cover"
            transition={150}
            // Remote thumbnail — skip expo-image's main-thread downscale resample.
            allowDownscaling={false}
          />
        ) : (
          <View style={[styles.thumb, styles.thumbFallback]}>
            <Icon name="video" size={20} color={brandColors.primary} />
          </View>
        )}
        <View style={styles.linkText}>
          <Text variant="subheadline" color={systemColors.label} numberOfLines={2}>
            {caption ?? link}
          </Text>
          {preview.isLoading && (
            <Text variant="caption2" color={systemColors.tertiaryLabel}>
              {t('mobile.betaVideos.shareReadingCaption')}
            </Text>
          )}
        </View>
      </View>

      <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.prompt}>
        {t('mobile.betaVideos.shareTargetPrompt')}
      </Text>

      <TextInput
        value={searchText}
        onChangeText={setSearchText}
        placeholder={t('mobile.betaVideos.shareSearchPlaceholder')}
        placeholderTextColor={iosSystemColors.systemGray}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        style={[styles.input, { color: systemColors.label, borderColor: systemColors.separator }]}
      />

      <View style={styles.listWrapper} pointerEvents={attach.isPending ? 'none' : 'auto'}>
        {!profile?.id || feed.isPending ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" />
          </View>
        ) : (
          <FlashList
            data={listData}
            renderItem={renderItem}
            keyExtractor={(item) => item.uuid}
            keyboardShouldPersistTaps="handled"
            onEndReached={handleEndReached}
            onEndReachedThreshold={0.5}
            contentContainerStyle={{ paddingBottom: insets.bottom + spacing[6] }}
            ListHeaderComponent={
              showSuggestions ? (
                <View style={styles.suggestedSection}>
                  <Text variant="footnote" color={brandColors.primary} style={styles.sectionLabel}>
                    {t('mobile.betaVideos.shareSuggestedTitle')}
                  </Text>
                  {suggestions.map((ascent) => (
                    <LogbookRow key={ascent.uuid} ascent={ascent} onPress={handleAttach} />
                  ))}
                  {listData.length > 0 && (
                    <Text variant="footnote" color={systemColors.tertiaryLabel} style={styles.sectionLabel}>
                      {t('mobile.betaVideos.shareOtherAscents')}
                    </Text>
                  )}
                </View>
              ) : null
            }
            ListFooterComponent={
              feed.isFetchingNextPage ? (
                <View style={styles.footer}>
                  <ActivityIndicator size="small" />
                </View>
              ) : null
            }
            ListEmptyComponent={
              showSuggestions ? null : (
                <View style={styles.empty}>
                  <Icon name="tick.outline" size={44} color={systemColors.tertiaryLabel} />
                  <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.emptyText}>
                    {isSearching ? t('mobile.betaVideos.shareNoResults') : t('mobile.betaVideos.shareNoAscents')}
                  </Text>
                </View>
              )
            }
          />
        )}
      </View>

      {attach.isPending && (
        <View style={styles.overlay} pointerEvents="auto">
          <ActivityIndicator size="large" />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  closeButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  linkCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    marginHorizontal: spacing[4],
    padding: spacing[3],
    borderRadius: borderRadius.md,
  },
  thumb: { width: 44, height: 44, borderRadius: borderRadius.sm },
  thumbFallback: { alignItems: 'center', justifyContent: 'center' },
  linkText: { flex: 1, gap: 2 },
  suggestedSection: { gap: spacing[1] },
  sectionLabel: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    paddingBottom: spacing[1],
    fontWeight: '600',
  },
  prompt: { paddingHorizontal: spacing[4], marginTop: spacing[4], marginBottom: spacing[2] },
  input: {
    marginHorizontal: spacing[4],
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
    fontSize: 16,
    marginBottom: spacing[2],
  },
  listWrapper: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing[4], padding: spacing[6] },
  centeredText: { textAlign: 'center' },
  footer: { paddingVertical: spacing[5], alignItems: 'center' },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 96,
    paddingHorizontal: spacing[8],
    gap: spacing[3],
  },
  emptyText: { textAlign: 'center' },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.15)',
  },
});
