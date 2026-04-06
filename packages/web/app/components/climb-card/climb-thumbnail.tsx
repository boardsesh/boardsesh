import React, { useMemo } from 'react';
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

const ClimbThumbnail: React.FC<ClimbThumbnailProps> = React.memo(({
  boardDetails,
  currentClimb,
  enableNavigation = false,
  onNavigate,
  maxHeight,
  preferImageLayers = false,
}) => {
  const pathname = usePathname();
  const canvasReady = useCanvasRendererReady();

  const boardStyle = useMemo<React.CSSProperties>(() => ({
    aspectRatio: `${boardDetails.boardWidth} / ${boardDetails.boardHeight}`,
    maxHeight: maxHeight ?? '10vh',
    width: '100%',
  }), [boardDetails.boardWidth, boardDetails.boardHeight, maxHeight]);

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
}, (prev, next) => {
  // Compare boardDetails by reference
  if (prev.boardDetails !== next.boardDetails) return false;

  // Compare currentClimb by display-relevant fields
  const prevClimb = prev.currentClimb;
  const nextClimb = next.currentClimb;
  if (prevClimb === nextClimb) {
    // Same reference — check remaining props
  } else if (prevClimb == null || nextClimb == null) {
    return false;
  } else if (
    prevClimb.uuid !== nextClimb.uuid ||
    prevClimb.frames !== nextClimb.frames ||
    prevClimb.mirrored !== nextClimb.mirrored
  ) {
    return false;
  }

  return (
    prev.enableNavigation === next.enableNavigation &&
    prev.maxHeight === next.maxHeight &&
    prev.preferImageLayers === next.preferImageLayers
    // onNavigate intentionally excluded — callback stability not guaranteed
  );
});

ClimbThumbnail.displayName = 'ClimbThumbnail';

export default ClimbThumbnail;
