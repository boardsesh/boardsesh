import { View, StyleSheet, type ViewStyle, type ViewabilityConfig } from 'react-native';
import { FlashList, type FlashListProps, type ListRenderItem } from '@shopify/flash-list';
import { spacing } from '../theme/tokens';

/**
 * The gap between two cards in a snapping rail. Exported because a host that
 * wants to pin a rail's height or compute a scroll offset needs the same number
 * the separator uses — never a second literal that can drift from it.
 */
export const SNAP_CARD_GAP = spacing[3];

type SnapCarouselProps<TItem> = {
  data: readonly TItem[];
  /** Fixed card width. Sets the snap interval together with `SNAP_CARD_GAP`. */
  cardWidth: number;
  renderItem: ListRenderItem<TItem>;
  keyExtractor: (item: TItem, index: number) => string;
  /**
   * Everything `renderItem` closes over that FlashList cannot see for itself.
   * Forwarded untouched: FlashList recycles rows and will not re-render an
   * unchanged item just because `renderItem` got a new identity.
   */
  extraData?: unknown;
  contentStyle?: ViewStyle;
  accessibilityLabel?: string;
  viewabilityConfig?: ViewabilityConfig;
  /**
   * Forwarded untouched, identity included — a list's `onViewableItemsChanged`
   * must not change between renders, so hosts hold theirs in a ref-backed stable
   * callback and this component must never wrap it.
   */
  onViewableItemsChanged?: FlashListProps<TItem>['onViewableItemsChanged'];
};

/**
 * Horizontal, free-scrolling card rail that snaps each card to the leading edge
 * — the native equivalent of the web's `scroll-snap-type: x proximity` scroller.
 *
 * This owns the list config (snapping, separators, content insets) so the rails
 * built on it cannot drift apart on it. Everything above the list — the card,
 * its memoization, per-rail extras — stays with the host.
 */
export function SnapCarousel<TItem>({
  data,
  cardWidth,
  renderItem,
  keyExtractor,
  extraData,
  contentStyle,
  accessibilityLabel,
  viewabilityConfig,
  onViewableItemsChanged,
}: SnapCarouselProps<TItem>) {
  return (
    // No `estimatedItemSize` — FlashList v2 (installed: 2.0.2) removed it in
    // favour of automatic sizing; passing it is a no-op. Cards are fixed-width
    // (`cardWidth`) so layout is stable regardless.
    <FlashList
      data={data}
      horizontal
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      extraData={extraData}
      showsHorizontalScrollIndicator={false}
      // Snap each card to the leading edge: card width + the gap between cards.
      snapToInterval={cardWidth + SNAP_CARD_GAP}
      snapToAlignment="start"
      decelerationRate="fast"
      disableIntervalMomentum
      ItemSeparatorComponent={Separator}
      viewabilityConfig={viewabilityConfig}
      onViewableItemsChanged={onViewableItemsChanged}
      accessibilityLabel={accessibilityLabel}
      contentContainerStyle={[styles.content, contentStyle]}
    />
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: spacing[4],
  },
  separator: {
    width: SNAP_CARD_GAP,
  },
});
