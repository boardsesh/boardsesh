import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useNavigation } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { BottomSheet } from '@expo/ui/community/bottom-sheet';
import type { GroupedNotification, SocialEntityType } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';
import { OfflineState } from '../OfflineState';
import { CommentSheet } from '../you/CommentSheet';
import { NotificationRow } from './NotificationRow';
import { useNotificationNavigation, type OpenCommentThread } from './use-notification-navigation';
import {
  useGroupedNotifications,
  useMarkAllAsRead,
  useUnreadNotificationCount,
} from '../../lib/graphql/hooks/use-notifications';
import { useOfflineQueryState } from '../../hooks/use-offline-query-state';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';

// Module-level so the empty-list identity is stable across renders, and hoisted
// so FlashList's `keyExtractor` prop keeps one identity for the list's lifetime
// (perf playbook rule 3) instead of a fresh arrow each pass.
const EMPTY_GROUPS: GroupedNotification[] = [];
const keyExtractor = (group: GroupedNotification) => group.uuid;

/** The thread a tapped comment/vote row opens; null while the sheet is closed. */
type CommentThread = { entityType: SocialEntityType; entityId: string };

/**
 * The notifications list — one screen component shared by the Home and Profile
 * tab stacks (each registers a 1-line re-export stub, the same shape session
 * detail uses), so the bell in the Home chrome pushes inside Home's stack and
 * Back returns to the feed.
 *
 * Grouping is server-side: the backend collapses rows by
 * (type, entity_type, entity_id) in SQL, so the client only flattens pages.
 */
export default function NotificationsScreen() {
  const { t } = useTranslation('notifications');
  const { t: tCommon } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();
  const navigation = useNavigation();
  const bottomChrome = useBottomChromeMetrics();

  // Destructured, not held as `query`: React Query mints a fresh result object
  // on every render, so a callback listing the whole object as a dep gets a new
  // identity each pass and its `useCallback` buys nothing. These members are
  // stable across renders.
  const {
    data,
    status,
    fetchStatus,
    isPending,
    isError,
    isRefetching,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    refetch,
  } = useGroupedNotifications();
  const unreadCount = useUnreadNotificationCount();
  const { mutate: markAllAsRead } = useMarkAllAsRead();

  // The comment thread lives here rather than in the navigation hook so that
  // hook keeps returning ONE stable callback: `openCommentThread` is empty-dep
  // (setState identity is stable), so opening a thread doesn't churn
  // `renderItem` and re-render every memoized row.
  const commentSheetRef = useRef<BottomSheet | null>(null);
  const [commentThread, setCommentThread] = useState<CommentThread | null>(null);
  const openCommentThread = useCallback<OpenCommentThread>((entityType, entityId) => {
    setCommentThread({ entityType, entityId });
    commentSheetRef.current?.snapToIndex(0);
  }, []);
  const closeCommentThread = useCallback(() => setCommentThread(null), []);

  const handlePress = useNotificationNavigation(openCommentThread);

  const groups = useMemo(() => data?.pages.flatMap((page) => page.groups) ?? EMPTY_GROUPS, [data]);

  // Notifications are network-only. `query-provider` runs React Query in
  // `offlineFirst`, so an offline fetch PAUSES rather than failing: `isPending`
  // never clears and the screen would spin forever without this branch.
  const offline = useOfflineQueryState({ status, fetchStatus, data });
  const showOffline = offline.isBlocked && groups.length === 0;
  const showSpinner = !showOffline && isPending && groups.length === 0;
  const showError = !showOffline && isError && groups.length === 0;

  const handleMarkAllAsRead = useCallback(() => markAllAsRead(), [markAllAsRead]);
  const handleRefresh = useCallback(() => void refetch(), [refetch]);

  const handleEndReached = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // "Mark all as read" lives in the native header rather than the list body, so
  // it stays reachable while the list is scrolled (the `setters` / `zone` filter
  // screens set the precedent). Shown only when there is something to mark AND
  // something on screen to mark it against — mirrors web's
  // `groupedNotifications.length > 0 && unreadCount > 0`, which keeps the action
  // off a first paint where the count query has resolved but the list has not.
  useEffect(() => {
    navigation.setOptions({
      headerRight:
        unreadCount > 0 && groups.length > 0
          ? () => (
              <Pressable onPress={handleMarkAllAsRead} hitSlop={8} accessibilityRole="button">
                <Text variant="subheadline" color={brandColors.primary}>
                  {t('markAllRead')}
                </Text>
              </Pressable>
            )
          : undefined,
    });
    // `groups.length` is a dep here on purpose. The perf playbook's ban on array
    // `.length` deps is about `renderItem` (it re-renders every row); this effect
    // only re-runs `setOptions` on the native header.
  }, [navigation, unreadCount, groups.length, handleMarkAllAsRead, brandColors.primary, t]);

  const renderItem = useCallback(
    ({ item }: { item: GroupedNotification }) => <NotificationRow notification={item} onPress={handlePress} />,
    [handlePress],
  );

  return (
    <View style={[styles.flex, { backgroundColor: systemColors.background }]}>
      <FlashList
        // No state ternary here: every one of showSpinner/showError/showOffline
        // is itself conjoined with `groups.length === 0`, so the list is already
        // empty whenever one is set and the state placards below own the screen.
        data={groups}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: bottomChrome.scrollBottomPadding + spacing[4] }}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={
          showOffline && offline.reason ? (
            <OfflineState reason={offline.reason} onRetry={handleRefresh} />
          ) : showSpinner ? (
            <View style={styles.stateBlock}>
              <ActivityIndicator size="large" />
            </View>
          ) : showError ? (
            <View style={styles.stateBlock}>
              <Icon name="error" size={32} color={iosSystemColors.systemRed} />
              <Text variant="headline" style={styles.stateTitle}>
                {t('errors.load')}
              </Text>
              <View style={styles.stateCta}>
                <Button title={tCommon('actions.retry')} onPress={handleRefresh} />
              </View>
            </View>
          ) : (
            <View style={styles.stateBlock}>
              <Icon name="notification" size={48} color={systemColors.tertiaryLabel} />
              <Text variant="headline" style={styles.stateTitle}>
                {t('empty')}
              </Text>
            </View>
          )
        }
        ListFooterComponent={
          isFetchingNextPage ? (
            <View style={styles.footer}>
              <ActivityIndicator size="small" />
            </View>
          ) : null
        }
        refreshControl={
          // `isRefetching` is `isFetching && !isPending`, which is also true while
          // a NEXT page loads — so without the guard the pull-to-refresh spinner
          // pops at the top of the list every time the user paginates at the
          // bottom. The footer spinner already owns that state.
          <RefreshControl
            refreshing={isRefetching && !isFetchingNextPage}
            onRefresh={handleRefresh}
            tintColor={brandColors.primary}
          />
        }
      />
      <CommentSheet
        sheetRef={commentSheetRef}
        entityId={commentThread?.entityId ?? null}
        entityType={commentThread?.entityType ?? 'tick'}
        onClose={closeCommentThread}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  stateBlock: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: spacing[16],
    paddingHorizontal: spacing[8],
    gap: spacing[2],
  },
  stateTitle: {
    marginTop: spacing[3],
    opacity: 0.65,
    textAlign: 'center',
  },
  stateCta: {
    marginTop: spacing[3],
  },
  footer: {
    paddingVertical: spacing[5],
    alignItems: 'center',
  },
});
