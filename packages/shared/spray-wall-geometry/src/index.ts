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
