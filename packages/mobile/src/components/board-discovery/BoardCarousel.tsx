import { useCallback } from 'react';
import { View, StyleSheet, type ViewStyle } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { spacing } from '../../theme/tokens';
import { BoardDiscoveryCard, DISCOVERY_CARD_WIDTH, type DiscoveryBoardItem } from './BoardDiscoveryCard';

const CARD_GAP = spacing[3];
// Snap each card to the leading edge: card width + the gap between cards.
const SNAP_INTERVAL = DISCOVERY_CARD_WIDTH + CARD_GAP;

type BoardCarouselProps = {
  items: DiscoveryBoardItem[];
  onSelect: (item: DiscoveryBoardItem) => void;
  /** See BoardDiscoveryCard — only the user's own boards carousel passes one. */
  onDownload?: (item: DiscoveryBoardItem) => void;
  /** Per-item accessibility label for the download glyph. Memoize it. */
  downloadLabelFor?: (item: DiscoveryBoardItem) => string;
  contentStyle?: ViewStyle;
};

/**
 * Horizontal, free-scrolling board carousel that snaps each card to the leading
 * edge — the native equivalent of the web home's `scroll-snap-type: x proximity`
 * board scroller. Built on FlashList so long sections (popular/nearby) stay
 * cheap to render.
 */
export function BoardCarousel({ items, onSelect, onDownload, downloadLabelFor, contentStyle }: BoardCarouselProps) {
  const renderItem = useCallback(
    ({ item }: { item: DiscoveryBoardItem }) => (
      <BoardDiscoveryCard
        item={item}
        onPress={onSelect}
        onDownload={onDownload}
        downloadLabel={downloadLabelFor?.(item)}
      />
    ),
    [onSelect, onDownload, downloadLabelFor],
  );

  return (
    // No `estimatedItemSize` — FlashList v2 (installed: 2.0.2) removed it in
    // favour of automatic sizing; passing it is a no-op. Cards are fixed-width
    // (DISCOVERY_CARD_WIDTH) so layout is stable regardless.
    <FlashList
      data={items}
      horizontal
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      showsHorizontalScrollIndicator={false}
      snapToInterval={SNAP_INTERVAL}
      snapToAlignment="start"
      decelerationRate="fast"
      disableIntervalMomentum
      ItemSeparatorComponent={Separator}
      contentContainerStyle={[styles.content, contentStyle]}
    />
  );
}

function keyExtractor(item: DiscoveryBoardItem) {
  return item.key;
}

function Separator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: spacing[4],
  },
  separator: {
    width: CARD_GAP,
  },
});
