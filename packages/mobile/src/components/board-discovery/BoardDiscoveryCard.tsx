import { memo } from 'react';
import { BoardDiscoveryCardView, type BoardDiscoveryCardViewProps } from './BoardDiscoveryCardView';
import { DiscoveryBoardImage, useDiscoveryBoardRender } from './DiscoveryBoardArt';
export { DISCOVERY_CARD_WIDTH } from './BoardDiscoveryCardView';
export type { BoardCardMenu, DiscoveryBoardItem } from './BoardDiscoveryCardView';
export const BoardDiscoveryCard = memo(function BoardDiscoveryCard(
  props: Omit<BoardDiscoveryCardViewProps, 'boardImage'>,
) {
  const { item } = props;
  const render = useDiscoveryBoardRender(item);
  return (
    <BoardDiscoveryCardView
      {...props}
      boardImage={render ? <DiscoveryBoardImage item={item} render={render} /> : undefined}
    />
  );
});
