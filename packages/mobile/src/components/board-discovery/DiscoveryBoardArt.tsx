import { memo, useMemo } from 'react';
import { getBoardRenderData } from '../../lib/board-details';
import { useSprayWallToken } from '../../lib/spray/use-spray-wall-token';
import { BoardImageNative } from '../BoardImageNative';
import type { DiscoveryBoardItem } from './BoardDiscoveryCardView';

type BoardRenderData = NonNullable<ReturnType<typeof getBoardRenderData>>;

/**
 * The render data for a board's bare art, or null when the catalogue cannot
 * draw it (the caller then shows its own fallback).
 */
export function useDiscoveryBoardRender(item: DiscoveryBoardItem): BoardRenderData | null {
  // The picker reads the same `myBoards` list as Manage, so a wall that is not
  // the active board would draw the generic fallback and never ask for its photo
  // or hear about its arrival without this (see `BoardManageRow`).
  const sprayToken = useSprayWallToken(item.boardName, item.layoutId);
  return useMemo(
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
}

const FILL_PARENT = { width: '100%', height: '100%' } as const;

/** The art itself, from render data the caller already has. */
export function DiscoveryBoardImage({
  item,
  render,
  size,
}: {
  item: DiscoveryBoardItem;
  render: BoardRenderData;
  /** Side of the square, in points. Absent: it fills its parent. */
  size?: number;
}) {
  const frameStyle = useMemo(() => (size === undefined ? FILL_PARENT : { width: size, height: size }), [size]);
  return (
    <BoardImageNative
      frames=""
      boardName={item.boardName}
      layoutId={item.layoutId}
      sizeId={item.sizeId}
      setIds={item.setIds}
      boardWidth={render.boardWidth}
      boardHeight={render.boardHeight}
      renderWidth={size === undefined ? 400 : Math.max(200, size * 3)}
      style={frameStyle}
    />
  );
}

/**
 * A board's bare art (no climb lit) in a square of `size` points, for the In
 * range hero and rows. Nothing for a board the catalogue cannot draw; the
 * caller's frame shows through.
 */
export const DiscoveryBoardArt = memo(function DiscoveryBoardArt({
  item,
  size,
}: {
  item: DiscoveryBoardItem;
  size: number;
}) {
  const render = useDiscoveryBoardRender(item);
  return render ? <DiscoveryBoardImage item={item} render={render} size={size} /> : null;
});
