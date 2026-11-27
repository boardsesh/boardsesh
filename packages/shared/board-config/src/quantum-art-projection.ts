import type { QuantumModelName } from '@boardsesh/board-constants/quantum';
import { getQuantumModelForConfig, type QuantumBoardDetails } from './quantum-config';

type ArtworkCrop = readonly [left: number, top: number, right: number, bottom: number];

// Optical registration of LED centres against the original uncropped artwork.
// These are measured render coordinates, not a controller or catalogue formula.
// Exporter coordinates have been scaled by 1,000 in the bundled geometry.
const STANDARD = { xScale: 20.47419725 / 1_000, yScale: 20.47813435 / 1_000, xOrigin: 132.77138, yOrigin: 2030.65532 };
const FITNESS = { xScale: 11.028746 / 1_000, yScale: 17.47828 / 1_000, xOrigin: 252.43056, yOrigin: 1836.32819 };

const CROPS = {
  xl: [126, 44, 2090, 2028],
  l: [126, 334, 2090, 2026],
  m: [324, 334, 1872, 2026],
  s: [372, 24, 1548, 1916],
} as const satisfies Record<Exclude<QuantumModelName, 'belay'>, ArtworkCrop>;

/** Set the canvas and every hold centre to cropped artwork pixels. The IDs and
 * source geometry remain the same, including the controller's LED lookup. */
export function projectQuantumBoardArtwork(
  details: QuantumBoardDetails,
  { scaleCanvas = true }: { scaleCanvas?: boolean } = {},
): QuantumBoardDetails {
  const model = details.neutralGrid.model;
  if (model === 'belay') return details;

  const { xScale, yScale, xOrigin, yOrigin } = model === 's' ? FITNESS : STANDARD;
  const [left, top, right, bottom] = CROPS[model];
  const cropWidth = right - left;
  const cropHeight = bottom - top;
  const canvasScale = scaleCanvas ? Math.min(1, 1536 / cropWidth, 2304 / cropHeight) : 1;
  const boardWidth = Math.round(cropWidth * canvasScale);
  const boardHeight = Math.round(cropHeight * canvasScale);
  const holdXScale = ((details.edge_right - details.edge_left) * xScale) / details.boardWidth;
  const holdYScale = ((details.edge_top - details.edge_bottom) * yScale) / details.boardHeight;
  const holdXOffset = details.edge_left * xScale + xOrigin - left;
  const holdYOffset = yOrigin - details.edge_top * yScale - top;
  const radiusScale = (cropWidth / details.boardWidth) * canvasScale;

  return {
    ...details,
    boardWidth,
    boardHeight,
    // Generic zone and selection geometry projects source units within the visible crop.
    edge_left: (left - xOrigin) / xScale,
    edge_right: (right - xOrigin) / xScale,
    edge_bottom: (yOrigin - bottom) / yScale,
    edge_top: (yOrigin - top) / yScale,
    neutralGrid: { ...details.neutralGrid, boardWidth, boardHeight },
    holdsData: details.holdsData.map((hold) => ({
      ...hold,
      cx: (hold.cx * holdXScale + holdXOffset) * canvasScale,
      cy: (hold.cy * holdYScale + holdYOffset) * canvasScale,
      r: hold.r * radiusScale,
    })),
  };
}

// Visible contact edges measured from original lossless standard-family art.
// XL crop-relative seams: (688,747)..(699,766), (1112,845)..(1103,855).
// The 3058/3063 and 6094/6086 bodies touch through antialiasing; these one-pixel
// boundaries join existing ground so each physical hold traces as one body.
const SOURCE_CONTACT_SEAMS = [
  [
    [814, 791],
    [816, 794],
    [818, 797],
    [820, 801],
    [822, 806],
    [825, 810],
  ],
  [
    [1238, 889],
    [1236, 891],
    [1234, 893],
    [1232, 896],
    [1229, 899],
  ],
] as const;

/** Offline segmentation calibration in original cropped image pixels. */
export function getQuantumArtworkContactSeams(
  layoutId: number,
  sizeId: number,
): ReadonlyArray<ReadonlyArray<readonly [number, number]>> {
  const resolved = getQuantumModelForConfig(layoutId, sizeId);
  if (!resolved || resolved.key === 'belay' || resolved.key === 's') return [];
  const [left, top] = CROPS[resolved.key];
  return SOURCE_CONTACT_SEAMS.map((seam) => seam.map(([x, y]) => [x - left, y - top] as const));
}
