import { classifySprayDraft, type SprayVersionPhoto } from '@boardsesh/spray-wall-geometry';
import type { SprayWallVersion } from '@boardsesh/graphql/generated/graphql';

export type SprayDraftVersion = Pick<SprayWallVersion, 'photo' | 'anchors' | 'homography'>;

/** Both bucket URL styles resolve to the same immutable private object key.
 * The photo upload handler stores every original as spray-walls/<wall>/<photo>.jpg.
 * Other paths fail closed instead of guessing a draft purpose.
 */
export function sprayPhotoObjectIdentity(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const pathname = new URL(url).pathname;
    return /(?:^|\/)(spray-walls\/[0-9a-f-]+\/[0-9a-f-]+\.jpg)$/i.exec(pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

function photoGeometry(version: SprayDraftVersion): SprayVersionPhoto {
  return {
    photoIdentity: sprayPhotoObjectIdentity(version.photo?.url),
    width: version.photo?.width ?? null,
    height: version.photo?.height ?? null,
    anchors: version.anchors,
    homography: version.homography,
  };
}

export function sprayDraftPurpose(draft: SprayDraftVersion, published: SprayDraftVersion | null | undefined) {
  return classifySprayDraft(photoGeometry(draft), published ? photoGeometry(published) : null);
}
