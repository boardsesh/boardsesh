import { memo, useMemo } from 'react';
import { getBoardRenderData } from '../../lib/board-details';
import { useSprayWallToken } from '../../lib/spray/use-spray-wall-token';
import { BoardImageNative } from '../BoardImageNative';
import { BoardDiscoveryCardView, type BoardDiscoveryCardViewProps } from './BoardDiscoveryCardView';
export { DISCOVERY_CARD_WIDTH } from './BoardDiscoveryCardView';
export type { BoardCardMenu, DiscoveryBoardItem } from './BoardDiscoveryCardView';
export const BoardDiscoveryCard = memo(function BoardDiscoveryCard(
  props: Omit<BoardDiscoveryCardViewProps, 'boardImage'>,
) {
  const { item } = props;
  // Same reason as `BoardManageRow`: the carousel reads the same `myBoards` list,
  // so a wall that is not the active board would draw the generic fallback and
  // never ask for its photo or hear about its arrival.
  const sprayToken = useSprayWallToken(item.boardName, item.layoutId);
  const render = useMemo(
    () =>
      getBoardRenderData({
        boardName: item.boardName,
        layoutId: item.layoutId,
        sizeId: item.sizeId,
        setIds: item.setIds.split(',').map(Number).filter(Number.isFinite),
      }),
    // `sprayToken` recomputes this when the wall lands or is reset.
    [item.boardName, item.layoutId, item.sizeId, item.setIds, sprayToken],
  );

  return (
    <BoardDiscoveryCardView
      {...props}
      boardImage={
        render ? (
          <BoardImageNative
            frames=""
            boardName={item.boardName}
            layoutId={item.layoutId}
            sizeId={item.sizeId}
            setIds={item.setIds}
            boardWidth={render.boardWidth}
            boardHeight={render.boardHeight}
            renderWidth={400}
            style={{ width: '100%', height: '100%' }}
          />
        ) : undefined
      }
    />
  );
});
