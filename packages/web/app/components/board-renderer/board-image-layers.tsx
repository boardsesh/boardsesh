import React, { useCallback, useMemo, useRef } from 'react';
import type { BoardDetails } from '@/app/lib/types';
import { getImageUrl, buildOverlayUrl } from './util';
import { trackRenderComplete, trackRenderError, type RenderContext } from '@/app/lib/rendering-metrics';

const layerStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
};

const layerContainStyle: React.CSSProperties = {
  ...layerStyle,
  objectFit: 'contain',
};

export interface BoardImageLayersProps {
  boardDetails: BoardDetails;
  frames?: string;
  mirrored: boolean;
  thumbnail?: boolean;
  /** Use object-fit: contain (for swipe carousel where container controls sizing) */
  contain?: boolean;
  /** Additional styles for the container div */
  style?: React.CSSProperties;
}

/**
 * Renders a board as layered images:
 * - Background: static board images (cached per board config, shared across all climbs)
 * - Overlay: transparent WebP with hold circles from the WASM renderer (cached per climb)
 * - Mirroring: CSS scaleX(-1) on the container (no separate render needed)
 */
const BoardImageLayers = React.memo(function BoardImageLayers({
  boardDetails,
  frames,
  mirrored,
  thumbnail,
  contain,
  style,
}: BoardImageLayersProps) {
  const overlayUrl = frames ? buildOverlayUrl(boardDetails, frames, thumbnail) : null;
  const backgroundUrls = useMemo(
    () => Object.keys(boardDetails.images_to_holds).map((img) => getImageUrl(img, boardDetails.board_name, thumbnail)),
    [boardDetails.images_to_holds, boardDetails.board_name, thumbnail],
  );

  const containerStyle = useMemo<React.CSSProperties>(
    () => ({
      position: 'relative',
      ...style,
      transform: mirrored ? 'scaleX(-1)' : style?.transform,
    }),
    [style, mirrored],
  );

  const imgStyle = contain ? layerContainStyle : layerStyle;

  // Render timing: measure mount → overlay loaded
  const mountTime = useRef(performance.now());
  const hasFired = useRef(false);
  const renderContext: RenderContext = thumbnail ? 'thumbnail' : contain ? 'full-board' : 'card';

  const handleOverlayLoad = useCallback(() => {
    if (hasFired.current) return;
    hasFired.current = true;
    trackRenderComplete(performance.now() - mountTime.current, renderContext, 'wasm');
  }, [renderContext]);

  const handleOverlayError = useCallback(() => {
    trackRenderError(renderContext, 'wasm');
  }, [renderContext]);

  return (
    <div style={containerStyle}>
      {backgroundUrls.map((url) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={url} src={url} alt="" style={imgStyle} />
      ))}
      {overlayUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={overlayUrl}
          alt=""
          loading="lazy"
          style={imgStyle}
          onLoad={handleOverlayLoad}
          onError={handleOverlayError}
        />
      )}
    </div>
  );
});

export default BoardImageLayers;
