'use client';

import React, { useMemo } from 'react';
import LocaleLink from '@/app/components/i18n/locale-link';
import type { BoardDetails, BoardName } from '@/app/lib/types';
import BoardImageLayers from '@/app/components/board-renderer/board-image-layers';
import BoardCanvasRenderer from '@/app/components/board-renderer/board-canvas-renderer';
import { useCanvasRendererReady } from '@/app/lib/board-render-worker/worker-manager';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { getDefaultBoardConfig } from '@/app/lib/default-board-configs';
import type { RenderBoardConfig } from '@boardsesh/shared-schema';
import { constructClimbViewUrlWithSlugs, constructClimbViewUrl, tryConstructSlugViewUrl } from '@/app/lib/url-utils';
import styles from './ascents-feed.module.css';

type AscentThumbnailProps = {
  boardType: string;
  layoutId: number | null;
  angle: number;
  climbUuid: string;
  climbName: string;
  frames: string | null;
  isMirror: boolean;
  /**
   * The board this ascent should be drawn on, resolved server-side — the board
   * it was climbed on, or the closest one the climber has. Falls back to the
   * layout default when absent (feeds that don't resolve it).
   */
  renderBoard?: RenderBoardConfig | null;
  /** When provided, renders as a <button> instead of the climb-view <Link>. */
  onClick?: (e: React.MouseEvent) => void;
};

const AscentThumbnail: React.FC<AscentThumbnailProps> = ({
  boardType,
  layoutId,
  angle,
  climbUuid,
  climbName,
  frames,
  isMirror,
  renderBoard,
  onClick,
}) => {
  const canvasReady = useCanvasRendererReady();
  // Memoize board details to avoid recomputing on every render
  const boardDetails = useMemo<BoardDetails | null>(() => {
    if (!layoutId) return null;

    const boardName = boardType as BoardName;
    const config = renderBoard ?? getDefaultBoardConfig(boardName, layoutId);
    if (!config) return null;

    try {
      return getBoardDetailsForBoard({
        board_name: boardName,
        layout_id: renderBoard?.layoutId ?? layoutId,
        size_id: config.sizeId,
        set_ids: config.setIds,
      });
    } catch (error) {
      console.error('Failed to get board details for thumbnail:', error);
      return null;
    }
  }, [boardType, layoutId, renderBoard]);

  // Reuse the already-memoized boardDetails to build the climb view URL
  const climbViewPath = useMemo(() => {
    if (!boardDetails || !layoutId) return null;

    // Id-aware first: `renderBoard` is the board this ascent was actually
    // logged on, which can be a size that shares its base slug with another
    // on the same layout (Kilter layout 1 sizes 10/27 — see `resolveSizeSlug`).
    // Slugging from names alone would link this climber's own thumbnail to
    // the OTHER physical board. Names stay the fallback for a board the
    // static tables don't carry.
    const idAwarePath = tryConstructSlugViewUrl(
      boardDetails.board_name,
      boardDetails.layout_id,
      boardDetails.size_id,
      boardDetails.set_ids,
      angle,
      climbUuid,
      climbName,
    );
    if (idAwarePath) return idAwarePath;

    if (boardDetails.layout_name && boardDetails.size_name && boardDetails.set_names) {
      return constructClimbViewUrlWithSlugs(
        boardDetails.board_name,
        boardDetails.layout_name,
        boardDetails.size_name,
        boardDetails.size_description,
        boardDetails.set_names,
        angle,
        climbUuid,
        climbName,
      );
    }

    const config = renderBoard ?? getDefaultBoardConfig(boardType as BoardName, layoutId);
    return constructClimbViewUrl(
      {
        board_name: boardType as BoardName,
        layout_id: renderBoard?.layoutId ?? layoutId,
        size_id: config?.sizeId ?? 1,
        set_ids: config?.setIds ?? [],
        angle,
      },
      climbUuid,
      climbName,
    );
  }, [boardDetails, boardType, layoutId, renderBoard, angle, climbUuid, climbName]);

  // If we can't render the thumbnail, don't show anything
  if (!boardDetails || (!onClick && !climbViewPath)) {
    return null;
  }

  const thumbnailStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
  };

  let thumbnailContent: React.ReactNode;
  if (canvasReady && frames) {
    thumbnailContent = (
      <BoardCanvasRenderer
        boardDetails={boardDetails}
        frames={frames}
        mirrored={isMirror}
        thumbnail
        style={thumbnailStyle}
      />
    );
  } else if (frames) {
    thumbnailContent = (
      <BoardImageLayers
        boardDetails={boardDetails}
        frames={frames}
        mirrored={isMirror}
        thumbnail
        style={thumbnailStyle}
      />
    );
  } else {
    thumbnailContent = (
      <BoardImageLayers boardDetails={boardDetails} mirrored={isMirror} thumbnail style={thumbnailStyle} />
    );
  }

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={styles.thumbnailLink}
        title={`Set ${climbName} as active climb`}
        aria-label={`Set ${climbName} as active climb`}
      >
        <div className={styles.thumbnailContainer}>{thumbnailContent}</div>
      </button>
    );
  }

  return (
    <LocaleLink href={climbViewPath!} className={styles.thumbnailLink} title={`View ${climbName}`}>
      <div className={styles.thumbnailContainer}>{thumbnailContent}</div>
    </LocaleLink>
  );
};

export default AscentThumbnail;
