import { useHttpQueryScope } from '../src/lib/graphql/use-http-query-scope';
import { useHttpActionScope } from '../src/lib/graphql/use-http-action-scope';
import {
  useHttpInfiniteQuery,
  type HttpPageConsumer,
  type HttpPageData,
  type HttpInfinitePageSource,
} from '../src/lib/graphql/use-http-query';
import {
  openShareBeta,
  findShareBetaOpening,
  useBetaOpeningCurrent,
  useBetaComposer,
  type BetaOpening,
  type BetaCompletion,
} from '../src/lib/graphql/hooks/use-beta-links';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import {
  GET_USER_ASCENTS_FEED,
  type AscentFeedItem,
  type GetUserAscentsFeedQueryResponse,
  type GetUserAscentsFeedQueryVariables,
} from '@boardsesh/graphql/operations';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  useCallback,
  useEffect,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
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
function NativeShareBetaScreen() {
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

function ShareBetaScreen() {
  const scope = useHttpQueryScope();
  const { link = '', betaOpening } = useLocalSearchParams<{ link?: string; betaOpening?: string }>();
  const [direct, setDirect] = useState<BetaOpening>();
  useLayoutEffect(() => {
    if (!scope.scoped || betaOpening || !link) return;
    try {
      setDirect(openShareBeta(scope, link));
    } catch {
      /* Not an admitted direct opening. */
    }
  }, [scope, betaOpening, link]);
  if (!scope.scoped) return <NativeShareBetaScreen />;
  const opening = betaOpening ? findShareBetaOpening(betaOpening, link) : direct;
  if (!opening || opening.entity !== link) return null;
  try {
    scope.assertView();
    opening.assertPresentation();
  } catch {
    return null;
  }
  return <SelectedShareBetaScreen key={opening.id} link={link} opening={opening} />;
}

type RecentPage = GetUserAscentsFeedQueryResponse;
type RecentView = Readonly<{ data: HttpPageData<RecentPage, number>; consumer: HttpPageConsumer; ticket: object }>;
/** This selected-only reader never mounts the native/local Logbook hook. Its
 * private source advances only from a qualified expected page. */
function SelectedRecentPicker({
  userId,
  query,
  opening,
  children,
}: {
  userId: string | undefined;
  query: string;
  opening: BetaOpening;
  children: (feed: {
    items: AscentFeedItem[];
    loading: boolean;
    loadingMore: boolean;
    end: () => void;
    assertCurrent: () => void;
    assertPresentation: () => void;
  }) => ReactNode;
}) {
  const input = useMemo<GetUserAscentsFeedQueryVariables['input']>(
    () => (query ? { statusMode: 'both', climbName: query } : { statusMode: 'both' }),
    [query],
  );
  const feed = useHttpInfiniteQuery({
    pageDelivery: true,
    queryKey: ['userAscentsFeed', userId, input],
    initialPageParam: 0,
    queryFn: ({ pageParam }, operation) => {
      // Shared physical work belongs to this Query/view, not one opening.
      return operation.request<GetUserAscentsFeedQueryResponse>(GET_USER_ASCENTS_FEED, {
        userId,
        input: { ...input, limit: 20, offset: pageParam },
      });
    },
    getNextPageParam: (lastPage, _pages, parameter) => (lastPage.userAscentsFeed.hasMore ? parameter + 20 : undefined),
    enabled: !!userId,
  });
  const actions = useHttpActionScope();
  const source = useRef<HttpInfinitePageSource<RecentPage, number> | undefined>(undefined);
  const live = useRef(true);
  const loading = useRef(false);
  const [view, setView] = useState<RecentView>();
  const committed = useRef(view);
  // This is only local post-commit bookkeeping. ACKed rows are admitted input;
  // a later attach obtains its own operation, never a replacement page proof.
  const admitted = useRef(new WeakSet<object>());
  const [marks, setMarks] = useState<readonly object[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const pending = useRef(new Map<object, Readonly<{ consumer: HttpPageConsumer; finish?: () => void }>>());
  const assertOwner = useCallback(() => {
    if (!live.current) throw new Error('Retired beta picker');
    opening.assertAction();
  }, [opening]);
  const publish = useCallback(
    (data: HttpPageData<RecentPage, number>, consumer: HttpPageConsumer, finish?: () => void) => {
      try {
        assertOwner();
        consumer.assertCurrent();
      } catch {
        consumer.release();
        finish?.();
        return;
      }
      if (pending.current.size >= 16) {
        consumer.release();
        finish?.();
        return;
      }
      const ticket = Object.freeze({});
      pending.current.set(ticket, Object.freeze({ consumer, finish }));
      // NEW mark first prevents React caching an eager source result across retirement.
      setMarks((previous) => [...previous.filter((mark) => pending.current.has(mark)), ticket]);
      setView((previous) => {
        try {
          assertOwner();
          consumer.assertCurrent();
          return Object.freeze({ data, consumer, ticket });
        } catch {
          return previous;
        }
      });
      setLoadingMore(false);
    },
    [assertOwner],
  );
  useLayoutEffect(() => {
    committed.current = view;
    for (const ticket of marks) {
      const publication = pending.current.get(ticket);
      if (!publication) continue;
      pending.current.delete(ticket);
      if (view?.ticket === ticket) {
        try {
          assertOwner();
          publication.consumer.acknowledge();
          admitted.current.add(ticket);
        } catch {
          /* No stale ACK. */
        }
      }
      publication.consumer.release();
      publication.finish?.();
      loading.current = false;
    }
  }, [marks, view, assertOwner]);
  useInsertionEffect(
    () => () => {
      live.current = false;
      source.current?.dispose();
      for (const publication of pending.current.values()) {
        publication.consumer.release();
        publication.finish?.();
      }
      pending.current.clear();
    },
    [],
  );
  useLayoutEffect(() => {
    if (source.current || !feed.data) return;
    try {
      assertOwner();
      const fixed = feed.capturePageSource();
      source.current = fixed;
      const initial = fixed.read();
      publish(initial.data, initial.retain());
    } catch {
      /* No synthetic empty success. */
    }
  }, [feed.data, feed.capturePageSource, assertOwner, publish]);
  const end = useCallback(() => {
    let action: ReturnType<typeof actions.capture> | undefined;
    try {
      action = actions.capture();
      assertOwner();
      const fixed = source.current;
      if (!fixed || loading.current || !fixed.read().hasMore) {
        action.finish();
        return;
      }
      loading.current = true;
      setLoadingMore(true);
      const original = action;
      void fixed.fetchNextPage({ signal: original.signal }).then(
        (outcome) => {
          try {
            original.assertView();
            assertOwner();
            if (outcome.status === 'delivered') {
              publish(outcome.data, outcome.consumer, original.finish);
              return;
            }
          } catch {
            if (outcome.status === 'delivered') outcome.consumer.release();
          }
          loading.current = false;
          original.finish();
          if (live.current) setLoadingMore(false);
        },
        () => {
          loading.current = false;
          original.finish();
          if (live.current) setLoadingMore(false);
        },
      );
    } catch {
      action?.finish();
    }
  }, [actions, assertOwner, publish]);
  const assertCurrent = useCallback(() => {
    assertOwner();
    if (committed.current !== view) throw new Error('Replaced beta rows');
    if (view && !admitted.current.has(view.ticket)) view.consumer.assertCurrent();
  }, [assertOwner, view]);
  const items = useMemo(() => view?.data.pages.flatMap((page) => page.userAscentsFeed.items) ?? [], [view]);
  const assertPresentation = useCallback(() => {
    assertOwner();
    if (view && !admitted.current.has(view.ticket)) view.consumer.assertCurrent();
  }, [assertOwner, view]);
  let visibleItems = items;
  try {
    assertPresentation();
  } catch {
    visibleItems = [];
  }
  return children({
    items: visibleItems,
    loading: !view && feed.isPending,
    loadingMore,
    end,
    assertCurrent,
    assertPresentation,
  });
}

function SelectedShareBetaScreen({ link, opening }: { link: string; opening: BetaOpening }) {
  const composer = useBetaComposer(opening);
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const { data: profile } = useProfile();
  const preview = useBetaLinkPreview(link);
  const caption = preview.data?.caption ?? null;
  const thumbnail = preview.data?.thumbnail ?? null;
  const [query, setQuery] = useState('');
  useEffect(() => {
    const original = composer.captureDraft();
    const originalText = original.text;
    const handle = setTimeout(() => {
      try {
        original.assertCurrent();
      } catch {
        return;
      }
      setQuery((previous) => {
        try {
          original.assertCurrent();
          return originalText.trim();
        } catch {
          return previous;
        }
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [composer.draft, composer.captureDraft]);
  useInsertionEffect(() => () => opening.close({ deferNotifications: true }), [opening]);
  const matches = useAscentCaptionMatches(profile?.id, query ? null : caption);
  const suggestions = useMemo(() => (query ? [] : (matches.data ?? [])), [query, matches.data]);
  const current = useBetaOpeningCurrent(opening);
  if (!composer.current || !current) return null;
  return (
    <SelectedRecentPicker key={`${profile?.id ?? ''}:${query}`} userId={profile?.id} query={query} opening={opening}>
      {(feed) => (
        <SelectedShareBetaContents
          link={link}
          opening={opening}
          composer={composer}
          feed={feed}
          suggestions={suggestions}
          query={query}
          isAuthenticated={isAuthenticated}
          caption={caption}
          thumbnail={thumbnail}
          previewLoading={preview.isLoading}
          onBack={() => router.back()}
          onSignIn={() => router.replace('/auth/login')}
        />
      )}
    </SelectedRecentPicker>
  );
}

function SelectedShareBetaContents({
  link,
  opening,
  composer,
  feed,
  suggestions,
  query,
  isAuthenticated,
  caption,
  thumbnail,
  previewLoading,
  onBack,
  onSignIn,
}: {
  link: string;
  opening: BetaOpening;
  composer: ReturnType<typeof useBetaComposer>;
  feed: {
    items: AscentFeedItem[];
    loading: boolean;
    loadingMore: boolean;
    end: () => void;
    assertCurrent: () => void;
    assertPresentation: () => void;
  };
  suggestions: AscentFeedItem[];
  query: string;
  isAuthenticated: boolean;
  caption: string | null;
  thumbnail: string | null;
  previewLoading: boolean;
  onBack: () => void;
  onSignIn: () => void;
}) {
  const styles = useTypographyStyles(createStyles);
  const { t } = useTranslation('session');
  const { brandColors, systemColors } = useTheme();
  const { showGuardedToast } = useToast();
  const attach = useAttachBetaLink();
  const listItems = useMemo(
    () => buildShareBetaListItems({ ascents: feed.items, suggestions, isSearching: !!query }),
    [feed.items, suggestions, query],
  );
  const rowOwner = useMemo(() => ({ committed: false }), [listItems]);
  const committed = useRef(rowOwner);
  useLayoutEffect(() => {
    rowOwner.committed = true;
    committed.current = rowOwner;
  }, [rowOwner]);
  const assertRows = useCallback(() => {
    opening.assertAction();
    feed.assertCurrent();
    if (committed.current !== rowOwner) throw new Error('Replaced beta picker rows');
  }, [opening, feed.assertCurrent, rowOwner]);
  const assertRowPresentation = useCallback(() => {
    opening.assertAction();
    feed.assertPresentation();
    if (rowOwner.committed && committed.current !== rowOwner) throw new Error('Replaced beta picker rows');
  }, [opening, feed.assertPresentation, rowOwner]);
  const handleAttach = useCallback(
    (ascent: AscentFeedItem, source: ShareBetaAscentSource) => {
      let action: ReturnType<typeof composer.begin>;
      try {
        assertRows();
        action = composer.begin();
      } catch {
        return;
      }
      if (!action) return;
      const assertIntent = () => {
        action.assertView();
        assertRows();
      };
      const pending = attach.attachWithOutcome(
        { boardType: ascent.boardType, climbUuid: ascent.climbUuid, link, angle: ascent.angle, tickUuid: ascent.uuid },
        { opening, assertIntent, signal: action.signal },
      );
      void pending.then(
        (outcome) => {
          if (outcome.kind === 'held') {
            composer.settle(null, undefined, action);
            return;
          }
          let completion: BetaCompletion | undefined;
          try {
            outcome.assertCurrent();
            if (outcome.kind === 'request-error') {
              const message = outcome.readMessage() ?? t('mobile.betaVideos.attachError');
              outcome.assertCurrent();
              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
              outcome.assertCurrent();
              composer.settle(message, outcome.retain(), action);
              return;
            }
            completion = outcome.acceptCompletion();
            composer.settle(null, outcome.retain(), action);
            completion.assertCurrent();
            track(SHARED_EVENTS.BetaAttached, {
              source,
              boardType: ascent.boardType,
              viaSearch: !!query,
              hasCaption: caption != null,
            });
            completion.assertCurrent();
            completion.close(onBack);
            completion.assertCurrent();
            showGuardedToast(t('mobile.betaVideos.attachSuccess'), 'success', completion);
            completion = undefined;
          } catch {
            composer.settle(null, undefined, action);
          } finally {
            completion?.release();
            outcome.release();
          }
        },
        () => composer.settle(null, undefined, action),
      );
    },
    [composer, assertRows, attach, link, opening, query, caption, onBack, showGuardedToast, t],
  );
  const renderItem = useCallback(
    ({ item }: { item: ShareBetaListItem }) => {
      try {
        assertRowPresentation();
      } catch {
        return null;
      }
      if (item.kind === 'section')
        return (
          <Text
            variant="footnote"
            color={item.source === 'suggested' ? brandColors.primary : systemColors.secondaryLabel}
            style={styles.sectionLabel}
            accessibilityRole="header"
          >
            {t(
              item.source === 'suggested'
                ? 'mobile.betaVideos.shareSuggestedTitle'
                : 'mobile.betaVideos.shareOtherAscents',
            )}
          </Text>
        );
      return (
        <ShareBetaAscentRow
          ascent={item.ascent}
          source={item.source}
          onActivate={handleAttach}
          assertOriginal={assertRows}
          assertPresentation={assertRowPresentation}
        />
      );
    },
    [
      assertRows,
      assertRowPresentation,
      brandColors.primary,
      systemColors.secondaryLabel,
      styles.sectionLabel,
      handleAttach,
      t,
    ],
  );
  const cancel = useCallback(() => {
    try {
      opening.assertAction();
      opening.close();
      onBack();
    } catch {
      /* Old close is inert. */
    }
  }, [opening, onBack]);
  return (
    <ShareBetaView
      isAuthenticated={isAuthenticated}
      onSignIn={() => {
        try {
          opening.assertAction();
          onSignIn();
        } catch {}
      }}
      onClose={cancel}
      thumbnail={thumbnail}
      caption={caption}
      link={link}
      previewLoading={previewLoading}
      searchText={composer.draft}
      onSearchChange={composer.changeDraft}
      attachError={composer.error}
      attaching={composer.busy}
      loading={!feed.items.length && feed.loading}
      loadingMore={feed.loadingMore}
      listItems={listItems}
      renderItem={renderItem}
      handleEndReached={feed.end}
      isSearching={!!query}
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
      fontWeight: '600',
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
