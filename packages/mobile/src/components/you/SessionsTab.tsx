import { useCallback, useMemo, useRef, useState } from 'react';
import { View, RefreshControl, StyleSheet } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter, useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type BottomSheet from '@gorhom/bottom-sheet';
import type { SessionFeedItem, SocialEntityType } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { Card } from '../Card';
import { ActivityIndicator } from '../ActivityIndicator';
import { SessionFeedCard } from './SessionFeedCard';
import { SessionsFeedHeader } from './SessionsFeedHeader';
import { FeedSectionLabel } from './FeedSectionLabel';
import { CommentSheet } from './CommentSheet';
import { bucketSessionsByRecency, dedupeSessionsById, type FeedRecencyBucket } from '../../lib/feed-time-buckets';
import { useSessionGroupedFeed, useBulkVoteSummaries } from '../../lib/graphql/hooks';
import { navigateToSessionFeedItem } from '../../lib/session-feed-navigation';
import { openClimbInPlayDrawer } from '../../lib/open-climb-in-play-drawer';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

type FeedRow = { type: 'header'; bucket: FeedRecencyBucket } | { type: 'session'; item: SessionFeedItem };
type CommentTarget = { entityId: string; entityType: SocialEntityType };

type TFunc = (key: string) => string;
const PENDING_SKELETON_KEYS = ['session-skeleton-1', 'session-skeleton-2'];

type SessionsTabProps = {
  userId: string | undefined;
  /** Measured chrome height — the list insets its top by this so the first row
   *  rests below the floating chrome and the rest scroll under it. */
  topInset?: number;
};

// String-literal `t(...)` per call so the catalog keys stay statically greppable.
function sectionLabel(bucket: FeedRecencyBucket, t: TFunc): string {
  if (bucket === 'today') return t('mobile.sessions.sectionToday');
  if (bucket === 'thisWeek') return t('mobile.sessions.sectionThisWeek');
  return t('mobile.sessions.sectionEarlier');
}

function SessionsPendingSkeleton({ topInset }: { topInset: number }) {
  return (
    <View
      style={[styles.pendingSkeleton, { paddingTop: topInset + spacing[3] }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {PENDING_SKELETON_KEYS.map((skeletonKey) => (
        <SessionCardSkeleton key={skeletonKey} />
      ))}
    </View>
  );
}

function SessionCardSkeleton() {
  const { systemColors } = useTheme();
  const blockStyle = { backgroundColor: systemColors.fill };

  return (
    <View style={styles.skeletonOuter}>
      <Card>
        <View style={styles.skeletonHeader}>
          <View style={[styles.skeletonAvatar, blockStyle]} />
          <View style={styles.skeletonHeaderText}>
            <View style={[styles.skeletonTitleLine, blockStyle]} />
            <View style={[styles.skeletonSmallLine, blockStyle]} />
          </View>
        </View>
        <View style={[styles.skeletonStatLine, blockStyle]} />
        <View style={styles.skeletonBody}>
          <View style={[styles.skeletonThumbnail, blockStyle]} />
          <View style={styles.skeletonDetails}>
            <View style={[styles.skeletonClimbName, blockStyle]} />
            <View style={[styles.skeletonMetaLine, blockStyle]} />
            <View style={[styles.skeletonCommentLine, blockStyle]} />
            <View style={[styles.skeletonCommentShortLine, blockStyle]} />
          </View>
        </View>
      </Card>
    </View>
  );
}

export function SessionsTab({ userId, topInset = 0 }: SessionsTabProps) {
  const { t } = useTranslation('you');
  const { systemColors, brandColors, variant } = useTheme();
  const router = useRouter();
  const { openPlayDrawer } = useDrawerHost();
  const bottomChrome = useBottomChromeMetrics();
  const paddingBottom = bottomChrome.scrollBottomPadding + spacing[4];

  const commentSheetRef = useRef<BottomSheet | null>(null);
  const [commentTarget, setCommentTarget] = useState<CommentTarget | null>(null);

  const feed = useSessionGroupedFeed({ userId }, !!userId);
  // De-dupe across pages: the OFFSET-paginated feed can return the same session
  // on two adjacent pages when its rank shifts mid-refetch, which would
  // otherwise produce duplicate FlashList keys (keyExtractor returns sessionId).
  const sessions = useMemo(
    () => dedupeSessionsById(feed.data?.pages.flatMap((page) => page.sessionGroupedFeed.sessions) ?? []),
    [feed.data],
  );

  // A single `now` shared by the rollup header and the section bucketing so the
  // two agree and neither rebuckets on every render. It re-evaluates on focus
  // and on pull-to-refresh (not per frame), so a screen left mounted across
  // midnight stops mislabelling yesterday's session as "Today".
  const [now, setNow] = useState(() => Date.now());
  useFocusEffect(
    useCallback(() => {
      setNow(Date.now());
    }, []),
  );

  // Flatten the recency groups into header + session rows for a single
  // virtualized list (FlashList has no built-in section support).
  const rows = useMemo<FeedRow[]>(() => {
    const groups = bucketSessionsByRecency(sessions, now);
    const flattened: FeedRow[] = [];
    for (const group of groups) {
      flattened.push({ type: 'header', bucket: group.bucket });
      for (const item of group.sessions) flattened.push({ type: 'session', item });
    }
    return flattened;
  }, [sessions, now]);

  // Per-viewer vote state for the visible sessions (the feed item carries
  // counts but not the viewer's own vote). Refetches as more pages load.
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
    !!userId && sessionEntityIds.length > 0,
  );
  const tickVoteSummaries = useBulkVoteSummaries('tick', tickEntityIds, !!userId && tickEntityIds.length > 0);
  const summaryMap = useMemo(() => {
    const map = new Map<string, { upvotes: number; userVote: number | null }>();
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

  const handleOpenSession = useCallback(
    (session: SessionFeedItem) => {
      navigateToSessionFeedItem(router, session, '/(tabs)/profile/session/[sessionId]');
    },
    [router],
  );

  const handleEndReached = useCallback(() => {
    if (feed.hasNextPage && !feed.isFetchingNextPage) void feed.fetchNextPage();
  }, [feed]);

  const renderItem = useCallback(
    ({ item: row }: { item: FeedRow }) => {
      if (row.type === 'header') {
        return <FeedSectionLabel label={sectionLabel(row.bucket, t)} />;
      }
      return (
        <SessionFeedCard
          session={row.item}
          voteSummary={summaryMap.get(`${row.item.socialEntityType}:${row.item.socialEntityId}`)}
          onOpenComments={handleOpenComments}
          onPress={handleOpenSession}
          onOpenClimb={(tick) => openClimbInPlayDrawer({ kind: 'tick', tick }, { openPlayDrawer, router })}
        />
      );
    },
    [handleOpenComments, handleOpenSession, summaryMap, t, openPlayDrawer, router],
  );

  // The screen's identity, in-body under the floating chrome, plus the feed
  // rollup when there are sessions. Memoized so FlashList doesn't re-measure /
  // re-render the header on every SessionsTab render — only when the rollup data
  // (sessions/now) changes. The large title always renders so it sits above the
  // empty state too.
  const listHeader = useMemo(
    () => (
      <>
        {/* On Material the M3 app bar owns the title, so the in-body large title is
            gated off there to avoid a doubled title. */}
        {variant === 'material' ? null : (
          <Text variant="largeTitle" style={styles.screenTitle}>
            {t('metadata.dashboard.title')}
          </Text>
        )}
        {sessions.length > 0 ? <SessionsFeedHeader sessions={sessions} now={now} /> : null}
      </>
    ),
    [t, sessions, now, variant],
  );

  if (!userId) {
    return (
      <View style={[styles.centered, { paddingTop: topInset }]}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (feed.isPending) {
    return <SessionsPendingSkeleton topInset={topInset} />;
  }

  return (
    <View style={styles.flex}>
      <FlashList
        data={rows}
        extraData={summaryMap}
        renderItem={renderItem}
        getItemType={(row) => row.type}
        keyExtractor={(row) => (row.type === 'header' ? `header-${row.bucket}` : row.item.sessionId)}
        contentInsetAdjustmentBehavior="never"
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.5}
        contentContainerStyle={{ paddingTop: topInset, paddingBottom }}
        scrollIndicatorInsets={{ top: topInset }}
        ListHeaderComponent={listHeader}
        refreshControl={
          <RefreshControl
            refreshing={feed.isRefetching}
            onRefresh={() => {
              setNow(Date.now());
              void feed.refetch();
            }}
            tintColor={brandColors.primary}
          />
        }
        ListFooterComponent={
          feed.isFetchingNextPage ? (
            <View style={styles.footer}>
              <ActivityIndicator size="small" />
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Icon name="history" size={48} color={systemColors.tertiaryLabel} />
            <Text variant="headline" style={styles.emptyTitle}>
              {t('mobile.sessions.emptyTitle')}
            </Text>
            <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.emptyBody}>
              {t('mobile.sessions.emptyBody')}
            </Text>
            <View style={styles.emptyCta}>
              {/* The Record tab hosts the session screen inline, so the CTA just
                  navigates there. */}
              <Button title={t('mobile.sessions.emptyCta')} onPress={() => router.navigate('/(tabs)/record')} />
            </View>
          </View>
        }
      />
      <CommentSheet
        sheetRef={commentSheetRef}
        entityId={commentTarget?.entityId ?? null}
        entityType={commentTarget?.entityType ?? 'session'}
        onClose={() => setCommentTarget(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  footer: { paddingVertical: spacing[5], alignItems: 'center' },
  pendingSkeleton: {
    flex: 1,
  },
  skeletonOuter: {
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
  skeletonStatLine: {
    width: '68%',
    height: 14,
    borderRadius: borderRadius.full,
    marginTop: spacing[3],
    opacity: 0.42,
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
  screenTitle: {
    paddingHorizontal: spacing[4],
    paddingTop: 0,
    paddingBottom: spacing[2],
  },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 120,
    paddingHorizontal: spacing[8],
    gap: spacing[2],
  },
  emptyTitle: { marginTop: spacing[3], textAlign: 'center' },
  emptyBody: { textAlign: 'center' },
  emptyCta: { marginTop: spacing[4] },
});
