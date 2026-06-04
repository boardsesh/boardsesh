import { useCallback, useMemo, useRef, useState } from 'react';
import { View, RefreshControl, StyleSheet } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type BottomSheet from '@gorhom/bottom-sheet';
import type { SessionFeedItem } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';
import { SessionFeedCard } from './SessionFeedCard';
import { SessionsFeedHeader } from './SessionsFeedHeader';
import { FeedSectionLabel } from './FeedSectionLabel';
import { CommentSheet } from './CommentSheet';
import { bucketSessionsByRecency, type FeedRecencyBucket } from '../../lib/feed-time-buckets';
import { useSessionGroupedFeed, useBulkVoteSummaries } from '../../lib/graphql/hooks';
import { TOOLBAR_RESERVE, TAB_BAR_HEIGHT } from '../../theme/layout';
import { brandColors } from '../../theme/colors';
import { spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { useSessionScreen } from '../../providers/session-screen-provider';

type FeedRow = { type: 'header'; bucket: FeedRecencyBucket } | { type: 'session'; item: SessionFeedItem };

type TFunc = (key: string) => string;

// String-literal `t(...)` per call so the catalog keys stay statically greppable.
function sectionLabel(bucket: FeedRecencyBucket, t: TFunc): string {
  if (bucket === 'today') return t('mobile.sessions.sectionToday');
  if (bucket === 'thisWeek') return t('mobile.sessions.sectionThisWeek');
  return t('mobile.sessions.sectionEarlier');
}

export function SessionsTab({ userId }: { userId: string | undefined }) {
  const { t } = useTranslation('you');
  const { systemColors } = useTheme();
  const router = useRouter();
  const { open: openSessionScreen } = useSessionScreen();
  const insets = useSafeAreaInsets();
  const paddingBottom = TOOLBAR_RESERVE + TAB_BAR_HEIGHT + insets.bottom + spacing[4];

  const commentSheetRef = useRef<BottomSheet | null>(null);
  const [commentSessionId, setCommentSessionId] = useState<string | null>(null);

  const feed = useSessionGroupedFeed({ userId }, !!userId);
  const sessions = useMemo(
    () => feed.data?.pages.flatMap((page) => page.sessionGroupedFeed.sessions) ?? [],
    [feed.data],
  );

  // One clock captured per mount (stable across renders) so the rollup header
  // and the section bucketing agree and neither rebuckets on every render.
  const [now] = useState(() => Date.now());

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
  const sessionIds = useMemo(() => sessions.map((session) => session.sessionId), [sessions]);
  const voteSummaries = useBulkVoteSummaries('session', sessionIds, !!userId && sessionIds.length > 0);
  const summaryMap = useMemo(() => {
    const map = new Map<string, { upvotes: number; userVote: number | null }>();
    for (const summary of voteSummaries.data ?? []) {
      map.set(summary.entityId, { upvotes: summary.upvotes, userVote: summary.userVote });
    }
    return map;
  }, [voteSummaries.data]);

  const handleOpenComments = useCallback((sessionId: string) => {
    setCommentSessionId(sessionId);
    commentSheetRef.current?.snapToIndex(0);
  }, []);

  const handleOpenSession = useCallback(
    (sessionId: string) => {
      router.push({ pathname: '/session/[sessionId]', params: { sessionId } });
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
          voteSummary={summaryMap.get(row.item.sessionId)}
          onOpenComments={handleOpenComments}
          onPress={handleOpenSession}
        />
      );
    },
    [handleOpenComments, handleOpenSession, summaryMap, t],
  );

  if (!userId || feed.isPending) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      <FlashList
        data={rows}
        extraData={summaryMap}
        renderItem={renderItem}
        getItemType={(row) => row.type}
        keyExtractor={(row) => (row.type === 'header' ? `header-${row.bucket}` : row.item.sessionId)}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.5}
        contentContainerStyle={{ paddingBottom }}
        ListHeaderComponent={sessions.length > 0 ? <SessionsFeedHeader sessions={sessions} now={now} /> : null}
        refreshControl={
          <RefreshControl
            refreshing={feed.isRefetching}
            onRefresh={() => void feed.refetch()}
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
              {/* The Record tab opens the session overlay (mounted at the root),
                  so open it directly rather than navigating to the blank /record
                  screen — a programmatic push wouldn't trigger BlurTabBar. */}
              <Button title={t('mobile.sessions.emptyCta')} onPress={openSessionScreen} />
            </View>
          </View>
        }
      />
      <CommentSheet
        sheetRef={commentSheetRef}
        entityId={commentSessionId}
        onClose={() => setCommentSessionId(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  footer: { paddingVertical: spacing[5], alignItems: 'center' },
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
