import React, { useCallback, useMemo } from 'react';
import type { RenderMode } from '@boardsesh/board-render/render-config';
import type { BoardDetails } from '@/app/lib/types';
import { buildBoardArtLayers, getImageUrl, hasDarkBoardArt, toDarkArtUrl } from './util';
import styles from './board-art-theme.module.css';
import { THUMBNAIL_WIDTH } from './types';
import { trackRenderError, type RenderContext } from '@/app/lib/rendering-metrics';

// Use CSS Grid stacking (gridArea: 1/1) instead of absolute positioning to avoid
// iOS 18.x WebKit bugs with absolutely positioned images in aspect-ratio containers.
const baseLayerStyle: React.CSSProperties = {
  gridArea: '1 / 1',
  width: '100%',
  height: '100%',
  objectFit: 'fill',
};

const layerStyle: React.CSSProperties = {
  ...baseLayerStyle,
  display: 'block',
};

const layerContainStyle: React.CSSProperties = {
  ...layerStyle,
  objectFit: 'contain',
};

// Light/dark pairs leave `display` to board-art-theme.module.css — an inline value would
// beat the class and both variants would paint on top of each other.
const pairedLayerStyle: React.CSSProperties = baseLayerStyle;

const pairedLayerContainStyle: React.CSSProperties = {
  ...baseLayerStyle,
  objectFit: 'contain',
};

export type BoardImageLayersProps = {
  boardDetails: BoardDetails;
  frames?: string;
  mirrored: boolean;
  thumbnail?: boolean;
  /** Use object-fit: contain (for swipe carousel where container controls sizing) */
  contain?: boolean;
  /** Additional styles for the container div */
  style?: React.CSSProperties;
  /** Set fetchpriority="high" for LCP-critical images */
  fetchPriority?: 'high' | 'low' | 'auto';
  /** Which drawing the server should render. Defaults to `aura` — see `buildBoardRenderUrl`. */
  renderMode?: RenderMode;
};

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
  fetchPriority,
  renderMode,
}: BoardImageLayersProps) {
  // Boards with dark art split the board photo back out as a static layer and keep ONE
  // per-climb overlay render — see buildBoardArtLayers for why a themed composite would cost
  // a second WASM + sharp job per card. Everything else keeps the single baked composite.
  const darkArt = hasDarkBoardArt(boardDetails.board_name);
  const { backgroundUrls: artBackgroundUrls, overlayUrl } = useMemo(
    () => buildBoardArtLayers(boardDetails, frames, thumbnail, renderMode),
    [boardDetails, frames, thumbnail, renderMode],
  );
  const bareBackgroundUrls = useMemo(
    () => Object.keys(boardDetails.images_to_holds).map((img) => getImageUrl(img, boardDetails.board_name, thumbnail)),
    [boardDetails.images_to_holds, boardDetails.board_name, thumbnail],
  );
  // With no climb to overlay, the photo layers are all there is to draw.
  const backgroundUrls = overlayUrl ? artBackgroundUrls : bareBackgroundUrls;

  const containerStyle = useMemo<React.CSSProperties>(
    () => ({
      display: 'grid',
      overflow: 'hidden',
      ...style,
      transform: mirrored ? 'scaleX(-1)' : style?.transform,
    }),
    [style, mirrored],
  );

  const useContain = contain || thumbnail;
  let imgStyle = useContain ? layerContainStyle : layerStyle;
  if (darkArt) imgStyle = useContain ? pairedLayerContainStyle : pairedLayerStyle;

  let renderContext: RenderContext = 'card';
  if (thumbnail) {
    renderContext = 'thumbnail';
  } else if (contain) {
    renderContext = 'full-board';
  }

  const handleOverlayError = useCallback(() => {
    trackRenderError(renderContext, 'wasm');
  }, [renderContext]);

  // Use actual thumbnail dimensions for HTML width/height hints so the browser
  // reserves the correct aspect ratio before the image loads.
  const imgWidth = thumbnail ? THUMBNAIL_WIDTH : boardDetails.boardWidth;
  const imgHeight = thumbnail
    ? Math.round((THUMBNAIL_WIDTH * boardDetails.boardHeight) / boardDetails.boardWidth)
    : boardDetails.boardHeight;

  return (
    <div style={containerStyle}>
      {backgroundUrls.map((url, i) => (
        <React.Fragment key={url}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt=""
            width={imgWidth}
            height={imgHeight}
            style={imgStyle}
            className={darkArt ? styles.lightArt : undefined}
            fetchPriority={i === 0 ? fetchPriority : undefined}
            loading={thumbnail && !(i === 0 && fetchPriority === 'high') ? 'lazy' : undefined}
          />
          {darkArt ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={toDarkArtUrl(url)}
              alt=""
              width={imgWidth}
              height={imgHeight}
              style={imgStyle}
              className={styles.darkArt}
              fetchPriority={i === 0 ? fetchPriority : undefined}
              loading={thumbnail && !(i === 0 && fetchPriority === 'high') ? 'lazy' : undefined}
            />
          ) : null}
        </React.Fragment>
      ))}

      {overlayUrl ? (
        // One render per climb either way: the board photo baked in for an ordinary board,
        // transparent and stacked over the photo layers above for a themed one.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={overlayUrl}
          alt=""
          width={imgWidth}
          height={imgHeight}
          style={imgStyle}
          fetchPriority={fetchPriority}
          loading={thumbnail && fetchPriority !== 'high' ? 'lazy' : undefined}
          onError={handleOverlayError}
        />
      ) : null}
    </div>
  );
});

export default BoardImageLayers;
