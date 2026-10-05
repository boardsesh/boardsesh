/** A photo identity excludes expiring signatures; adapters supply storage keys. */
export type SprayVersionPhoto = {
  photoIdentity: string | null;
  width: number | null;
  height: number | null;
  anchors: unknown;
  homography: unknown;
};

export type SprayDraftPurpose = 'initial' | 'hold-edit' | 'reset';

/** Compare the stored numeric geometry, refusing malformed or unknown shapes. */
export function sameSprayGeometry(first: unknown, second: unknown): boolean {
  if (first == null || second == null) return first == null && second == null;
  if (typeof first === 'number' && typeof second === 'number') {
    return Number.isFinite(first) && first === second;
  }
  return (
    Array.isArray(first) &&
    Array.isArray(second) &&
    first.length === second.length &&
    first.every((coordinate, index) => sameSprayGeometry(coordinate, second[index]))
  );
}

function validMapping(photo: SprayVersionPhoto): boolean {
  const matrix = photo.homography;
  const anchors = photo.anchors;
  return (
    (matrix == null ||
      (Array.isArray(matrix) &&
        matrix.length === 9 &&
        matrix.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate)))) &&
    (anchors == null ||
      (Array.isArray(anchors) &&
        anchors.length === 4 &&
        anchors.every(
          (point) =>
            Array.isArray(point) &&
            point.length === 2 &&
            point.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate)),
        )))
  );
}

/** Reusing the exact published photo and mapping edits holds; every other photo needs reset review. */
export function classifySprayDraft(draft: SprayVersionPhoto, published: SprayVersionPhoto | null): SprayDraftPurpose {
  if (!published) return 'initial';
  return draft.photoIdentity != null &&
    draft.photoIdentity.length > 0 &&
    draft.photoIdentity === published.photoIdentity &&
    draft.width != null &&
    draft.height != null &&
    Number.isInteger(draft.width) &&
    Number.isInteger(draft.height) &&
    draft.width > 0 &&
    draft.height > 0 &&
    draft.width === published.width &&
    draft.height === published.height &&
    validMapping(draft) &&
    validMapping(published) &&
    sameSprayGeometry(draft.anchors, published.anchors) &&
    sameSprayGeometry(draft.homography, published.homography)
    ? 'hold-edit'
    : 'reset';
}
