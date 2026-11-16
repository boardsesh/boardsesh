import { useCallback, useMemo, type ComponentType } from 'react';
import { type ViewStyle } from 'react-native';
import { SnapCarousel } from '../SnapCarousel';
import type { BoardCardMenuAction, BoardCardMenuCapabilities, BoardCardMenuVia } from './board-card-menu';
import {
  DISCOVERY_CARD_WIDTH,
  type BoardCardMenu,
  type BoardDiscoveryCardViewProps,
  type DiscoveryBoardItem,
} from './BoardDiscoveryCardView';
import { useBoardCardMenuLabels } from './use-board-card-menu-labels';

export type BoardCarouselViewProps = {
  Card: ComponentType<Omit<BoardDiscoveryCardViewProps, 'boardImage'>>;
  items: DiscoveryBoardItem[];
  onSelect: (item: DiscoveryBoardItem) => void;
  /**
   * What each card's menu may offer here (the ⋯, the hold, and the matching
   * screen-reader actions). Absent draws plain cards: Popular, and the offline
   * list. Memoize it: a new object re-renders every card in the rail.
   */
  menuCapabilities?: BoardCardMenuCapabilities;
  /** Runs a picked menu row. Only read alongside `menuCapabilities`. Memoize it. */
  onMenuAction?: (item: DiscoveryBoardItem, action: BoardCardMenuAction, via: BoardCardMenuVia) => void;
  contentStyle?: ViewStyle;
};

/**
 * Horizontal, free-scrolling board carousel that snaps each card to the leading
 * edge — the native equivalent of the web home's `scroll-snap-type: x proximity`
 * board scroller. Built on FlashList so long sections (popular/nearby) stay
 * cheap to render.
 */
export function BoardCarouselView({
  Card,
  items,
  onSelect,
  menuCapabilities,
  onMenuAction,
  contentStyle,
}: BoardCarouselViewProps) {
  const menuLabels = useBoardCardMenuLabels();
  // One object for the whole rail, rebuilt only when what the menu may offer
  // changes (going offline, say). It is the only card input outside the item,
  // so it is also the extraData that tells FlashList a recycled cell is stale.
  const menu = useMemo<BoardCardMenu | undefined>(
    () =>
      menuCapabilities && onMenuAction
        ? { capabilities: menuCapabilities, labels: menuLabels, onAction: onMenuAction }
        : undefined,
    [menuCapabilities, onMenuAction, menuLabels],
  );

  const renderItem = useCallback(
    ({ item }: { item: DiscoveryBoardItem }) => <Card item={item} onPress={onSelect} menu={menu} />,
    [Card, onSelect, menu],
  );

  return (
    <SnapCarousel
      data={items}
      cardWidth={DISCOVERY_CARD_WIDTH}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      extraData={menu}
      contentStyle={contentStyle}
    />
  );
}

function keyExtractor(item: DiscoveryBoardItem) {
  return item.key;
}
