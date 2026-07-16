export const HOLD_MORPHOLOGY_VERSION = 'hold-morphology-v1' as const;

/**
 * Stable feature order written to the offline JSONL artifact. Changing the
 * order or the feature definitions requires a new HOLD_MORPHOLOGY_VERSION.
 */
export const HOLD_MORPHOLOGY_FEATURE_NAMES = [
  'normalizedArea',
  'normalizedWidth',
  'normalizedHeight',
  'logAspectRatio',
  'normalizedPerimeter',
  'solidity',
  'eccentricity',
  'orientationSin2',
  'orientationCos2',
  'textureEdgeDensity',
  'meanLuminance',
  'luminanceStdDev',
] as const;

export type HoldMorphologyFeatureName = (typeof HOLD_MORPHOLOGY_FEATURE_NAMES)[number];

export type HoldMorphologyVector = readonly [
  normalizedArea: number,
  normalizedWidth: number,
  normalizedHeight: number,
  logAspectRatio: number,
  normalizedPerimeter: number,
  solidity: number,
  eccentricity: number,
  orientationSin2: number,
  orientationCos2: number,
  textureEdgeDensity: number,
  meanLuminance: number,
  luminanceStdDev: number,
];

export type RawRgbaImage = {
  data: Uint8Array;
  width: number;
  height: number;
  channels: number;
};

export type HoldPixelLocation = {
  centerX: number;
  centerY: number;
  /** Horizontal distance between adjacent board-grid cells in this image. */
  cellWidth: number;
  /** Vertical distance between adjacent board-grid cells in this image. */
  cellHeight: number;
  /**
   * Restrict the silhouette to this cell. Callers set this only after detecting
   * that adjacent holds touch in the alpha layer.
   */
  clipToCell?: boolean;
};

export type HoldMorphologyOptions = {
  /** Alpha at or above this value belongs to the visible hold silhouette. */
  alphaThreshold?: number;
  /** Components smaller than this are ignored as anti-aliasing/artwork noise. */
  minimumComponentPixels?: number;
  /** Maximum centre-to-silhouette search distance, in fractions of a grid cell. */
  searchRadiusFraction?: number;
  /** Sobel magnitude threshold, normalized to the operator's theoretical maximum. */
  textureEdgeThreshold?: number;
};

export type PreparedMorphologyComponent = {
  id: number;
  pixelIndices: readonly number[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export type PreparedMorphologyImage = {
  image: RawRgbaImage;
  labels: Int32Array;
  components: readonly PreparedMorphologyComponent[];
  foregroundPixelCount: number;
  options: Required<HoldMorphologyOptions>;
};

export type HoldComponentLocation =
  | {
      ok: true;
      componentId: number;
      componentPixelCount: number;
      /** Nearest visible alpha pixel distance divided by the smaller grid-cell dimension. */
      normalizedCenterDistance: number;
    }
  | {
      ok: false;
      reason: 'empty-image' | 'missing-hold';
    };

export type HoldMorphologyExtraction =
  | {
      ok: true;
      componentId: number;
      componentPixelCount: number;
      normalizedCenterDistance: number;
      /** True when the caller split a shared alpha component at cell boundaries. */
      componentWasClipped: boolean;
      vector: HoldMorphologyVector;
    }
  | {
      ok: false;
      reason: 'empty-image' | 'missing-hold';
    };

type HoldMorphologyRecordBase = {
  morphologyVersion: typeof HOLD_MORPHOLOGY_VERSION;
  setId: number;
  sourceAsset: string;
  sourceAssetSha256: string;
  /** Extraction confidence proxy: 0 is centred on visible art; 0.45 is the search limit. */
  normalizedCenterDistance: number;
  vector: HoldMorphologyVector;
};

export type AuroraHoldMorphologyRecord = HoldMorphologyRecordBase & {
  boardType: 'kilter' | 'tension';
  layoutId: number;
  placementId: number;
};

export type MoonBoardHoldMorphologyRecord = HoldMorphologyRecordBase & {
  boardType: 'moonboard';
  layoutId: number;
  gridCellId: number;
};

export type HoldMorphologyRecord = AuroraHoldMorphologyRecord | MoonBoardHoldMorphologyRecord;
