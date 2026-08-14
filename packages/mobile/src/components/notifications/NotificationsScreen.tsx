import { useCallback, useEffect, useMemo } from 'react';
import { Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useNavigation } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { GroupedNotification } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';
import { OfflineState } from '../OfflineState';
import { NotificationRow } from './NotificationRow';
import { useNotificationNavigation } from './use-notification-navigation';
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

  const query = useGroupedNotifications();
  const unreadCount = useUnreadNotificationCount();
  const { mutate: markAllAsRead } = useMarkAllAsRead();
  const handlePress = useNotificationNavigation();

  const groups = useMemo(() => query.data?.pages.flatMap((page) => page.groups) ?? EMPTY_GROUPS, [query.data]);

  // Notifications are network-only. `query-provider` runs React Query in
  // `offlineFirst`, so an offline fetch PAUSES rather than failing: `isPending`
  // never clears and the screen would spin forever without this branch.
  const offline = useOfflineQueryState(query);
  const showOffline = offline.isBlocked && groups.length === 0;
  const showSpinner = !showOffline && query.isPending && groups.length === 0;
  const showError = !showOffline && query.isError && groups.length === 0;

  const handleMarkAllAsRead = useCallback(() => markAllAsRead(), [markAllAsRead]);
  const handleRefresh = useCallback(() => void query.refetch(), [query]);

  const handleEndReached = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  }, [query]);

  // "Mark all as read" lives in the native header rather than the list body, so
  // it stays reachable while the list is scrolled (the `setters` / `zone` filter
  // screens set the precedent). Shown only when there is something to mark.
  useEffect(() => {
    navigation.setOptions({
      headerRight:
        unreadCount > 0
          ? () => (
              <Pressable onPress={handleMarkAllAsRead} hitSlop={8} accessibilityRole="button">
                <Text variant="subheadline" color={brandColors.primary}>
                  {t('markAllRead')}
                </Text>
              </Pressable>
            )
          : undefined,
    });
  }, [navigation, unreadCount, handleMarkAllAsRead, brandColors.primary, t]);

  const renderItem = useCallback(
    ({ item }: { item: GroupedNotification }) => <NotificationRow notification={item} onPress={handlePress} />,
    [handlePress],
  );

  return (
    <View style={[styles.flex, { backgroundColor: systemColors.background }]}>
      <FlashList
        data={showSpinner || showError || showOffline ? EMPTY_GROUPS : groups}
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
          query.isFetchingNextPage ? (
            <View style={styles.footer}>
              <ActivityIndicator size="small" />
            </View>
          ) : null
        }
        refreshControl={
          <RefreshControl refreshing={query.isRefetching} onRefresh={handleRefresh} tintColor={brandColors.primary} />
        }
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
