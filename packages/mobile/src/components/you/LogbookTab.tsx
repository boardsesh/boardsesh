import { useCallback, useRef, useState } from 'react';
import { View, RefreshControl, StyleSheet } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useTranslation } from 'react-i18next';
import type BottomSheet from '@gorhom/bottom-sheet';
import type { AscentFeedItem } from '@boardsesh/graphql/operations';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../../lib/analytics';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { ActivityIndicator } from '../ActivityIndicator';
import { LogbookRow } from './LogbookRow';
import { LogbookEditSheet } from './LogbookEditSheet';
import { useUserAscentsFeed } from '../../lib/graphql/hooks';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

export function LogbookTab({ userId }: { userId: string | undefined }) {
  const { t } = useTranslation('you');
  const { systemColors, brandColors } = useTheme();
  const bottomChrome = useBottomChromeMetrics();
  const paddingBottom = bottomChrome.scrollBottomPadding + spacing[4];

  const editSheetRef = useRef<BottomSheet | null>(null);
  const [editAscent, setEditAscent] = useState<AscentFeedItem | null>(null);

  const feed = useUserAscentsFeed(userId);
  const items = feed.data?.pages.flatMap((page) => page.userAscentsFeed.items) ?? [];

  const handlePress = useCallback((ascent: AscentFeedItem) => {
    track(SHARED_EVENTS.LogbookRowClicked, { climbUuid: ascent.climbUuid });
    setEditAscent(ascent);
    editSheetRef.current?.snapToIndex(0);
  }, []);

  const handleEndReached = useCallback(() => {
    if (feed.hasNextPage && !feed.isFetchingNextPage) void feed.fetchNextPage();
  }, [feed]);

  const renderItem = useCallback(
    ({ item }: { item: AscentFeedItem }) => <LogbookRow ascent={item} onPress={handlePress} />,
    [handlePress],
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
        data={items}
        renderItem={renderItem}
        keyExtractor={(item) => item.uuid}
        contentInsetAdjustmentBehavior="automatic"
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.5}
        contentContainerStyle={{ paddingBottom }}
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
            <Icon name="tick.outline" size={48} color={systemColors.tertiaryLabel} />
            <Text variant="headline" style={styles.emptyTitle}>
              {t('mobile.logbook.empty')}
            </Text>
          </View>
        }
      />
      <LogbookEditSheet sheetRef={editSheetRef} ascent={editAscent} onClose={() => setEditAscent(null)} />
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
  emptyTitle: { opacity: 0.6, marginTop: spacing[3], textAlign: 'center' },
});
