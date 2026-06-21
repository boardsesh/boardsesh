/**
 * Image-resize sizes shared by the backend (`/static/...` `?size=` handlers)
 * and the web + mobile clients that build those URLs. Kept in one place so a
 * change to the allowlist can't leave a client silently requesting a size the
 * backend doesn't honor (an off-list `?size=` makes the backend serve the
 * full-size original).
 */

/**
 * Allowlist of widths (px) the backend will resize to. Bounded so the set of
 * cached resized-variant S3 keys can't explode.
 */
export const ALLOWED_IMAGE_SIZES = [44, 64, 80, 128, 140, 280] as const;
export type AllowedImageSize = (typeof ALLOWED_IMAGE_SIZES)[number];

const MAX_ALLOWED_IMAGE_SIZE = ALLOWED_IMAGE_SIZES[ALLOWED_IMAGE_SIZES.length - 1];

/**
 * Snap a desired pixel width up to the smallest allowed bucket (clamped to the
 * largest bucket). Used by clients to pick a `?size=` the backend will honor.
 */
export function snapToAllowedImageSize(targetPx: number): AllowedImageSize {
  return ALLOWED_IMAGE_SIZES.find((candidate) => candidate >= targetPx) ?? MAX_ALLOWED_IMAGE_SIZE;
}

/**
 * Width requested for beta-video thumbnails — the ~140px card at 2× DPR. Must
 * be a member of {@link ALLOWED_IMAGE_SIZES}.
 */
export const BETA_THUMBNAIL_REQUEST_SIZE: AllowedImageSize = 280;
