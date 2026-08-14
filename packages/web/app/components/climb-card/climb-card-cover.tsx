'use client';
import React from 'react';
import type { LogbookEntry } from '@boardsesh/board-react';
import type { BoardName, Climb, BoardDetails } from '@/app/lib/types';
import BoardImageLayers from '@/app/components/board-renderer/board-image-layers';
import BoardCanvasRenderer from '@/app/components/board-renderer/board-canvas-renderer';
import { useDoubleTap } from '@/app/lib/hooks/use-double-tap';
import { useCanvasRendererReady } from '@/app/lib/board-render-worker/worker-manager';
import { AscentStatus } from './ascent-status';
import styles from './ascent-status.module.css';

type ClimbCardCoverProps = {
  climb?: Climb;
  boardDetails: BoardDetails;
  onClick?: () => void;
  onDoubleClick?: () => void;
  preferImageLayers?: boolean;
  /** Viewer's ticks, forwarded to the ascent badge. Omit for anonymous renders. */
  logbook?: readonly LogbookEntry[];
  /** Board the cover shows; the badge needs it to decide on mirrored ticks. */
  boardName?: BoardName;
};

const ClimbCardCover = ({
  climb,
  boardDetails,
  onClick,
  onDoubleClick,
  preferImageLayers = false,
  logbook,
  boardName,
}: ClimbCardCoverProps) => {
  const { ref, onDoubleClick: handleDoubleClick } = useDoubleTap(onDoubleClick);
  const canvasReady = useCanvasRendererReady();

  // Both renderers below are React.memo'd, and a fresh style object defeats
  // that memo — every board re-renders whenever anything above re-renders the
  // cover (a logbook fetch resolving, a tick save, auth settling).
  const boardStyle: React.CSSProperties = React.useMemo(
    () => ({
      aspectRatio: `${boardDetails.boardWidth} / ${boardDetails.boardHeight}`,
      width: '100%',
    }),
    [boardDetails.boardWidth, boardDetails.boardHeight],
  );

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
      {climb && (
        <AscentStatus
          climbUuid={climb.uuid}
          angle={climb.angle}
          logbook={logbook}
          boardName={boardName}
          fontSize={12}
          className={styles.badge}
          mirroredClassName={styles.badgeMirrored}
        />
      )}
    </div>
  );
};

/**
 * Memoized because the card above now reads BoardContext on the badge's behalf:
 * without this, every board context change (logbook fetch, tick save, auth
 * settling) walks the whole grid down to the renderers.
 */
export default React.memo(ClimbCardCover);
