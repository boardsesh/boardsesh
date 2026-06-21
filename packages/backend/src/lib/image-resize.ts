import sharp from 'sharp';
import type { Readable } from 'stream';
import { ALLOWED_IMAGE_SIZES, type AllowedImageSize } from '@boardsesh/shared-schema';

// Re-exported so handlers importing from this module get the allowlist from a
// single source (it lives in @boardsesh/shared-schema so the web + mobile
// clients that build `?size=` URLs share the same values).
export { ALLOWED_IMAGE_SIZES, type AllowedImageSize };

/**
 * Parse a `?size=` query value against the allowlist. Returns null for
 * missing / non-numeric / out-of-allowlist values, in which case the
 * caller serves the original image (back-compat).
 */
export function parseSizeParam(raw: string | null | undefined): AllowedImageSize | null {
  if (!raw) return null;
  const parsed = Number(raw);
  return (ALLOWED_IMAGE_SIZES as readonly number[]).includes(parsed) ? (parsed as AllowedImageSize) : null;
}

/**
 * S3 key for a resized variant of a base object, e.g.
 * `avatars/u1.jpg` → `avatars/u1.jpg@140.jpg`. Variants are always JPEG.
 */
export function resizedVariantKey(baseKey: string, size: AllowedImageSize): string {
  return `${baseKey}@${size}.jpg`;
}

/**
 * Resize an image buffer to fill a size×size square, re-encoding as JPEG.
 * Never upscales beyond the source (`withoutEnlargement`), so a small
 * source is returned at its own size rather than blown up.
 */
export async function resizeImageBuffer(input: Buffer, size: AllowedImageSize): Promise<Buffer> {
  return sharp(input).resize(size, size, { fit: 'cover', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
}

/**
 * Collect a readable stream into a single Buffer. No size cap — callers only
 * pass it size-bounded objects (avatars are limited by the upload handler;
 * beta thumbnails by the fetch/cache step). Add a cap before reusing this for
 * arbitrary/user-controlled object sizes.
 */
export async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
  }
  return Buffer.concat(chunks);
}
