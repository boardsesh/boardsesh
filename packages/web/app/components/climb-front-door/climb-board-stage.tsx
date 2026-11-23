import React from 'react';
import Box from '@mui/material/Box';
import { BOARD_FIELD_COLORS } from '@boardsesh/board-look';
import { toDarkArtUrl } from '@/app/components/board-renderer/util';
import boardArtStyles from '@/app/components/board-renderer/board-art-theme.module.css';
import styles from './climb-board-stage.module.css';

type ClimbBoardStageProps = {
  /** Static board-photo layers, from `buildBoardArtLayers`. Empty unless the board ships dark art. */
  backgroundUrls: string[];
  /** The per-climb holds render, from `buildBoardArtLayers`. */
  overlayUrl: string;
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
  overlayUrl,
  boardWidth,
  boardHeight,
  alt,
  children,
}: ClimbBoardStageProps) {
  return (
    <Box className={styles.stage}>
      {/* The frame is the dark field the render is drawn for, so the board reads
          as one wall rather than a picture on a card. */}
      <Box component="figure" className={styles.frame} sx={{ bgcolor: BOARD_FIELD_COLORS.dark }}>
        {/* The ratio feeds the height cap in the stylesheet. */}
        <Box className={styles.art} sx={{ '--board-aspect-ratio': String(boardWidth / boardHeight) }}>
          {backgroundUrls.map((backgroundUrl) => (
            <React.Fragment key={backgroundUrl}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={backgroundUrl}
                alt=""
                width={boardWidth}
                height={boardHeight}
                className={boardArtStyles.lightArt}
                fetchPriority="high"
                decoding="async"
                style={boardLayerStyle}
              />
              {/* eslint-disable-next-line @next/next/no-img-element */}
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
            </React.Fragment>
          ))}
          {/* eslint-disable-next-line @next/next/no-img-element -- the overlay route
              is already an optimised render endpoint; next/image would add a second
              proxy hop in front of the page's LCP element for no gain. */}
          <img
            src={overlayUrl}
            alt={alt}
            width={boardWidth}
            height={boardHeight}
            fetchPriority="high"
            decoding="async"
            style={boardLayerStyle}
          />
        </Box>
      </Box>
      {children}
    </Box>
  );
}
