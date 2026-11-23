import React, { useMemo } from 'react';
import Box from '@mui/material/Box';
import { BOARD_FIELD_COLORS } from '@boardsesh/board-look';
import BoardImageLayers from '@/app/components/board-renderer/board-image-layers';
import { getBoardImageDetailsForPlaylist } from '@/app/lib/board-image-details';
import { getClimbCoverPlacement, type ClimbThumbnailCrop } from '@/app/lib/climb-thumbnail-crop';
import type { BoardImageDetails, Climb } from '@/app/lib/types';

/** The art a cover can hold. */
export const PLAYLIST_COVER_MAX_CLIMBS = 4;

type CoverClimb = Pick<Climb, 'uuid' | 'frames' | 'mirrored' | 'boardType' | 'layoutId'>;

export type PlaylistCoverMosaicProps = {
  /** The playlist's climbs in order. The first four with drawable art make the cover. */
  climbs: readonly CoverClimb[];
  /** Board for a climb that carries no board type of its own (the playlist's). */
  fallbackBoardType: string;
  /** Server-computed lit-hold crops, by climb uuid. A climb without one shows its whole board. */
  cropsByClimb?: Record<string, ClimbThumbnailCrop>;
  /** Drawn instead when no climb has art: an empty playlist, or one of spray-wall climbs only. */
  fallback: React.ReactNode;
  className?: string;
};

type CellShape = 'full' | 'tall' | 'square';

type CoverCell = {
  climb: CoverClimb;
  boardDetails: BoardImageDetails;
  shape: CellShape;
};

/** Grid placement inside the 2×2 tile, and width over height to fit the climb's holds into. */
const CELL_SHAPES: Record<CellShape, { gridColumn: string; gridRow: string; slotAspect: number }> = {
  full: { gridColumn: '1 / -1', gridRow: '1 / -1', slotAspect: 1 },
  tall: { gridColumn: 'auto', gridRow: '1 / -1', slotAspect: 0.5 },
  square: { gridColumn: 'auto', gridRow: 'auto', slotAspect: 1 },
};

/**
 * Where each climb goes, by how many there are, so no cell is ever empty:
 * one fills the tile, two split it into tall halves, three put the first in a
 * tall left half beside two squares, four make the 2×2.
 */
function cellShape(index: number, count: number): CellShape {
  if (count === 1) return 'full';
  if (count === 2 || (count === 3 && index === 0)) return 'tall';
  return 'square';
}

const tileSx = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gridTemplateRows: '1fr 1fr',
  gap: '3px',
  width: '100%',
  aspectRatio: '1',
  overflow: 'hidden',
  // The gaps between cells read as thin dark rules, the board field's own colour.
  backgroundColor: BOARD_FIELD_COLORS.dark,
} as const;

const cellSx = {
  position: 'relative',
  overflow: 'hidden',
  minWidth: 0,
  minHeight: 0,
  backgroundColor: BOARD_FIELD_COLORS.dark,
} as const;

/**
 * A playlist's cover: the board art of its first climbs, the climbs the page
 * already renders in its list. Reuses the rows' `BoardImageLayers` and, for two
 * or more climbs, their exact thumbnail URLs, so the browser fetches each
 * image once for the cover and the row together.
 *
 * Decorative: every climb it shows is a named, linked row right below it.
 */
export default function PlaylistCoverMosaic({
  climbs,
  fallbackBoardType,
  cropsByClimb,
  fallback,
  className,
}: PlaylistCoverMosaicProps) {
  const cells = useMemo<CoverCell[]>(() => {
    const drawable: Array<Pick<CoverCell, 'climb' | 'boardDetails'>> = [];
    for (const climb of climbs) {
      if (drawable.length === PLAYLIST_COVER_MAX_CLIMBS) break;
      const boardDetails = getBoardImageDetailsForPlaylist(climb.boardType ?? fallbackBoardType, climb.layoutId);
      if (boardDetails) drawable.push({ climb, boardDetails });
    }
    return drawable.map((cell, index) => ({ ...cell, shape: cellShape(index, drawable.length) }));
  }, [climbs, fallbackBoardType]);

  if (cells.length === 0) return <>{fallback}</>;

  // One climb is drawn across the whole tile, past what a 200px thumbnail can
  // hold sharply, so it gets the full render. Smaller cells share the rows' thumbnails.
  const thumbnail = cells.length > 1;

  return (
    <Box className={className} sx={tileSx} aria-hidden data-testid="playlist-cover-mosaic">
      {cells.map(({ climb, boardDetails, shape }, index) => {
        const { gridColumn, gridRow, slotAspect } = CELL_SHAPES[shape];
        return (
          <Box
            key={climb.uuid}
            sx={{ ...cellSx, gridColumn, gridRow }}
            data-testid="playlist-cover-cell"
            data-shape={shape}
          >
            <Box
              sx={{
                position: 'absolute',
                ...getClimbCoverPlacement(
                  cropsByClimb?.[climb.uuid],
                  boardDetails.boardWidth,
                  boardDetails.boardHeight,
                  !!climb.mirrored,
                  slotAspect,
                ),
              }}
            >
              <BoardImageLayers
                boardDetails={boardDetails}
                frames={climb.frames}
                mirrored={!!climb.mirrored}
                thumbnail={thumbnail}
                style={{ aspectRatio: `${boardDetails.boardWidth} / ${boardDetails.boardHeight}`, width: '100%' }}
                // The cover sits at the top of the page, so its first image loads
                // with the page rather than waiting for the lazy-load observer.
                fetchPriority={index === 0 ? 'high' : undefined}
              />
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
