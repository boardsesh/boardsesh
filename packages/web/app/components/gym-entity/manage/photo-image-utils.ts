// Pure decision logic for the gym photo uploader. The DOM/canvas work lives in
// gym-photo-uploader.tsx; everything a unit test can pin down without a browser
// (encoding choice, dimension math) lives here. Display-URL resolution for
// stored photos lives in app/lib/gym-logo-display-url.ts, shared with the
// public gym page.
//
// Photos are not logos: no transparency to preserve and no animation to keep,
// so every accepted input re-encodes as JPEG at a wall-shot-sized ceiling.

import { GYM_PHOTO_MAX_UPLOAD_BYTES as SHARED_GYM_PHOTO_MAX_UPLOAD_BYTES } from '@boardsesh/shared-schema';
import { scaleToFit } from './logo-image-utils';

/** Client-side ceiling on the PICKED file — we downscale before uploading. */
export const GYM_PHOTO_MAX_INPUT_BYTES = 20 * 1024 * 1024;

/**
 * The backend's hard Busboy cap on the UPLOADED file (POST /api/gym-photos).
 * Re-exported from @boardsesh/shared-schema rather than restated, so the two
 * caps cannot drift; photo-image-utils.test.ts pins the identity.
 */
export const GYM_PHOTO_MAX_UPLOAD_BYTES = SHARED_GYM_PHOTO_MAX_UPLOAD_BYTES;

/** Longest side of the uploaded photo after the canvas downscale. */
export const GYM_PHOTO_MAX_DIMENSION = 1920;

/**
 * The two caps in megabytes, for interpolation into the localized copy. Each
 * limit exists exactly once (as a byte constant) and every user-facing string
 * that quotes a size reads it from here, so raising a cap can't leave four
 * catalogs stating the old figure.
 */
export const GYM_PHOTO_MAX_INPUT_MB = Math.round(GYM_PHOTO_MAX_INPUT_BYTES / (1024 * 1024));
export const GYM_PHOTO_MAX_UPLOAD_MB = Math.round(GYM_PHOTO_MAX_UPLOAD_BYTES / (1024 * 1024));

/** Mirror of the backend's mime allowlist, minus GIF (a photo isn't animated). */
export const GYM_PHOTO_ACCEPTED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type GymPhotoEncodingPlan = {
  /**
   * Always JPEG. A gym photo has no alpha to protect, and a 1920px PNG of a
   * wall runs several megabytes where the JPEG is a few hundred kilobytes.
   */
  outputMimeType: 'image/jpeg';
  outputFileName: string;
  quality: number;
  /** JPEG has no alpha channel, so a transparent PNG needs a ground first. */
  fillWhite: boolean;
};

/** How to prepare a picked file for upload, or null when the type is unsupported. */
export function resolvePhotoEncodingPlan(inputMimeType: string): GymPhotoEncodingPlan | null {
  if (!(GYM_PHOTO_ACCEPTED_MIME_TYPES as readonly string[]).includes(inputMimeType)) {
    return null;
  }
  return {
    outputMimeType: 'image/jpeg',
    outputFileName: 'gym-photo.jpg',
    quality: 0.82,
    fillWhite: true,
  };
}

export { scaleToFit };
