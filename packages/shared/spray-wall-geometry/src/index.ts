/**
 * `@boardsesh/spray-wall-geometry` — the maths a spray wall photo needs: the
 * per-version homography that maps a photo onto the wall's canonical frame, and
 * the rule that tells a hold-edit draft from a new-photo draft.
 *
 * Pure TypeScript, no dependencies, shared by the backend, the app and the web
 * climb page. The hold matcher that compared two photos of one wall went with the
 * retired in-place reset. The frame is written up in `docs/spray-walls.md`,
 * "Canonical coordinates".
 */
export {
  IDENTITY_HOMOGRAPHY,
  type Homography,
  type Quad,
  type ReferenceSize,
  boundingSize,
  homographyFromAnchors,
  invert,
  isConvexQuad,
  isSolvableAnchorQuad,
  isValidAnchorQuad,
  mapPoint,
  mapRadius,
  mapRing,
  quadDoubleArea,
} from './homography';

export { classifySprayDraft, sameSprayGeometry, type SprayDraftPurpose, type SprayVersionPhoto } from './draft-purpose';

export {
  ART_CIRCLE_POINTS,
  ART_DILATE_FRACTION,
  ART_DILATE_MAX_PX,
  ART_FEATHER_FRACTION,
  ART_FEATHER_MAX_SIGMA,
  ART_MAX_EDGE,
  ART_RECIPE,
  SPRAY_WALL_BACKGROUNDS,
  type ArtHold,
  type ArtMaskRing,
  type ArtSize,
  type SprayWallBackground,
  artFeather,
  canonicalArtSize,
  holdMaskRings,
  warpBilinear,
} from './clean-art';
export {
  ART_MIN_FRAME_SHORT_EDGE,
  ART_STRETCH_GOOD_MAX,
  ART_STRETCH_GRID,
  ART_STRETCH_GRID_MARGIN,
  ART_STRETCH_SOFT_MAX,
  type ArtQualityReason,
  type ArtVerdict,
  type PhotoQuality,
  measureStretch,
  photoQuality,
} from './photo-quality';
export {
  PREVIEW_MESH_MAX_DIVISIONS,
  PREVIEW_MESH_TOLERANCE_PX,
  type AffineMatrix,
  type PreviewMesh,
  type PreviewMeshTriangle,
  affinePreviewMesh,
  applyViewMatrix,
  perspectiveViewMatrix,
  photoToTileHomography,
} from './look-preview';

export { SPRAY_WALL_PHOTO_MAX_LONG_SIDE, SPRAY_WALL_PHOTO_MAX_PIXELS, sprayWallPhotoMaxLongSide } from './photo-size';
