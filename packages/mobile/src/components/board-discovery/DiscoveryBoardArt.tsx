import { memo, useMemo } from 'react';
import type { BoardRenderData } from '../../lib/board-details';
import { useBoardRenderData } from '../../lib/use-board-render-data';
import { BoardImageNative } from '../BoardImageNative';
import { BoardThumbnail, type BoardThumbnailSize } from '../boards/BoardThumbnail';
import type { DiscoveryBoardItem } from './BoardDiscoveryCardView';

/**
 * The render data for a board's bare art, or null when the catalogue cannot
 * draw it (the caller then shows its own fallback).
 */
export function useDiscoveryBoardRender(item: DiscoveryBoardItem): BoardRenderData | null {
  return useBoardRenderData({
    boardName: item.boardName,
    layoutId: item.layoutId,
    sizeId: item.sizeId,
    setIds: item.setIds,
  });
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

/** What draws a board's art in a row or the hero: the real thumbnail in the app, a fixture in stories. */
export type DiscoveryBoardArtProps = { item: DiscoveryBoardItem; size: BoardThumbnailSize };

/**
 * A board's bare art (no climb lit) in an art slot, for the picker's rows and
 * hero: `BoardThumbnail`, fitted to the board's own aspect with no tile behind
 * it, a spray wall's photo or the camera glyph.
 */
export const DiscoveryBoardArt = memo(function DiscoveryBoardArt({ item, size }: DiscoveryBoardArtProps) {
  const board = useMemo(
    () => ({ boardType: item.boardName, layoutId: item.layoutId, sizeId: item.sizeId, setIds: item.setIds }),
    [item.boardName, item.layoutId, item.sizeId, item.setIds],
  );
  return <BoardThumbnail board={board} size={size} />;
});
