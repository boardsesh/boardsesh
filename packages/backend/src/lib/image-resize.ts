import sharp from 'sharp';
import type { Readable } from 'stream';
import { ALLOWED_IMAGE_SIZES, type AllowedImageSize } from '@boardsesh/shared-schema';

// Re-exported so handlers importing from this module get the allowlist from a
// single source (it lives in @boardsesh/shared-schema so the web + mobile
// clients that build `?size=` URLs share the same values).
export { ALLOWED_IMAGE_SIZES, type AllowedImageSize };

/**
 * Cache lifetime for a variant of a MUTABLE key (avatars, gym images).
 *
 * Matches what the proxying path served, so a client that drops the `?v=`
 * cache buster still self-heals within a day rather than pinning a replaced
 * image forever.
 */
export const MUTABLE_IMAGE_CACHE_CONTROL = 'public, max-age=86400';

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

/**
 * Write every allowed resize variant of a freshly uploaded image.
 *
 * Called for the MUTABLE media keys (avatars, gym logos, gym photos), which the
 * proxying path deliberately never cached a variant for: the key is overwritten
 * in place on re-upload, so a cached variant could shadow a new image. Serving
 * the bucket directly removes the on-the-fly resizer, so every size a client can
 * request has to exist as an object — and the `?v=` cache buster already in the
 * stored URL is what keeps a replacement visible instead.
 *
 * Variants are written BEFORE their base object by the callers, so a reader who
 * can see a new base can always see its variants; a partial failure leaves the
 * previous image and its variants fully consistent and surfaces as a 500.
 */
export async function writeImageVariants(
  original: Buffer,
  baseKey: string,
  writeObject: (key: string, body: Buffer, contentType: string) => Promise<unknown>,
  sizes: readonly AllowedImageSize[] = ALLOWED_IMAGE_SIZES,
  originalContentType = 'image/jpeg',
): Promise<void> {
  const resized = await Promise.all(
    sizes.map(async (size) => {
      try {
        return {
          key: resizedVariantKey(baseKey, size),
          body: await resizeImageBuffer(original, size),
          contentType: 'image/jpeg',
        };
      } catch {
        // A source sharp cannot decode still has to produce an OBJECT at every
        // variant key, because direct-from-bucket serving has no fallback: a
        // missing key is a 404, not a slightly-too-large image. Storing the
        // original bytes mirrors what the proxying resize path did on a failed
        // resize — serve the original unchanged — and keeps the upload itself
        // succeeding, which matters more than the pixels being the right size.
        return { key: resizedVariantKey(baseKey, size), body: original, contentType: originalContentType };
      }
    }),
  );
  await Promise.all(resized.map(({ key, body, contentType }) => writeObject(key, body, contentType)));
}
