import React, { useMemo } from 'react';

import type { BoardImageDetails, Climb } from '@/app/lib/types';
import BoardImageLayers from '@/app/components/board-renderer/board-image-layers';

type ClimbThumbnailProps = {
  currentClimb: Climb | null;
  boardDetails: BoardImageDetails;
  /** Current pathname — passed from parent to avoid per-instance usePathname() context lookups. */
  pathname: string;
  /** Callback for thumbnail presses when an active-climb/play-drawer flow is desired. */
  onClick?: () => void;
  maxHeight?: string;
  /** Set fetchpriority="high" for LCP-critical images */
  fetchPriority?: 'high' | 'low' | 'auto';
};

const ClimbThumbnail: React.FC<ClimbThumbnailProps> = React.memo(
  ({ boardDetails, currentClimb, pathname: _pathname, onClick, maxHeight, fetchPriority }) => {
    const boardStyle = useMemo<React.CSSProperties>(
      () => ({
        aspectRatio: '5 / 7',
        maxHeight: maxHeight ?? '120px',
        width: '100%',
      }),
      [maxHeight],
    );

    const renderContent = currentClimb ? (
      <BoardImageLayers
        boardDetails={boardDetails}
        frames={currentClimb.frames}
        mirrored={!!currentClimb.mirrored}
        thumbnail
        style={boardStyle}
        fetchPriority={fetchPriority}
      />
    ) : null;

    if (onClick && currentClimb) {
      return (
        <div
          onClick={onClick}
          style={{ cursor: 'pointer' }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onClick();
            }
          }}
        >
          {renderContent}
        </div>
      );
    }

    return <div>{renderContent}</div>;
  },
  (prev, next) => {
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
      prev.pathname === next.pathname &&
      prev.onClick === next.onClick &&
      prev.maxHeight === next.maxHeight &&
      prev.fetchPriority === next.fetchPriority
    );
  },
);

ClimbThumbnail.displayName = 'ClimbThumbnail';

export default ClimbThumbnail;
