// The canonical -> photo projection moved to `@boardsesh/spray-wall-geometry`
// (SW-20, #5471) so the backend's training review and export share it with the
// render path. Re-exported here so the app's imports stay where they were.
export {
  type CanonicalSprayHold,
  type SprayHoldProvenance,
  type SprayPhotoHold,
  mapCanonicalHoldsToPhoto,
  scaleCanonicalHoldsToArt,
} from '@boardsesh/spray-wall-geometry';
