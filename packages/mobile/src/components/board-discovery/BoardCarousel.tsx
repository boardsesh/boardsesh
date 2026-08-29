import { useCallback } from 'react';
import { View, StyleSheet, type ViewStyle } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { spacing } from '../../theme/tokens';
import type { BoardCardAction } from './board-card-actions';
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
  /**
   * The per-card ownership action (edit / unfollow / delete). Reads the flag
   * `userBoardToItem` already stamped on the item — never a scan back into the
   * source list. Memoize it, like `downloadLabelFor`.
   */
  actionFor?: (item: DiscoveryBoardItem) => BoardCardAction;
  /** Per-item screen-reader label for that action. Memoize it. */
  actionLabelFor?: (item: DiscoveryBoardItem) => string;
  onAction?: (item: DiscoveryBoardItem) => void;
  /**
   * Visible Edit-mode button labels, resolved once per carousel instead of per
   * card: which of the two a card shows follows from its own action.
   */
  deleteActionTitle?: string;
  unfollowActionTitle?: string;
  /** "Your boards" is in Edit mode. A scalar, so toggling leaves item identities alone. */
  isEditing?: boolean;
  /**
   * The key of the board whose delete/unfollow is in flight, or null. A scalar
   * for the same reason: only the one card whose `isActionPending` flipped
   * re-renders.
   */
  pendingActionKey?: string | null;
  contentStyle?: ViewStyle;
};

/**
 * Horizontal, free-scrolling board carousel that snaps each card to the leading
 * edge — the native equivalent of the web home's `scroll-snap-type: x proximity`
 * board scroller. Built on FlashList so long sections (popular/nearby) stay
 * cheap to render.
 */
export function BoardCarousel({
  items,
  onSelect,
  onDownload,
  downloadLabelFor,
  actionFor,
  actionLabelFor,
  onAction,
  deleteActionTitle,
  unfollowActionTitle,
  isEditing = false,
  pendingActionKey = null,
  contentStyle,
}: BoardCarouselProps) {
  const renderItem = useCallback(
    ({ item }: { item: DiscoveryBoardItem }) => {
      const action = actionFor?.(item) ?? null;
      return (
        <BoardDiscoveryCard
          item={item}
          onPress={onSelect}
          onDownload={onDownload}
          downloadLabel={downloadLabelFor?.(item)}
          action={action}
          onAction={onAction}
          actionLabel={actionLabelFor?.(item)}
          actionTitle={
            action === 'delete' ? deleteActionTitle : action === 'unfollow' ? unfollowActionTitle : undefined
          }
          isEditing={isEditing}
          isActionPending={pendingActionKey === item.key}
        />
      );
    },
    [
      onSelect,
      onDownload,
      downloadLabelFor,
      actionFor,
      actionLabelFor,
      onAction,
      deleteActionTitle,
      unfollowActionTitle,
      isEditing,
      pendingActionKey,
    ],
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
