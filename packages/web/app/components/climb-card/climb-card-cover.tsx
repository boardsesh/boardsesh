'use client';
import React from 'react';
import type { Climb, BoardDetails } from '@/app/lib/types';
import BoardImageLayers from '@/app/components/board-renderer/board-image-layers';
import BoardCanvasRenderer from '@/app/components/board-renderer/board-canvas-renderer';
import { useDoubleTap } from '@/app/lib/hooks/use-double-tap';
import { useCanvasRendererReady } from '@/app/lib/board-render-worker/worker-manager';

type ClimbCardCoverProps = {
  climb?: Climb;
  boardDetails: BoardDetails;
  onClick?: () => void;
  onDoubleClick?: () => void;
  preferImageLayers?: boolean;
};

const ClimbCardCover = ({
  climb,
  boardDetails,
  onClick,
  onDoubleClick,
  preferImageLayers = false,
}: ClimbCardCoverProps) => {
  const { ref, onDoubleClick: handleDoubleClick } = useDoubleTap(onDoubleClick);
  const canvasReady = useCanvasRendererReady();

  const boardStyle: React.CSSProperties = {
    aspectRatio: `${boardDetails.boardWidth} / ${boardDetails.boardHeight}`,
    width: '100%',
  };

  let renderContent: React.ReactNode;
  if (!climb) {
    renderContent = <BoardImageLayers boardDetails={boardDetails} mirrored={false} style={boardStyle} />;
  } else if (!preferImageLayers && canvasReady) {
    renderContent = (
      <BoardCanvasRenderer
        boardDetails={boardDetails}
        frames={climb.frames}
        mirrored={!!climb.mirrored}
        style={boardStyle}
      />
    );
  } else {
    renderContent = (
      <BoardImageLayers
        boardDetails={boardDetails}
        frames={climb.frames}
        mirrored={!!climb.mirrored}
        style={boardStyle}
      />
    );
  }

  return (
    <div
      ref={ref}
      onClick={onClick}
      onDoubleClick={handleDoubleClick}
      style={{
        width: '100%',
        height: 'auto',
        position: 'relative',
        cursor: onClick || onDoubleClick ? 'pointer' : 'default',
      }}
    >
      {renderContent}
    </div>
  );
};

export default ClimbCardCover;
