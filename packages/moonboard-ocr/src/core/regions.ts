import type { ImageRegion } from '../image-processor/types';
import type { GridRows } from '../board-profiles';

export type ImageRegions = {
  header: ImageRegion;
  board: ImageRegion;
};

/** Observed stock Android 1.3.68 on a Pixel 8 Pro at 1008×2244.
 * Mini boards are centered with additional vertical space, not stretched to 18
 * rows. These bounds describe cell edges, not the yellow artwork (which also
 * includes labels). Reject other geometries instead of silently mislabeling holds.
 */
export function calculateAndroidRegions(width: number, height: number, rows: GridRows): ImageRegions {
  if (width !== 1008 || height !== 2244) throw new Error('Unvalidated Android screenshot dimensions');
  return {
    header: { x: 0, y: 247, width, height: 202 },
    board: { x: 107, y: rows === 12 ? 786 : 560, width: 853, height: rows === 12 ? 931 : 1396 },
  };
}

/**
 * Calculate header and board regions based on image dimensions.
 * Fallback method using hardcoded proportions calibrated for 1290x2796 iPhones.
 * Prefer calculateRegionsFromDetectedBoard() when yellow region is available.
 */
export function calculateRegions(width: number, height: number): ImageRegions {
  const headerTop = Math.round(height * 0.11);
  const headerHeight = Math.round(height * 0.09);

  const boardTop = Math.round(height * 0.249);
  const boardBottom = Math.round(height * 0.88);
  const boardHeight = boardBottom - boardTop;

  const boardLeft = Math.round(width * 0.1);
  const boardRight = Math.round(width * 0.95);
  const boardWidth = boardRight - boardLeft;

  return {
    header: {
      x: 0,
      y: headerTop,
      width: width,
      height: headerHeight,
    },
    board: {
      x: boardLeft,
      y: boardTop,
      width: boardWidth,
      height: boardHeight,
    },
  };
}

// Calibrated from 1290x2796 fixtures by comparing detectBoardRegion() output
// against known-good proportional board regions.
// Horizontal insets are consistent across images because the board left/right
// edges are well-defined. Vertical positions use proportional calculation
// because the yellow region's top/bottom boundaries vary (some screenshots
// include extra yellow area from UI elements or the "TRAIN HARD" section).
const GRID_LEFT_INSET = 0.0886; // Row number labels on left
const GRID_RIGHT_INSET = 0.0359; // Small margin on right

/**
 * Calculate header and board regions from the auto-detected yellow board area.
 *
 * Uses yellow detection for horizontal boundaries (fixes different screen widths)
 * and proportional calculation for vertical boundaries (stable across images).
 * The header position is derived from proportional image height.
 */
export function calculateRegionsFromDetectedBoard(
  yellowRegion: ImageRegion,
  imageWidth: number,
  imageHeight: number,
): ImageRegions {
  // Horizontal: use yellow detection (accurate across different resolutions)
  const gridLeft = Math.round(yellowRegion.x + yellowRegion.width * GRID_LEFT_INSET);
  const gridRight = Math.round(yellowRegion.x + yellowRegion.width * (1 - GRID_RIGHT_INSET));
  const gridWidth = gridRight - gridLeft;

  // Vertical: use proportional calculation (yellow top/bottom vary too much)
  const gridTop = Math.round(imageHeight * 0.249);
  const gridBottom = Math.round(imageHeight * 0.88);
  const gridHeight = gridBottom - gridTop;

  // Header: proportional (consistent across resolutions for the vertical axis)
  const headerTop = Math.round(imageHeight * 0.11);
  const headerHeight = Math.round(imageHeight * 0.09);

  return {
    header: {
      x: 0,
      y: headerTop,
      width: imageWidth,
      height: headerHeight,
    },
    board: {
      x: gridLeft,
      y: gridTop,
      width: gridWidth,
      height: gridHeight,
    },
  };
}
