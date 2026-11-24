import React from 'react';
import Box from '@mui/material/Box';
import { BOARD_FIELD_COLORS } from '@boardsesh/board-look';
import { toDarkArtUrl } from '@/app/components/board-renderer/util';
import boardArtStyles from '@/app/components/board-renderer/board-art-theme.module.css';
import styles from './climb-board-stage.module.css';
import { ClimbBoardStageOrientation } from './climb-board-stage-orientation';

type ClimbBoardStageProps = {
  /** Static board-photo layers, from `buildBoardArtLayers`. Empty unless the board ships dark art. */
  backgroundUrls: string[];
  backgroundHasDarkArt?: boolean;
  /** The per-climb holds render, from `buildBoardArtLayers`. */
  overlayUrl?: string;
  /** Viewer-only hold overlay kept inline instead of sent to the shared image renderer. */
  overlay?: React.ReactNode;
  mirrored?: boolean;
  allowMirrorFragment?: boolean;
  boardWidth: number;
  boardHeight: number;
  /** Alt text for the holds render, the one layer a screen reader announces. */
  alt: string;
  /**
   * What sits under the art: the climb's `HoldLegend`. Passed in rather than
   * rendered here so this component stays synchronous and the async legend is
   * a plain child of the server tree.
   */
  children?: React.ReactNode;
};

const boardLayerStyle: React.CSSProperties = {
  maxWidth: '100%',
  height: 'auto',
  width: '100%',
};

/**
 * The climb page's hero: the board art on the plain page, with a legend of the
 * climb's holds under it.
 *
 * The art is plain server `<img>`s, never `BoardRenderer` or
 * `BoardImageLayers`: both are hook-bearing client components, and this image
 * is the page's LCP, so it has to be in the first HTML. Each layer carries its
 * explicit width and height (so it reserves its box before it loads),
 * `fetchPriority="high"`, and no `loading="lazy"`.
 *
 * Woods art has a white ground that glares on a dark page, so it ships a dark
 * sibling. Rather than render the whole composite twice — one WASM + sharp job
 * per theme, per climb — the board photo splits out as static layers the
 * stylesheet picks between, and the holds render once on top. See
 * `buildBoardArtLayers`.
 */
export default function ClimbBoardStage({
  backgroundUrls,
  backgroundHasDarkArt = true,
  overlayUrl,
  overlay,
  mirrored,
  allowMirrorFragment,
  boardWidth,
  boardHeight,
  alt,
  children,
}: ClimbBoardStageProps) {
  const aspectRatio = String(boardWidth / boardHeight);
  const layers = (
    <>
      {backgroundUrls.map((backgroundUrl) => (
        <React.Fragment key={backgroundUrl}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={backgroundUrl}
            alt=""
            width={boardWidth}
            height={boardHeight}
            className={backgroundHasDarkArt ? boardArtStyles.lightArt : undefined}
            fetchPriority="high"
            decoding="async"
            style={boardLayerStyle}
          />
          {backgroundHasDarkArt && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={toDarkArtUrl(backgroundUrl)}
              alt=""
              width={boardWidth}
              height={boardHeight}
              className={boardArtStyles.darkArt}
              fetchPriority="high"
              decoding="async"
              style={boardLayerStyle}
            />
          )}
        </React.Fragment>
      ))}
      {overlayUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- this already uses the optimised render endpoint.
        <img
          src={overlayUrl}
          alt={alt}
          width={boardWidth}
          height={boardHeight}
          fetchPriority="high"
          decoding="async"
          style={boardLayerStyle}
        />
      ) : (
        overlay
      )}
    </>
  );
  return (
    <Box className={styles.stage}>
      <Box component="figure" className={styles.frame} sx={{ bgcolor: BOARD_FIELD_COLORS.dark }}>
        {allowMirrorFragment ? (
          <ClimbBoardStageOrientation aspectRatio={aspectRatio}>{layers}</ClimbBoardStageOrientation>
        ) : (
          <Box
            className={styles.art}
            data-mirrored={mirrored || undefined}
            sx={{ '--board-aspect-ratio': aspectRatio }}
          >
            {layers}
          </Box>
        )}
      </Box>
      {children}
    </Box>
  );
}
