import { useCallback, useMemo } from 'react';
import { type ViewStyle } from 'react-native';
import { SnapCarousel } from '../SnapCarousel';
import type { BoardCardAction } from './board-card-actions';
import { BoardDiscoveryCard, DISCOVERY_CARD_WIDTH, type DiscoveryBoardItem } from './BoardDiscoveryCard';

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
  /**
   * Toggle a board's pin. Only "Your boards" passes one; the card renders no pin
   * control without it. Memoize it, like `downloadLabelFor`.
   */
  onTogglePin?: (item: DiscoveryBoardItem) => void;
  /** Per-item screen-reader label for the pin toggle. Memoize it. */
  pinLabelFor?: (item: DiscoveryBoardItem) => string;
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
  onTogglePin,
  pinLabelFor,
  isEditing = false,
  pendingActionKey = null,
  contentStyle,
}: BoardCarouselProps) {
  // One object per (isEditing, pendingActionKey) pair rather than per render, so
  // FlashList only invalidates its cells when something actually changed.
  const extraData = useMemo(() => ({ isEditing, pendingActionKey }), [isEditing, pendingActionKey]);

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
          onTogglePin={onTogglePin}
          pinLabel={pinLabelFor?.(item)}
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
      onTogglePin,
      pinLabelFor,
      isEditing,
      pendingActionKey,
    ],
  );

  return (
    <SnapCarousel
      data={items}
      cardWidth={DISCOVERY_CARD_WIDTH}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      // The card's interactive state — Edit mode, the in-flight action, and now
      // the pin — lives outside the item for the first two, so FlashList has to
      // be told when a recycled cell is stale. Without it a pin tap can leave
      // the neighbouring recycled card showing the old glyph.
      extraData={extraData}
      contentStyle={contentStyle}
    />
  );
}

function keyExtractor(item: DiscoveryBoardItem) {
  return item.key;
}
