import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { AscentFeedItem } from '@boardsesh/graphql/operations';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native';
import { Text } from '../src/components/Text';
import { holdUntilLaunchReady } from '../src/components/launch-update/hold-until-launch-ready';
import { ShareBetaAscentRow } from '../src/components/share-beta/ShareBetaAscentRow';
import { ShareBetaView } from '../src/components/share-beta/ShareBetaView';
import { useTypographyStyles, type TypographyScale } from '../src/hooks/use-typography-styles';
import { track } from '../src/lib/analytics';
import { extractGraphqlMessage } from '../src/lib/graphql/extract-error-message';
import {
  useAscentCaptionMatches,
  useAttachBetaLink,
  useBetaLinkPreview,
  useProfile,
  useUserAscentsFeed,
} from '../src/lib/graphql/hooks';
import {
  buildShareBetaListItems,
  type ShareBetaAscentSource,
  type ShareBetaListItem,
} from '../src/lib/share-beta-list';
import { useAuth } from '../src/providers/auth-provider';
import { useTheme } from '../src/providers/theme-provider';
import { useToast } from '../src/providers/toast-provider';
import { borderRadius, spacing } from '../src/theme/tokens';

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
function ShareBetaScreen() {
  const styles = useTypographyStyles(createStyles);
  const { link = '' } = useLocalSearchParams<{ link?: string }>();
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const { showToast } = useToast();
  const { data: profile } = useProfile();
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
  const isSearching = committedQuery.length > 0;

  // attachBetaLink rejections shown inline (not via toast): this is a native
  // modal, so a toast renders behind the sheet where the user never sees it.
  const [attachError, setAttachError] = useState<string | null>(null);

  // A warm share reuses this already-open modal (the provider swaps the link via
  // setParams instead of remounting), so reset the previous reel's search + inline
  // error when the link changes — otherwise a stale search would suppress the new
  // reel's suggestions, or an old attach error would linger for an unrelated link.
  useEffect(() => {
    setSearchText('');
    setCommittedQuery('');
    setAttachError(null);
  }, [link]);

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
  // keeps the caption→suggestion de-dup below from recomputing every render.
  const items = useMemo(() => feed.data?.pages.flatMap((page) => page.userAscentsFeed.items) ?? [], [feed.data]);

  // "Suggested" section: the backend matches the reel caption against the user's
  // entire logbook and returns full ascent rows (with board art) — so a climb
  // older than this feed page still surfaces. Suppressed while searching; the
  // user's query drives the list then.
  const matches = useAscentCaptionMatches(profile?.id, isSearching ? null : caption);
  const suggestions = useMemo(() => (isSearching ? [] : (matches.data ?? [])), [isSearching, matches.data]);

  const handleEndReached = useCallback(() => {
    if (feed.hasNextPage && !feed.isFetchingNextPage) void feed.fetchNextPage();
  }, [feed]);

  // Boolean, not the caption text — the event must never carry post content.
  const hasCaption = caption != null;

  const handleAttach = useCallback(
    (ascent: AscentFeedItem, source: ShareBetaAscentSource) => {
      if (!link || attach.isPending) return;
      setAttachError(null);
      attach.mutate(
        { boardType: ascent.boardType, climbUuid: ascent.climbUuid, link, angle: ascent.angle, tickUuid: ascent.uuid },
        {
          onSuccess: () => {
            // The picker had no product analytics at all, so "does anyone use
            // this, and does the caption match actually pick the climb?" was
            // only answerable by guessing. `source` splits caption-matched
            // picks from browsed ones.
            track(SHARED_EVENTS.BetaAttached, {
              source,
              boardType: ascent.boardType,
              viaSearch: isSearching,
              hasCaption,
            });
            // Toast is fine on success (and it plays the success haptic) — router.back() dismisses the modal first,
            // so it lands on the screen underneath where the toast is visible.
            showToast(t('mobile.betaVideos.attachSuccess'), 'success');
            router.back();
          },
          onError: (error: unknown) => {
            // Surface the backend message verbatim — it carries the useful
            // guidance ("post isn't available", "already attached to <climb>",
            // "temporarily blocking us"). Show it INLINE, not as a toast: the
            // modal stays open so the user can pick another climb, and a toast
            // would render behind the sheet where they'd never see it.
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
            setAttachError(extractGraphqlMessage(error) ?? t('mobile.betaVideos.attachError'));
          },
        },
      );
    },
    [attach, hasCaption, isSearching, link, router, showToast, t],
  );

  const renderItem = useCallback(
    ({ item }: { item: ShareBetaListItem }) => {
      if (item.kind === 'section') {
        const suggested = item.source === 'suggested';
        return (
          <Text
            emphasized
            variant="footnote"
            color={suggested ? brandColors.primary : systemColors.secondaryLabel}
            style={styles.sectionLabel}
            accessibilityRole="header"
          >
            {suggested ? t('mobile.betaVideos.shareSuggestedTitle') : t('mobile.betaVideos.shareOtherAscents')}
          </Text>
        );
      }
      return <ShareBetaAscentRow ascent={item.ascent} source={item.source} onActivate={handleAttach} />;
    },
    [brandColors.primary, handleAttach, systemColors.secondaryLabel, t],
  );

  // One flat, fully virtualized list: section headers + suggested rows + the
  // browse rows, with a suggested climb dropped from the browse section so a
  // recent + matched climb isn't listed twice.
  const listItems = useMemo(
    () => buildShareBetaListItems({ ascents: items, suggestions, isSearching }),
    [isSearching, items, suggestions],
  );
  return (
    <ShareBetaView
      isAuthenticated={isAuthenticated}
      onSignIn={() => router.replace('/auth/login')}
      onClose={() => router.back()}
      thumbnail={thumbnail}
      caption={caption}
      link={link}
      previewLoading={preview.isLoading}
      searchText={searchText}
      onSearchChange={setSearchText}
      attachError={attachError}
      attaching={attach.isPending}
      loading={!profile?.id || feed.isPending}
      loadingMore={feed.isFetchingNextPage}
      listItems={listItems}
      renderItem={renderItem}
      handleEndReached={handleEndReached}
      isSearching={isSearching}
    />
  );
}

const createStyles = (textStyles: TypographyScale) =>
  StyleSheet.create({
    container: { flex: 1 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[3],
    },
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
    sectionLabel: {
      paddingHorizontal: spacing[4],
      paddingTop: spacing[3],
      paddingBottom: spacing[1],
    },
    prompt: { paddingHorizontal: spacing[4], marginTop: spacing[4], marginBottom: spacing[2] },
    input: {
      marginHorizontal: spacing[4],
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: borderRadius.md,
      paddingHorizontal: spacing[3],
      paddingVertical: spacing[3],
      fontSize: textStyles.callout.fontSize,
      marginBottom: spacing[2],
    },
    errorBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing[2],
      marginHorizontal: spacing[4],
      marginBottom: spacing[2],
      paddingHorizontal: spacing[3],
      paddingVertical: spacing[2],
      borderRadius: borderRadius.md,
    },
    errorText: { flex: 1 },
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

// iOS presents this route as a native modal, above the launch update
// placeholder, and a URL can open it on a cold start. Held until launch is
// ready so a gate reload cannot land mid-tap (#6006).
export default holdUntilLaunchReady(ShareBetaScreen);
