import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { BoardDetails, Climb } from '@/app/lib/types';
import BoardImageLayers from '@/app/components/board-renderer/board-image-layers';
import BoardCanvasRenderer from '@/app/components/board-renderer/board-canvas-renderer';
import { useCanvasRendererReady } from '@/app/lib/board-render-worker/worker-manager';
import { getContextAwareClimbViewUrl } from '@/app/lib/url-utils';

type ClimbThumbnailProps = {
  currentClimb: Climb | null;
  boardDetails: BoardDetails;
  enableNavigation?: boolean;
  onNavigate?: () => void;
  maxHeight?: string;
  preferImageLayers?: boolean;
};

const ClimbThumbnail = ({
  boardDetails,
  currentClimb,
  enableNavigation = false,
  onNavigate,
  maxHeight,
  preferImageLayers = false,
}: ClimbThumbnailProps) => {
  const pathname = usePathname();
  const canvasReady = useCanvasRendererReady();

  const boardStyle: React.CSSProperties = {
    aspectRatio: `${boardDetails.boardWidth} / ${boardDetails.boardHeight}`,
    maxHeight: maxHeight ?? '10vh',
  };

  let renderContent: React.ReactNode = null;
  if (currentClimb) {
    if (!preferImageLayers && canvasReady) {
      renderContent = (
        <BoardCanvasRenderer
          boardDetails={boardDetails}
          frames={currentClimb.frames}
          mirrored={!!currentClimb.mirrored}
          thumbnail
          style={boardStyle}
        />
      );
    } else {
      renderContent = (
        <BoardImageLayers
          boardDetails={boardDetails}
          frames={currentClimb.frames}
          mirrored={!!currentClimb.mirrored}
          thumbnail
          style={boardStyle}
        />
      );
    }
  }

  if (enableNavigation && currentClimb) {
    const climbViewUrl = getContextAwareClimbViewUrl(
      pathname,
      boardDetails,
      currentClimb.angle,
      currentClimb.uuid,
      currentClimb.name,
    );

    return (
      <div>
        <Link href={climbViewUrl} prefetch={false} onClick={() => onNavigate?.()} data-testid="climb-thumbnail-link">
          {renderContent}
        </Link>
      </div>
    );
  }

  return <div>{renderContent}</div>;
};

export default ClimbThumbnail;
