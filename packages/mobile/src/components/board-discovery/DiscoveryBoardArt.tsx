import { memo, useMemo } from 'react';
import { getBoardRenderData } from '../../lib/board-details';
import { useSprayWallToken } from '../../lib/spray/use-spray-wall-token';
import { BoardImageNative } from '../BoardImageNative';
import { BoardThumbnail, type BoardThumbnailSize } from '../boards/BoardThumbnail';
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

/** What draws a board's art in a row or the hero: the real thumbnail in the app, a fixture in stories. */
export type DiscoveryBoardArtProps = { item: DiscoveryBoardItem; size: BoardThumbnailSize };

/**
 * A board's bare art (no climb lit) in an art slot, for the picker's rows and
 * hero: `BoardThumbnail`, fitted to the board's own aspect with no tile behind
 * it, a spray wall's photo or the camera glyph.
 */
export const DiscoveryBoardArt = memo(function DiscoveryBoardArt({ item, size }: DiscoveryBoardArtProps) {
  const board = useMemo(
    () => ({
      uuid: item.key,
      boardType: item.boardName,
      layoutId: item.layoutId,
      sizeId: item.sizeId,
      setIds: item.setIds,
      sprayImport: item.sprayImport,
    }),
    [item.key, item.boardName, item.layoutId, item.sizeId, item.setIds, item.sprayImport],
  );
  return <BoardThumbnail board={board} size={size} />;
});
