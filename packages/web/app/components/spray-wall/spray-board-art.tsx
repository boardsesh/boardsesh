import React from 'react';
import Box from '@mui/material/Box';
import type { SprayLitHoldMark } from '@/app/lib/spray/spray-climb-view';

type SprayBoardArtProps = {
  photoUrl: string;
  photoAlt: string;
  /** The photograph's own pixel box, which is the SVG's coordinate system. */
  frameWidth: number;
  frameHeight: number;
  marks: readonly SprayLitHoldMark[];
};

/**
 * A wall photograph with the climb's holds drawn over it.
 *
 * Server-rendered, and with no client component anywhere in it, for the reason
 * `ClimbFrontDoor` gives for the catalogue boards: this image is the page's LCP
 * and a crawler that runs no JavaScript still has to see the climb. So the
 * marks ship as inline SVG in the first HTML rather than through the board
 * renderer, which is a hook-bearing client component and could not draw a wall
 * in any case — its whole coordinate system is the catalogue tuple.
 *
 * The photo and the overlay stack in one CSS grid cell rather than through
 * absolute positioning, matching `BoardImageLayers`: absolutely positioned
 * children inside an aspect-ratio box hit iOS 18.x WebKit bugs.
 */
export default function SprayBoardArt({ photoUrl, photoAlt, frameWidth, frameHeight, marks }: SprayBoardArtProps) {
  return (
    <Box
      sx={{
        display: 'grid',
        '& > *': { gridArea: '1 / 1' },
        width: '100%',
        maxWidth: '100%',
      }}
    >
      {/*
        A plain `<img>`, not `next/image`. The source is an object in a storage
        bucket whose host varies by environment, and on an unlisted wall it is a
        presigned URL that changes on every read — neither survives the image
        optimiser's host allowlist or its cache key.
      */}
      <Box
        component="img"
        src={photoUrl}
        alt={photoAlt}
        width={frameWidth}
        height={frameHeight}
        sx={{ width: '100%', height: 'auto', display: 'block', borderRadius: 1 }}
      />
      <Box
        component="svg"
        viewBox={`0 0 ${frameWidth} ${frameHeight}`}
        // Decorative: every hold it draws is already named in the alt text of
        // the photograph underneath, so a screen reader that read both would
        // hear the climb twice.
        aria-hidden="true"
        focusable="false"
        sx={{ width: '100%', height: 'auto', display: 'block', pointerEvents: 'none' }}
      >
        {marks.map((mark) => (
          <SprayHoldMark key={mark.id} mark={mark} frameWidth={frameWidth} />
        ))}
      </Box>
    </Box>
  );
}

/**
 * One lit hold: its traced silhouette when the owner drew one, a ring at its
 * placement radius when they did not — the same fallback an untraced catalogue
 * placement gets.
 *
 * Two strokes, dark under bright. A spray wall is a photograph of real holds in
 * arbitrary colours, so a single coloured line disappears against a hold that
 * happens to be the same colour. The dark outer stroke is what keeps the mark
 * readable on a pale wall.
 */
function SprayHoldMark({ mark, frameWidth }: { mark: SprayLitHoldMark; frameWidth: number }) {
  // Scaled to the photograph rather than fixed, so a 4,000 px phone photo and a
  // 900 px one draw marks of the same visual weight once both are scaled into
  // the page's column.
  const strokeWidth = Math.max(2, frameWidth / 400);
  const shared = {
    fill: mark.color,
    fillOpacity: 0.2,
    stroke: mark.color,
    strokeWidth,
  };

  if (mark.polygonPoints) {
    return (
      <>
        <polygon
          points={mark.polygonPoints}
          fill="none"
          stroke="#000000"
          strokeOpacity={0.55}
          strokeWidth={strokeWidth * 2.2}
        />
        <polygon points={mark.polygonPoints} {...shared} />
      </>
    );
  }

  return (
    <>
      <circle
        cx={mark.cx}
        cy={mark.cy}
        r={mark.r}
        fill="none"
        stroke="#000000"
        strokeOpacity={0.55}
        strokeWidth={strokeWidth * 2.2}
      />
      <circle cx={mark.cx} cy={mark.cy} r={mark.r} {...shared} />
    </>
  );
}
