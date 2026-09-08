import { useCallback, useMemo, useRef } from 'react';
import { View, StyleSheet, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { FlashList, type ListRenderItem } from '@shopify/flash-list';
import { SectionHeader } from '../SectionHeader';
import { ActivityIndicator } from '../ActivityIndicator';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { textStyles as fallbackTextStyles } from '../../theme/typography';

export type PlaylistShelfProps<PlaylistItem> = {
  title: string;
  items: readonly PlaylistItem[];
  renderItem: ListRenderItem<PlaylistItem>;
  keyExtractor: (item: PlaylistItem, index: number) => string;
  extraData?: unknown;
  loading?: boolean;
  isLoadingMore?: boolean;
  hasMore: boolean;
  onEndReached: () => void;
  actionLabel?: string;
  onActionPress?: () => void;
};

export function playlistShelfHeight(fontScale: number, nameLineHeight: number, metaLineHeight: number): number {
  // Match PlaylistCard's fixed preview, two gaps and Text's 1.5 scaling cap.
  return 120 + 2 * spacing[2] + Math.ceil((nameLineHeight + metaLineHeight) * Math.min(fontScale, 1.5));
}

const KEEP_SCROLL_OFFSET = { disabled: true };

function CardSeparator() {
  return <View style={styles.separator} />;
}
function LoadingFooter() {
  return (
    <View style={styles.footer}>
      <ActivityIndicator size="small" />
    </View>
  );
}

/** A bounded horizontal viewport. Data remains paginated in the shared hooks. */
export function PlaylistShelf<PlaylistItem>({
  title,
  items,
  renderItem,
  keyExtractor,
  extraData,
  loading,
  isLoadingMore,
  hasMore,
  onEndReached,
  actionLabel,
  onActionPress,
}: PlaylistShelfProps<PlaylistItem>) {
  const { fontScale } = useWindowDimensions();
  const { textStyles } = useTheme();
  const height = playlistShelfHeight(
    fontScale,
    textStyles.subheadline.lineHeight ?? fallbackTextStyles.subheadline.lineHeight,
    textStyles.caption1.lineHeight ?? fallbackTextStyles.caption1.lineHeight,
  );
  const listStyle = useMemo(() => ({ height }), [height]);
  const interaction = useRef({ armed: false, dragging: false, momentum: false });
  const handleBeginDrag = useCallback(() => {
    interaction.current = { armed: !loading && !isLoadingMore, dragging: true, momentum: false };
  }, [loading, isLoadingMore]);
  const handleEndDrag = useCallback(() => {
    interaction.current.dragging = false;
  }, []);
  const handleMomentumBegin = useCallback(() => {
    interaction.current.momentum = true;
  }, []);
  const handleMomentumEnd = useCallback(() => {
    interaction.current.momentum = false;
    interaction.current.armed = false;
  }, []);
  const requestPage = useCallback(() => {
    const current = interaction.current;
    if (!current.armed || (!current.dragging && !current.momentum)) return;
    if (!hasMore || loading || isLoadingMore) {
      current.armed = false;
      return;
    }
    // Consume before invoking: append, dedup, and layout callbacks cannot drain
    // pages during this gesture. A new drag permits retries after a failed page.
    current.armed = false;
    onEndReached();
  }, [hasMore, loading, isLoadingMore, onEndReached]);
  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      // Also inspect user scrolls so another drag can retry at an unchanged end
      // after a duplicate page or failure (FlashList may not emit onEndReached again).
      if (contentSize.width - contentOffset.x - layoutMeasurement.width < 200) requestPage();
    },
    [requestPage],
  );
  return (
    <View style={styles.section}>
      <SectionHeader title={title} actionLabel={actionLabel} onActionPress={onActionPress} />
      {loading ? (
        <View style={[styles.loading, listStyle]}>
          <ActivityIndicator size="small" />
        </View>
      ) : (
        <View style={listStyle}>
          <FlashList
            horizontal
            data={items}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            extraData={extraData}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.content}
            ItemSeparatorComponent={CardSeparator}
            ListFooterComponent={isLoadingMore ? LoadingFooter : null}
            drawDistance={240}
            maintainVisibleContentPosition={KEEP_SCROLL_OFFSET}
            onEndReached={requestPage}
            onEndReachedThreshold={0.5}
            onScroll={handleScroll}
            onScrollBeginDrag={handleBeginDrag}
            onScrollEndDrag={handleEndDrag}
            onMomentumScrollBegin={handleMomentumBegin}
            onMomentumScrollEnd={handleMomentumEnd}
            scrollEventThrottle={16}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: spacing[2] },
  content: { paddingHorizontal: spacing[4] },
  separator: { width: spacing[4] },
  loading: { alignItems: 'center', justifyContent: 'center' },
  footer: {
    width: 48,
    height: 120,
    marginLeft: spacing[4],
    alignItems: 'center',
    justifyContent: 'center',
  },
});
